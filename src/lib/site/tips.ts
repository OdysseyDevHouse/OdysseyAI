import 'server-only'
import type { PoolConnection } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { round, toNum } from '../decimals'
import { splitOverTender, serviceChargeFor, tipsInDrawer, type ServiceTier } from '../tipMath'
import { getSetting } from './settings'
import type { Actor } from './activityLog'

/**
 * Tips, on the server.
 *
 * ── WHERE A TIP SITS IN A FINALISE ────────────────────────────────────────
 *
 * `finaliseDocument` already allocates CHANGE per tender against `allows_change`:
 *
 *     let remainingChange = check.change
 *     for (const tender of tenders) { changeHere = min(remainingChange, amount) ... }
 *
 * A tip is the OTHER claim on that same excess, which makes the ordering the whole
 * problem. Decide tips FIRST, subtract them, and let change divide what is left —
 * otherwise the same R20 is recorded once as change and once as a tip, the drawer is
 * expected to hold it twice, and every cash-up with a tip reads short by exactly the tip.
 *
 * `planTips` therefore takes the tenders and the total excess and returns both halves:
 * the tips to write, and the change that remains to be allocated. `finaliseDocument`'s
 * existing loop then runs unchanged against the reduced figure.
 *
 * ── NO VAT, ANYWHERE IN THIS FILE ─────────────────────────────────────────
 *
 * A gratuity is not consideration for goods. Nothing here touches a document total, and
 * `assertBalanced` would catch it if it did.
 */

type Row = RowDataPacket & Record<string, unknown>

export type TipSource = 'over_tender' | 'declared' | 'service' | 'manual'

/** A tip to be written, as `planTips` works it out. */
export type PlannedTip = {
  tenderTypeId: number
  amount: number
  source: TipSource
}

/** What the caller needs for one tender to decide whether its excess is a tip. */
export type TenderForTips = {
  tenderTypeId: number
  /** Gross, as handed over. */
  amount: number
  allowsChange: boolean
  tipOnOverTender: boolean
  /** Only for the refusal message. */
  tenderName: string
}

export type TipPlan =
  | {
      ok: true
      tips: PlannedTip[]
      /** What `finaliseDocument` should allocate as change, after tips are taken. */
      changeRemaining: number
    }
  | { ok: false; error: string }

/**
 * Splits an over-tender into tips and change.
 *
 * ── THE ORDER OF THE THREE CLAIMS ─────────────────────────────────────────
 *
 * 1. A DECLARED tip is honoured first. Somebody looked at the money and said so, which
 *    beats any inference — and it is the only source that can take a tip out of a tender
 *    that gives change.
 * 2. An OVER-TENDER tip on a no-change tender takes what is left of its own excess.
 * 3. Whatever remains is CHANGE.
 *
 * A no-change tender whose excess is neither declared nor tippable is an ERROR, not a
 * windfall: keeping a mis-keyed R20 because the customer cannot be given change is theft
 * by typo, and refusing it at the pad costs one correction.
 */
export function planTips(input: {
  /** `check.change` — the whole excess over what was owed. */
  totalExcess: number
  tenders: readonly TenderForTips[]
  /**
   * Tips a person declared at the pad, per tender.
   *
   * Keyed by tender type rather than positional, because a basket may hold two payments
   * on the same method and a declared tip belongs to the METHOD — which is all the tip
   * row records.
   */
  declared?: Record<number, number>
  /** From a service-charge tier, already computed. Not tied to one tender. */
  serviceCharge?: { tenderTypeId: number; amount: number } | null
}): TipPlan {
  const excess = round(Math.max(0, input.totalExcess), 2)
  const tips: PlannedTip[] = []
  let left = excess

  /* A service charge is not taken out of the excess — it was added to what the customer
     owed BEFORE they paid, so it is already inside the bill they settled. It is recorded
     as a tip because that is what it is, but it does not compete for the change. */
  if (input.serviceCharge && input.serviceCharge.amount > 0.005) {
    tips.push({
      tenderTypeId: input.serviceCharge.tenderTypeId,
      amount: round(input.serviceCharge.amount, 2),
      source: 'service',
    })
  }

  // 1. Declared tips, per tender, clamped to what is actually spare.
  for (const tender of input.tenders) {
    const wanted = round(Math.max(0, input.declared?.[tender.tenderTypeId] ?? 0), 2)
    if (wanted <= 0.005) continue
    const take = round(Math.min(wanted, left), 2)
    if (take <= 0.005) continue
    tips.push({ tenderTypeId: tender.tenderTypeId, amount: take, source: 'declared' })
    left = round(left - take, 2)
  }

  /* 2. Over-tender tips. Per tender, and bounded by BOTH what that tender paid over and
        what is still unclaimed — a tender cannot tip more than it handed over, and two
        tenders cannot each claim the same remaining rand. */
  for (const tender of input.tenders) {
    if (left <= 0.005) break
    const own = round(Math.max(0, tender.amount), 2)
    const outcome = splitOverTender(0, Math.min(own, left), {
      allowsChange: tender.allowsChange,
      tipOnOverTender: tender.tipOnOverTender,
      tipInDrawer: true,
    })
    if (outcome.kind === 'tip' && outcome.amount > 0.005) {
      tips.push({ tenderTypeId: tender.tenderTypeId, amount: outcome.amount, source: 'over_tender' })
      left = round(left - outcome.amount, 2)
      continue
    }
    if (outcome.kind === 'refuse' && outcome.amount > 0.005) {
      return {
        ok: false,
        error: `${tender.tenderName} was paid over by ${outcome.amount.toFixed(2)}, and it cannot give change or take a tip. Correct the amount, or turn on tips for ${tender.tenderName}.`,
      }
    }
  }

  return { ok: true, tips, changeRemaining: left }
}

