import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { postTransaction, openDebits, allocate } from './customerLedger'
import { today } from './ledger'
import { guardPosting } from './periodLocks'

/**
 * Writing off bad debt.
 *
 * Mechanically a write-off is a journal, and the sub-ledger could already post
 * one. What it could NOT do is answer "how much bad debt did we write off last
 * year, who approved it, and why" — which is what an auditor asks, what a
 * provision is calculated from, and what a policy threshold needs.
 *
 * So the journal still carries the money and this table carries the story,
 * pointing at it. Nothing here duplicates a balance; delete every row in
 * debt_write_offs and the ledger is still correct, just unexplained.
 *
 * ── APPROVAL ─────────────────────────────────────────────────────────────
 *
 * Above a threshold a second person must agree, and the request sits pending
 * until they do. Both names are kept because "approved by" equalling "requested
 * by" is itself a finding — the control only works if it is visible when it was
 * bypassed.
 */

export const WRITE_OFF_CATEGORIES = [
  'bad_debt',
  'small_bal',
  'dispute',
  'goodwill',
  'other',
] as const
export type WriteOffCategory = (typeof WRITE_OFF_CATEGORIES)[number]

export const CATEGORY_LABELS: Record<WriteOffCategory, string> = {
  bad_debt: 'Bad debt',
  small_bal: 'Small balance',
  dispute: 'Settled dispute',
  goodwill: 'Goodwill',
  other: 'Other',
}

export type WriteOffStatus = 'pending' | 'posted' | 'rejected'

export type WriteOff = {
  id: number
  customerId: number
  customerCode: string
  customerName: string
  transactionId: number | null
  amount: number
  writeOffDate: string
  category: WriteOffCategory
  categoryLabel: string
  reason: string
  requiresApproval: boolean
  approvedBy: string | null
  approvedAt: Date | null
  status: WriteOffStatus
  recoveredAt: Date | null
  recoveredTxnId: number | null
  userName: string
  createdAt: Date
}

type Row = RowDataPacket & Record<string, unknown>

function mapWriteOff(r: Row): WriteOff {
  const category = String(r.category) as WriteOffCategory
  return {
    id: Number(r.id),
    customerId: Number(r.customer_id),
    customerCode: String(r.customer_code ?? ''),
    customerName: String(r.customer_name ?? ''),
    transactionId: r.transaction_id === null ? null : Number(r.transaction_id),
    amount: toNum(r.amount),
    writeOffDate: String(r.write_off_date),
    category,
    categoryLabel: CATEGORY_LABELS[category] ?? category,
    reason: String(r.reason ?? ''),
    requiresApproval: Boolean(r.requires_approval),
    approvedBy: (r.approved_by as string | null) ?? null,
    approvedAt: (r.approved_at as Date | null) ?? null,
    status: String(r.status) as WriteOffStatus,
    recoveredAt: (r.recovered_at as Date | null) ?? null,
    recoveredTxnId: r.recovered_txn_id === null ? null : Number(r.recovered_txn_id),
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
  }
}

const SELECT_WRITE_OFF = `
  SELECT w.*, c.code AS customer_code, c.name AS customer_name
    FROM debt_write_offs w
    JOIN customers c ON c.id = w.customer_id
`

export async function listWriteOffs(
  siteId: number,
  opts: { status?: WriteOffStatus; from?: string; to?: string; customerId?: number; limit?: number } = {},
): Promise<WriteOff[]> {
  const where: string[] = []
  const params: unknown[] = []

  if (opts.status) {
    where.push('w.status = ?')
    params.push(opts.status)
  }
  if (opts.customerId) {
    where.push('w.customer_id = ?')
    params.push(opts.customerId)
  }
  if (opts.from) {
    where.push('w.write_off_date >= ?')
    params.push(opts.from)
  }
  if (opts.to) {
    where.push('w.write_off_date <= ?')
    params.push(opts.to)
  }

  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000)
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_WRITE_OFF}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY w.write_off_date DESC, w.id DESC
      LIMIT ${limit}`,
    params,
  )
  return rows.map(mapWriteOff)
}

export async function getWriteOff(siteId: number, id: number): Promise<WriteOff | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_WRITE_OFF} WHERE w.id = ? LIMIT 1`, [id])
  return row ? mapWriteOff(row) : null
}

/* ── Requesting ──────────────────────────────────────────────────────────── */

