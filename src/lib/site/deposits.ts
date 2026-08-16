import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { logActivityTx } from './activityLog'
import type { Actor } from './activityLog'
import { shiftToBankInto } from './shifts'
import { getSettings } from './settings'
import { round, toNum } from '../decimals'
import {
  refundRefusal,
  takeRefusal,
  tenderAtFinalise,
  type DepositPosition,
} from '../depositRules'

/**
 * Money taken up front against a sale, a quote or an invoice.
 *
 * ── THIS IS THE LAY-BY PATTERN, DELIBERATELY ─────────────────────────────
 *
 * `laybys.ts` already solved this problem, and the reasoning it sets out at the
 * top of that file applies here word for word: under CPA s62(1)(a) each amount
 * paid remains the property of the consumer until the goods are delivered. So a
 * deposit writes exactly one row and touches nothing else. In particular it
 * does NOT write:
 *
 *   customer_transactions  every row there moves the debtor balance, and a
 *                          customer who has paid a deposit owes nothing
 *   the general ledger     revenue is recognised at delivery, not at deposit
 *   VAT                    time of supply falls on delivery
 *   stock_movements        nothing has left the shelf
 *
 * All four happen once, at finalise, when `tenderForDocument` hands the money
 * back to the ordinary posting path as a single tender. Nothing
 * deposit-specific happens at posting time, which is the same trick
 * `completeLayby` uses and the reason every existing guard still runs.
 *
 * ── BUT THE DRAWER MUST SEE IT ───────────────────────────────────────────
 *
 * The money physically arrived, so `shift_id` is stamped on every row and the
 * cash-up reads it. Miss that and every till taking deposits reconciles short
 * by exactly the deposits taken. `shiftToBankInto` is the same hinge lay-bys
 * use, and null is a legitimate answer — a back-office deposit belongs to no
 * drawer.
 *
 * ── HELD IS ALWAYS A SUM, NEVER A STORED TOTAL ───────────────────────────
 *
 * There is no `amount_paid` column anywhere, on purpose. What is held is
 * `SUM(amount)` over the rows and nothing else, following the rule laybys.ts
 * applies to `paid_total`: recompute, never increment, so the figure cannot
 * drift from the rows it summarises.
 */

type Row = RowDataPacket & Record<string, unknown>

export type DepositKind = 'deposit' | 'refund' | 'applied'

export type Deposit = {
  id: number
  documentId: number | null
  basketUid: string | null
  kind: DepositKind
  /** Signed. Positive took money in, negative gave it back or consumed it. */
  amount: number
  tenderTypeId: number | null
  tenderName: string
  reference: string | null
  takenOn: string
  shiftId: number | null
  terminalId: number | null
  userName: string
  note: string | null
  createdAt: Date
}

export type DepositSummary = {
  entries: Deposit[]
  /** Σ amount. What the shop is currently holding for this customer. */
  held: number
  /** Of that, what came in as deposits, ignoring refunds and applications. */
  taken: number
  /** The document total this is measured against. */
  totalIncl: number
  /** totalIncl − held, floored at zero. */
  stillToPay: number
}

const SELECT_DEPOSIT = `
  SELECT id, document_id, basket_uid, kind, amount, tender_type_id, tender_name,
         reference, taken_on, shift_id, terminal_id, user_id, user_name, note, created_at
    FROM sale_deposits
`

function mapDeposit(r: Row): Deposit {
  return {
    id: Number(r.id),
    documentId: r.document_id === null ? null : Number(r.document_id),
    basketUid: r.basket_uid === null ? null : String(r.basket_uid),
    kind: String(r.kind) as DepositKind,
    amount: toNum(r.amount),
    tenderTypeId: r.tender_type_id === null ? null : Number(r.tender_type_id),
    tenderName: String(r.tender_name ?? ''),
    reference: r.reference === null ? null : String(r.reference),
    // DATE comes back as a driver Date. Read it as wall-clock — the pool sets
    // timezone 'Z', so getUTC* is the honest reader here.
    takenOn: wallClockDate(r.taken_on),
    shiftId: r.shift_id === null ? null : Number(r.shift_id),
    terminalId: r.terminal_id === null ? null : Number(r.terminal_id),
    userName: String(r.user_name ?? ''),
    note: r.note === null ? null : String(r.note),
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at)),
  }
}

