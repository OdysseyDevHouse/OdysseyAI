import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { logActivityTx, type Actor } from './activityLog'
import {
  bucketFor,
  DOC_LABELS,
  daysBetween,
  dueDateFor,
  emptyAging,
  planAutoAllocation,
  refuseAllocation,
  signedAmount,
  splitVat,
  today,
  type Aging,
  type Allocatable,
  type DocType,
} from './ledger'
import { guardPosting } from './periodLocks'

/**
 * The creditors sub-ledger — the mirror of customerLedger.ts.
 *
 * Same invariant, opposite meaning: suppliers.balance always equals
 * SUM(amount_signed), and positive means WE owe THEM. An invoice is still a
 * debit and a payment still a credit, because the sign convention is defined
 * per table as "more is owed" rather than "money in" — which is what lets both
 * ledgers share ledger.ts unchanged.
 *
 * The SQL is written out rather than shared with the debtors module: threading
 * a table name through a query builder is how an injection bug gets in, and the
 * pure rules that genuinely are shared already live in ledger.ts.
 */

export type SupplierLedgerLine = {
  id: number
  supplierId: number
  docType: DocType
  docLabel: string
  docNumber: string | null
  docDate: string
  dueDate: string | null
  reference: string | null
  description: string | null
  amountGross: number
  amountVat: number
  amountNet: number
  amountSigned: number
  amountOutstanding: number
  source: string
  reversesId: number | null
  userName: string
  createdAt: Date
  runningBalance?: number
  daysOverdue?: number
}

type Row = RowDataPacket & Record<string, unknown>

function mapLine(r: Row): SupplierLedgerLine {
  const docType = String(r.doc_type) as DocType
  return {
    id: Number(r.id),
    supplierId: Number(r.supplier_id),
    docType,
    docLabel: DOC_LABELS[docType] ?? docType,
    docNumber: (r.doc_number as string | null) ?? null,
    docDate: String(r.doc_date),
    dueDate: r.due_date === null ? null : String(r.due_date),
    reference: (r.reference as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    amountGross: toNum(r.amount_gross),
    amountVat: toNum(r.amount_vat),
    amountNet: toNum(r.amount_net),
    amountSigned: toNum(r.amount_signed),
    amountOutstanding: toNum(r.amount_outstanding),
    source: String(r.source),
    reversesId: r.reverses_id === null ? null : Number(r.reverses_id),
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
  }
}

const SELECT_LINE = `
  SELECT id, supplier_id, doc_type, doc_number, doc_date, due_date, reference, description,
         amount_gross, amount_vat, amount_net, amount_signed, amount_outstanding,
         source, source_doc_id, reverses_id, user_name, created_at
    FROM supplier_transactions
`

export type LedgerOptions = { openOnly?: boolean; from?: string; to?: string; limit?: number }

export async function listSupplierLedger(
  siteId: number,
  supplierId: number,
  opts: LedgerOptions = {},
): Promise<SupplierLedgerLine[]> {
  const where: string[] = ['supplier_id = ?']
  const params: unknown[] = [supplierId]

  if (opts.openOnly) where.push('amount_outstanding <> 0')
  if (opts.from) {
    where.push('doc_date >= ?')
    params.push(opts.from)
  }
  if (opts.to) {
    where.push('doc_date <= ?')
    params.push(opts.to)
  }

  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000)
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_LINE} WHERE ${where.join(' AND ')} ORDER BY doc_date ASC, id ASC LIMIT ${limit}`,
    params,
  )

  const now = today()
  let running = 0

  return rows.map((r) => {
    const line = mapLine(r)
    running = round(running + line.amountSigned, 2)
    line.runningBalance = running
    line.daysOverdue =
      line.dueDate && line.amountOutstanding > 0 ? Math.max(daysBetween(line.dueDate, now), 0) : 0
    return line
  })
}

export async function getSupplierTransaction(
  siteId: number,
  id: number,
): Promise<SupplierLedgerLine | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_LINE} WHERE id = ? LIMIT 1`, [id])
  return row ? mapLine(row) : null
}

