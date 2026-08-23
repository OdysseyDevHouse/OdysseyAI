import 'server-only'
import type { PoolConnection } from 'mysql2/promise'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
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

/*
 * The PLANNER lives in ../tipMath.ts, not here, and is re-exported so server callers
 * keep one import site.
 *
 * It moved because this file is server-only: the tender pad has to run the same planner
 * the finalise does, and importing it from here would drag the database driver into the
 * browser bundle. Same reasoning as documentMath and tenderMath.
 */
export { planTips } from '../tipMath'
export type { TipSource, PlannedTip, TenderForTips, TipPlan } from '../tipMath'
/* Imported as well as re-exported: `writeTips` and the readers below USE these, and a
   bare `export type { ... } from` re-exports without binding them in this module. */
import type { TipSource, PlannedTip } from '../tipMath'

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
 * How much of a shift's tips are sitting in the drawer.
 *
 * ── NOT AN ADDEND FOR CASH-UP. READ THIS BEFORE USING IT. ─────────────────
 *
 * I built this expecting `closeShift` to add it to the expected drawer, and that would
 * have been a DOUBLE COUNT. Its query is already right:
 *
 *     SUM(t.amount - t.change_given)
 *
 * `amount` is what was handed over and `change_given` is what went back. A R120 cash
 * tender with a R20 tip records amount=120, change_given=0 — so the expectation is R120,
 * the drawer holds R120, and it balances with no help. A card tip never enters that sum in
 * the first place, because its tender is not `counts_as_drawer_cash`.
 *
 * So this is a REPORTING figure: "how much of tonight's takings is gratuity", for the
 * cash-up screen to show beside the count and for a manager paying staff out. Adding it to
 * `expectedCash` would leave every tipping shift reading over by exactly its tips — the
 * very bug the flag exists to prevent, arrived at from the other direction.
 */
export async function expectedTipsInDrawer(siteId: number, shiftId: number): Promise<number> {
  return tipsInDrawer(await tipsForShift(siteId, shiftId))
}

/* ── Service-charge tiers ────────────────────────────────────────────────── */

export async function listServiceTiers(siteId: number): Promise<(ServiceTier & { id: number })[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, min_total, max_total, charge_kind, percent, charge_amount, is_active
       FROM service_charge_tiers ORDER BY min_total`,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    minTotal: toNum(r.min_total),
    maxTotal: r.max_total === null ? null : toNum(r.max_total),
    /* Anything unrecognised reads as a percentage, which is what every band was
       before 216 added the column — a band whose kind cannot be read must not
       silently start charging its (zero) flat amount. */
    chargeKind: String(r.charge_kind) === 'amount' ? 'amount' : 'percent',
    percent: toNum(r.percent),
    amount: toNum(r.charge_amount),
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

/**
 * A tip total split by how the money arrived.
 *
 * Matched on `tender_types.code`, never `name`. The code is the engine's stable handle —
 * UNIQUE, `/^[A-Z0-9_]{2,24}$/`, and unchangeable on a system tender — while the name is
 * whatever the shop decided to call it this week. A store renaming "Card" to "Speedpoint"
 * must not empty the card figure.
 *
 * `other` is the NEGATION of the named set rather than a list of the rest, so a tender
 * added after this was written — including a shop's own — always lands somewhere and
 *
 *     cash + card + eft + account + other === total
 *
 * holds for every possible configuration. The screen prints these beside the total; a
 * split that could silently lose a tender would show chips that do not add up to the
 * figure next to them, which is worse than showing no split at all.
 */
export type TipTenderSplit = {
  cash: number
  card: number
  eft: number
  account: number
  other: number
  /**
   * What the till should physically be holding.
   *
   * Read from the shop's `tip_in_drawer` flag, NOT derived from the codes above. The flag
   * defaults to 1, so a shop's own cash-like tender is in the drawer even though its code
   * is not CASH — deriving this from the four named codes would quietly understate it.
   */
  inDrawer: number
}

export type TipsOwed = {
  userId: number | null
  userName: string
  total: number
  count: number
  /** The same total, split by how it arrived. */
  byTender: TipTenderSplit
}

/**
 * Tips by person, split by tender — the body behind `tipsOwed` and `tipsEarned`.
 *
 * ── ONE QUERY, ONE payout_id PREDICATE ────────────────────────────────────
 *
 * These two questions differ by exactly one clause and are otherwise the same query.
 * Written out twice, the `payout_id IS NULL` that makes `owed` safe to pay from sits one
 * careless edit away from being fixed in one copy and not the other — and that failure is
 * invisible: both totals still look plausible while the money goes out twice. So the
 * predicate is a PARAMETER of one query, and the two exported functions below are the two
 * ways of asking.
 *
 * The per-tender split rides along free: same GROUP BY, same scan, extra columns.
 */
async function tipsByPerson(
  siteId: number,
  range: { from: string; to: string },
  unpaidOnly: boolean,
): Promise<TipsOwed[]> {
  /* A boolean-driven constant, never a value — there is no path from user input to here. */
  const unpaidClause = unpaidOnly ? 'AND t.payout_id IS NULL' : ''
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT t.user_id, COALESCE(NULLIF(t.user_name, ''), 'Pool') AS user_name,
            SUM(t.amount) AS total, COUNT(*) AS n,
            SUM(CASE WHEN tt.code = 'CASH'    THEN t.amount ELSE 0 END) AS t_cash,
            SUM(CASE WHEN tt.code = 'CARD'    THEN t.amount ELSE 0 END) AS t_card,
            SUM(CASE WHEN tt.code = 'EFT'     THEN t.amount ELSE 0 END) AS t_eft,
            SUM(CASE WHEN tt.code = 'ACCOUNT' THEN t.amount ELSE 0 END) AS t_account,
            SUM(CASE WHEN tt.code NOT IN ('CASH','CARD','EFT','ACCOUNT')
                     THEN t.amount ELSE 0 END) AS t_other,
            SUM(CASE WHEN tt.tip_in_drawer = 1 THEN t.amount ELSE 0 END) AS t_drawer
       FROM sales_tips t
       JOIN sales_documents d ON d.id = t.document_id AND d.status = 'finalised'
       /* INNER, like tipsForShift: tender_type_id is NOT NULL behind an FK, so a tip with
          no tender cannot exist. A LEFT JOIN here would hide a broken row rather than
          letting it fail loudly, and would drop it out of the other bucket as well. */
       JOIN tender_types tt ON tt.id = t.tender_type_id
      WHERE d.document_date BETWEEN ? AND ?
        ${unpaidClause}
      GROUP BY t.user_id, user_name
      ORDER BY total DESC`,
    [range.from, range.to],
  )
  return rows.map((r) => ({
    userId: r.user_id === null ? null : Number(r.user_id),
    userName: r.user_id === null ? 'Pool' : String(r.user_name ?? ''),
    total: toNum(r.total),
    count: Number(r.n ?? 0),
    byTender: {
      cash: toNum(r.t_cash),
      card: toNum(r.t_card),
      eft: toNum(r.t_eft),
      account: toNum(r.t_account),
      other: toNum(r.t_other),
      inDrawer: toNum(r.t_drawer),
    },
  }))
}

