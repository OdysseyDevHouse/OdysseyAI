import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'
import {
  computeSpecials,
  COMBO_MODES,
  SPECIAL_TYPES,
  type Special,
  type SpecialItem,
  type ComboMode,
  type SpecialType,
  validateSpecial,
  type SpecialInput,
  type SpecialItemInput,
  type SpecialRole,
} from '../specialsEngine'

/**
 * Reading and writing specials.
 *
 * The arithmetic lives in lib/specialsEngine.ts, which is pure — this module
 * only loads rows and validates what a screen sends. Keeping them apart is
 * what lets the till, the storefront and the tests all agree about what a
 * basket is entitled to.
 */

type Row = RowDataPacket & Record<string, unknown>

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }
export type ActionResult = { ok: true } | { ok: false; error: string }

/** Long enough to describe a deal, short enough to fit a column on a list. */
const NAME_MAX = 100

function mapSpecial(r: Row, items: SpecialItem[]): Special {
  const type = String(r.type)
  const mode = String(r.combo_mode ?? '')
  return {
    id: Number(r.id),
    name: String(r.name),
    // Coerced rather than trusted: one row written by a future version must
    // not take down every till that reads it.
    type: (SPECIAL_TYPES as readonly string[]).includes(type) ? (type as SpecialType) : 'happy_hour',
    comboMode: (COMBO_MODES as readonly string[]).includes(mode) ? (mode as ComboMode) : '',
    isActive: !!r.is_active,
    // Already the wall-clock text a shopkeeper typed — see 057's note on why
    // these are not DATETIME columns.
    startsAt: String(r.starts_at ?? ''),
    endsAt: String(r.ends_at ?? ''),
    dailyStart: String(r.daily_start ?? ''),
    dailyEnd: String(r.daily_end ?? ''),
    daysOfWeek: /^[01]{7}$/.test(String(r.days_of_week)) ? String(r.days_of_week) : '1111111',
    discountPct: toNum(r.discount_pct),
    appliesToAll: !!r.applies_to_all,
    triggerQty: Number(r.trigger_qty ?? 0),
    bundlePriceIncl: toNum(r.bundle_price_incl),
    spendAmountIncl: toNum(r.spend_amount_incl),
    // A row written before priorities existed sorts by its id instead, which
    // is at least stable and matches the order it was created in.
    priority: Number(r.priority) || Number(r.id),
    items,
  }
}

function mapItem(r: Row): SpecialItem {
  const role = String(r.role)
  return {
    role: (['scope', 'trigger', 'reward'] as const).includes(role as SpecialRole)
      ? (role as SpecialRole)
      : 'scope',
    productId: r.product_id === null ? null : Number(r.product_id),
    departmentId: r.department_id === null ? null : Number(r.department_id),
    qty: toNum(r.qty) || 1,
    priceIncl: toNum(r.price_incl),
  }
}

/** Every special, in firing order. Includes the switched-off ones. */
export async function listSpecials(siteId: number): Promise<Special[]> {
  const [specials, items] = await Promise.all([
    siteQuery<Row>(siteId, `SELECT * FROM specials ORDER BY priority, id`),
    siteQuery<Row>(siteId, `SELECT * FROM special_items ORDER BY id`),
  ])

  const bySpecial = new Map<number, SpecialItem[]>()
  for (const row of items) {
    const id = Number(row.special_id)
    const list = bySpecial.get(id) ?? []
    list.push(mapItem(row))
    bySpecial.set(id, list)
  }

  return specials.map((r) => mapSpecial(r, bySpecial.get(Number(r.id)) ?? []))
}

/**
 * The specials worth sending to a till or a storefront.
 *
 * Filtered only on "switched on and not finished". The daily band and the day
 * mask are deliberately NOT applied here — they are evaluated against the
 * clock at the moment of pricing, so a till that cached its catalogue at ten
 * to five still starts the five o'clock happy hour on time.
 *
 * Future specials are included for the same reason.
 */
export async function liveSpecials(siteId: number): Promise<Special[]> {
  const all = await listSpecials(siteId)
  /*
   * Compared as TEXT, not as dates. 'YYYY-MM-DDTHH:mm' sorts correctly, and
   * parsing would drag the timezone problem back in through the side door.
   */
  return all.filter((s) => s.isActive && s.endsAt >= wallClockNow())
}

/**
 * Now, as the same wall-clock text the windows are stored in.
 *
 * Comparing two strings in this format is a correct chronological comparison,
 * and it keeps the timezone conversion that broke these windows once from
 * getting back in through a `new Date()`.
 */
