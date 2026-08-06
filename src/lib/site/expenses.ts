import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { nextDocumentNumber } from './sequences'
import { postSupplierTransaction } from './supplierLedger'
import { guardPosting } from './periodLocks'
import { today, dueDateFor } from './ledger'
import {
  computeTotals,
  refuseExpense,
  type ExpenseLineInput,
  type ExpensePaymentType,
  type ExpenseStatus,
} from '../expenseModel'

/**
 * Expenses — spending that is not stock.
 *
 * ── THE BRANCH THAT MATTERS ──────────────────────────────────────────────
 *
 * Two events wear the same word, and finalise() is where they part:
 *
 *   ON ACCOUNT — a supplier bill. Posts to supplier_transactions, so it joins
 *   the payables age analysis and can be settled by a payment run. Nothing
 *   leaves the bank yet.
 *
 *   DIRECT — money already gone. Posts straight to the cashbook against the
 *   account it came out of. No liability is ever created, because there never
 *   was one.
 *
 * Everything before that branch — capture, lines, VAT split, validation — is
 * identical, which is why they are one table and one screen.
 *
 * ── WHAT AN EXPENSE NEVER DOES ───────────────────────────────────────────
 *
 * It never touches stock and never moves average_cost. That is the whole
 * distinction from a GRV, and it is enforced by this module simply not
 * importing stockMovements — see the note at the top of 042.
 */

export type ExpenseLine = {
  id: number
  lineNumber: number
  categoryId: number
  categoryCode: string | null
  categoryName: string | null
  description: string | null
  departmentId: number | null
  departmentName?: string | null
  vatRatePct: number
  lineExcl: number
  lineVat: number
  lineIncl: number
  vatClaimable: boolean
}

export type Expense = {
  id: number
  status: ExpenseStatus
  documentNumber: string | null
  expenseDate: string
  dueDate: string | null
  paymentType: ExpensePaymentType
  supplierId: number | null
  supplierName: string | null
  supplierInvoiceNo: string | null
  bankAccountId: number | null
  bankAccountName?: string | null
  bankTxnId: number | null
  supplierTxnId: number | null
  subtotalExcl: number
  vatTotal: number
  totalIncl: number
  /** The part of vatTotal the VAT return may claim. */
  vatClaimable: number
  reference: string | null
  description: string | null
  notes: string | null
  recurringId: number | null
  reversesId: number | null
  userName: string
  finalisedAt: Date | null
  createdAt: Date
  lines: ExpenseLine[]
}

type Row = RowDataPacket & Record<string, unknown>