/**
 * Tips by person over a date range, for the report a manager pays out from.
 *
 * The POOL comes back as a row with `userId: null` rather than being omitted — a manager
 * dividing the pool needs to see its size, and a report that silently dropped it would
 * make pooled tips look like money that had evaporated.
 *
 * ── OWED MEANS UNSETTLED, NOT EARNED ──────────────────────────────────────
 *
 * `payout_id IS NULL` is the filter, and it is what makes this figure safe to pay from.
 * Without it the same tips reappear every time last week's range is re-opened, and a
 * manager paying from the screen pays twice with nothing in the data able to notice.
 *
 * A shop that wants what somebody EARNED over a period — for a payslip, or to settle an
 * argument — wants `tipsEarned` below instead. Two questions, deliberately two functions:
 * one figure serving both is the figure that gets paid out twice.
 */
export async function tipsOwed(
  siteId: number,
  range: { from: string; to: string },
): Promise<TipsOwed[]> {
  return tipsByPerson(siteId, range, true)
}

/**
 * Tips by person over a date range REGARDLESS of whether they have been paid.
 *
 * What somebody earned, which is a different question from what they are owed and must not
 * be answered by the same figure — see `tipsOwed`.
 */
export async function tipsEarned(
  siteId: number,
  range: { from: string; to: string },
): Promise<TipsOwed[]> {
  return tipsByPerson(siteId, range, false)
}

/* ── Paying them out ─────────────────────────────────────────────────────── */

export type PayoutMethod = 'cash' | 'wages' | 'transfer' | 'other'

export type TipPayout = {
  id: number
  userId: number | null
  userName: string
  amount: number
  method: PayoutMethod
  fromPool: boolean
  note: string | null
  paidByName: string
  paidAt: string
  tipCount: number
}

export type PayoutResult = { ok: true; payoutId: number; amount: number } | { ok: false; error: string }

const METHODS: readonly PayoutMethod[] = ['cash', 'wages', 'transfer', 'other']

