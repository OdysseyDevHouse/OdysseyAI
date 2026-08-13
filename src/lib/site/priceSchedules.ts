import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'
import { safeDateTime } from '../storefrontModel'
import type { PendingSchedule } from '../priceSchedules'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { planReprice, writePriceRows, recordPriceRemoval, type RepriceScope } from './reprice'
import type { RepriceRule } from '../repricing'

/**
 * Scheduled price changes — the database half.
 *
 * The owner builds a list of new prices and names a moment. At that moment the
 * tills switch on their own clock (see lib/priceSchedules.ts, which is pure and
 * ships to them), and a few minutes later the tick here writes the same numbers
 * into product_prices so the shop, the reports and the online store agree.
 *
 * ── RULE LINES ARE MATERIALISED, NOT RE-PLANNED ──────────────────────────
 *
 * `addRuleLines` runs the reprice planner ONCE, when the owner presses the
 * button, and stores the numbers it produced. Firing does not re-plan.
 *
 * Two reasons. The owner approved the list they were looking at; re-deriving it
 * at six in the morning against a cost that moved on a delivery at ten the
 * night before would put prices live that nobody has ever seen. And a till
 * cannot re-plan — it has no costs and no VAT table — so a rule that existed
 * only as a rule could never be evaluated where it needs to be evaluated.
 */

type Row = RowDataPacket & Record<string, unknown>

export type ScheduleStatus = 'draft' | 'armed' | 'applied' | 'cancelled'

export type ScheduleLine = {
  id: number
  productId: number
  code: string
  description: string
  priceStructureId: number
  structureName: string
  newPriceIncl: number
  oldPriceIncl: number | null
  origin: 'typed' | 'rule'
}

export type Schedule = {
  id: number
  name: string
  effectiveAt: string
  status: ScheduleStatus
  appliedAt: Date | null
  appliedCount: number
  note: string
  createdBy: string
  updatedBy: string
  lineCount: number
  /** How many lines would actually move a price, ignoring the no-ops. */
  changingCount: number
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }
export type ActionResult = { ok: true } | { ok: false; error: string }

/**
 * How far ahead a till is told about.
 *
 * A change further out than a fortnight does not need to be in every till's
 * IndexedDB — the catalogue syncs many times a day and will pick it up long
 * before it matters. This bounds what a shop that has queued next year's price
 * list makes every terminal carry.
 */
const LOOKAHEAD_DAYS = 14

/**
 * Past this many lines, a schedule is not shipped to the tills at all.
 *
 * A whole-catalogue change is 40 000 triples — well over a megabyte on top of a
 * catalogue that is already big. Rather than bloat every sync, an enormous
 * change is left to the tick: the tills pick it up on the reload that follows,
 * so it lands a few minutes late instead of on the minute. That is the right
 * trade for a change of that size, which is a repricing exercise rather than a
 * six-o'clock menu switch.
 */
const MAX_PENDING_LINES = 20_000

/** Give up after this many failed firings and say so, rather than churning. */
const MAX_FAILURES = 5

/**
 * Now, as the same wall-clock text the moments are stored in.
 *
 * Comparing two strings in this format is a correct chronological comparison,
 * and it keeps the timezone conversion that broke the specials windows once
 * from getting back in through a `new Date()`. Same shape as wallClockNow in
 * site/specials.ts and storefrontModel.ts.
 */
function wallClockNow(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}`
  )
}

/** The same text, N days out. Bounds what the tills are told about. */
function wallClockIn(days: number): string {
  const then = new Date()
  then.setDate(then.getDate() + days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${then.getFullYear()}-${pad(then.getMonth() + 1)}-${pad(then.getDate())}` +
    `T${pad(then.getHours())}:${pad(then.getMinutes())}`
  )
}

/* ── Reading ──────────────────────────────────────────────────────────────── */

const SELECT_SCHEDULE = `
  SELECT s.id, s.name, s.effective_at, s.status, s.applied_at, s.applied_count,
         s.note, s.created_by, s.updated_by,
         (SELECT COUNT(*) FROM price_schedule_lines l WHERE l.schedule_id = s.id) AS line_count,
         (SELECT COUNT(*) FROM price_schedule_lines l
           WHERE l.schedule_id = s.id
             AND (l.old_price_incl IS NULL OR l.old_price_incl <> l.new_price_incl)) AS changing_count
    FROM price_schedules s
`