/** Their invoices we have not finished paying — what a payment settles. */
export async function openSupplierDebits(
  siteId: number,
  supplierId: number,
): Promise<SupplierLedgerLine[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_LINE} WHERE supplier_id = ? AND amount_outstanding > 0 ORDER BY doc_date ASC, id ASC`,
    [supplierId],
  )
  return rows.map(mapLine)
}

export async function unappliedSupplierCredits(
  siteId: number,
  supplierId: number,
): Promise<SupplierLedgerLine[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_LINE} WHERE supplier_id = ? AND amount_outstanding < 0 ORDER BY doc_date ASC, id ASC`,
    [supplierId],
  )
  return rows.map(mapLine)
}

/** Payables aging for one supplier — what is due to them, and how late we are. */
export async function supplierAgingFor(siteId: number, supplierId: number): Promise<Aging> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_LINE} WHERE supplier_id = ? AND amount_outstanding <> 0`,
    [supplierId],
  )

  const now = today()
  const aging = emptyAging()

  for (const raw of rows) {
    const line = mapLine(raw)
    if (line.amountOutstanding < 0) {
      aging.current = round(aging.current + line.amountOutstanding, 2)
    } else {
      const bucket = bucketFor(line.dueDate ? daysBetween(line.dueDate, now) : 0)
      aging[bucket] = round(aging[bucket] + line.amountOutstanding, 2)
    }
    aging.total = round(aging.total + line.amountOutstanding, 2)
  }

  return aging
}

/**
 * One supplier's aging AS IT STOOD on a past date — the creditors twin of agingAsAt.
 *
 * supplierAgingFor above reads amount_outstanding, which is the CURRENT position and
 * therefore wrong for a statement of a past period: an invoice we have since paid would
 * read as settled on a document dated before we paid it.
 *
 * No bucket width here. Suppliers have no statement cycle of ours — they decide when to
 * statement us, and this screen exists to reconcile against the document they send — so
 * the ladder stays the 30/60/90/120 every creditors report uses.
 */
export async function supplierAgingAsAt(
  siteId: number,
  supplierId: number,
  asAt: string,
): Promise<Aging> {
  const { supplierAging } = await import('./aging')
  const { rows } = await supplierAging(siteId, { asAt, supplierId })
  return rows[0]?.aging ?? emptyAging()
}

export async function supplierAgingSummary(siteId: number): Promise<Aging> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT due_date, amount_outstanding FROM supplier_transactions WHERE amount_outstanding <> 0`,
  )

  const now = today()
  const aging = emptyAging()

  for (const r of rows) {
    const outstanding = toNum(r.amount_outstanding)
    if (outstanding < 0) {
      aging.current = round(aging.current + outstanding, 2)
    } else {
      const due = r.due_date === null ? null : String(r.due_date)
      const bucket = bucketFor(due ? daysBetween(due, now) : 0)
      aging[bucket] = round(aging[bucket] + outstanding, 2)
    }
    aging.total = round(aging.total + outstanding, 2)
  }

  return aging
}

/* ── Posting ─────────────────────────────────────────────────────────────── */

export type SupplierPostInput = {
  supplierId: number
  docType: DocType
  amount: number
  docDate?: string
  docNumber?: string | null
  reference?: string | null
  description?: string | null
  vatRatePct?: number
  source?: string
  sourceDocId?: number | null
  reversesId?: number | null
  autoAllocate?: boolean
}

export type PostResult = { ok: true; id: number } | { ok: false; error: string }

export function validateSupplierPost(input: SupplierPostInput): string | null {
  if (!Number.isFinite(input.amount) || input.amount === 0) return 'Enter an amount.'
  if (input.docType !== 'journal' && input.amount < 0) {
    return 'Enter a positive amount — the document type decides the direction.'
  }
  if (Math.abs(input.amount) > 99_999_999) return 'That amount is too large.'
  if (input.docDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.docDate)) return 'That date is not valid.'
  if ((input.vatRatePct ?? 0) < 0 || (input.vatRatePct ?? 0) > 100) {
    return 'VAT rate must be between 0 and 100 percent.'
  }
  return null
}