/**
 * Hands one person's outstanding tips over, and marks exactly those tips settled.
 *
 * ── WHY THE TIPS ARE SELECTED INSIDE THE TRANSACTION, AND LOCKED ───────────
 *
 * The amount and the settling are ONE fact. Reading the total on the screen and then
 * writing a payout for that number is a race with the till: a tip taken between the two
 * is either paid and not marked, or marked and not paid, depending which way it lands.
 * So the rows are chosen and stamped here, under `FOR UPDATE`, and the payout's amount is
 * their SUM rather than anything the caller passed — the caller cannot hand over a figure
 * that disagrees with the tips it settles, because it does not get to name one.
 *
 * A second manager pressing the same button at the same moment therefore finds no
 * outstanding rows and is told so, rather than writing a second envelope for the same money.
 */
export async function payTipsOut(
  siteId: number,
  actor: Actor,
  input: {
    /** Whose tips. `null` IS the pool — see `reassignTip` for the same convention. */
    userId: number | null
    userName: string
    range: { from: string; to: string }
    method: PayoutMethod
    note?: string
    /**
     * Attribute a POOL share to a person while settling the pool's own rows.
     *
     * A pool split pays named people out of `user_id IS NULL` tips, so the payout says who
     * received it while `from_pool` says where it came from. Without this the history reads
     * as though they earned it directly, which is the one thing a pooled tip did not do.
     */
    creditTo?: { userId: number | null; userName: string } | null
  },
): Promise<PayoutResult> {
  if (!METHODS.includes(input.method)) return { ok: false, error: 'Unknown payment method.' }

  return siteTransaction(siteId, async (tx) => {
    const [rows] = await tx.query<Row[]>(
      `SELECT t.id, t.amount
         FROM sales_tips t
         JOIN sales_documents d ON d.id = t.document_id AND d.status = 'finalised'
        WHERE d.document_date BETWEEN ? AND ?
          AND t.payout_id IS NULL
          AND ${input.userId === null ? 't.user_id IS NULL' : 't.user_id = ?'}
        FOR UPDATE`,
      input.userId === null
        ? [input.range.from, input.range.to]
        : [input.range.from, input.range.to, input.userId],
    )
    if (rows.length === 0) {
      return { ok: false as const, error: 'There are no unpaid tips for that person in this period.' }
    }

    const amount = round(
      rows.reduce((sum, r) => round(sum + toNum(r.amount), 2), 0),
      2,
    )
    const credited = input.creditTo ?? { userId: input.userId, userName: input.userName }
    const [res] = await tx.execute<ResultSetHeader>(
      `INSERT INTO tip_payouts
         (user_id, user_name, amount, method, from_pool, note, paid_by, paid_by_name)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        credited.userId,
        credited.userName.slice(0, 120),
        amount.toFixed(4),
        input.method,
        input.userId === null ? 1 : 0,
        input.note?.trim().slice(0, 200) || null,
        actor.userId,
        actor.userName.slice(0, 120),
      ],
    )
    const payoutId = res.insertId

    await tx.query('UPDATE sales_tips SET payout_id = ? WHERE id IN (?)', [
      payoutId,
      rows.map((r) => Number(r.id)),
    ])
    return { ok: true as const, payoutId, amount }
  })
}

export type PoolShare = { userId: number; userName: string; amount: number }

/**
 * Splits the pool across named staff, in ONE transaction.
 *
 * Each share becomes its own payout marked `from_pool`, and the pool's tip rows are settled
 * once — by the first share — so the total paid out cannot exceed the pool.
 *
 * ── WHY ONE TRANSACTION AND NOT N CALLS TO payTipsOut ─────────────────────
 *
 * Because the second call would find the rows already settled by the first and refuse,
 * paying one person and nobody else. The split is one decision and has to commit as one.
 *
 * The shares must sum to the pool exactly. A short split would leave money marked paid that
 * nobody received; a long one would pay out money that was never taken. Neither is
 * recoverable from the data afterwards, so both are refused here rather than warned about.
 */
export async function splitPoolOut(
  siteId: number,
  actor: Actor,
  input: {
    range: { from: string; to: string }
    method: PayoutMethod
    shares: PoolShare[]
    note?: string
  },
): Promise<{ ok: true; payoutIds: number[]; amount: number } | { ok: false; error: string }> {
  if (!METHODS.includes(input.method)) return { ok: false, error: 'Unknown payment method.' }
  if (input.shares.length === 0) return { ok: false, error: 'Choose who the pool is being split between.' }
  if (input.shares.some((s) => !(s.amount > 0))) {
    return { ok: false, error: 'Every share must be more than nothing.' }
  }

  return siteTransaction(siteId, async (tx) => {
    const [rows] = await tx.query<Row[]>(
      `SELECT t.id, t.amount
         FROM sales_tips t
         JOIN sales_documents d ON d.id = t.document_id AND d.status = 'finalised'
        WHERE d.document_date BETWEEN ? AND ?
          AND t.payout_id IS NULL
          AND t.user_id IS NULL
        FOR UPDATE`,
      [input.range.from, input.range.to],
    )
    if (rows.length === 0) {
      return { ok: false as const, error: 'The pool has nothing unpaid in this period.' }
    }

    const pool = round(
      rows.reduce((sum, r) => round(sum + toNum(r.amount), 2), 0),
      2,
    )
    const allocated = round(
      input.shares.reduce((sum, s) => round(sum + s.amount, 2), 0),
      2,
    )
    if (allocated !== pool) {
      return {
        ok: false as const,
        error: `The shares add up to ${allocated.toFixed(2)} but the pool is ${pool.toFixed(2)}.`,
      }
    }

    const payoutIds: number[] = []
    for (const share of input.shares) {
      const [res] = await tx.execute<ResultSetHeader>(
        `INSERT INTO tip_payouts
           (user_id, user_name, amount, method, from_pool, note, paid_by, paid_by_name)
         VALUES (?,?,?,?,1,?,?,?)`,
        [
          share.userId,
          share.userName.slice(0, 120),
          round(share.amount, 2).toFixed(4),
          input.method,
          input.note?.trim().slice(0, 200) || null,
          actor.userId,
          actor.userName.slice(0, 120),
        ],
      )
      payoutIds.push(res.insertId)
    }

    /* Settled against the FIRST share's payout. The pool's tips belong to the split as a
       whole and there is no honest way to divide row-level ownership between the shares;
       what matters is that they are settled exactly once, by a payout that exists. */
    await tx.query('UPDATE sales_tips SET payout_id = ? WHERE id IN (?)', [
      payoutIds[0],
      rows.map((r) => Number(r.id)),
    ])
    return { ok: true as const, payoutIds, amount: pool }
  })
}

/** Payouts already made in a period, newest first, for the "paid" half of the screen. */
export async function listPayouts(
  siteId: number,
  range: { from: string; to: string },
): Promise<TipPayout[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.user_id, p.user_name, p.amount, p.method, p.from_pool, p.note,
            p.paid_by_name, p.paid_at,
            (SELECT COUNT(*) FROM sales_tips t WHERE t.payout_id = p.id) AS tip_count
       FROM tip_payouts p
      WHERE DATE(p.paid_at) BETWEEN ? AND ?
      ORDER BY p.paid_at DESC, p.id DESC`,
    [range.from, range.to],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    userId: r.user_id === null ? null : Number(r.user_id),
    userName: String(r.user_name ?? ''),
    amount: toNum(r.amount),
    method: String(r.method ?? 'cash') as PayoutMethod,
    fromPool: Number(r.from_pool ?? 0) === 1,
    note: r.note === null ? null : String(r.note),
    paidByName: String(r.paid_by_name ?? ''),
    paidAt: String(r.paid_at ?? ''),
    tipCount: Number(r.tip_count ?? 0),
  }))
}

