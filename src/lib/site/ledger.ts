import 'server-only'
import { round } from '../decimals'

/**
 * The rules both sub-ledgers obey.
 *
 * Debtors and creditors are mirror images: the tables differ, the sign of
 * "positive" means the opposite thing, but posting, allocation and aging work
 * identically. That shared logic lives here as PURE functions — no database, no
 * siteId — so it can be reasoned about and tested on its own, and so the two
 * ledger modules cannot drift into disagreeing about what a payment does.
 *
 * The SQL itself is deliberately NOT shared. customerLedger.ts and
 * supplierLedger.ts each write their own statements against their own tables;
 * threading a table name through a query builder is how an injection bug gets
 * in, and the queries are short enough that duplicating them costs less than
 * the abstraction would.
 */

export const DOC_TYPES = [
  'invoice',
  'credit_note',
  'payment',
  'journal',
  'opening',
  'interest',
] as const
export type DocType = (typeof DOC_TYPES)[number]

/**
 * Which way a document type moves the balance.
 *
 * 'debit'  — increases what is owed (an invoice, an opening balance, interest)
 * 'credit' — decreases it (a payment, a credit note)
 * 'either' — a journal, which can correct in either direction
 *
 * Identical on both sides because the sign convention is defined per table:
 * positive always means "more is owed", whoever owes it.
 */
export const DOC_DIRECTION: Record<DocType, 'debit' | 'credit' | 'either'> = {
  invoice: 'debit',
  opening: 'debit',
  interest: 'debit',
  credit_note: 'credit',
  payment: 'credit',
  journal: 'either',
}

/** Human labels, so the two ledgers name a document type the same way. */
export const DOC_LABELS: Record<DocType, string> = {
  invoice: 'Invoice',
  credit_note: 'Credit note',
  payment: 'Payment',
  journal: 'Journal',
  opening: 'Opening balance',
  interest: 'Interest',
}

/**
 * The signed amount for a posting.
 *
 * Callers pass a POSITIVE magnitude and a doc type; this decides the sign. That
 * is deliberate — asking every call site to get the sign right is asking for
 * the one bug that silently inverts an account's balance.
 *
 * A journal is the exception: it takes the sign it is given, because "adjust
 * this account by -250" is the whole point of a journal.
 */
export function signedAmount(docType: DocType, amount: number): number {
  const direction = DOC_DIRECTION[docType]
  if (direction === 'either') return round(amount, 2)
  const magnitude = Math.abs(round(amount, 2))
  return direction === 'debit' ? magnitude : -magnitude
}

/** True when this row adds to what is owed — the side an allocation settles. */
export function isDebit(amountSigned: number): boolean {
  return amountSigned > 0
}

/**
 * The due date for a debit, given its document date and the account's terms.
 *
 * Snapshotted at posting time rather than derived at read time: changing an
 * account's terms next year must not silently re-age every invoice already
 * issued. Credits have no due date — a payment is not itself due.
 */