export async function postSupplierTransaction(
  siteId: number,
  actor: Actor,
  input: SupplierPostInput,
): Promise<PostResult> {
  const invalid = validateSupplierPost(input)
  if (invalid) return { ok: false, error: invalid }

  // See postTransaction in customerLedger.ts — a closed period refuses.
  const locked = await guardPosting(siteId, input.docDate ?? today(), 'ledger')
  if (locked) return { ok: false, error: locked }

  const supplier = await siteQueryOne<Row>(
    siteId,
    'SELECT id, code, name, payment_terms_days FROM suppliers WHERE id = ? LIMIT 1',
    [input.supplierId],
  )
  if (!supplier) return { ok: false, error: 'Supplier not found.' }

  // The debtor-side reasoning applies unchanged here: the same number twice on
  // one account is a re-post or a mis-typed transaction type, never a real
  // second document. See postTransaction in customerLedger.ts.
  //
  // It matters more on this side, if anything — a supplier invoice entered
  // twice gets PAID twice.
  if (input.docNumber?.trim()) {
    const clash = await siteQueryOne<Row>(
      siteId,
      `SELECT id FROM supplier_transactions
        WHERE supplier_id = ? AND doc_number = ? AND doc_type = ? LIMIT 1`,
      [input.supplierId, input.docNumber.trim(), input.docType],
    )
    if (clash) {
      return {
        ok: false,
        error: `${input.docNumber.trim()} is already on this account as ${DOC_LABELS[input.docType].toLowerCase()} #${clash.id}. Use a different number, or reverse the original.`,
      }
    }
  }

  const docDate = input.docDate ?? today()
  const dueDate = dueDateFor(input.docType, docDate, Number(supplier.payment_terms_days ?? 30))
  const signed = signedAmount(input.docType, input.amount)
  const { gross, net, vat } = splitVat(Math.abs(signed), input.vatRatePct ?? 0)

  return siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO supplier_transactions
         (supplier_id, doc_type, doc_number, doc_date, due_date, reference, description,
          amount_gross, amount_vat, amount_net, amount_signed, amount_outstanding,
          source, source_doc_id, reverses_id, user_id, user_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.supplierId,
        input.docType,
        input.docNumber?.trim() || null,
        docDate,
        dueDate,
        input.reference?.trim() || null,
        input.description?.trim() || null,
        gross.toFixed(4),
        vat.toFixed(4),
        net.toFixed(4),
        signed.toFixed(4),
        signed.toFixed(4),
        input.source ?? 'manual',
        input.sourceDocId ?? null,
        input.reversesId ?? null,
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )
    const id = (res as { insertId: number }).insertId

    await bumpBalance(tx, input.supplierId, signed)

    await logActivityTx(tx, actor, {
      entity: 'supplier',
      entityId: input.supplierId,
      action: 'ledger',
      detail: `${DOC_LABELS[input.docType]} ${input.docNumber ?? ''} ${signed.toFixed(2)}`.replace(
        /\s+/g,
        ' ',
      ),
    })

    return { ok: true as const, id }
  }).then(async (result) => {
    if (result.ok && input.autoAllocate && signed < 0) {
      await autoAllocateSupplier(siteId, actor, result.id)
    }
    return result
  })
}

/** The only place suppliers.balance is ever written. */
async function bumpBalance(tx: PoolConnection, supplierId: number, delta: number): Promise<void> {
  await tx.execute('UPDATE suppliers SET balance = balance + ? WHERE id = ?', [
    delta.toFixed(4),
    supplierId,
  ] as never)
}