/**
 * One tip, as the detail behind somebody's outstanding total.
 *
 * Carries both halves of the tender: `tenderCode` is what any logic keys off, `tenderName`
 * is what a manager reads. Same rule as everywhere else in this file — the name is
 * renameable, the code is not.
 */
export type OutstandingTip = {
  id: number
  amount: number
  source: TipSource
  documentNumber: string
  date: string
  tenderCode: string
  tenderName: string
  /** Whether this one is cash the till should be holding, per the shop's own flag. */
  tipInDrawer: boolean
}

/** The individual tips behind one person's outstanding total — what makes up the envelope. */
export async function outstandingTipsFor(
  siteId: number,
  userId: number | null,
  range: { from: string; to: string },
): Promise<OutstandingTip[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT t.id, t.amount, t.source, d.document_number, d.document_date,
            tt.code AS tender_code, tt.name AS tender_name, tt.tip_in_drawer
       FROM sales_tips t
       JOIN sales_documents d ON d.id = t.document_id AND d.status = 'finalised'
       JOIN tender_types tt ON tt.id = t.tender_type_id
      WHERE d.document_date BETWEEN ? AND ?
        AND t.payout_id IS NULL
        AND ${userId === null ? 't.user_id IS NULL' : 't.user_id = ?'}
      ORDER BY d.document_date DESC, t.id DESC`,
    userId === null ? [range.from, range.to] : [range.from, range.to, userId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    amount: toNum(r.amount),
    source: String(r.source ?? 'manual') as TipSource,
    documentNumber: String(r.document_number ?? ''),
    date: String(r.document_date ?? ''),
    tenderCode: String(r.tender_code ?? ''),
    tenderName: String(r.tender_name ?? ''),
    tipInDrawer: Number(r.tip_in_drawer ?? 0) === 1,
  }))
}