/**
 * A DATE column as the yyyy-mm-dd it was written as.
 *
 * `String(driverDate)` is a locale string and `new Date(x + 'Z')` yields NaN on
 * one — both are ways this has been got wrong before. The pool runs in UTC, so
 * the wall-clock date is the UTC date.
 */
function wallClockDate(value: unknown): string {
  if (value instanceof Date) {
    const y = value.getUTCFullYear()
    const m = String(value.getUTCMonth() + 1).padStart(2, '0')
    const d = String(value.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(value ?? '').slice(0, 10)
}

/* ── Reading ─────────────────────────────────────────────────────────────── */

/** Every deposit row against one document, oldest first. */
export async function depositsForDocument(siteId: number, documentId: number): Promise<Deposit[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_DEPOSIT} WHERE document_id = ? ORDER BY taken_on, id`,
    [documentId],
  )
  return rows.map(mapDeposit)
}

/** Every deposit row against an offline basket that has no document yet. */
export async function depositsForBasket(siteId: number, uid: string): Promise<Deposit[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_DEPOSIT} WHERE basket_uid = ? AND document_id IS NULL ORDER BY taken_on, id`,
    [uid],
  )
  return rows.map(mapDeposit)
}

/**
 * What is held against a document, and what that leaves to pay.
 *
 * One query for the money and one for the total, rather than a join: the
 * document may legitimately have no deposits at all, and a LEFT JOIN that
 * returns a null row is a shape every caller then has to defend against.
 */
export async function depositSummary(
  siteId: number,
  documentId: number,
): Promise<DepositSummary> {
  const [entries, doc] = await Promise.all([
    depositsForDocument(siteId, documentId),
    siteQueryOne<Row>(siteId, 'SELECT total_incl FROM sales_documents WHERE id = ? LIMIT 1', [
      documentId,
    ]),
  ])

  const held = round(
    entries.reduce((sum, e) => sum + e.amount, 0),
    2,
  )
  const taken = round(
    entries.filter((e) => e.kind === 'deposit').reduce((sum, e) => sum + e.amount, 0),
    2,
  )
  const totalIncl = toNum(doc?.total_incl)

  return {
    entries,
    held,
    taken,
    totalIncl,
    stillToPay: round(Math.max(totalIncl - held, 0), 2),
  }
}

/**
 * What is held against many documents at once, keyed by document id.
 *
 * For the register, where N documents each needing their own query is the
 * difference between a list that paints and one that does not.
 */
