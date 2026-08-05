import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne } from '../siteDb'
import { round, toNum } from '../decimals'

/**
 * Sales reporting.
 *
 * Every report here answers a question a store owner actually asks, and every
 * one is built from sales_documents + sales_document_lines with no extra
 * tables — which is why those lines snapshot the description, department and
 * cost at sale time. A report that joined back to `products` would silently
 * restate history every time a product was re-filed or re-priced.
 *
 * TWO CONVENTIONS worth stating once:
 *
 *   Voided documents are EXCLUDED from every figure. They keep their number and
 *   their lines for the audit trail, but they did not happen commercially.
 *
 *   Credit notes carry negative quantities and negative money, so every
 *   aggregate is a plain SUM. Returns net off sales without a single CASE.
 */

type Row = RowDataPacket & Record<string, unknown>

export type DateRange = { from: string; to: string }

/** Finalised sales and credit notes in the period. The base of every report. */
const LIVE_DOCS = `
  FROM sales_document_lines l
  JOIN sales_documents d ON d.id = l.document_id
 WHERE d.status = 'finalised'
   AND d.doc_type IN ('invoice','credit_sale')
   AND d.document_date BETWEEN ? AND ?
`

export type SalesSummary = {
  documents: number
  salesIncl: number
  salesExcl: number
  vat: number
  discount: number
  costExcl: number
  profit: number
  gpPct: number
  /** Average basket, on invoices only — credit notes would drag it negative. */
  averageSale: number
}

export async function salesSummary(siteId: number, range: DateRange): Promise<SalesSummary> {
  const [totals, invoices] = await Promise.all([
    siteQueryOne<Row>(
      siteId,
      `SELECT COALESCE(SUM(l.line_total_incl), 0) AS incl,
              COALESCE(SUM(l.line_total_excl), 0) AS excl,
              COALESCE(SUM(l.line_vat), 0)        AS vat,
              COALESCE(SUM(l.discount_incl), 0)   AS discount,
              COALESCE(SUM(l.unit_cost_excl * l.qty), 0) AS cost
         ${LIVE_DOCS}`,
      [range.from, range.to],
    ),
    siteQueryOne<Row>(
      siteId,
      `SELECT COUNT(*) AS n, COALESCE(SUM(total_incl), 0) AS total
         FROM sales_documents
        WHERE status = 'finalised' AND doc_type = 'invoice'
          AND document_date BETWEEN ? AND ?`,
      [range.from, range.to],
    ),
  ])

  const salesExcl = toNum(totals?.excl)
  const costExcl = toNum(totals?.cost)
  const profit = round(salesExcl - costExcl, 2)
  const count = Number(invoices?.n ?? 0)

  return {
    documents: count,
    salesIncl: toNum(totals?.incl),
    salesExcl,
    vat: toNum(totals?.vat),
    discount: toNum(totals?.discount),
    costExcl,
    profit,
    // GP is profit over SELLING price. Markup is profit over cost. They are
    // different ratios of the same two numbers and are routinely confused.
    gpPct: salesExcl === 0 ? 0 : round((profit / salesExcl) * 100, 2),
    averageSale: count === 0 ? 0 : round(toNum(invoices?.total) / count, 2),
  }
}

export type DailyRow = { date: string; documents: number; salesIncl: number; profit: number }