function mapExpense(r: Row, lines: ExpenseLine[] = []): Expense {
  return {
    id: Number(r.id),
    status: String(r.status) as ExpenseStatus,
    documentNumber: (r.document_number as string | null) ?? null,
    expenseDate: String(r.expense_date),
    dueDate: r.due_date === null ? null : String(r.due_date),
    paymentType: String(r.payment_type) as ExpensePaymentType,
    supplierId: r.supplier_id === null ? null : Number(r.supplier_id),
    supplierName: (r.supplier_name as string | null) ?? null,
    supplierInvoiceNo: (r.supplier_invoice_no as string | null) ?? null,
    bankAccountId: r.bank_account_id === null ? null : Number(r.bank_account_id),
    bankAccountName: (r.bank_account_name as string | null) ?? null,
    bankTxnId: r.bank_txn_id === null ? null : Number(r.bank_txn_id),
    supplierTxnId: r.supplier_txn_id === null ? null : Number(r.supplier_txn_id),
    subtotalExcl: toNum(r.subtotal_excl),
    vatTotal: toNum(r.vat_total),
    totalIncl: toNum(r.total_incl),
    vatClaimable: toNum(r.vat_claimable),
    reference: (r.reference as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    recurringId: r.recurring_id === null ? null : Number(r.recurring_id),
    reversesId: r.reverses_id === null ? null : Number(r.reverses_id),
    userName: String(r.user_name ?? ''),
    finalisedAt: (r.finalised_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
    lines,
  }
}

function mapLine(r: Row): ExpenseLine {
  return {
    id: Number(r.id),
    lineNumber: Number(r.line_number),
    categoryId: Number(r.category_id),
    categoryCode: (r.category_code as string | null) ?? null,
    categoryName: (r.category_name as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    departmentId: r.department_id === null ? null : Number(r.department_id),
    departmentName: (r.department_name as string | null) ?? null,
    vatRatePct: toNum(r.vat_rate_pct),
    lineExcl: toNum(r.line_excl),
    lineVat: toNum(r.line_vat),
    lineIncl: toNum(r.line_incl),
    vatClaimable: Boolean(r.vat_claimable),
  }
}

const SELECT_EXPENSE = `
  SELECT e.*, b.name AS bank_account_name
    FROM expenses e
    LEFT JOIN bank_accounts b ON b.id = e.bank_account_id
`

/* ── Reads ───────────────────────────────────────────────────────────────── */

export type ExpenseListOptions = {
  status?: ExpenseStatus
  from?: string
  to?: string
  supplierId?: number
  categoryId?: number
  paymentType?: ExpensePaymentType
  search?: string
  limit?: number
  offset?: number
}

export async function listExpenses(
  siteId: number,
  opts: ExpenseListOptions = {},
): Promise<{ items: Expense[]; total: number }> {
  const where: string[] = []
  const params: unknown[] = []

  if (opts.status) {
    where.push('e.status = ?')
    params.push(opts.status)
  } else {
    // A voided expense is a correction, not a cost. Hiding it by default keeps
    // the list a list of what was actually spent; it is one filter away.
    where.push("e.status <> 'void'")
  }
  if (opts.from) {
    where.push('e.expense_date >= ?')
    params.push(opts.from)
  }
  if (opts.to) {
    where.push('e.expense_date <= ?')
    params.push(opts.to)
  }
  if (opts.supplierId) {
    where.push('e.supplier_id = ?')
    params.push(opts.supplierId)
  }
  if (opts.paymentType) {
    where.push('e.payment_type = ?')
    params.push(opts.paymentType)
  }
  if (opts.categoryId) {
    where.push('EXISTS (SELECT 1 FROM expense_lines l WHERE l.expense_id = e.id AND l.category_id = ?)')
    params.push(opts.categoryId)
  }
  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`
    where.push(
      '(e.document_number LIKE ? OR e.supplier_name LIKE ? OR e.supplier_invoice_no LIKE ? OR e.description LIKE ? OR e.reference LIKE ?)',
    )
    params.push(term, term, term, term, term)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)

  const [rows, countRow] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `${SELECT_EXPENSE} ${whereSql}
        ORDER BY e.expense_date DESC, e.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    siteQueryOne<Row>(siteId, `SELECT COUNT(*) AS n FROM expenses e ${whereSql}`, params),
  ])

  return { items: rows.map((r) => mapExpense(r)), total: Number(countRow?.n ?? 0) }
}

export async function getExpense(siteId: number, id: number): Promise<Expense | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_EXPENSE} WHERE e.id = ? LIMIT 1`, [id])
  if (!row) return null

  const lines = await siteQuery<Row>(
    siteId,
    `SELECT l.*, d.name AS department_name
       FROM expense_lines l
       LEFT JOIN departments d ON d.id = l.department_id
      WHERE l.expense_id = ?
      ORDER BY l.line_number`,
    [id],
  )

  return mapExpense(row, lines.map(mapLine))
}

/**
 * Whether this supplier invoice number has been captured before.
 *
 * The commonest expense error is booking the same bill twice, and it silently
 * overstates costs and understates profit. Surfaced as a warning rather than a
 * refusal: a supplier may legitimately reuse a number across years.
 */
export async function findDuplicate(
  siteId: number,
  supplierId: number,
  supplierInvoiceNo: string,
  excludeId = 0,
): Promise<Expense | null> {
  if (!supplierInvoiceNo.trim()) return null

  const row = await siteQueryOne<Row>(
    siteId,
    `${SELECT_EXPENSE}
      WHERE e.supplier_id = ? AND e.supplier_invoice_no = ?
        AND e.status <> 'void' AND e.id <> ?
      LIMIT 1`,
    [supplierId, supplierInvoiceNo.trim(), excludeId],
  )
  return row ? mapExpense(row) : null
}

/* ── Capture ─────────────────────────────────────────────────────────────── */

export type ExpenseInput = {
  expenseDate?: string
  paymentType: ExpensePaymentType
  supplierId?: number | null
  supplierName?: string | null
  supplierInvoiceNo?: string | null
  bankAccountId?: number | null
  reference?: string | null
  description?: string | null
  notes?: string | null
  lines: ExpenseLineInput[]
  recurringId?: number | null
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

/**
 * Saves a draft. Posts nothing.
 *
 * Drafts exist so a bill can be captured now and checked later — and because
 * the recurring schedule generates them. Nothing about a draft is trusted:
 * finalise() re-reads the categories and recomputes every total rather than
 * believing what was stored, because a category's VAT treatment may have
 * changed between capture and posting.
 */
export async function saveDraft(
  siteId: number,
  actor: Actor,
  input: ExpenseInput,
  existingId?: number,
): Promise<SaveResult> {
  const refusal = refuseExpense(input)
  if (refusal) return { ok: false, error: refusal }

  const expenseDate = input.expenseDate ?? today()
  const resolved = await resolveLines(siteId, input.lines)
  if (!resolved.ok) return resolved

  const totals = computeTotals(resolved.lines)

  return siteTransaction(siteId, async (tx) => {
    let id = existingId ?? 0

    if (id) {
      const existing = await siteQueryOne<Row>(
        siteId,
        'SELECT status FROM expenses WHERE id = ? LIMIT 1',
        [id],
      )
      if (!existing) return { ok: false as const, error: 'That expense no longer exists.' }
      if (String(existing.status) !== 'draft') {
        return { ok: false as const, error: 'Only a draft can be edited. Void it and capture again.' }
      }

      await tx.execute(
        `UPDATE expenses
            SET expense_date = ?, payment_type = ?, supplier_id = ?, supplier_name = ?,
                supplier_invoice_no = ?, bank_account_id = ?, reference = ?, description = ?,
                notes = ?, subtotal_excl = ?, vat_total = ?, total_incl = ?, vat_claimable = ?
          WHERE id = ?`,
        [
          expenseDate,
          input.paymentType,
          input.supplierId ?? null,
          input.supplierName?.trim() || null,
          input.supplierInvoiceNo?.trim() || null,
          input.bankAccountId ?? null,
          input.reference?.trim() || null,
          input.description?.trim() || null,
          input.notes?.trim() || null,
          totals.subtotalExcl.toFixed(4),
          totals.vatTotal.toFixed(4),
          totals.totalIncl.toFixed(4),
          totals.vatClaimable.toFixed(4),
          id,
        ] as never,
      )
      await tx.execute('DELETE FROM expense_lines WHERE expense_id = ?', [id] as never)
    } else {
      const [res] = await tx.execute(
        `INSERT INTO expenses
           (status, expense_date, payment_type, supplier_id, supplier_name, supplier_invoice_no,
            bank_account_id, reference, description, notes,
            subtotal_excl, vat_total, total_incl, vat_claimable, recurring_id, user_id, user_name)
         VALUES ('draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          expenseDate,
          input.paymentType,
          input.supplierId ?? null,
          input.supplierName?.trim() || null,
          input.supplierInvoiceNo?.trim() || null,
          input.bankAccountId ?? null,
          input.reference?.trim() || null,
          input.description?.trim() || null,
          input.notes?.trim() || null,
          totals.subtotalExcl.toFixed(4),
          totals.vatTotal.toFixed(4),
          totals.totalIncl.toFixed(4),
          totals.vatClaimable.toFixed(4),
          input.recurringId ?? null,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      id = (res as { insertId: number }).insertId
    }

    await insertLines(tx, id, resolved.lines, totals)

    return { ok: true as const, id }
  })
}