export type WriteOffInput = {
  customerId: number
  amount: number
  writeOffDate?: string
  category?: WriteOffCategory
  reason: string
  /** Above this, a second person must approve. */
  approvalThreshold?: number
  /** Settle the oldest open invoices with it, rather than leaving a floating credit. */
  allocateToOldest?: boolean
}

export type WriteOffResult =
  | { ok: true; id: number; status: WriteOffStatus; transactionId: number | null }
  | { ok: false; error: string }

export function validateWriteOff(input: WriteOffInput): string | null {
  if (!Number.isFinite(input.amount) || round(input.amount, 2) <= 0) {
    return 'Enter a positive amount to write off.'
  }
  if (Math.abs(input.amount) > 99_999_999) return 'That amount is too large.'
  if (!input.reason?.trim()) return 'Give a reason for the write-off.'
  if (input.reason.trim().length < 5) return 'Give a fuller reason than that.'
  if (input.writeOffDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.writeOffDate)) {
    return 'That date is not valid.'
  }
  if (input.category && !WRITE_OFF_CATEGORIES.includes(input.category)) {
    return 'That is not a valid category.'
  }
  return null
}

/**
 * Requests a write-off, and posts it immediately when no approval is needed.
 *
 * Below the threshold there is no value in a two-step dance for a R3.40 rounding
 * difference, so it posts at once. At or above it, the row is created pending
 * and NOTHING is posted — the balance does not move until someone approves,
 * which is the entire point of a threshold.
 */
export async function requestWriteOff(
  siteId: number,
  actor: Actor,
  input: WriteOffInput,
): Promise<WriteOffResult> {
  const invalid = validateWriteOff(input)
  if (invalid) return { ok: false, error: invalid }

  const writeOffDate = input.writeOffDate ?? today()

  const locked = await guardPosting(siteId, writeOffDate, 'ledger')
  if (locked) return { ok: false, error: locked }

  const customer = await siteQueryOne<Row>(
    siteId,
    'SELECT id, code, name, balance FROM customers WHERE id = ? LIMIT 1',
    [input.customerId],
  )
  if (!customer) return { ok: false, error: 'Customer not found.' }

  const amount = round(input.amount, 2)
  const balance = toNum(customer.balance)

  // Writing off more than is owed leaves a credit on the account that nobody
  // intended and that will be refunded or absorbed by mistake later.
  if (amount > balance + 0.005) {
    return {
      ok: false,
      error: `That account only owes ${balance.toFixed(2)}. Write off that much or less.`,
    }
  }

  const threshold = input.approvalThreshold ?? 0
  const needsApproval = threshold > 0 && amount >= threshold

  const id = await siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO debt_write_offs
         (customer_id, amount, write_off_date, category, reason,
          requires_approval, status, user_id, user_name)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        input.customerId,
        amount.toFixed(4),
        writeOffDate,
        input.category ?? 'bad_debt',
        input.reason.trim().slice(0, 400),
        needsApproval,
        needsApproval ? 'pending' : 'pending',
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )
    const writeOffId = (res as { insertId: number }).insertId

    await logActivityTx(tx, actor, {
      entity: 'customer',
      entityId: input.customerId,
      action: 'write_off_requested',
      detail: `Write-off of ${amount.toFixed(2)} requested — ${input.reason.trim()}${needsApproval ? ' (awaiting approval)' : ''}`,
    })

    return writeOffId
  })

  if (needsApproval) {
    return { ok: true, id, status: 'pending', transactionId: null }
  }

  // Below the threshold: post it now, under the requester's own name.
  const posted = await postWriteOff(siteId, actor, id, {
    allocateToOldest: input.allocateToOldest ?? true,
  })
  if (!posted.ok) return posted

  return { ok: true, id, status: 'posted', transactionId: posted.transactionId }
}

/**
 * Approves and posts a pending write-off.
 *
 * The approver is recorded separately from the requester. Self-approval is
 * ALLOWED but stamped as such rather than blocked: a one-person business has
 * nobody else to ask, and refusing would simply push the write-off into an
 * untracked manual journal — losing the record entirely, which is worse than
 * recording that it was self-approved.
 */
