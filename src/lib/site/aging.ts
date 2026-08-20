import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { customerQuery, supplierQuery } from './customerDb'
import { round, toNum } from '../decimals'
import { bucketFor, daysBetween, emptyAging, today, type Aging, type AgingBucket } from './ledger'

/**
 * Age analysis for the whole book.
 *
 * Two paths, deliberately:
 *
 *   TODAY  — reads amount_outstanding directly. One indexed scan, no joins.
 *   AS AT  — reconstructs what was outstanding on a past date, because
 *            amount_outstanding is a CURRENT figure. An invoice settled last
 *            week reads as zero today, but on an as-at of a month ago it was
 *            still owing in full. Getting this wrong makes "the age analysis I
 *            printed in March" unreproducible, which is exactly when someone
 *            asks for it.
 *
 * The reconstruction is:
 *   outstanding as-at D = amount_signed − (allocations against it on or before D)
 * which is why customer_allocations.allocated_at exists and is indexed.
 *
 * `reconcileAging` proves the two paths agree when the as-at date is today. If
 * they ever disagree, one of them is wrong and the report is not trustworthy.
 */

export type AgingBasis = 'due' | 'doc'

export type AgingRow = {
  id: number
  code: string
  name: string
  status: string
  creditLimit: number
  contactName: string | null
  email: string | null
  phone: string | null
  groupName: string | null
  repName: string | null
  aging: Aging
  /** The oldest unsettled document, in days. Drives the "worst first" sort. */
  oldestDays: number
}

export type AgingOptions = {
  /** yyyy-mm-dd. Omit for today, which takes the fast path. */
  asAt?: string
  /** Age from the due date (default) or the document date. */
  basis?: AgingBasis
  /** Only accounts with something in 30+ — the collections list. */
  overdueOnly?: boolean
  groupId?: number
  repId?: number
  /**
   * One account only. For a per-account document — a statement — rather than
   * the book-wide report this function is named for.
   */
  customerId?: number
  /**
   * Rung width for the age ladder, default 30. Only a single-account caller
   * should set it: widths that differ per row would make a comparison table's
   * headings mean a different thing on every line.
   */
  bucketDays?: number
}

type Row = RowDataPacket & Record<string, unknown>

const CUSTOMER_COLUMNS = `
  c.id, c.code, c.name, c.status, c.credit_limit, c.contact_name, c.email, c.phone,
  g.name AS group_name, r.name AS rep_name
`

/**
 * Per-account aging across the book.
 *
 * Returns one row per account with a non-zero position, so a book of 4 000
 * customers of whom 200 owe anything produces 200 rows. Accounts that owe
 * nothing are not "R0.00 across the board" — they are simply not on an age
 * analysis.
 */