export async function salesByDay(siteId: number, range: DateRange): Promise<DailyRow[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT d.document_date AS date,
            COUNT(DISTINCT d.id)                       AS documents,
            COALESCE(SUM(l.line_total_incl), 0)        AS incl,
            COALESCE(SUM(l.line_total_excl - l.unit_cost_excl * l.qty), 0) AS profit
       ${LIVE_DOCS}
       GROUP BY d.document_date
       ORDER BY d.document_date`,
    [range.from, range.to],
  )
  return rows.map((r) => ({
    date: String(r.date),
    documents: Number(r.documents),
    salesIncl: toNum(r.incl),
    profit: toNum(r.profit),
  }))
}

export type GroupedRow = {
  key: string
  label: string
  qty: number
  salesIncl: number
  salesExcl: number
  costExcl: number
  profit: number
  gpPct: number
  documents: number
}

function mapGrouped(r: Row): GroupedRow {
  const salesExcl = toNum(r.excl)
  const costExcl = toNum(r.cost)
  const profit = round(salesExcl - costExcl, 2)
  return {
    key: String(r.key ?? ''),
    label: String(r.label ?? '—'),
    qty: toNum(r.qty),
    salesIncl: toNum(r.incl),
    salesExcl,
    costExcl,
    profit,
    gpPct: salesExcl === 0 ? 0 : round((profit / salesExcl) * 100, 2),
    documents: Number(r.documents ?? 0),
  }
}

/**
 * By product.
 *
 * `sort` matters more than it looks: top sellers BY REVENUE and BY PROFIT are
 * different lists, and a store that only ever sees the first one keeps pushing
 * its least profitable lines.
 */
export async function salesByProduct(
  siteId: number,
  range: DateRange,
  sort: 'revenue' | 'profit' | 'qty' = 'revenue',
  limit = 50,
): Promise<GroupedRow[]> {
  const order =
    sort === 'profit'
      ? 'profit DESC'
      : sort === 'qty'
        ? 'qty DESC'
        : 'incl DESC'
  const capped = Math.min(Math.max(limit, 1), 500)

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT COALESCE(l.product_code, l.description) AS \`key\`,
            l.description                          AS label,
            SUM(l.qty)                             AS qty,
            SUM(l.line_total_incl)                 AS incl,
            SUM(l.line_total_excl)                 AS excl,
            SUM(l.unit_cost_excl * l.qty)          AS cost,
            SUM(l.line_total_excl - l.unit_cost_excl * l.qty) AS profit,
            COUNT(DISTINCT d.id)                   AS documents
       ${LIVE_DOCS}
       GROUP BY \`key\`, l.description
       ORDER BY ${order}
       LIMIT ${capped}`,
    [range.from, range.to],
  )
  return rows.map(mapGrouped)
}

export async function salesByDepartment(
  siteId: number,
  range: DateRange,
): Promise<GroupedRow[]> {
  // The department join is written out rather than appended to LIVE_DOCS: a
  // JOIN after WHERE is invalid SQL, and LIVE_DOCS already carries its own
  // WHERE clause.
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT COALESCE(dep.id, 0)                 AS \`key\`,
            COALESCE(dep.name, 'Unfiled')       AS label,
            SUM(l.qty)                          AS qty,
            SUM(l.line_total_incl)              AS incl,
            SUM(l.line_total_excl)              AS excl,
            SUM(l.unit_cost_excl * l.qty)       AS cost,
            SUM(l.line_total_excl - l.unit_cost_excl * l.qty) AS profit,
            COUNT(DISTINCT d.id)                AS documents
       FROM sales_document_lines l
       JOIN sales_documents d        ON d.id = l.document_id
       LEFT JOIN departments dep     ON dep.id = l.department_id
      WHERE d.status = 'finalised'
        AND d.doc_type IN ('invoice','credit_sale')
        AND d.document_date BETWEEN ? AND ?
      GROUP BY \`key\`, label
      ORDER BY incl DESC`,
    [range.from, range.to],
  )
  return rows.map(mapGrouped)
}

export async function salesByCashier(siteId: number, range: DateRange): Promise<GroupedRow[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT COALESCE(d.user_id, 0)        AS \`key\`,
            COALESCE(NULLIF(d.user_name, ''), 'Unknown') AS label,
            SUM(l.qty)                    AS qty,
            SUM(l.line_total_incl)        AS incl,
            SUM(l.line_total_excl)        AS excl,
            SUM(l.unit_cost_excl * l.qty) AS cost,
            SUM(l.line_total_excl - l.unit_cost_excl * l.qty) AS profit,
            COUNT(DISTINCT d.id)          AS documents
       ${LIVE_DOCS}
       GROUP BY \`key\`, label
       ORDER BY incl DESC`,
    [range.from, range.to],
  )
  return rows.map(mapGrouped)
}