/* ── Writing them ────────────────────────────────────────────────────────── */

/**
 * Writes the planned tips, INSIDE the caller's transaction.
 *
 * Takes a connection rather than opening its own, which is the whole point: a tip written
 * in a second transaction can be orphaned by a rollback of the first, leaving money
 * recorded against a sale that does not exist — or worse, a sale with no record of the
 * tip that was taken with it.
 *
 * `user_id` is whoever the SALE is attributed to. That is the waiter who served the table,
 * which is what per-person attribution means here; `original_user_id` is stamped with the
 * same value so a later reassignment can always name who it came from.
 */
export async function writeTips(
  tx: PoolConnection,
  input: {
    documentId: number
    shiftId: number | null
    userId: number | null
    userName: string
    tips: readonly PlannedTip[]
  },
): Promise<void> {
  for (const tip of input.tips) {
    if (tip.amount <= 0.005) continue
    await tx.execute(
      `INSERT INTO sales_tips
         (document_id, tender_type_id, shift_id, amount, source,
          user_id, user_name, original_user_id)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        input.documentId,
        tip.tenderTypeId,
        input.shiftId,
        round(tip.amount, 2).toFixed(4),
        tip.source,
        input.userId,
        input.userName.slice(0, 120),
        input.userId,
      ] as never,
    )
  }
}

/* ── Reading them ────────────────────────────────────────────────────────── */

export type ShiftTip = {
  id: number
  documentId: number
  amount: number
  source: TipSource
  tenderName: string
  tipInDrawer: boolean
  userId: number | null
  userName: string
}

/**
 * A shift's tips, with the flag cash-up needs.
 *
 * `tip_in_drawer` is joined from the tender type rather than copied onto the tip row, so a
 * shop that corrects the flag fixes its NEXT cash-up rather than rewriting history it
 * cannot see. That is the right trade here: the flag describes where the money goes, which
 * is a property of the method and not of one tip.
 */
export async function tipsForShift(siteId: number, shiftId: number): Promise<ShiftTip[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT t.id, t.document_id, t.amount, t.source, t.user_id, t.user_name,
            tt.name AS tender_name, tt.tip_in_drawer
       FROM sales_tips t
       JOIN tender_types tt ON tt.id = t.tender_type_id
       /* Finalised only, exactly as closeShift's tender sum is: a voided sale keeps its
          rows as history, but the money went back over the counter. */
       JOIN sales_documents d ON d.id = t.document_id AND d.status = 'finalised'
      WHERE t.shift_id = ?
      ORDER BY t.id`,
    [shiftId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    documentId: Number(r.document_id),
    amount: toNum(r.amount),
    source: String(r.source) as TipSource,
    tenderName: String(r.tender_name ?? ''),
    tipInDrawer: !!r.tip_in_drawer,
    userId: r.user_id === null ? null : Number(r.user_id),
    userName: String(r.user_name ?? ''),
  }))
}

/**
 * How much of a shift's tips the drawer should contain.
 *
 * The one number `closeShift` needs. A cash tip is in the till and must be expected; a
 * card or account tip is not. See tipMath.tipsInDrawer for why this is per tender rather
 * than a global setting.
 */
export async function expectedTipsInDrawer(siteId: number, shiftId: number): Promise<number> {
  return tipsInDrawer(await tipsForShift(siteId, shiftId))
}

/* ── Service-charge tiers ────────────────────────────────────────────────── */