export async function customerAging(
  siteId: number,
  opts: AgingOptions = {},
): Promise<{ rows: AgingRow[]; totals: Aging }> {
  const asAt = opts.asAt ?? today()
  const isToday = asAt >= today()
  const basis = opts.basis ?? 'due'

  const where: string[] = []
  const params: unknown[] = []

  if (opts.groupId) {
    where.push('c.group_id = ?')
    params.push(opts.groupId)
  }
  if (opts.repId) {
    where.push('c.rep_id = ?')
    params.push(opts.repId)
  }
  // Both row helpers alias the customer table as `c`, so this one filter scopes
  // the fast path and the reconstruction alike.
  if (opts.customerId) {
    where.push('c.id = ?')
    params.push(opts.customerId)
  }

  const rows = isToday
    ? await currentRows(siteId, where, params)
    : await asAtRows(siteId, asAt, where, params)

  // Group the flat transaction rows into one bucket set per account.
  const byCustomer = new Map<number, AgingRow>()

  for (const r of rows) {
    const id = Number(r.id)
    let entry = byCustomer.get(id)
    if (!entry) {
      entry = {
        id,
        code: String(r.code),
        name: String(r.name),
        status: String(r.status),
        creditLimit: toNum(r.credit_limit),
        contactName: (r.contact_name as string | null) ?? null,
        email: (r.email as string | null) ?? null,
        phone: (r.phone as string | null) ?? null,
        groupName: (r.group_name as string | null) ?? null,
        repName: (r.rep_name as string | null) ?? null,
        aging: emptyAging(),
        oldestDays: 0,
      }
      byCustomer.set(id, entry)
    }

    const outstanding = toNum(r.outstanding)
    if (outstanding === 0) continue

    if (outstanding < 0) {
      // Unapplied credits sit in Current rather than being dropped. Money on
      // account genuinely reduces what is owed, and buckets that do not add up
      // to the balance are buckets nobody trusts.
      entry.aging.current = round(entry.aging.current + outstanding, 2)
    } else {
      const reference =
        basis === 'doc' ? String(r.doc_date) : ((r.due_date as string | null) ?? String(r.doc_date))
      const days = daysBetween(reference, asAt)
      const bucket = bucketFor(days, opts.bucketDays)
      entry.aging[bucket] = round(entry.aging[bucket] + outstanding, 2)
      if (days > entry.oldestDays) entry.oldestDays = days
    }

    entry.aging.total = round(entry.aging.total + outstanding, 2)
  }

  let result = [...byCustomer.values()].filter((r) => r.aging.total !== 0)

  if (opts.overdueOnly) {
    result = result.filter(
      (r) => r.aging.d30 + r.aging.d60 + r.aging.d90 + r.aging.d120 > 0,
    )
  }

  // Worst first: the point of this report is knowing who to chase.
  result.sort((a, b) => b.oldestDays - a.oldestDays || b.aging.total - a.aging.total)

  const totals = emptyAging()
  for (const row of result) {
    for (const bucket of ['current', 'd30', 'd60', 'd90', 'd120'] as AgingBucket[]) {
      totals[bucket] = round(totals[bucket] + row.aging[bucket], 2)
    }
    totals.total = round(totals.total + row.aging.total, 2)
  }

  return { rows: result, totals }
}

/** The fast path: amount_outstanding is already what we want. */
async function currentRows(
  siteId: number,
  where: string[],
  params: unknown[],
): Promise<Row[]> {
  const filter = where.length ? `AND ${where.join(' AND ')}` : ''
  return customerQuery<Row>(
    siteId,
    `SELECT ${CUSTOMER_COLUMNS},
            t.doc_date, t.due_date, t.amount_outstanding AS outstanding
       FROM customer_transactions t
       JOIN customers c        ON c.id = t.customer_id
       LEFT JOIN customer_groups g ON g.id = c.group_id
       LEFT JOIN sales_reps     r  ON r.id = c.rep_id
      WHERE t.amount_outstanding <> 0 ${filter}`,
    params,
  )
}

/**
 * The as-at path: rebuild what each document had outstanding on that date.
 *
 * Transactions posted after the as-at date are excluded entirely, and
 * allocations made after it are rolled back by subtracting only the matches
 * that had happened by then. A document fully settled in June therefore still
 * shows as owing on an as-at of May.
 */