export type TenderRow = {
  tenderCode: string
  tenderName: string
  countsAsDrawerCash: boolean
  /** Net of change — what actually arrived. */
  amount: number
  transactions: number
}

/**
 * By tender type — what the bank reconciliation is done against.
 *
 * This deliberately does NOT equal the sales total, and expecting it to is a
 * mistake worth naming. It answers "what money arrived", not "what was sold":
 *
 *   A CREDIT NOTE left on an account reduces sales but moves no money, so it
 *   appears in the sales report and not here.
 *   A REFUND paid out appears here as a negative tender.
 *   A VOIDED sale is excluded from both — the money went back over the counter.
 *
 * Reconcile this against the bank statement and the drawer; reconcile
 * salesSummary against the VAT return.
 */
export async function salesByTender(siteId: number, range: DateRange): Promise<TenderRow[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT t.tender_code, t.tender_name, tt.counts_as_drawer_cash,
            SUM(t.amount - t.change_given) AS amount,
            COUNT(*)                       AS n
       FROM sales_tenders t
       JOIN sales_documents d ON d.id = t.document_id
       JOIN tender_types   tt ON tt.id = t.tender_type_id
      WHERE d.status = 'finalised' AND d.document_date BETWEEN ? AND ?
      GROUP BY t.tender_code, t.tender_name, tt.counts_as_drawer_cash
      ORDER BY amount DESC`,
    [range.from, range.to],
  )
  return rows.map((r) => ({
    tenderCode: String(r.tender_code),
    tenderName: String(r.tender_name),
    countsAsDrawerCash: !!r.counts_as_drawer_cash,
    amount: toNum(r.amount),
    transactions: Number(r.n),
  }))
}

export type VatRow = { ratePct: number; excl: number; vat: number; incl: number }

/**
 * VAT by rate, for the return.
 *
 * Grouped by the rate SNAPSHOTTED on the line, not by the current rate on the
 * product — so a rate change next year cannot restate a return already filed.
 */
export async function vatByRate(siteId: number, range: DateRange): Promise<VatRow[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT l.vat_rate_pct              AS rate,
            SUM(l.line_total_excl)      AS excl,
            SUM(l.line_vat)             AS vat,
            SUM(l.line_total_incl)      AS incl
       ${LIVE_DOCS}
       GROUP BY l.vat_rate_pct
       ORDER BY l.vat_rate_pct DESC`,
    [range.from, range.to],
  )
  return rows.map((r) => ({
    ratePct: toNum(r.rate),
    excl: toNum(r.excl),
    vat: toNum(r.vat),
    incl: toNum(r.incl),
  }))
}

/* ── The exception report ────────────────────────────────────────────────── */

export type ExceptionRow = {
  userId: number
  userName: string
  voids: number
  voidValue: number
  discountedLines: number
  discountValue: number
  creditNotes: number
  creditValue: number
  noReceiptReturns: number
}

/**
 * Voids, discounts and returns by cashier.
 *
 * The report that catches theft. Not because any one of these is wrong — every
 * shop voids sales and gives discounts — but because a cashier whose numbers
 * sit far outside their colleagues' is the pattern worth a conversation.
 *
 * A no-receipt return is called out separately: it is the easiest way to take
 * money out of a till, since there is no original sale to check it against.
 */