function toSchedule(r: Row): Schedule {
  return {
    id: Number(r.id),
    name: String(r.name),
    effectiveAt: String(r.effective_at ?? ''),
    status: String(r.status) as ScheduleStatus,
    appliedAt: r.applied_at ? new Date(r.applied_at as string) : null,
    appliedCount: Number(r.applied_count ?? 0),
    note: String(r.note ?? ''),
    createdBy: String(r.created_by ?? ''),
    updatedBy: String(r.updated_by ?? ''),
    lineCount: Number(r.line_count ?? 0),
    changingCount: Number(r.changing_count ?? 0),
  }
}

export async function listSchedules(siteId: number): Promise<Schedule[]> {
  /*
   * Drafts and armed changes first, then history. A shop looking at this screen
   * is nearly always working on the next change, not reading the last one.
   */
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_SCHEDULE}
      ORDER BY FIELD(s.status, 'armed', 'draft', 'applied', 'cancelled'),
               s.effective_at DESC, s.id DESC`,
  )
  return rows.map(toSchedule)
}

export async function getSchedule(
  siteId: number,
  id: number,
): Promise<(Schedule & { lines: ScheduleLine[] }) | null> {
  const head = await siteQueryOne<Row>(siteId, `${SELECT_SCHEDULE} WHERE s.id = ?`, [id])
  if (!head) return null

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT l.id, l.product_id, l.price_structure_id, l.new_price_incl, l.old_price_incl,
            l.origin, p.code, p.description, ps.name AS structure_name
       FROM price_schedule_lines l
       JOIN products p ON p.id = l.product_id
       JOIN price_structures ps ON ps.id = l.price_structure_id
      WHERE l.schedule_id = ?
      ORDER BY p.description ASC, ps.position ASC`,
    [id],
  )

  return {
    ...toSchedule(head),
    lines: rows.map((r) => ({
      id: Number(r.id),
      productId: Number(r.product_id),
      code: String(r.code),
      description: String(r.description),
      priceStructureId: Number(r.price_structure_id),
      structureName: String(r.structure_name),
      newPriceIncl: toNum(r.new_price_incl),
      oldPriceIncl: r.old_price_incl === null ? null : toNum(r.old_price_incl),
      origin: String(r.origin) as 'typed' | 'rule',
    })),
  }
}

/* ── Building one ─────────────────────────────────────────────────────────── */

export type ScheduleInput = { name: string; effectiveAt: unknown }

export async function createSchedule(
  siteId: number,
  actor: Actor,
  input: ScheduleInput,
): Promise<SaveResult> {
  const name = String(input.name ?? '').trim()
  if (!name) return { ok: false, error: 'Give this price change a name.' }

  const result = await siteExecute(
    siteId,
    `INSERT INTO price_schedules (name, effective_at, created_by, updated_by)
     VALUES (?,?,?,?)`,
    [name.slice(0, 120), safeDateTime(input.effectiveAt), actor.userName, actor.userName],
  )
  const id = Number(result.insertId ?? 0)
  await logActivity(siteId, actor, {
    entity: 'price_schedule',
    entityId: id,
    action: 'create',
    detail: `Price change "${name}" started`,
  })
  return { ok: true, id }
}

export async function updateSchedule(
  siteId: number,
  actor: Actor,
  id: number,
  input: ScheduleInput,
): Promise<ActionResult> {
  const name = String(input.name ?? '').trim()
  if (!name) return { ok: false, error: 'Give this price change a name.' }

  // Only a draft may be edited. An armed change is already in the tills, and
  // moving its moment or its prices underneath them is how the two disagree.
  const current = await siteQueryOne<Row>(siteId, `SELECT status FROM price_schedules WHERE id = ?`, [id])
  if (!current) return { ok: false, error: 'That price change no longer exists.' }
  if (String(current.status) !== 'draft') {
    return { ok: false, error: 'Unschedule this change before editing it.' }
  }

  await siteExecute(
    siteId,
    `UPDATE price_schedules SET name = ?, effective_at = ?, updated_by = ? WHERE id = ?`,
    [name.slice(0, 120), safeDateTime(input.effectiveAt), actor.userName, id],
  )
  return { ok: true }
}