export async function reverseSupplierTransaction(
  siteId: number,
  actor: Actor,
  id: number,
  reason: string,
): Promise<PostResult> {
  if (!reason?.trim()) return { ok: false, error: 'Give a reason for the reversal.' }

  const original = await getSupplierTransaction(siteId, id)
  if (!original) return { ok: false, error: 'Transaction not found.' }

  const already = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM supplier_transactions WHERE reverses_id = ? LIMIT 1',
    [id],
  )
  if (already) return { ok: false, error: 'That transaction has already been reversed.' }

  // Both dates, per reverseTransaction in customerLedger.ts.
  const originalLocked = await guardPosting(siteId, original.docDate, 'ledger')
  if (originalLocked) {
    return {
      ok: false,
      error: `That document is dated inside a closed period. ${originalLocked}`,
    }
  }
  const todayLocked = await guardPosting(siteId, today(), 'ledger')
  if (todayLocked) return { ok: false, error: todayLocked }

  if (round(original.amountOutstanding, 2) !== round(original.amountSigned, 2)) {
    return {
      ok: false,
      error: 'That document has payments allocated against it. Unallocate them first.',
    }
  }

  return siteTransaction(siteId, async (tx) => {
    const reversed = round(-original.amountSigned, 2)

    const [res] = await tx.execute(
      `INSERT INTO supplier_transactions
         (supplier_id, doc_type, doc_number, doc_date, due_date, reference, description,
          amount_gross, amount_vat, amount_net, amount_signed, amount_outstanding,
          source, reverses_id, user_id, user_name)
       VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        original.supplierId,
        'journal',
        original.docNumber ? `REV-${original.docNumber}` : null,
        today(),
        original.reference,
        `Reversal of ${original.docLabel} ${original.docNumber ?? `#${original.id}`} — ${reason.trim()}`,
        round(-original.amountGross, 2).toFixed(4),
        round(-original.amountVat, 2).toFixed(4),
        round(-original.amountNet, 2).toFixed(4),
        reversed.toFixed(4),
        reversed.toFixed(4),
        'manual',
        original.id,
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )
    const newId = (res as { insertId: number }).insertId

    await tx.execute('UPDATE supplier_transactions SET amount_outstanding = 0 WHERE id IN (?, ?)', [
      original.id,
      newId,
    ] as never)
    await tx.execute(
      `INSERT INTO supplier_allocations (debit_txn_id, credit_txn_id, amount, user_id, user_name)
       VALUES (?,?,?,?,?)`,
      [
        original.amountSigned > 0 ? original.id : newId,
        original.amountSigned > 0 ? newId : original.id,
        Math.abs(original.amountSigned).toFixed(4),
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )

    await bumpBalance(tx, original.supplierId, reversed)

    await logActivityTx(tx, actor, {
      entity: 'supplier',
      entityId: original.supplierId,
      action: 'reverse',
      detail: `Reversed ${original.docLabel} ${original.docNumber ?? `#${original.id}`} — ${reason.trim()}`,
    })

    return { ok: true as const, id: newId }
  })
}

/* ── Allocation ──────────────────────────────────────────────────────────── */

export type AllocateResult = { ok: true; allocated: number } | { ok: false; error: string }

export async function allocateSupplier(
  siteId: number,
  actor: Actor,
  debitId: number,
  creditId: number,
  amount: number,
): Promise<AllocateResult> {
  const [debit, credit] = await Promise.all([
    getSupplierTransaction(siteId, debitId),
    getSupplierTransaction(siteId, creditId),
  ])
  if (!debit || !credit) return { ok: false, error: 'Transaction not found.' }
  if (debit.supplierId !== credit.supplierId) {
    return { ok: false, error: 'Both documents must belong to the same supplier.' }
  }

  const refusal = refuseAllocation(toAllocatable(debit), toAllocatable(credit), amount)
  if (refusal) return { ok: false, error: refusal }

  const value = round(amount, 2)

  // The balance does NOT move: allocation is bookkeeping about money already
  // posted. Touching it here would double-count the payment.
  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      `INSERT INTO supplier_allocations (debit_txn_id, credit_txn_id, amount, user_id, user_name)
            VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount), allocated_at = CURRENT_TIMESTAMP`,
      [debitId, creditId, value.toFixed(4), actor.userId, actor.userName.slice(0, 120)] as never,
    )
    await tx.execute(
      'UPDATE supplier_transactions SET amount_outstanding = amount_outstanding - ? WHERE id = ?',
      [value.toFixed(4), debitId] as never,
    )
    await tx.execute(
      'UPDATE supplier_transactions SET amount_outstanding = amount_outstanding + ? WHERE id = ?',
      [value.toFixed(4), creditId] as never,
    )
  })

  return { ok: true, allocated: value }
}

export async function unallocateSupplier(
  siteId: number,
  actor: Actor,
  debitId: number,
  creditId: number,
): Promise<AllocateResult> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT amount FROM supplier_allocations WHERE debit_txn_id = ? AND credit_txn_id = ? LIMIT 1',
    [debitId, creditId],
  )
  if (!row) return { ok: false, error: 'That allocation no longer exists.' }

  const value = toNum(row.amount)

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      'DELETE FROM supplier_allocations WHERE debit_txn_id = ? AND credit_txn_id = ?',
      [debitId, creditId] as never,
    )
    await tx.execute(
      'UPDATE supplier_transactions SET amount_outstanding = amount_outstanding + ? WHERE id = ?',
      [value.toFixed(4), debitId] as never,
    )
    await tx.execute(
      'UPDATE supplier_transactions SET amount_outstanding = amount_outstanding - ? WHERE id = ?',
      [value.toFixed(4), creditId] as never,
    )
    await logActivityTx(tx, actor, {
      entity: 'supplier',
      entityId: 0,
      action: 'unallocate',
      detail: `Unallocated ${value.toFixed(2)} between #${debitId} and #${creditId}`,
    })
  })

  return { ok: true, allocated: value }
}