function wallClockNow(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}`
  )
}

/**
 * What a single unit of a product costs right now, given the live specials.
 *
 * ── ONLY THE TYPES THAT MEAN SOMETHING FOR ONE UNIT ─────────────────────
 *
 * A shelf price can only show a straight discount or a marked-down price.
 * "Buy three, cheapest free" tells a shopper nothing about what ONE costs, and
 * striking through a price it does not actually reduce would be a lie — so
 * combos are excluded here and simply apply at the till.
 *
 * ── THE SHOP AND THE ORDER USE THIS SAME FUNCTION ────────────────────────
 *
 * Which is the point: there is no second pricing path for the displayed price
 * to drift away from.
 */
export function specialPriceFor(
  line: { productId: number; departmentId: number | null; priceIncl: number },
  specials: Special[],
  now: Date,
): { priceIncl: number; wasPriceIncl: number; specialId: number; name: string } | null {
  const singleUnit = specials.filter(
    (s) => s.type === 'happy_hour' || s.type === 'special_price',
  )
  if (singleUnit.length === 0) return null

  const { lineSpecials } = computeSpecials(
    [{ ...line, qty: 1 }],
    singleUnit,
    now,
  )
  const applied = lineSpecials[0]
  if (!applied) return null

  const discounted = Math.round(line.priceIncl * (1 - applied.pct / 100) * 100) / 100
  // A "discount" that raises the price, or takes it to nothing, is a
  // misconfiguration rather than a deal.
  if (!(discounted > 0) || discounted >= line.priceIncl) return null

  return {
    priceIncl: discounted,
    wasPriceIncl: line.priceIncl,
    specialId: applied.specialId,
    name: applied.name,
  }
}

/**
 * What every line of a basket is entitled to, ready for the till.
 *
 * ── ONE CALL, SO THE TILL AND INVOICING CANNOT DISAGREE ──────────────────
 *
 * Both screens price the same basket the same way. Each doing its own load and
 * its own `computeSpecials` would be two chances to drift, and the drift would
 * only show up as a customer being charged one price on a slip and another on
 * an invoice for the same goods.
 *
 * Returns the discount as a PERCENTAGE per line, plus the special that caused
 * it, so the caller can write both to the sale line.
 */
export async function priceBasket(
  siteId: number,
  lines: { productId: number; departmentId: number | null; priceIncl: number; qty: number }[],
): Promise<{
  lines: { discountPct: number; specialId: number | null; specialName: string | null }[]
  rewards: { productId: number; qty: number; specialId: number; name: string }[]
}> {
  if (lines.length === 0) return { lines: [], rewards: [] }

  const specials = await liveSpecials(siteId)
  if (specials.length === 0) {
    return {
      lines: lines.map(() => ({ discountPct: 0, specialId: null, specialName: null })),
      rewards: [],
    }
  }

  const { lineSpecials, rewards } = computeSpecials(lines, specials, new Date())

  return {
    lines: lineSpecials.map((applied) => ({
      discountPct: applied?.pct ?? 0,
      specialId: applied?.specialId ?? null,
      specialName: applied?.name ?? null,
    })),
    rewards: rewards.map((r) => ({
      productId: r.productId,
      qty: r.qty,
      specialId: r.specialId,
      name: r.name,
    })),
  }
}

/**
 * Every special's items, resolved to what a person would recognise.
 *
 * The rows themselves hold ids. A form needs the NAME to show and the CURRENT
 * price to work a discount against — and looking those up per row would be a
 * query per item across every special on the screen, so they are fetched in
 * two passes and joined in memory.
 */
export type ResolvedItem = {
  specialId: number
  role: SpecialRole
  productId: number | null
  departmentId: number | null
  qty: number
  priceIncl: number
  /** "CODE · Description", or the department's name. */
  label: string
  /** The shelf price today. Undefined for a department — it has no one price. */
  currentPrice?: number
}

export async function resolveSpecialItems(siteId: number): Promise<ResolvedItem[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT si.*,
            p.code AS product_code, p.description AS product_description,
            d.name AS department_name,
            (SELECT pp.selling_price_incl FROM product_prices pp
              JOIN price_structures ps ON ps.id = pp.price_structure_id
             WHERE pp.product_id = si.product_id
             ORDER BY ps.is_default DESC, ps.id LIMIT 1) AS selling_incl
       FROM special_items si
       LEFT JOIN products p    ON p.id = si.product_id
       LEFT JOIN departments d ON d.id = si.department_id
      ORDER BY si.id`,
  )

  return rows.map((r) => {
    const price = toNum(r.selling_incl)
    return {
      specialId: Number(r.special_id),
      role: String(r.role) as SpecialRole,
      productId: r.product_id === null ? null : Number(r.product_id),
      departmentId: r.department_id === null ? null : Number(r.department_id),
      qty: toNum(r.qty) || 1,
      priceIncl: toNum(r.price_incl),
      label:
        r.product_id !== null
          ? `${String(r.product_code ?? '')} · ${String(r.product_description ?? '')}`
          : String(r.department_name ?? `Department ${r.department_id}`),
      currentPrice: price > 0 ? price : undefined,
    }
  })
}

/* ── What a screen may send ───────────────────────────────────────────────── */

// The input shapes and their validation live in the pure engine, so the FORM
// can run the same checks the server does without importing this module.
export type { SpecialInput, SpecialItemInput } from '../specialsEngine'
export { validateSpecial }

/**
 * Only the rows this shape actually uses.
 *
 * Rows for the other roles are dropped on save rather than stored — a combo
 * carrying a leftover "scope" row from when it was a happy hour is a row
 * nothing reads and the next person has to puzzle over.
 */