export async function approveWriteOff(
  siteId: number,
  actor: Actor,
  id: number,
  opts: { allocateToOldest?: boolean } = {},
): Promise<WriteOffResult> {
  const writeOff = await getWriteOff(siteId, id)
  if (!writeOff) return { ok: false, error: 'That write-off no longer exists.' }
  if (writeOff.status === 'posted') return { ok: false, error: 'That write-off is already posted.' }
  if (writeOff.status === 'rejected') return { ok: false, error: 'That write-off was rejected.' }

  await siteExecute(
    siteId,
    'UPDATE debt_write_offs SET approved_by = ?, approved_at = NOW() WHERE id = ?',
    [actor.userName.slice(0, 120), id],
  )

  const posted = await postWriteOff(siteId, actor, id, opts)
  if (!posted.ok) return posted

  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: writeOff.customerId,
    action: 'write_off_approved',
    detail: `Approved a write-off of ${writeOff.amount.toFixed(2)}${writeOff.userName === actor.userName ? ' (self-approved)' : ` requested by ${writeOff.userName}`}`,
  })

  return { ok: true, id, status: 'posted', transactionId: posted.transactionId }
}

/**
 * Posts the journal that actually moves the balance.
 *
 * A NEGATIVE journal: the customer owes less. The sub-ledger's own
 * postTransaction does the work so the balance invariant and the audit trail
 * behave exactly as everywhere else, and the write-off row is then pointed at
 * the transaction it produced.
 *
 * Allocating against the oldest open invoices is the default. Without it the
 * write-off sits as an unapplied credit and the invoices it was meant to clear
 * stay open, still ageing, still appearing on the age analysis — which defeats
 * the purpose entirely.
 */
async function postWriteOff(
  siteId: number,
  actor: Actor,
  id: number,
  opts: { allocateToOldest?: boolean } = {},
): Promise<{ ok: true; transactionId: number } | { ok: false; error: string }> {
  const writeOff = await getWriteOff(siteId, id)
  if (!writeOff) return { ok: false, error: 'That write-off no longer exists.' }

  const posted = await postTransaction(siteId, actor, {
    customerId: writeOff.customerId,
    docType: 'journal',
    // Negative: a journal takes the sign it is given, and this reduces what is
    // owed. See signedAmount() in ledger.ts.
    amount: -writeOff.amount,
    docDate: writeOff.writeOffDate,
    description: `${CATEGORY_LABELS[writeOff.category]} written off — ${writeOff.reason}`.slice(0, 190),
    source: 'write_off',
    sourceDocId: id,
  })
  if (!posted.ok) return { ok: false, error: posted.error }

  await siteExecute(
    siteId,
    "UPDATE debt_write_offs SET status = 'posted', transaction_id = ? WHERE id = ?",
    [posted.id, id],
  )

  if (opts.allocateToOldest !== false) {
    const debits = await openDebits(siteId, writeOff.customerId)
    let remaining = writeOff.amount
    for (const debit of debits) {
      if (remaining <= 0) break
      const amount = round(Math.min(remaining, debit.amountOutstanding), 2)
      if (amount <= 0) continue
      const result = await allocate(siteId, actor, debit.id, posted.id, amount)
      if (result.ok) remaining = round(remaining - amount, 2)
    }
  }

  return { ok: true, transactionId: posted.id }
}

export async function rejectWriteOff(
  siteId: number,
  actor: Actor,
  id: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!reason?.trim()) return { ok: false, error: 'Give a reason for rejecting it.' }

  const writeOff = await getWriteOff(siteId, id)
  if (!writeOff) return { ok: false, error: 'That write-off no longer exists.' }
  if (writeOff.status === 'posted') {
    return { ok: false, error: 'That write-off is already posted. Reverse it instead.' }
  }

  await siteExecute(
    siteId,
    "UPDATE debt_write_offs SET status = 'rejected', reason = CONCAT(reason, ' · REJECTED: ', ?) WHERE id = ?",
    [reason.trim().slice(0, 150), id],
  )
  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: writeOff.customerId,
    action: 'write_off_rejected',
    detail: `Rejected a write-off of ${writeOff.amount.toFixed(2)} — ${reason.trim()}`,
  })
  return { ok: true }
}

/**
 * The customer paid after all.
 *
 * Posts a journal putting the debt back, and stamps the original as recovered.
 * A recovery is a genuinely good outcome and one a provision calculation needs
 * to know about — writing off, then quietly re-invoicing, loses that entirely.
 */