export async function autoAllocateSupplier(
  siteId: number,
  actor: Actor,
  creditId: number,
): Promise<AllocateResult> {
  const credit = await getSupplierTransaction(siteId, creditId)
  if (!credit) return { ok: false, error: 'Transaction not found.' }
  if (credit.amountOutstanding >= 0) return { ok: false, error: 'Nothing left to apply.' }

  const debits = await openSupplierDebits(siteId, credit.supplierId)
  const plan = planAutoAllocation(toAllocatable(credit), debits.map(toAllocatable))

  let total = 0
  for (const step of plan) {
    const result = await allocateSupplier(siteId, actor, step.debitId, step.creditId, step.amount)
    if (result.ok) total = round(total + result.allocated, 2)
  }

  return { ok: true, allocated: total }
}

function toAllocatable(line: SupplierLedgerLine): Allocatable {
  return { id: line.id, docDate: line.docDate, outstanding: line.amountOutstanding }
}

/* ── Reconciliation ──────────────────────────────────────────────────────── */

export type BalanceDrift = {
  id: number
  code: string
  name: string
  stored: number
  computed: number
  drift: number
}

/** See reconcileBalances in customerLedger.ts — same contract, same reasoning. */
export async function reconcileSupplierBalances(siteId: number): Promise<BalanceDrift[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT s.id, s.code, s.name,
            s.balance                     AS stored,
            COALESCE(t.ledger_total, 0)   AS computed,
            s.balance - COALESCE(t.ledger_total, 0) AS drift
       FROM suppliers s
       LEFT JOIN (
             SELECT supplier_id, SUM(amount_signed) AS ledger_total
               FROM supplier_transactions
              GROUP BY supplier_id
            ) t ON t.supplier_id = s.id
      WHERE ABS(s.balance - COALESCE(t.ledger_total, 0)) > 0.0001
      ORDER BY ABS(s.balance - COALESCE(t.ledger_total, 0)) DESC`,
  )

  return rows.map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    stored: toNum(r.stored),
    computed: toNum(r.computed),
    drift: toNum(r.drift),
  }))
}