export async function listServiceTiers(siteId: number): Promise<(ServiceTier & { id: number })[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, min_total, max_total, percent, is_active
       FROM service_charge_tiers ORDER BY min_total`,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    minTotal: toNum(r.min_total),
    maxTotal: r.max_total === null ? null : toNum(r.max_total),
    percent: toNum(r.percent),
    isActive: !!r.is_active,
  }))
}

/**
 * The service charge a bill earns.
 *
 * `tips_tables_only` defaults to ON, so a retail basket never earns one — a service charge
 * on a R600 takeaway is a charge a customer did not expect and did not agree to. A shop
 * with no tables at all therefore never sees the feature.
 */
export async function serviceChargeForBill(
  siteId: number,
  input: { total: number; hasTable: boolean },
): Promise<number> {
  /* Through `getSetting`, not hand-written SQL. My first version selected `value` from
     `key` — the columns are `setting_value` and `setting_key`, so it would have thrown on
     every bill. The helper also applies whatever defaulting the rest of the app does. */
  const stored = await getSetting(siteId, 'tips_tables_only')
  /* Absent means ON. A shop that has never touched the setting must not have service
     charges appear on its counter sales the moment tiers are configured. */
  const tablesOnly = stored === null || stored === undefined ? true : String(stored) !== '0'
  if (tablesOnly && !input.hasTable) return 0

  return serviceChargeFor(input.total, await listServiceTiers(siteId))
}

/* ── Reassignment ────────────────────────────────────────────────────────── */

export type ReassignResult = { ok: true } | { ok: false; error: string }

/**
 * Moves a tip to another person, or to the pool.
 *
 * `toUserId: null` IS the pool — there is no separate flag to disagree with it.
 *
 * The trail is the point. Per-person attribution is worth nothing if a tip can be moved
 * off somebody quietly, so the original owner, who moved it, when, and why are all kept.
 * `original_user_id` is written only if it is not already set, so a tip moved twice still
 * names the person it started with rather than the last holder.
 */
export async function reassignTip(
  siteId: number,
  actor: Actor,
  input: {
    tipId: number
    toUserId: number | null
    toUserName: string
    reason: string
  },
): Promise<ReassignResult> {
  if (!input.reason.trim()) {
    return { ok: false, error: 'Say why this tip is being moved.' }
  }

  const tip = await siteQueryOne<Row>(
    siteId,
    'SELECT id, user_id, original_user_id FROM sales_tips WHERE id = ?',
    [input.tipId],
  )
  if (!tip) return { ok: false, error: 'That tip no longer exists.' }

  await siteExecute(
    siteId,
    `UPDATE sales_tips
        SET user_id = ?,
            user_name = ?,
            original_user_id = COALESCE(original_user_id, ?),
            reassigned_by = ?,
            reassigned_by_name = ?,
            reassigned_at = NOW(),
            reassign_reason = ?
      WHERE id = ?`,
    [
      input.toUserId,
      input.toUserName.slice(0, 120),
      tip.user_id === null ? null : Number(tip.user_id),
      actor.userId,
      actor.userName.slice(0, 120),
      input.reason.trim().slice(0, 200),
      input.tipId,
    ],
  )
  return { ok: true }
}

/**
 * Records that a forced service charge was removed.
 *
 * A service charge cannot be removed by a waiter, but it CAN by somebody holding
 * `sales.discount_override` — because the alternative is a bill nobody in the building can
 * correct in front of a customer who has refused it, or a tier that fired on a mis-keyed
 * amount. Recorded rather than silent, which is what makes the policy enforceable: a shop
 * can see who removes them and how often.
 */
export async function recordServiceChargeRemoval(
  siteId: number,
  actor: Actor,
  input: { documentId: number | null; amount: number; reason: string },
): Promise<void> {
  await siteExecute(
    siteId,
    `INSERT INTO service_charge_removals (document_id, amount, user_id, user_name, reason)
     VALUES (?,?,?,?,?)`,
    [
      input.documentId,
      round(Math.abs(input.amount), 2).toFixed(4),
      actor.userId,
      actor.userName.slice(0, 120),
      input.reason.trim().slice(0, 200),
    ],
  )
}

/* ── What each person is owed ────────────────────────────────────────────── */

export type TipsOwed = {
  userId: number | null
  userName: string
  total: number
  count: number
}

/**
 * Tips by person over a date range, for the report a manager pays out from.
 *
 * The POOL comes back as a row with `userId: null` rather than being omitted — a manager
 * dividing the pool needs to see its size, and a report that silently dropped it would
 * make pooled tips look like money that had evaporated.
 */
export async function tipsOwed(
  siteId: number,
  range: { from: string; to: string },
): Promise<TipsOwed[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT t.user_id, COALESCE(NULLIF(t.user_name, ''), 'Pool') AS user_name,
            SUM(t.amount) AS total, COUNT(*) AS n
       FROM sales_tips t
       JOIN sales_documents d ON d.id = t.document_id AND d.status = 'finalised'
      WHERE d.document_date BETWEEN ? AND ?
      GROUP BY t.user_id, user_name
      ORDER BY total DESC`,
    [range.from, range.to],
  )
  return rows.map((r) => ({
    userId: r.user_id === null ? null : Number(r.user_id),
    userName: r.user_id === null ? 'Pool' : String(r.user_name ?? ''),
    total: toNum(r.total),
    count: Number(r.n ?? 0),
  }))
}