export async function deleteSchedule(siteId: number, actor: Actor, id: number): Promise<ActionResult> {
  const current = await siteQueryOne<Row>(
    siteId,
    `SELECT name, status FROM price_schedules WHERE id = ?`,
    [id],
  )
  if (!current) return { ok: true }
  /*
   * An APPLIED change is not deleted. Its lines are the only record of what the
   * prices used to be, and they are what "put these back" restores from —
   * throwing them away turns a reversible morning into a permanent one.
   */
  if (String(current.status) === 'applied') {
    return { ok: false, error: 'This change has already happened. It is kept so the prices can be put back.' }
  }

  await siteExecute(siteId, `DELETE FROM price_schedules WHERE id = ?`, [id])
  await logActivity(siteId, actor, {
    entity: 'price_schedule',
    entityId: id,
    action: 'delete',
    detail: `Price change "${String(current.name)}" deleted`,
  })
  return { ok: true }
}

/* ── Lines ────────────────────────────────────────────────────────────────── */

export type LineInput = {
  productId: number
  priceStructureId: number
  newPriceIncl: number
  origin?: 'typed' | 'rule'
}

/**
 * Put lines on a draft.
 *
 * Upserts on (product, price type), so adding a product that is already on the
 * list corrects its price rather than creating a second, contradictory answer.
 *
 * `old_price_incl` is read from product_prices in the same statement rather
 * than passed in: it is what the shop charges at the moment the line is built,
 * and a client that supplied it could claim any "before" it liked — which would
 * show the owner a rise that looks like a cut.
 */
export async function setScheduleLines(
  siteId: number,
  scheduleId: number,
  lines: readonly LineInput[],
): Promise<ActionResult> {
  if (lines.length === 0) return { ok: true }

  const guard = await requireDraft(siteId, scheduleId)
  if (!guard.ok) return guard

  /*
   * The "before" price is a correlated subquery inside the VALUES rather than a
   * value the caller supplies — see the note above. Written as one row template
   * so the placeholder count and the parameter order cannot drift apart.
   */
  const ROW = `(?, ?, ?, ?, ?,
                (SELECT pp.selling_price_incl FROM product_prices pp
                  WHERE pp.product_id = ? AND pp.price_structure_id = ?))`

  const BATCH = 500
  await siteTransaction(siteId, async (tx) => {
    for (let i = 0; i < lines.length; i += BATCH) {
      const slice = lines.slice(i, i + BATCH)
      const params: unknown[] = []
      for (const l of slice) {
        params.push(
          scheduleId,
          l.productId,
          l.priceStructureId,
          l.newPriceIncl.toFixed(4),
          l.origin ?? 'typed',
          l.productId,
          l.priceStructureId,
        )
      }
      await tx.execute(
        `INSERT INTO price_schedule_lines
           (schedule_id, product_id, price_structure_id, new_price_incl, origin, old_price_incl)
         VALUES ${slice.map(() => ROW).join(',')}
         ON DUPLICATE KEY UPDATE
           new_price_incl = VALUES(new_price_incl),
           old_price_incl = VALUES(old_price_incl),
           origin         = VALUES(origin)`,
        params as never,
      )
    }
  })
  return { ok: true }
}

export async function removeScheduleLine(
  siteId: number,
  scheduleId: number,
  lineId: number,
): Promise<ActionResult> {
  const guard = await requireDraft(siteId, scheduleId)
  if (!guard.ok) return guard
  await siteExecute(siteId, `DELETE FROM price_schedule_lines WHERE id = ? AND schedule_id = ?`, [
    lineId,
    scheduleId,
  ])
  return { ok: true }
}

export async function clearScheduleLines(siteId: number, scheduleId: number): Promise<ActionResult> {
  const guard = await requireDraft(siteId, scheduleId)
  if (!guard.ok) return guard
  await siteExecute(siteId, `DELETE FROM price_schedule_lines WHERE schedule_id = ?`, [scheduleId])
  return { ok: true }
}

async function requireDraft(siteId: number, scheduleId: number): Promise<ActionResult> {
  const row = await siteQueryOne<Row>(siteId, `SELECT status FROM price_schedules WHERE id = ?`, [
    scheduleId,
  ])
  if (!row) return { ok: false, error: 'That price change no longer exists.' }
  if (String(row.status) !== 'draft') {
    return { ok: false, error: 'Unschedule this change before editing its prices.' }
  }
  return { ok: true }
}

export type SeedScope = {
  priceStructureIds: number[]
  departmentIds?: number[]
  brandIds?: number[]
  includeArchived?: boolean
}