function itemsFor(input: SpecialInput): SpecialItemInput[] {
  const keep: SpecialRole[] =
    input.type === 'happy_hour' || input.type === 'special_price'
      ? ['scope']
      : input.type === 'spend'
        ? ['reward']
        : input.comboMode === 'free_item'
          ? ['trigger', 'reward']
          : ['trigger']

  return input.items
    .filter((i) => keep.includes(i.role))
    // A row naming neither a product nor a department matches nothing, so it
    // would sit in the table doing nothing but confusing the next reader.
    .filter((i) => i.productId !== null || i.departmentId !== null)
}

export async function saveSpecial(
  siteId: number,
  input: SpecialInput,
  updatedBy: string,
): Promise<SaveResult> {
  const problem = validateSpecial(input)
  if (problem) return { ok: false, error: problem }

  const items = itemsFor(input)

  return siteTransaction(siteId, async (tx) => {
    let id = input.id ?? 0

    const fields = [
      input.name.trim().slice(0, NAME_MAX),
      input.type,
      // Blank unless it IS a combo, so a leftover mode cannot make a happy
      // hour behave like one.
      input.type === 'combo' ? input.comboMode : '',
      input.isActive ? 1 : 0,
      input.startsAt.trim(),
      input.endsAt.trim(),
      input.dailyStart.trim(),
      input.dailyEnd.trim(),
      input.daysOfWeek,
      input.discountPct.toFixed(3),
      input.appliesToAll ? 1 : 0,
      Math.max(0, Math.floor(input.triggerQty)),
      input.bundlePriceIncl.toFixed(4),
      input.spendAmountIncl.toFixed(4),
      updatedBy.slice(0, 120),
    ]

    if (id) {
      await tx.query(
        `UPDATE specials
            SET name = ?, type = ?, combo_mode = ?, is_active = ?, starts_at = ?, ends_at = ?,
                daily_start = ?, daily_end = ?, days_of_week = ?, discount_pct = ?,
                applies_to_all = ?, trigger_qty = ?, bundle_price_incl = ?,
                spend_amount_incl = ?, updated_by = ?
          WHERE id = ?`,
        [...fields, id],
      )
    } else {
      // A new special goes to the BOTTOM of the list. Inserting it at the top
      // would silently outrank every promotion already running.
      const [maxRow] = await tx.query<Row[]>(`SELECT COALESCE(MAX(priority), 0) AS p FROM specials`)
      const nextPriority = Number(maxRow[0]?.p ?? 0) + 1

      const [result] = await tx.query<import('mysql2').ResultSetHeader>(
        `INSERT INTO specials
           (name, type, combo_mode, is_active, starts_at, ends_at, daily_start, daily_end,
            days_of_week, discount_pct, applies_to_all, trigger_qty,
            bundle_price_incl, spend_amount_incl, updated_by, priority)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [...fields, nextPriority],
      )
      id = result.insertId
    }

    /*
     * Replace the items wholesale rather than diffing them.
     *
     * A special's scope is small and edited as a set — working out which rows
     * moved would be more code than rewriting three of them, and a diff that
     * gets it wrong leaves a product in a promotion nobody can see.
     */
    await tx.query(`DELETE FROM special_items WHERE special_id = ?`, [id])
    for (const item of items) {
      await tx.query(
        `INSERT INTO special_items (special_id, role, product_id, department_id, qty, price_incl)
         VALUES (?,?,?,?,?,?)`,
        [
          id,
          item.role,
          item.productId,
          item.departmentId,
          Math.max(item.qty, 1).toFixed(3),
          Math.max(item.priceIncl, 0).toFixed(4),
        ],
      )
    }

    return { ok: true as const, id }
  })
}

export async function deleteSpecial(siteId: number, id: number): Promise<ActionResult> {
  // The items go with it via ON DELETE CASCADE; any sale line that recorded it
  // keeps its discount and simply forgets which special caused it.
  await siteExecute(siteId, `DELETE FROM specials WHERE id = ?`, [id])
  return { ok: true }
}

export async function setSpecialActive(
  siteId: number,
  id: number,
  active: boolean,
): Promise<ActionResult> {
  await siteExecute(siteId, `UPDATE specials SET is_active = ? WHERE id = ?`, [active ? 1 : 0, id])
  return { ok: true }
}

/**
 * Put the specials in this firing order.
 *
 * Ids the caller omitted are appended rather than dropped, and ids this shop
 * does not own are ignored — a stale browser tab must not be able to remove a
 * promotion from the list by not knowing about it.
 */
export async function reorderSpecials(siteId: number, ids: number[]): Promise<ActionResult> {
  const existing = await listSpecials(siteId)
  const known = new Set(existing.map((s) => s.id))
  const ordered = ids.filter((id) => known.has(id))
  for (const s of existing) if (!ordered.includes(s.id)) ordered.push(s.id)

  await siteTransaction(siteId, async (tx) => {
    for (const [index, id] of ordered.entries()) {
      await tx.query(`UPDATE specials SET priority = ? WHERE id = ?`, [index + 1, id])
    }
  })
  return { ok: true }
}