/** Writes the line rows with their computed splits. Shared by save and finalise. */
async function insertLines(
  tx: PoolConnection,
  expenseId: number,
  lines: readonly ResolvedLine[],
  totals: ReturnType<typeof computeTotals>,
): Promise<void> {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const computed = totals.lines[i]
    await tx.execute(
      `INSERT INTO expense_lines
         (expense_id, line_number, category_id, category_code, category_name, description,
          department_id, vat_rate_pct, line_excl, line_vat, line_incl, vat_claimable)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        expenseId,
        i + 1,
        line.categoryId,
        line.categoryCode,
        line.categoryName,
        line.description?.trim() || null,
        line.departmentId ?? null,
        line.vatRatePct,
        computed.excl.toFixed(4),
        computed.vat.toFixed(4),
        computed.incl.toFixed(4),
        line.vatClaimable !== false,
      ] as never,
    )
  }
}

type ResolvedLine = ExpenseLineInput & {
  categoryCode: string | null
  categoryName: string | null
}

/**
 * Fills each line's category snapshot and applies the category's VAT rules.
 *
 * The category is the authority on whether input VAT may be claimed, not the
 * form: entertainment is denied by section 17(2)(a) of the VAT Act however the
 * invoice is worded, and a screen that let someone tick "claimable" on it would
 * be helping them file an incorrect return.
 */
async function resolveLines(
  siteId: number,
  lines: readonly ExpenseLineInput[],
): Promise<{ ok: true; lines: ResolvedLine[] } | { ok: false; error: string }> {
  const ids = [...new Set(lines.map((l) => l.categoryId))]
  if (ids.length === 0) return { ok: false, error: 'Add at least one line.' }

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, account_code, name, vat_claimable, is_active
       FROM expense_categories WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )

  const byId = new Map(rows.map((r) => [Number(r.id), r]))

  const resolved: ResolvedLine[] = []
  for (const line of lines) {
    const category = byId.get(line.categoryId)
    if (!category) return { ok: false, error: 'One of those categories no longer exists.' }
    if (!category.is_active) {
      return { ok: false, error: `${category.name} is no longer an active category.` }
    }

    resolved.push({
      ...line,
      categoryCode: String(category.account_code),
      categoryName: String(category.name),
      // The category decides, always. A claimable flag from the form is ignored.
      vatClaimable: Boolean(category.vat_claimable),
    })
  }

  return { ok: true, lines: resolved }
}

/* ── Finalising ──────────────────────────────────────────────────────────── */

export type FinaliseResult =
  | { ok: true; id: number; documentNumber: string; supplierTxnId: number | null; bankTxnId: number | null }
  | { ok: false; error: string }

/**
 * Posts an expense: number issued, and the money recorded where it went.
 *
 * ── THE ORDERING, AND WHY ────────────────────────────────────────────────
 *
 * The document number and the expense row commit FIRST, in their own
 * transaction. The ledger or cashbook posting follows. A failure between the
 * two leaves a finalised expense with no ledger entry — visible, reportable,
 * and fixable — whereas the reverse would leave money recorded against a
 * document nobody can find.
 *
 * The same reasoning postTransaction() gives for deferring auto-allocation.
 */
export async function finalise(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<FinaliseResult> {
  const expense = await getExpense(siteId, id)
  if (!expense) return { ok: false, error: 'That expense no longer exists.' }
  if (expense.status === 'finalised') return { ok: false, error: 'That expense is already posted.' }
  if (expense.status === 'void') return { ok: false, error: 'That expense was voided.' }
  if (expense.lines.length === 0) return { ok: false, error: 'There is nothing on this expense.' }

  const locked = await guardPosting(siteId, expense.expenseDate, 'purchases')
  if (locked) return { ok: false, error: locked }

  // Re-validate against the CURRENT state rather than trusting the draft: a
  // category may have been deactivated or its VAT treatment changed since.
  const refusal = refuseExpense({
    expenseDate: expense.expenseDate,
    paymentType: expense.paymentType,
    supplierId: expense.supplierId,
    supplierName: expense.supplierName,
    bankAccountId: expense.bankAccountId,
    lines: expense.lines.map((l) => ({
      categoryId: l.categoryId,
      amountIncl: l.lineIncl,
      vatRatePct: l.vatRatePct,
      vatClaimable: l.vatClaimable,
    })),
  })
  if (refusal) return { ok: false, error: refusal }

  // Issue the number and mark it posted, atomically.
  const documentNumber = await siteTransaction(siteId, async (tx) => {
    const number = await nextDocumentNumber(tx, 'expense')
    await tx.execute(
      `UPDATE expenses
          SET status = 'finalised', document_number = ?, finalised_at = NOW()
        WHERE id = ? AND status = 'draft'`,
      [number, id] as never,
    )
    return number
  })

  let supplierTxnId: number | null = null
  let bankTxnId: number | null = null

  if (expense.paymentType === 'on_account' && expense.supplierId) {
    // A bill: they are owed. Terms come from the supplier, snapshotted by the
    // sub-ledger exactly as a GRV's would be.
    const posted = await postSupplierTransaction(siteId, actor, {
      supplierId: expense.supplierId,
      docType: 'invoice',
      amount: expense.totalIncl,
      docDate: expense.expenseDate,
      docNumber: expense.supplierInvoiceNo ?? documentNumber,
      reference: expense.reference,
      description: expense.description ?? `Expense ${documentNumber}`,
      vatRatePct: expense.subtotalExcl > 0
        ? round((expense.vatTotal / expense.subtotalExcl) * 100, 2)
        : 0,
      source: 'expense',
      sourceDocId: id,
    })

    if (posted.ok) {
      supplierTxnId = posted.id
      await siteExecute(siteId, 'UPDATE expenses SET supplier_txn_id = ?, due_date = ? WHERE id = ?', [
        posted.id,
        await supplierDueDate(siteId, expense.supplierId, expense.expenseDate),
        id,
      ])
    }
  } else if (expense.bankAccountId) {
    // A direct payment: the money is already gone. Negative — out of the
    // account, per the cashbook's sign convention.
    const { captureTransaction } = await import('./cashbook')
    const captured = await captureTransaction(siteId, actor, {
      bankAccountId: expense.bankAccountId,
      amount: -expense.totalIncl,
      txnDate: expense.expenseDate,
      description:
        expense.description ??
        `${expense.supplierName ?? 'Expense'} · ${documentNumber}`,
      reference: expense.reference ?? expense.supplierInvoiceNo,
      source: 'expense',
      sourceDocId: id,
    })

    if (captured.ok) {
      bankTxnId = captured.id
      await siteExecute(siteId, 'UPDATE expenses SET bank_txn_id = ? WHERE id = ?', [
        captured.id,
        id,
      ])
    }
  }

  await logActivity(siteId, actor, {
    entity: 'expense',
    entityId: id,
    action: 'finalise',
    detail: `${documentNumber} · ${expense.totalIncl.toFixed(2)} · ${expense.supplierName ?? 'no payee'}`,
  })

  return { ok: true, id, documentNumber, supplierTxnId, bankTxnId }
}

async function supplierDueDate(
  siteId: number,
  supplierId: number,
  docDate: string,
): Promise<string | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT payment_terms_days FROM suppliers WHERE id = ? LIMIT 1',
    [supplierId],
  )
  return dueDateFor('invoice', docDate, Number(row?.payment_terms_days ?? 30))
}

/* ── Voiding ─────────────────────────────────────────────────────────────── */

/**
 * Reverses a posted expense.
 *
 * Kept, never deleted, per 014's rule. The ledger side is reversed through the
 * sub-ledger's own reverseSupplierTransaction so the audit trail reads the same
 * as any other reversal; the cashbook side is voided, which backs the money out
 * without posting a confusing mirror line.
 *
 * Refuses once the bill has been part-paid: unwinding an expense whose
 * liability has been settled would leave the payment allocated to nothing.
 */
export async function voidExpense(
  siteId: number,
  actor: Actor,
  id: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!reason?.trim()) return { ok: false, error: 'Give a reason.' }

  const expense = await getExpense(siteId, id)
  if (!expense) return { ok: false, error: 'That expense no longer exists.' }
  if (expense.status === 'void') return { ok: false, error: 'That expense is already void.' }

  const locked = await guardPosting(siteId, expense.expenseDate, 'purchases')
  if (locked) return { ok: false, error: locked }

  // A draft never posted anything, so it just becomes void.
  if (expense.status === 'draft') {
    await siteExecute(siteId, "UPDATE expenses SET status = 'void' WHERE id = ?", [id])
    return { ok: true }
  }

  if (expense.supplierTxnId) {
    const txn = await siteQueryOne<Row>(
      siteId,
      'SELECT amount_signed, amount_outstanding FROM supplier_transactions WHERE id = ? LIMIT 1',
      [expense.supplierTxnId],
    )
    if (txn && round(toNum(txn.amount_outstanding), 2) !== round(toNum(txn.amount_signed), 2)) {
      return {
        ok: false,
        error: 'That bill has been paid, in part or in full. Reverse the payment first.',
      }
    }

    const { reverseSupplierTransaction } = await import('./supplierLedger')
    const reversed = await reverseSupplierTransaction(
      siteId,
      actor,
      expense.supplierTxnId,
      reason.trim(),
    )
    if (!reversed.ok) return { ok: false, error: reversed.error }
  }

  if (expense.bankTxnId) {
    const { voidTransaction } = await import('./cashbook')
    const voided = await voidTransaction(siteId, actor, expense.bankTxnId, reason.trim())
    if (!voided.ok) return { ok: false, error: voided.error }
  }

  await siteExecute(
    siteId,
    "UPDATE expenses SET status = 'void', notes = CONCAT(COALESCE(notes,''), ' · VOID: ', ?) WHERE id = ?",
    [reason.trim().slice(0, 190), id],
  )

  await logActivity(siteId, actor, {
    entity: 'expense',
    entityId: id,
    action: 'void',
    detail: `Voided ${expense.documentNumber ?? `#${id}`} — ${reason.trim()}`,
  })

  return { ok: true }
}

/** Deletes a draft outright. Only ever a draft — a posted expense is voided. */
export async function deleteDraft(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const expense = await getExpense(siteId, id)
  if (!expense) return { ok: false, error: 'That expense no longer exists.' }
  if (expense.status !== 'draft') {
    return { ok: false, error: 'Only a draft can be deleted. Void it instead.' }
  }

  await siteExecute(siteId, 'DELETE FROM expenses WHERE id = ?', [id])
  await logActivity(siteId, actor, {
    entity: 'expense',
    entityId: null,
    action: 'delete_draft',
    detail: `Discarded a draft expense of ${expense.totalIncl.toFixed(2)}`,
  })
  return { ok: true }
}

export type { ExpenseLineInput, ExpensePaymentType, ExpenseStatus }