/**
 * Start from what the shop charges today.
 *
 * This is the primary way a change gets built: "take the menu I already have
 * and give it new pricing". Every current price in scope becomes a line whose
 * new price equals its old one, so the owner edits a list that already reads
 * like their menu instead of assembling one from nothing.
 *
 * Lines that are still untouched at arming are dropped, so seeding the whole
 * catalogue and changing four things schedules four changes — not 40 000
 * rewrites of the same number, which would bump every row's updated_at and send
 * every till in the shop into a full reload for nothing.
 */
export async function seedFromCurrent(
  siteId: number,
  scheduleId: number,
  scope: SeedScope,
): Promise<{ ok: true; added: number } | { ok: false; error: string }> {
  const guard = await requireDraft(siteId, scheduleId)
  if (!guard.ok) return guard
  if (scope.priceStructureIds.length === 0) {
    return { ok: false, error: 'Choose at least one price type.' }
  }

  const where: string[] = ['1 = 1']
  const params: unknown[] = []
  if (!scope.includeArchived) where.push('p.is_archived = 0')
  if (scope.departmentIds?.length) {
    where.push(`p.department_id IN (${scope.departmentIds.map(() => '?').join(',')})`)
    params.push(...scope.departmentIds)
  }
  if (scope.brandIds?.length) {
    where.push(`p.brand_id IN (${scope.brandIds.map(() => '?').join(',')})`)
    params.push(...scope.brandIds)
  }

  /*
   * A parent with variants never sells, so its price is not a price anybody
   * charges — putting it on the list would ask the owner to set a number that
   * does nothing. The variants themselves are ordinary products and are here.
   */
  where.push('p.has_variants = 0')

  const result = await siteExecute(
    siteId,
    `INSERT INTO price_schedule_lines
       (schedule_id, product_id, price_structure_id, new_price_incl, old_price_incl, origin)
     SELECT ?, p.id, pp.price_structure_id, pp.selling_price_incl, pp.selling_price_incl, 'typed'
       FROM products p
       JOIN product_prices pp ON pp.product_id = p.id
      WHERE ${where.join(' AND ')}
        AND pp.price_structure_id IN (${scope.priceStructureIds.map(() => '?').join(',')})
     ON DUPLICATE KEY UPDATE
       old_price_incl = VALUES(old_price_incl)`,
    [scheduleId, ...params, ...scope.priceStructureIds],
  )

  return { ok: true, added: Number(result.affectedRows ?? 0) }
}

/**
 * Expand a pricing rule into lines.
 *
 * Runs `planReprice` — the same planner the bulk reprice screen uses — so a
 * change scheduled for Monday and one applied on the spot cannot produce
 * different numbers from the same rule. The result is MATERIALISED here; see
 * the note at the top of this file on why firing does not re-plan.
 */
export async function addRuleLines(
  siteId: number,
  scheduleId: number,
  scope: RepriceScope,
  rule: RepriceRule,
): Promise<{ ok: true; added: number; skipped: number } | { ok: false; error: string }> {
  const guard = await requireDraft(siteId, scheduleId)
  if (!guard.ok) return guard

  const plan = await planReprice(siteId, scope, rule)
  const changing = plan.changes.filter((c) => c.changed)
  if (changing.length === 0) return { ok: true, added: 0, skipped: plan.skips.length }

  const written = await setScheduleLines(
    siteId,
    scheduleId,
    changing.map((c) => ({
      productId: c.productId,
      priceStructureId: scope.targetStructureId,
      newPriceIncl: c.newIncl,
      origin: 'rule' as const,
    })),
  )
  if (!written.ok) return written

  return { ok: true, added: changing.length, skipped: plan.skips.length }
}

/**
 * Lines whose "before" price no longer matches what the shop charges.
 *
 * A change built on Monday to fire on Friday can be overtaken by somebody
 * editing a price by hand on Wednesday. Applying it would silently undo that
 * edit, so the screen says which lines and how many.
 *
 * Deliberately does NOT block arming or firing: overwriting may be exactly what
 * the owner means, and a change that refuses to run on the morning it was
 * needed is worse than one that runs and was announced.
 */
