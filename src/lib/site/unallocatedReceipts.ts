import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne } from '../siteDb'
import { customerQuery, customerQueryOne, supplierQuery } from './customerDb'
import { round, toNum } from '../decimals'
import { today } from './ledger'
import { daysBetweenDates } from './interestRules'

/**
 * Money we are holding that is not matched to anything.
 *
 * The sub-ledger has always tracked this — `amount_outstanding < 0` on a credit
 * is precisely "unapplied" — but nothing has ever put it on a screen. That
 * matters for three separate reasons, and each is a different reader:
 *
 *   The BOOKKEEPER sees payments that need allocating, before the customer
 *   phones to ask why their invoice still shows as unpaid.
 *
 *   The AGE ANALYSIS is distorted while they sit there. An account with a R10k
 *   invoice at 60 days and an unapplied R10k payment shows a 60-day debt beside
 *   a credit in `current`, which reads as a problem account and is not one.
 *
 *   The BUSINESS is holding somebody else's money. A deposit taken for an order
 *   that was never placed is a liability, and one nobody can see is one nobody
 *   refunds.
 *
 * Everything here is a READ. Allocating is customerLedger.allocate(); this
 * module only finds what needs it.
 */

export type UnallocatedCredit = {
  txnId: number
  customerId: number
  customerCode: string
  customerName: string
  docType: string
  docNumber: string | null
  docDate: string
  reference: string | null
  description: string | null
  /** The credit's full value, positive. */
  amount: number
  /** Still unapplied, positive. */
  unapplied: number
  daysHeld: number
  /** What this customer still owes that this credit could settle. */
  openDebt: number
  /** True when the account has open invoices this could be applied to. */
  canAllocate: boolean
}

type Row = RowDataPacket & Record<string, unknown>

/**
 * Every unapplied credit on the debtors book, oldest first.
 *
 * `openDebt` comes from a correlated subquery so each row can say whether it is
 * simply awaiting allocation (there are invoices to match) or is genuinely
 * money held on account with nothing to settle. Those two need different
 * actions, and a list that cannot tell them apart makes the reader open every
 * account to find out.
 */
export async function listUnallocatedCredits(
  siteId: number,
  opts: { minAmount?: number; minDaysHeld?: number; customerId?: number; limit?: number } = {},
): Promise<UnallocatedCredit[]> {
  const where: string[] = ['t.amount_outstanding < -0.004']
  const params: unknown[] = []

  if (opts.customerId) {
    where.push('t.customer_id = ?')
    params.push(opts.customerId)
  }
  if (opts.minAmount) {
    where.push('ABS(t.amount_outstanding) >= ?')
    params.push(round(opts.minAmount, 2).toFixed(4))
  }
  if (opts.minDaysHeld) {
    where.push('t.doc_date <= DATE_SUB(CURDATE(), INTERVAL ? DAY)')
    params.push(Math.max(opts.minDaysHeld, 0))
  }

  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000)

  const rows = await customerQuery<Row>(
    siteId,
    `SELECT t.id, t.customer_id, t.doc_type, t.doc_number, t.doc_date,
            t.reference, t.description, t.amount_signed, t.amount_outstanding,
            c.code AS customer_code, c.name AS customer_name,
            COALESCE((
              SELECT SUM(d.amount_outstanding) FROM customer_transactions d
               WHERE d.customer_id = t.customer_id AND d.amount_outstanding > 0
            ), 0) AS open_debt
       FROM customer_transactions t
       JOIN customers c ON c.id = t.customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY t.doc_date ASC, t.id ASC
      LIMIT ${limit}`,
    params,
  )

  const now = today()

  return rows.map((r) => {
    const openDebt = toNum(r.open_debt)
    const unapplied = Math.abs(toNum(r.amount_outstanding))
    return {
      txnId: Number(r.id),
      customerId: Number(r.customer_id),
      customerCode: String(r.customer_code),
      customerName: String(r.customer_name),
      docType: String(r.doc_type),
      docNumber: (r.doc_number as string | null) ?? null,
      docDate: String(r.doc_date),
      reference: (r.reference as string | null) ?? null,
      description: (r.description as string | null) ?? null,
      amount: Math.abs(toNum(r.amount_signed)),
      unapplied,
      daysHeld: Math.max(daysBetweenDates(String(r.doc_date), now), 0),
      openDebt,
      canAllocate: openDebt > 0.004,
    }
  })
}

export type UnallocatedSummary = {
  /** Every unapplied credit, however old. */
  total: number
  count: number
  /** The subset with invoices waiting — a tidy-up job. */
  allocatable: number
  allocatableCount: number
  /** The subset with nothing to settle — money genuinely held. */
  heldOnAccount: number
  heldOnAccountCount: number
  /** Held longer than 90 days, which is where questions start. */
  agedTotal: number
  agedCount: number
}

/**
 * The headline figures, for a dashboard tile or the top of the screen.
 *
 * Split rather than one total because the actions differ: allocatable credits
 * need someone to spend ten minutes matching them, whereas money held on
 * account with no invoices may need refunding — and a single combined number
 * prompts neither.
 */