export function dueDateFor(docType: DocType, docDate: string, termsDays: number): string | null {
  if (DOC_DIRECTION[docType] === 'credit') return null

  const date = new Date(`${docDate}T00:00:00`)
  if (Number.isNaN(date.getTime())) return null
  date.setDate(date.getDate() + Math.max(termsDays, 0))

  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Today as yyyy-mm-dd in local time. toISOString() would shift across UTC midnight. */
export function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/* ── VAT ─────────────────────────────────────────────────────────────────── */

/**
 * Splits a VAT-inclusive amount into net and VAT.
 *
 * VAT by SUBTRACTION, never computed independently. `round2(incl * r/(1+r))`
 * and `incl - round2(incl/(1+r))` disagree by a cent roughly one time in fifty,
 * and when they do, the document total stops equalling net + VAT. Subtraction
 * reconciles exactly, always.
 *
 * This is the same rule documentMath.ts will use for sale lines. Stated here
 * too because a manually captured invoice must split identically to one the
 * till posts, or the VAT report will not tie back.
 */
export function splitVat(
  amountIncl: number,
  vatRatePct: number,
): { gross: number; net: number; vat: number } {
  const gross = round(amountIncl, 2)
  if (vatRatePct <= 0) return { gross, net: gross, vat: 0 }

  const net = round(gross / (1 + vatRatePct / 100), 2)
  return { gross, net, vat: round(gross - net, 2) }
}

/* ── Allocation ──────────────────────────────────────────────────────────── */

/** One side of a match, as the allocator needs to see it. */
export type Allocatable = {
  id: number
  docDate: string
  /** Signed and still unsettled: positive on a debit, negative on a credit. */
  outstanding: number
}

export type AllocationPlan = { debitId: number; creditId: number; amount: number }

/**
 * Matches a credit against open debits, oldest first.
 *
 * Oldest-first is the right default and the wrong law: a customer who pays
 * R5 000 without saying what it settles almost always means "the oldest
 * outstanding", so that is what happens automatically. When a remittance DOES
 * say which invoices it covers, the UI passes an explicit plan instead and this
 * is never called. Never guess when told; always guess sensibly when not.
 *
 * Returns the plan rather than executing it, so the caller can show it before
 * committing and so this stays testable without a database.
 */
export function planAutoAllocation(
  credit: Allocatable,
  openDebits: readonly Allocatable[],
): AllocationPlan[] {
  let remaining = Math.abs(round(credit.outstanding, 2))
  if (remaining <= 0) return []

  const plan: AllocationPlan[] = []
  const oldestFirst = [...openDebits]
    .filter((d) => d.outstanding > 0)
    .sort((a, b) => (a.docDate === b.docDate ? a.id - b.id : a.docDate < b.docDate ? -1 : 1))

  for (const debit of oldestFirst) {
    if (remaining <= 0) break
    const amount = round(Math.min(remaining, debit.outstanding), 2)
    if (amount <= 0) continue
    plan.push({ debitId: debit.id, creditId: credit.id, amount })
    remaining = round(remaining - amount, 2)
  }

  return plan
}

/**
 * Why this allocation cannot be made. Null means it can.
 *
 * Checked before any write, because a half-applied allocation leaves both rows
 * disagreeing about how much is settled — and nothing would report it.
 */
export function refuseAllocation(
  debit: Allocatable,
  credit: Allocatable,
  amount: number,
): string | null {
  const value = round(amount, 2)
  if (value <= 0) return 'An allocation must be for a positive amount.'
  if (debit.id === credit.id) return 'A transaction cannot be allocated against itself.'
  if (debit.outstanding <= 0) return 'That document is already fully settled.'
  if (credit.outstanding >= 0) return 'That credit has already been fully applied.'

  if (value > round(debit.outstanding, 2)) {
    return `Only ${debit.outstanding.toFixed(2)} is outstanding on that document.`
  }
  if (value > Math.abs(round(credit.outstanding, 2))) {
    return `Only ${Math.abs(credit.outstanding).toFixed(2)} of that credit is unapplied.`
  }
  return null
}

/* ── Aging ───────────────────────────────────────────────────────────────── */

export const AGING_BUCKETS = ['current', 'd30', 'd60', 'd90', 'd120'] as const
export type AgingBucket = (typeof AGING_BUCKETS)[number]

export const BUCKET_LABELS: Record<AgingBucket, string> = {
  current: 'Current',
  d30: '30 days',
  d60: '60 days',
  d90: '90 days',
  d120: '120+ days',
}

export type Aging = Record<AgingBucket, number> & { total: number }

export function emptyAging(): Aging {
  return { current: 0, d30: 0, d60: 0, d90: 0, d120: 0, total: 0 }
}

/**
 * Which bucket a debit falls in, by how many days overdue it is.
 *
 * Days are counted from the DUE date, not the document date — "30 days" on an
 * age analysis means thirty days late, not thirty days old. An invoice on
 * 30-day terms issued 45 days ago is 15 days overdue and belongs in the first
 * bucket, not the second.
 */
export function bucketFor(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return 'current'
  if (daysOverdue <= 30) return 'd30'
  if (daysOverdue <= 60) return 'd60'
  if (daysOverdue <= 90) return 'd90'
  return 'd120'
}

/** Whole days between two yyyy-mm-dd dates. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime()
  const b = new Date(`${to}T00:00:00`).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}