export async function staleLines(siteId: number, scheduleId: number): Promise<ScheduleLine[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT l.id, l.product_id, l.price_structure_id, l.new_price_incl, l.old_price_incl,
            l.origin, p.code, p.description, ps.name AS structure_name,
            pp.selling_price_incl AS live_incl
       FROM price_schedule_lines l
       JOIN products p ON p.id = l.product_id
       JOIN price_structures ps ON ps.id = l.price_structure_id
       LEFT JOIN product_prices pp
              ON pp.product_id = l.product_id AND pp.price_structure_id = l.price_structure_id
      WHERE l.schedule_id = ?
        AND NOT (l.old_price_incl <=> pp.selling_price_incl)
      ORDER BY p.description ASC`,
    [scheduleId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    productId: Number(r.product_id),
    code: String(r.code),
    description: String(r.description),
    priceStructureId: Number(r.price_structure_id),
    structureName: String(r.structure_name),
    newPriceIncl: toNum(r.new_price_incl),
    oldPriceIncl: r.old_price_incl === null ? null : toNum(r.old_price_incl),
    origin: String(r.origin) as 'typed' | 'rule',
  }))
}

/** Re-read every line's "before" from the shop as it stands now. */
export async function refreshOldPrices(siteId: number, scheduleId: number): Promise<ActionResult> {
  const guard = await requireDraft(siteId, scheduleId)
  if (!guard.ok) return guard
  await siteExecute(
    siteId,
    `UPDATE price_schedule_lines l
       LEFT JOIN product_prices pp
              ON pp.product_id = l.product_id AND pp.price_structure_id = l.price_structure_id
        SET l.old_price_incl = pp.selling_price_incl
      WHERE l.schedule_id = ?`,
    [scheduleId],
  )
  return { ok: true }
}

/* ── Arming ───────────────────────────────────────────────────────────────── */

/**
 * Approve a change and hand it to the tills.
 *
 * Drops the lines that would not move anything first — a seeded list is mostly
 * unchanged prices, and writing them back would bump 40 000 rows' updated_at
 * and send every till into a full catalogue reload to achieve nothing.
 */
export async function armSchedule(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<ActionResult> {
  const schedule = await siteQueryOne<Row>(
    siteId,
    `SELECT name, effective_at, status FROM price_schedules WHERE id = ?`,
    [id],
  )
  if (!schedule) return { ok: false, error: 'That price change no longer exists.' }
  if (String(schedule.status) !== 'draft') {
    return { ok: false, error: 'This change is already scheduled.' }
  }

  const when = String(schedule.effective_at ?? '')
  if (!when) return { ok: false, error: 'Choose when this change should happen.' }
  if (when <= wallClockNow()) return { ok: false, error: 'Choose a time in the future.' }

  await siteExecute(
    siteId,
    `DELETE FROM price_schedule_lines
      WHERE schedule_id = ? AND old_price_incl IS NOT NULL AND old_price_incl = new_price_incl`,
    [id],
  )

  const remaining = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS n FROM price_schedule_lines WHERE schedule_id = ?`,
    [id],
  )
  const count = Number(remaining?.n ?? 0)
  if (count === 0) {
    return { ok: false, error: 'Nothing on this list changes a price yet.' }
  }

  await siteExecute(
    siteId,
    `UPDATE price_schedules SET status = 'armed', note = '', fail_count = 0, updated_by = ? WHERE id = ?`,
    [actor.userName, id],
  )
  await logActivity(siteId, actor, {
    entity: 'price_schedule',
    entityId: id,
    action: 'arm',
    detail: `"${String(schedule.name)}" scheduled for ${when} — ${count} price${count === 1 ? '' : 's'}`,
  })
  return { ok: true }
}