export async function unallocatedSummary(siteId: number): Promise<UnallocatedSummary> {
  const row = await customerQueryOne<Row>(
    siteId,
    `SELECT
       COALESCE(SUM(ABS(t.amount_outstanding)), 0) AS total,
       COUNT(*) AS n,
       COALESCE(SUM(CASE WHEN d.open_debt > 0.004 THEN ABS(t.amount_outstanding) END), 0) AS allocatable,
       COUNT(CASE WHEN d.open_debt > 0.004 THEN 1 END) AS allocatable_n,
       COALESCE(SUM(CASE WHEN COALESCE(d.open_debt, 0) <= 0.004 THEN ABS(t.amount_outstanding) END), 0) AS held,
       COUNT(CASE WHEN COALESCE(d.open_debt, 0) <= 0.004 THEN 1 END) AS held_n,
       COALESCE(SUM(CASE WHEN t.doc_date <= DATE_SUB(CURDATE(), INTERVAL 90 DAY) THEN ABS(t.amount_outstanding) END), 0) AS aged,
       COUNT(CASE WHEN t.doc_date <= DATE_SUB(CURDATE(), INTERVAL 90 DAY) THEN 1 END) AS aged_n
     FROM customer_transactions t
     LEFT JOIN (
           SELECT customer_id, SUM(amount_outstanding) AS open_debt
             FROM customer_transactions WHERE amount_outstanding > 0
            GROUP BY customer_id
          ) d ON d.customer_id = t.customer_id
     WHERE t.amount_outstanding < -0.004`,
  )

  return {
    total: toNum(row?.total),
    count: Number(row?.n ?? 0),
    allocatable: toNum(row?.allocatable),
    allocatableCount: Number(row?.allocatable_n ?? 0),
    heldOnAccount: toNum(row?.held),
    heldOnAccountCount: Number(row?.held_n ?? 0),
    agedTotal: toNum(row?.aged),
    agedCount: Number(row?.aged_n ?? 0),
  }
}

/**
 * The supplier-side mirror: credits from suppliers we have not yet taken.
 *
 * A supplier credit note sitting unapplied means we are paying invoices in full
 * while holding a credit that should have reduced the payment — money genuinely
 * lost if it expires or the relationship ends.
 */
export async function listUnappliedSupplierCredits(
  siteId: number,
  opts: { limit?: number } = {},
): Promise<
  {
    txnId: number
    supplierId: number
    supplierCode: string
    supplierName: string
    docNumber: string | null
    docDate: string
    unapplied: number
    daysHeld: number
    openDebt: number
    canAllocate: boolean
  }[]
> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000)

  const rows = await supplierQuery<Row>(
    siteId,
    `SELECT t.id, t.supplier_id, t.doc_number, t.doc_date, t.amount_outstanding,
            s.code AS supplier_code, s.name AS supplier_name,
            COALESCE((
              SELECT SUM(d.amount_outstanding) FROM supplier_transactions d
               WHERE d.supplier_id = t.supplier_id AND d.amount_outstanding > 0
            ), 0) AS open_debt
       FROM supplier_transactions t
       JOIN suppliers s ON s.id = t.supplier_id
      WHERE t.amount_outstanding < -0.004
      ORDER BY t.doc_date ASC, t.id ASC
      LIMIT ${limit}`,
  )

  const now = today()

  return rows.map((r) => {
    const openDebt = toNum(r.open_debt)
    return {
      txnId: Number(r.id),
      supplierId: Number(r.supplier_id),
      supplierCode: String(r.supplier_code),
      supplierName: String(r.supplier_name),
      docNumber: (r.doc_number as string | null) ?? null,
      docDate: String(r.doc_date),
      unapplied: Math.abs(toNum(r.amount_outstanding)),
      daysHeld: Math.max(daysBetweenDates(String(r.doc_date), now), 0),
      openDebt,
      canAllocate: openDebt > 0.004,
    }
  })
}

/**
 * Bank receipts that never reached a customer account.
 *
 * A different failure from an unallocated credit, and a worse one: the money is
 * in the bank but no customer has been credited at all, so somebody's account
 * still shows a debt they have already paid. Almost always an EFT that arrived
 * with a reference nobody recognised.
 *
 * Depends on the cashbook, so it returns an empty list rather than throwing
 * where those tables are not present — the screen degrades instead of breaking.
 */
export async function unidentifiedBankReceipts(
  siteId: number,
  opts: { limit?: number } = {},
): Promise<
  { bankTxnId: number; bankAccountName: string; txnDate: string; amount: number; description: string | null; reference: string | null; daysHeld: number }[]
> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT t.id, t.txn_date, t.amount_signed, t.description, t.reference,
            a.name AS account_name
       FROM bank_transactions t
       JOIN bank_accounts a ON a.id = t.bank_account_id
       LEFT JOIN cashbook_links l ON l.bank_txn_id = t.id
      WHERE t.amount_signed > 0
        AND t.status <> 'void'
        AND l.id IS NULL
      ORDER BY t.txn_date ASC
      LIMIT ${limit}`,
  ).catch(() => [] as Row[])

  const now = today()

  return rows.map((r) => ({
    bankTxnId: Number(r.id),
    bankAccountName: String(r.account_name ?? ''),
    txnDate: String(r.txn_date),
    amount: toNum(r.amount_signed),
    description: (r.description as string | null) ?? null,
    reference: (r.reference as string | null) ?? null,
    daysHeld: Math.max(daysBetweenDates(String(r.txn_date), now), 0),
  }))
}