async function asAtRows(
  siteId: number,
  asAt: string,
  where: string[],
  params: unknown[],
): Promise<Row[]> {
  const filter = where.length ? `AND ${where.join(' AND ')}` : ''
  return customerQuery<Row>(
    siteId,
    `SELECT ${CUSTOMER_COLUMNS},
            t.doc_date, t.due_date,
            t.amount_signed - COALESCE(a.matched, 0) AS outstanding
       FROM customer_transactions t
       JOIN customers c            ON c.id = t.customer_id
       LEFT JOIN customer_groups g ON g.id = c.group_id
       LEFT JOIN sales_reps     r  ON r.id = c.rep_id
       LEFT JOIN (
             -- What had been matched against each row by the as-at date. A
             -- debit is reduced by allocations naming it as the debit; a credit
             -- is offset by those naming it as the credit, hence the sign flip.
             SELECT debit_txn_id AS txn_id, SUM(amount) AS matched
               FROM customer_allocations WHERE allocated_at <= ?
              GROUP BY debit_txn_id
             UNION ALL
             SELECT credit_txn_id AS txn_id, -SUM(amount) AS matched
               FROM customer_allocations WHERE allocated_at <= ?
              GROUP BY credit_txn_id
            ) a ON a.txn_id = t.id
      WHERE t.doc_date <= ? ${filter}
      HAVING outstanding <> 0`,
    // The as-at is a DATE; allocations carry a DATETIME. Compare to the END of
    // that day, or a payment allocated at 14:00 on the as-at date would be
    // treated as not yet made.
    [`${asAt} 23:59:59`, `${asAt} 23:59:59`, asAt, ...params],
  )
}

/**
 * Proves the fast path and the reconstruction agree.
 *
 * Run with no as-at date, the two should produce identical totals. A difference
 * means one of them is wrong — and since the fast path is what every screen
 * shows and the reconstruction is what a historical report shows, a silent
 * disagreement is the worst outcome.
 */
export async function reconcileAging(
  siteId: number,
): Promise<{ ok: boolean; fast: Aging; rebuilt: Aging }> {
  const now = today()
  const fastResult = await customerAging(siteId, {})
  // Force the reconstruction path by asking for yesterday's-style query on
  // today's date: asAtRows is only reached when asAt < today, so shift the
  // comparison to end-of-day today via a direct call.
  const rebuiltRows = await asAtRows(siteId, now, [], [])

  const rebuilt = emptyAging()
  for (const r of rebuiltRows) {
    const outstanding = toNum(r.outstanding)
    if (outstanding === 0) continue
    if (outstanding < 0) {
      rebuilt.current = round(rebuilt.current + outstanding, 2)
    } else {
      const reference = (r.due_date as string | null) ?? String(r.doc_date)
      rebuilt[bucketFor(daysBetween(reference, now))] = round(
        rebuilt[bucketFor(daysBetween(reference, now))] + outstanding,
        2,
      )
    }
    rebuilt.total = round(rebuilt.total + outstanding, 2)
  }

  return {
    ok: round(fastResult.totals.total, 2) === round(rebuilt.total, 2),
    fast: fastResult.totals,
    rebuilt,
  }
}

/* ── Creditors ───────────────────────────────────────────────────────────── */

export type SupplierAgingRow = {
  id: number
  code: string
  name: string
  status: string
  contactName: string | null
  email: string | null
  phone: string | null
  accountNumber: string | null
  aging: Aging
  oldestDays: number
}

export type SupplierAgingOptions = {
  /** yyyy-mm-dd. Omit for today, which takes the fast path. */
  asAt?: string
  /** Age from the due date (default) or the document date. */
  basis?: AgingBasis
  /** Only accounts with something in 30+. */
  overdueOnly?: boolean
  /** One account only, for a per-supplier statement. */
  supplierId?: number
}

const SUPPLIER_COLUMNS = `
  s.id, s.code, s.name, s.status, s.contact_name, s.email, s.phone, s.account_number
`

/** The payables fast path — the mirror of currentRows above. */
async function supplierCurrentRows(
  siteId: number,
  where: string[],
  params: unknown[],
): Promise<Row[]> {
  const filter = where.length ? `AND ${where.join(' AND ')}` : ''
  return supplierQuery<Row>(
    siteId,
    `SELECT ${SUPPLIER_COLUMNS},
            t.doc_date, t.due_date, t.amount_outstanding AS outstanding
       FROM supplier_transactions t
       JOIN suppliers s ON s.id = t.supplier_id
      WHERE t.amount_outstanding <> 0 ${filter}`,
    params,
  )
}