export async function recoverWriteOff(
  siteId: number,
  actor: Actor,
  id: number,
  amount?: number,
): Promise<{ ok: true; transactionId: number } | { ok: false; error: string }> {
  const writeOff = await getWriteOff(siteId, id)
  if (!writeOff) return { ok: false, error: 'That write-off no longer exists.' }
  if (writeOff.status !== 'posted') {
    return { ok: false, error: 'Only a posted write-off can be recovered.' }
  }
  if (writeOff.recoveredAt) return { ok: false, error: 'That write-off was already recovered.' }

  const value = round(amount ?? writeOff.amount, 2)
  if (value <= 0) return { ok: false, error: 'Enter a positive amount.' }
  if (value > writeOff.amount + 0.005) {
    return { ok: false, error: `Only ${writeOff.amount.toFixed(2)} was written off.` }
  }

  const posted = await postTransaction(siteId, actor, {
    customerId: writeOff.customerId,
    docType: 'journal',
    // Positive: the debt is restored.
    amount: value,
    docDate: today(),
    description: `Bad debt recovered — reverses write-off #${id}`,
    source: 'write_off_recovery',
    sourceDocId: id,
  })
  if (!posted.ok) return { ok: false, error: posted.error }

  await siteExecute(
    siteId,
    'UPDATE debt_write_offs SET recovered_at = NOW(), recovered_txn_id = ? WHERE id = ?',
    [posted.id, id],
  )
  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: writeOff.customerId,
    action: 'write_off_recovered',
    detail: `Recovered ${value.toFixed(2)} previously written off`,
  })

  return { ok: true, transactionId: posted.id }
}

/* ── Reporting ───────────────────────────────────────────────────────────── */

export type WriteOffSummary = {
  category: WriteOffCategory
  categoryLabel: string
  count: number
  total: number
}

/**
 * Write-offs by category for a period — the figure a provision is built from
 * and the one an auditor asks for by name.
 */
export async function writeOffSummary(
  siteId: number,
  range: { from: string; to: string },
): Promise<{ rows: WriteOffSummary[]; total: number; recovered: number }> {
  const [rows, recovered] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT category, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
         FROM debt_write_offs
        WHERE status = 'posted' AND write_off_date BETWEEN ? AND ?
        GROUP BY category
        ORDER BY total DESC`,
      [range.from, range.to],
    ),
    siteQueryOne<Row>(
      siteId,
      `SELECT COALESCE(SUM(amount), 0) AS total FROM debt_write_offs
        WHERE recovered_at IS NOT NULL AND write_off_date BETWEEN ? AND ?`,
      [range.from, range.to],
    ),
  ])

  const mapped = rows.map((r) => {
    const category = String(r.category) as WriteOffCategory
    return {
      category,
      categoryLabel: CATEGORY_LABELS[category] ?? category,
      count: Number(r.n),
      total: toNum(r.total),
    }
  })

  return {
    rows: mapped,
    total: mapped.reduce((sum, r) => round(sum + r.total, 2), 0),
    recovered: toNum(recovered?.total),
  }
}

/**
 * Accounts worth writing off: nothing has moved in a long time and a balance
 * remains.
 *
 * A suggestion list, never an action. It answers "who should we look at" — the
 * decision to write any of them off stays with a person, because "no activity
 * for 180 days" describes a customer on a long project as accurately as one who
 * has gone under.
 */
export async function writeOffCandidates(
  siteId: number,
  opts: { minDaysSinceActivity?: number; minAmount?: number; limit?: number } = {},
): Promise<
  { customerId: number; code: string; name: string; balance: number; daysSinceActivity: number; oldestDue: string | null }[]
> {
  const days = Math.max(opts.minDaysSinceActivity ?? 180, 1)
  const minAmount = round(opts.minAmount ?? 0, 2)
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT c.id, c.code, c.name, c.balance,
            DATEDIFF(CURDATE(), MAX(t.doc_date)) AS days_since,
            MIN(CASE WHEN t.amount_outstanding > 0 THEN t.due_date END) AS oldest_due
       FROM customers c
       JOIN customer_transactions t ON t.customer_id = c.id
      WHERE c.balance > ?
      GROUP BY c.id, c.code, c.name, c.balance
     HAVING days_since >= ?
      ORDER BY c.balance DESC
      LIMIT ${limit}`,
    [minAmount.toFixed(4), days],
  )

  return rows.map((r) => ({
    customerId: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    balance: toNum(r.balance),
    daysSinceActivity: Number(r.days_since ?? 0),
    oldestDue: r.oldest_due === null ? null : String(r.oldest_due),
  }))
}