export async function exceptionReport(
  siteId: number,
  range: DateRange,
): Promise<ExceptionRow[]> {
  const [voids, discounts, credits] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT COALESCE(voided_by_user_id, user_id) AS uid,
              COALESCE(NULLIF(user_name, ''), 'Unknown') AS name,
              COUNT(*) AS n, COALESCE(SUM(total_incl), 0) AS value
         FROM sales_documents
        WHERE status = 'cancelled' AND document_date BETWEEN ? AND ?
        GROUP BY uid, name`,
      [range.from, range.to],
    ),
    siteQuery<Row>(
      siteId,
      `SELECT COALESCE(d.user_id, 0) AS uid,
              COALESCE(NULLIF(d.user_name, ''), 'Unknown') AS name,
              COUNT(*) AS n, COALESCE(SUM(l.discount_incl), 0) AS value
         FROM sales_document_lines l
         JOIN sales_documents d ON d.id = l.document_id
        WHERE d.status = 'finalised' AND l.discount_incl <> 0
          AND d.document_date BETWEEN ? AND ?
        GROUP BY uid, name`,
      [range.from, range.to],
    ),
    siteQuery<Row>(
      siteId,
      `SELECT COALESCE(user_id, 0) AS uid,
              COALESCE(NULLIF(user_name, ''), 'Unknown') AS name,
              COUNT(*) AS n,
              COALESCE(SUM(ABS(total_incl)), 0) AS value,
              SUM(CASE WHEN reverses_id IS NULL THEN 1 ELSE 0 END) AS no_receipt
         FROM sales_documents
        WHERE status = 'finalised' AND doc_type = 'credit_sale'
          AND document_date BETWEEN ? AND ?
        GROUP BY uid, name`,
      [range.from, range.to],
    ),
  ])

  const byUser = new Map<number, ExceptionRow>()
  const entry = (uid: number, name: string): ExceptionRow => {
    let row = byUser.get(uid)
    if (!row) {
      row = {
        userId: uid,
        userName: name,
        voids: 0,
        voidValue: 0,
        discountedLines: 0,
        discountValue: 0,
        creditNotes: 0,
        creditValue: 0,
        noReceiptReturns: 0,
      }
      byUser.set(uid, row)
    }
    return row
  }

  for (const r of voids) {
    const row = entry(Number(r.uid), String(r.name))
    row.voids = Number(r.n)
    row.voidValue = toNum(r.value)
  }
  for (const r of discounts) {
    const row = entry(Number(r.uid), String(r.name))
    row.discountedLines = Number(r.n)
    row.discountValue = toNum(r.value)
  }
  for (const r of credits) {
    const row = entry(Number(r.uid), String(r.name))
    row.creditNotes = Number(r.n)
    row.creditValue = toNum(r.value)
    row.noReceiptReturns = Number(r.no_receipt ?? 0)
  }

  // Worst first: the point is spotting who stands out.
  return [...byUser.values()].sort(
    (a, b) => b.voidValue + b.creditValue - (a.voidValue + a.creditValue),
  )
}

/**
 * Products that have not moved.
 *
 * Stock sitting on a shelf is money on a shelf. Anything with stock on hand and
 * no sale in the period is the list to look at before ordering more.
 */
export async function slowMovers(
  siteId: number,
  range: DateRange,
  limit = 100,
): Promise<{ id: number; code: string; description: string; onHand: number; value: number }[]> {
  const capped = Math.min(Math.max(limit, 1), 500)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.code, p.description, p.stock_on_hand,
            p.stock_on_hand * p.average_cost AS value
       FROM products p
      WHERE p.is_archived = 0
        AND p.stock_on_hand > 0
        AND p.product_type IN ('normal','returnable')
        AND NOT EXISTS (
              SELECT 1 FROM sales_document_lines l
                JOIN sales_documents d ON d.id = l.document_id
               WHERE l.product_id = p.id
                 AND d.status = 'finalised'
                 AND d.document_date BETWEEN ? AND ?
            )
      ORDER BY value DESC
      LIMIT ${capped}`,
    [range.from, range.to],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    description: String(r.description),
    onHand: toNum(r.stock_on_hand),
    value: toNum(r.value),
  }))
}