/** The payables as-at path — the same reconstruction asAtRows does. */
async function supplierAsAtRows(
  siteId: number,
  asAt: string,
  where: string[],
  params: unknown[],
): Promise<Row[]> {
  const filter = where.length ? `AND ${where.join(' AND ')}` : ''
  return supplierQuery<Row>(
    siteId,
    `SELECT ${SUPPLIER_COLUMNS},
            t.doc_date, t.due_date,
            t.amount_signed - COALESCE(a.matched, 0) AS outstanding
       FROM supplier_transactions t
       JOIN suppliers s ON s.id = t.supplier_id
       LEFT JOIN (
             SELECT debit_txn_id AS txn_id, SUM(amount) AS matched
               FROM supplier_allocations WHERE allocated_at <= ?
              GROUP BY debit_txn_id
             UNION ALL
             SELECT credit_txn_id AS txn_id, -SUM(amount) AS matched
               FROM supplier_allocations WHERE allocated_at <= ?
              GROUP BY credit_txn_id
            ) a ON a.txn_id = t.id
      WHERE t.doc_date <= ? ${filter}
      HAVING outstanding <> 0`,
    [`${asAt} 23:59:59`, `${asAt} 23:59:59`, asAt, ...params],
  )
}

/** The payables mirror — who we owe, and how late we are paying them. */
export async function supplierAging(
  siteId: number,
  opts: SupplierAgingOptions = {},
): Promise<{ rows: SupplierAgingRow[]; totals: Aging }> {
  const asAt = opts.asAt ?? today()
  const isToday = asAt >= today()
  const basis = opts.basis ?? 'due'

  const where: string[] = []
  const params: unknown[] = []

  if (opts.supplierId) {
    where.push('s.id = ?')
    params.push(opts.supplierId)
  }

  const rows = isToday
    ? await supplierCurrentRows(siteId, where, params)
    : await supplierAsAtRows(siteId, asAt, where, params)

  const bySupplier = new Map<number, SupplierAgingRow>()

  for (const r of rows) {
    const id = Number(r.id)
    let entry = bySupplier.get(id)
    if (!entry) {
      entry = {
        id,
        code: String(r.code),
        name: String(r.name),
        status: String(r.status),
        contactName: (r.contact_name as string | null) ?? null,
        email: (r.email as string | null) ?? null,
        phone: (r.phone as string | null) ?? null,
        accountNumber: (r.account_number as string | null) ?? null,
        aging: emptyAging(),
        oldestDays: 0,
      }
      bySupplier.set(id, entry)
    }

    const outstanding = toNum(r.outstanding)
    if (outstanding === 0) continue

    if (outstanding < 0) {
      entry.aging.current = round(entry.aging.current + outstanding, 2)
    } else {
      const reference =
        basis === 'doc' ? String(r.doc_date) : ((r.due_date as string | null) ?? String(r.doc_date))
      const days = daysBetween(reference, asAt)
      entry.aging[bucketFor(days)] = round(entry.aging[bucketFor(days)] + outstanding, 2)
      if (days > entry.oldestDays) entry.oldestDays = days
    }
    entry.aging.total = round(entry.aging.total + outstanding, 2)
  }

  let result = [...bySupplier.values()].filter((r) => r.aging.total !== 0)
  if (opts.overdueOnly) {
    result = result.filter((r) => r.aging.d30 + r.aging.d60 + r.aging.d90 + r.aging.d120 > 0)
  }
  result.sort((a, b) => b.oldestDays - a.oldestDays || b.aging.total - a.aging.total)

  const totals = emptyAging()
  for (const row of result) {
    for (const bucket of ['current', 'd30', 'd60', 'd90', 'd120'] as AgingBucket[]) {
      totals[bucket] = round(totals[bucket] + row.aging[bucket], 2)
    }
    totals.total = round(totals.total + row.aging.total, 2)
  }

  return { rows: result, totals }
}