export async function heldByDocument(
  siteId: number,
  documentIds: readonly number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (documentIds.length === 0) return out

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT document_id, COALESCE(SUM(amount), 0) AS held
       FROM sale_deposits
      WHERE document_id IN (${documentIds.map(() => '?').join(',')})
      GROUP BY document_id`,
    [...documentIds],
  )
  for (const r of rows) out.set(Number(r.document_id), toNum(r.held))
  return out
}

/* ── Taking ──────────────────────────────────────────────────────────────── */

export type TakeInput = {
  /** The document the money is held against. Null only for an offline basket. */
  documentId: number | null
  /** The offline basket, when there is no document. */
  basketUid?: string | null
  amount: number
  tenderTypeId: number | null
  tenderName: string
  reference?: string | null
  terminalId?: number | null
  note?: string | null
}

export type TakeResult =
  | { ok: true; depositId: number; held: number; stillToPay: number }
  | { ok: false; error: string }

/**
 * Take a deposit.
 *
 * The refusal comes from `depositRules.takeRefusal`, the same pure function the
 * till runs before it opens the tender pad, so the cashier is never told at the
 * counter that something is fine and then told by the server that it is not.
 */
export async function takeDeposit(
  siteId: number,
  actor: Actor,
  input: TakeInput,
): Promise<TakeResult> {
  if (input.documentId === null && !input.basketUid) {
    return { ok: false, error: 'A deposit needs a sale to belong to.' }
  }

  const settings = await getSettings(siteId, ['deposit_min_pct', 'deposit_allow_walkin'])
  const minPct = Number(settings.deposit_min_pct ?? '0') || 0
  const allowWalkin = String(settings.deposit_allow_walkin ?? '1') !== '0'

  // An offline basket has no document to measure against, so the rules that
  // depend on a total cannot run here. They ran on the till, against the
  // basket it could see, which is the only place that information exists.
  if (input.documentId !== null) {
    const doc = await siteQueryOne<Row>(
      siteId,
      'SELECT id, status, total_incl, customer_id FROM sales_documents WHERE id = ? LIMIT 1',
      [input.documentId],
    )
    if (!doc) return { ok: false, error: 'That sale no longer exists.' }

    const summary = await depositSummary(siteId, input.documentId)
    const refusal = takeRefusal({
      status: String(doc.status),
      totalIncl: toNum(doc.total_incl),
      heldTotal: summary.held,
      amount: input.amount,
      minPct,
      hasCustomer: doc.customer_id !== null,
      allowWalkin,
    })
    if (refusal) return { ok: false, error: refusal }
  } else if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false, error: 'Enter an amount.' }
  }

  const shiftId = await shiftToBankInto(siteId, input.terminalId ?? null, actor.userId ?? null)

  const depositId = await siteTransaction(siteId, async (tx) => {
    const id = await insertRow(tx, actor, {
      documentId: input.documentId,
      basketUid: input.basketUid ?? null,
      kind: 'deposit',
      amount: round(input.amount, 2),
      tenderTypeId: input.tenderTypeId,
      tenderName: input.tenderName,
      reference: input.reference ?? null,
      shiftId,
      terminalId: input.terminalId ?? null,
      note: input.note ?? null,
    })

    if (input.documentId !== null) {
      await tx.execute(
        `INSERT INTO document_audit (document_id, action, detail, user_id, user_name)
         VALUES (?, 'deposit_taken', ?, ?, ?)`,
        [
          input.documentId,
          `${round(input.amount, 2).toFixed(2)} by ${input.tenderName || 'unknown tender'}`,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
    }

    return id
  })

  const after = input.documentId !== null ? await depositSummary(siteId, input.documentId) : null

  return {
    ok: true,
    depositId,
    held: after?.held ?? round(input.amount, 2),
    stillToPay: after?.stillToPay ?? 0,
  }
}

/* ── Refunding ───────────────────────────────────────────────────────────── */

export type RefundInput = {
  documentId: number
  amount: number
  tenderTypeId: number | null
  tenderName: string
  reference?: string | null
  terminalId?: number | null
  note?: string | null
}

export type RefundResult = { ok: true; depositId: number; held: number } | { ok: false; error: string }

/**
 * Give a held deposit back.
 *
 * Stored as a negative row rather than by deleting or editing the original, for
 * the reason `layby_payments` keeps refunds as rows: the customer paid on one
 * day and was refunded on another, two cash-ups counted those two events, and
 * a delete would make both of them wrong retrospectively.
 */
export async function refundDeposit(
  siteId: number,
  actor: Actor,
  input: RefundInput,
): Promise<RefundResult> {
  const doc = await siteQueryOne<Row>(
    siteId,
    'SELECT id, status, total_incl FROM sales_documents WHERE id = ? LIMIT 1',
    [input.documentId],
  )
  if (!doc) return { ok: false, error: 'That sale no longer exists.' }

  const summary = await depositSummary(siteId, input.documentId)
  const refusal = refundRefusal({
    status: String(doc.status),
    totalIncl: toNum(doc.total_incl),
    heldTotal: summary.held,
    amount: input.amount,
  })
  if (refusal) return { ok: false, error: refusal }

  const shiftId = await shiftToBankInto(siteId, input.terminalId ?? null, actor.userId ?? null)

  const depositId = await siteTransaction(siteId, async (tx) => {
    const id = await insertRow(tx, actor, {
      documentId: input.documentId,
      basketUid: null,
      kind: 'refund',
      // Negative: Σ amount is what is still held, so a refund has to subtract.
      amount: -round(input.amount, 2),
      tenderTypeId: input.tenderTypeId,
      tenderName: input.tenderName,
      reference: input.reference ?? null,
      shiftId,
      terminalId: input.terminalId ?? null,
      note: input.note ?? null,
    })

    await tx.execute(
      `INSERT INTO document_audit (document_id, action, detail, user_id, user_name)
       VALUES (?, 'deposit_refunded', ?, ?, ?)`,
      [
        input.documentId,
        `${round(input.amount, 2).toFixed(2)} returned by ${input.tenderName || 'unknown tender'}`,
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )

    await logActivityTx(tx, actor, {
      entity: 'customer',
      entityId: null,
      action: 'deposit_refunded',
      detail: `${round(input.amount, 2).toFixed(2)} on document ${input.documentId}`,
    })

    return id
  })

  const after = await depositSummary(siteId, input.documentId)
  return { ok: true, depositId, held: after.held }
}

/* ── Applying, at finalise ───────────────────────────────────────────────── */

/**
 * What a document's deposits contribute as a tender when it posts.
 *
 * Returns zero when nothing is held, which is the common case and must stay
 * cheap — this runs on every finalise, deposit or not.
 *
 * Capped at the document total by `tenderAtFinalise`. Money held beyond what
 * the sale is worth must not become a tender: the till would hand back change
 * for cash taken on a different day and already counted in a different
 * cash-up. That excess is refunded as its own event instead.
 */
export async function tenderForDocument(
  siteId: number,
  documentId: number,
): Promise<{ amount: number; position: DepositPosition }> {
  const summary = await depositSummary(siteId, documentId)
  const position: DepositPosition = {
    totalIncl: summary.totalIncl,
    heldTotal: summary.held,
  }
  return { amount: tenderAtFinalise(position), position }
}

/**
 * Mark a document's deposits consumed, inside the posting transaction.
 *
 * Called by `finaliseDocument` after the sale has posted, on the SAME
 * connection, so the deposit cannot be recorded as spent by a sale that then
 * rolls back.
 *
 * The row is written with `kind = 'applied'` and a negative amount rather than
 * by deleting the deposits: Σ amount falls to zero, so nothing is still held,
 * while the history of what was taken and when stays readable on the document
 * afterwards.
 */
export async function applyDepositsTx(
  tx: PoolConnection,
  actor: Actor,
  documentId: number,
  amount: number,
  shiftId: number | null,
  terminalId: number | null,
): Promise<void> {
  if (!Number.isFinite(amount) || round(amount, 2) <= 0) return

  await insertRow(tx, actor, {
    documentId,
    basketUid: null,
    kind: 'applied',
    amount: -round(amount, 2),
    tenderTypeId: null,
    tenderName: 'Deposit applied',
    reference: null,
    shiftId,
    terminalId,
    note: null,
  })
}

/**
 * Move an offline basket's deposits onto the document it became.
 *
 * An offline-parked basket has a uid and no document id. When it finally
 * reaches the server its money has to follow it, or a customer who paid a
 * deposit on a till with no network pays again when the basket syncs.
 *
 * `basket_uid` is deliberately left in place rather than cleared: it is the
 * record of where the money came from, and the only way to tell afterwards that
 * a deposit was taken offline.
 */
export async function attachBasketDeposits(
  siteId: number,
  uid: string,
  documentId: number,
): Promise<number> {
  const result = await siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      'UPDATE sale_deposits SET document_id = ? WHERE basket_uid = ? AND document_id IS NULL',
      [documentId, uid] as never,
    )
    return (res as { affectedRows?: number }).affectedRows ?? 0
  })
  return result
}

/* ── The one INSERT ──────────────────────────────────────────────────────── */

type InsertInput = {
  documentId: number | null
  basketUid: string | null
  kind: DepositKind
  amount: number
  tenderTypeId: number | null
  tenderName: string
  reference: string | null
  shiftId: number | null
  terminalId: number | null
  note: string | null
}

/**
 * Every write to `sale_deposits` goes through here.
 *
 * One place that knows the column list, the truncation lengths and the
 * DECIMAL(12,4) formatting. Three call sites writing their own INSERT is three
 * places for a `.toFixed(4)` to go missing, which MySQL would accept and
 * silently round.
 */
async function insertRow(tx: PoolConnection, actor: Actor, input: InsertInput): Promise<number> {
  const [res] = await tx.execute(
    `INSERT INTO sale_deposits
       (document_id, basket_uid, kind, amount, tender_type_id, tender_name,
        reference, taken_on, shift_id, terminal_id, user_id, user_name, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?, ?, ?, ?)`,
    [
      input.documentId,
      input.basketUid?.slice(0, 64) ?? null,
      input.kind,
      input.amount.toFixed(4),
      input.tenderTypeId,
      input.tenderName.slice(0, 60),
      input.reference?.slice(0, 120) ?? null,
      input.shiftId,
      input.terminalId,
      actor.userId,
      actor.userName.slice(0, 120),
      input.note?.slice(0, 190) ?? null,
    ] as never,
  )
  return (res as { insertId: number }).insertId
}