/** Take it back off the tills, so it can be edited again. */
export async function disarmSchedule(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<ActionResult> {
  const result = await siteExecute(
    siteId,
    `UPDATE price_schedules SET status = 'draft', updated_by = ? WHERE id = ? AND status = 'armed'`,
    [actor.userName, id],
  )
  if (Number(result.affectedRows ?? 0) === 0) {
    return { ok: false, error: 'This change is not scheduled.' }
  }
  await logActivity(siteId, actor, {
    entity: 'price_schedule',
    entityId: id,
    action: 'disarm',
    detail: 'Schedule cancelled before it happened',
  })
  return { ok: true }
}

/* ── What the tills are told ──────────────────────────────────────────────── */

/**
 * Every change a till should be carrying.
 *
 * ── SHIPPED WHOLE, MOMENTS UNEVALUATED ───────────────────────────────────
 *
 * Exactly as liveSpecials does, and for the same reason: the till re-checks
 * against its own clock, so a change at six lands on the minute on a catalogue
 * that was fetched at ten to — and on a till that has been off the network
 * since yesterday.
 *
 * Overdue-but-unapplied ones are INCLUDED. If the tick has not run, the shop
 * must still be selling at the new price; the till being right is the point of
 * this whole arrangement, and waiting for a cron would defeat it.
 */
export async function pendingSchedulesForTill(siteId: number): Promise<PendingSchedule[]> {
  const heads = await siteQuery<Row>(
    siteId,
    `SELECT s.id, s.name, s.effective_at,
            (SELECT COUNT(*) FROM price_schedule_lines l WHERE l.schedule_id = s.id) AS line_count
       FROM price_schedules s
      WHERE s.status = 'armed' AND s.effective_at <> '' AND s.effective_at <= ?
      ORDER BY s.effective_at ASC, s.id ASC`,
    [wallClockIn(LOOKAHEAD_DAYS)],
  )
  if (heads.length === 0) return []

  const shippable = heads.filter((h) => Number(h.line_count ?? 0) <= MAX_PENDING_LINES)
  if (shippable.length === 0) return []

  const ids = shippable.map((h) => Number(h.id))
  const lines = await siteQuery<Row>(
    siteId,
    `SELECT schedule_id, product_id, price_structure_id, new_price_incl
       FROM price_schedule_lines
      WHERE schedule_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )

  const bySchedule = new Map<number, PendingSchedule>()
  for (const h of shippable) {
    bySchedule.set(Number(h.id), {
      id: Number(h.id),
      name: String(h.name),
      effectiveAt: String(h.effective_at),
      lines: [],
    })
  }
  for (const l of lines) {
    bySchedule.get(Number(l.schedule_id))?.lines.push({
      productId: Number(l.product_id),
      priceStructureId: Number(l.price_structure_id),
      newPriceIncl: toNum(l.new_price_incl),
    })
  }
  return [...bySchedule.values()]
}

/**
 * Prices that are legitimately in force but not yet written.
 *
 * Between a till applying a change on its own clock and the tick writing it,
 * the till is right and product_prices is stale. Anything that re-reads a
 * shelf price in that window — the price guard, recalling a parked basket —
 * asks this so it agrees with the terminal in front of the customer.
 *
 * Bounded to changes already DUE. A future price is not yet a price anybody may
 * charge, or an operator could ring up next week's cheaper one today.
 */
export async function duePricesFor(
  siteId: number,
  priceStructureId: number | null,
  productIds: readonly number[],
): Promise<Map<number, number>> {
  if (priceStructureId === null || productIds.length === 0) return new Map()

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT l.product_id, l.new_price_incl
       FROM price_schedule_lines l
       JOIN price_schedules s ON s.id = l.schedule_id
      WHERE s.status = 'armed' AND s.effective_at <> '' AND s.effective_at <= ?
        AND l.price_structure_id = ?
        AND l.product_id IN (${productIds.map(() => '?').join(',')})
      ORDER BY s.effective_at ASC, s.id ASC`,
    [wallClockNow(), priceStructureId, ...productIds],
  )

  // Later schedules overwrite earlier ones — the same last-one-wins the till
  // applies, and the same order the tick writes them in.
  const out = new Map<number, number>()
  for (const r of rows) out.set(Number(r.product_id), toNum(r.new_price_incl))
  return out
}

/* ── Firing ───────────────────────────────────────────────────────────────── */

export type ApplySweep = { applied: number; skipped: number; prices: number }

/**
 * Apply every change whose moment has come.
 *
 * ── LATE IS FINE; EARLY IS NOT ───────────────────────────────────────────
 *
 * `effective_at <= now`, so a tick delayed by a missed run or a restart applies
 * everything that fell due while it was away. A price rise that never lands
 * costs money every minute it does not; one that lands four minutes late costs
 * nothing. Early would be the shop's pricing leaking before it meant to.
 *
 * One schedule failing must not stall the others — the same reasoning as the
 * per-site try/catch in the cron route, one level down.
 */
export async function applyDueSchedules(siteId: number): Promise<ApplySweep> {
  const now = wallClockNow()
  const due = await siteQuery<Row>(
    siteId,
    `SELECT id FROM price_schedules
      WHERE status = 'armed' AND effective_at <> '' AND effective_at <= ?
      ORDER BY effective_at ASC, id ASC`,
    [now],
  )

  let applied = 0
  let skipped = 0
  let prices = 0
  for (const row of due) {
    const id = Number(row.id)
    try {
      const result = await applyOneSchedule(siteId, id)
      /* Only what THIS sweep claimed. A change another tick took is neither
         applied by us nor skipped — it simply was not ours, and counting it
         would report two price changes where the shop saw one. */
      if (result.ok && result.claimed) {
        applied++
        prices += result.written
      } else if (!result.ok) {
        skipped++
      }
    } catch (error) {
      skipped++
      await noteFailure(siteId, id, error)
    }
  }
  return { applied, skipped, prices }
}

/**
 * Apply one, by hand or by tick.
 *
 * `claimed: false` means somebody else got there first — an overlapping tick,
 * or the Apply now button pressed while the cron was already mid-flight. That
 * is a normal outcome rather than an error: the change HAS been applied, just
 * not by this caller. Reported separately so a sweep does not count it as its
 * own work and tell the shop two changes happened when one did.
 */
export async function applyOneSchedule(
  siteId: number,
  id: number,
  actor: Actor = { userId: 0, userName: 'Scheduled' },
): Promise<{ ok: true; claimed: boolean; written: number } | { ok: false; error: string }> {
  let written = 0
  let claimed = false

  await siteTransaction(siteId, async (tx) => {
    /*
     * ── THE CLAIM ────────────────────────────────────────────────────────
     *
     * First statement in the transaction, and conditional. Two ticks that
     * overlap — a slow run and the next one five minutes later — would both
     * read status='armed' if this were a SELECT, and both would write every
     * price. The UPDATE lets exactly one through; the other sees no affected
     * rows and leaves without touching anything.
     */
    const claim = await tx.execute(
      `UPDATE price_schedules
          SET status = 'applied', applied_at = NOW()
        WHERE id = ? AND status = 'armed' AND applied_at IS NULL`,
      [id] as never,
    )
    if (Number((claim[0] as { affectedRows?: number }).affectedRows ?? 0) === 0) return
    claimed = true

    const [lineRows] = await tx.execute(
      `SELECT l.product_id, l.price_structure_id, l.new_price_incl
         FROM price_schedule_lines l
         LEFT JOIN product_prices pp
                ON pp.product_id = l.product_id AND pp.price_structure_id = l.price_structure_id
        WHERE l.schedule_id = ?
          AND NOT (pp.selling_price_incl <=> l.new_price_incl)`,
      [id] as never,
    )

    /*
     * Lines already at their target are filtered out above rather than written
     * anyway. Writing them would move product_prices.updated_at, which is the
     * signal every till watches to decide it needs a full catalogue reload —
     * so a change that alters nothing would still cost the shop a 40 000-row
     * download on every terminal at once.
     */
    const rows = (lineRows as Row[]).map((r) => ({
      productId: Number(r.product_id),
      priceStructureId: Number(r.price_structure_id),
      priceIncl: toNum(r.new_price_incl),
    }))

    if (rows.length > 0) {
      await writePriceRows(tx, rows, { source: 'schedule', sourceDocId: id, userName: 'Schedule' })
    }
    written = rows.length

    await tx.execute(`UPDATE price_schedules SET applied_count = ? WHERE id = ?`, [
      written,
      id,
    ] as never)

    const [nameRow] = await tx.execute(`SELECT name FROM price_schedules WHERE id = ?`, [
      id,
    ] as never)
    const name = String((nameRow as Row[])[0]?.name ?? '')

    /*
     * logActivityTx, not logActivity: the trail must live or die with the
     * write. A price change with no record of who or when — and this one's
     * "who" is a cron — is the kind of thing nobody can reconstruct later.
     */
    await logActivityTx(tx, actor, {
      entity: 'price_schedule',
      entityId: id,
      action: 'apply',
      detail: `"${name}" applied — ${written} price${written === 1 ? '' : 's'} changed`,
    })
  })

  return { ok: true, claimed, written }
}

/**
 * Record that a firing threw, and stop trying after a few.
 *
 * A schedule that cannot succeed — a price type deleted under it, a database
 * that keeps refusing — would otherwise be retried every five minutes forever,
 * which is load nobody wanted and a log nobody reads. Cancelling it with a note
 * puts it on the screen instead, where somebody can see what happened.
 */
async function noteFailure(siteId: number, id: number, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : 'Unknown error'
  try {
    await siteExecute(
      siteId,
      `UPDATE price_schedules
          SET fail_count = fail_count + 1,
              note = ?,
              status = IF(fail_count + 1 >= ?, 'cancelled', status)
        WHERE id = ?`,
      [message.slice(0, 400), MAX_FAILURES, id],
    )
  } catch (e) {
    console.error('price schedule failure could not be recorded', e)
  }
}

/* ── Putting it back ──────────────────────────────────────────────────────── */

/**
 * Restore the prices a change replaced.
 *
 * ── WHAT IT REFUSES TO TOUCH ─────────────────────────────────────────────
 *
 * Lines whose current price is no longer the one this change wrote have been
 * edited by hand since. Restoring those would quietly undo somebody else's
 * work, so they are left alone and counted.
 *
 * A line with no "before" had no price under that type at all, so its row is
 * DELETED rather than set to zero. Zero is a price, and a shop that gave
 * everything away because an undo wrote 0.00 would have a bad morning.
 */
export async function revertSchedule(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<{ ok: true; restored: number; skipped: number } | { ok: false; error: string }> {
  const schedule = await siteQueryOne<Row>(
    siteId,
    `SELECT name, status FROM price_schedules WHERE id = ?`,
    [id],
  )
  if (!schedule) return { ok: false, error: 'That price change no longer exists.' }
  if (String(schedule.status) !== 'applied') {
    return { ok: false, error: 'This change has not happened yet.' }
  }

  let restored = 0
  let skipped = 0

  await siteTransaction(siteId, async (tx) => {
    const [rows] = await tx.execute(
      `SELECT l.product_id, l.price_structure_id, l.old_price_incl,
              pp.selling_price_incl AS live_incl, l.new_price_incl
         FROM price_schedule_lines l
         LEFT JOIN product_prices pp
                ON pp.product_id = l.product_id AND pp.price_structure_id = l.price_structure_id
        WHERE l.schedule_id = ?`,
      [id] as never,
    )

    const toWrite: { productId: number; priceStructureId: number; priceIncl: number }[] = []
    const toDelete: { productId: number; priceStructureId: number }[] = []

    for (const r of rows as Row[]) {
      const live = r.live_incl === null ? null : toNum(r.live_incl)
      const wrote = toNum(r.new_price_incl)
      // Somebody has changed it since. Not ours to put back.
      if (live === null || Math.abs(live - wrote) > 0.0001) {
        skipped++
        continue
      }
      const old = r.old_price_incl === null ? null : toNum(r.old_price_incl)
      if (old === null) {
        toDelete.push({
          productId: Number(r.product_id),
          priceStructureId: Number(r.price_structure_id),
        })
      } else {
        toWrite.push({
          productId: Number(r.product_id),
          priceStructureId: Number(r.price_structure_id),
          priceIncl: old,
        })
      }
      restored++
    }

    if (toWrite.length > 0) {
      await writePriceRows(tx, toWrite, {
        source: 'revert',
        sourceDocId: id,
        userName: actor.userName,
      })
    }
    for (const d of toDelete) {
      await tx.execute(
        `DELETE FROM product_prices WHERE product_id = ? AND price_structure_id = ?`,
        [d.productId, d.priceStructureId] as never,
      )
    }
    // A deletion is a price event too — the panel renders NULL as "removed".
    if (toDelete.length > 0) {
      const wroteBy = new Map(
        (rows as Row[]).map((r) => [
          `${r.product_id}:${r.price_structure_id}`,
          toNum(r.new_price_incl),
        ]),
      )
      await recordPriceRemoval(
        tx,
        toDelete.map((d) => ({
          productId: d.productId,
          priceStructureId: d.priceStructureId,
          oldPriceIncl: wroteBy.get(`${d.productId}:${d.priceStructureId}`) ?? 0,
        })),
        { source: 'revert', sourceDocId: id, userName: actor.userName },
      )
    }

    await tx.execute(
      `UPDATE price_schedules SET status = 'cancelled', note = ?, updated_by = ? WHERE id = ?`,
      [`Put back by ${actor.userName}`.slice(0, 400), actor.userName, id] as never,
    )

    await logActivityTx(tx, actor, {
      entity: 'price_schedule',
      entityId: id,
      action: 'revert',
      detail: `"${String(schedule.name)}" put back — ${restored} restored, ${skipped} left alone`,
    })
  })

  return { ok: true, restored, skipped }
}
