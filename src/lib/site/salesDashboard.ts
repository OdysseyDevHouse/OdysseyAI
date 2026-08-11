import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne } from '../siteDb'
import { round, toNum } from '../decimals'
import { exceptionReport, type ExceptionRow } from './salesReports'

/**
 * The sales dashboard's data layer.
 *
 * Everything here is built from sales_documents + sales_document_lines +
 * sales_tenders, and follows the two conventions salesReports.ts sets out:
 *
 *   VOIDED documents are excluded from every figure. They keep their number
 *   for the audit trail, but they did not happen commercially.
 *
 *   CREDIT SALES carry negative quantities and negative money, so every
 *   aggregate is a plain SUM and returns net off sales without a single CASE.
 *
 * WHY THIS IS SEPARATE FROM salesReports.ts. The reports module answers one
 * question per call and renders it as a table. The dashboard needs a dozen
 * answers for one period, plus the same dozen for the period before it, in a
 * single round trip — and it needs two cuts (by hour, and versus a comparison
 * period) that no report asks for. Sharing the SQL and splitting the shape
 * would have meant one module doing both jobs badly.
 *
 * WHICH TIMESTAMP. Day and hour buckets read `finalised_at` — the moment the
 * sale was actually posted. `document_date` is a DATE, so it cannot answer
 * "what does the 5pm rush look like", and it is user-editable on an invoice,
 * so it is the wrong clock for "when did the money come in". The RANGE filter
 * still uses document_date, so the dashboard agrees with the reports about
 * which sales fall in the period.
 */

type Row = RowDataPacket & Record<string, unknown>

export type DateRange = { from: string; to: string }

export type SalesKpis = {
  turnoverIncl: number
  turnoverExcl: number
  grossProfit: number
  /** GP over turnover-excl, as a percentage. */
  grossProfitPct: number
  saleCount: number
  avgSaleValue: number
  avgItemsPerSale: number
}

export type HourBucket = { hour: number; turnover: number; saleCount: number }
export type DayBucket = { date: string; turnover: number; saleCount: number }
export type TenderBucket = { key: string; label: string; amount: number }

/** A ranked row for products, departments or cashiers — they share a shape. */
export type RankedRow = {
  key: string
  label: string
  qty: number
  turnoverIncl: number
  saleCount: number
  grossProfit: number
  grossProfitPct: number
}

export type SalesDashboardData = {
  kpis: SalesKpis
  /** The same KPIs one calendar month earlier. Null when that period is empty. */
  compareKpis: SalesKpis | null
  /** Human label for the comparison, e.g. "vs May 2026". */
  compareLabel: string
  perHour: HourBucket[]
  perDay: DayBucket[]
  tenderTypes: TenderBucket[]
  topProducts: RankedRow[]
  topDepartments: RankedRow[]
  topCashiers: RankedRow[]
  /**
   * Voids, credits and no-receipt returns by cashier — top five.
   *
   * Null when the caller lacks `reports.view`, which is NOT the same as an
   * empty array: one means "you may not see this", the other "there was
   * nothing to see". The widget says something different for each.
   */
  exceptions: ExceptionRow[] | null
  hasData: boolean
}

/** The dimensions the ranked tables and their "View more" modals support. */
export type DetailDimension = 'products' | 'departments' | 'cashiers'

const EMPTY_KPIS: SalesKpis = {
  turnoverIncl: 0,
  turnoverExcl: 0,
  grossProfit: 0,
  grossProfitPct: 0,
  saleCount: 0,
  avgSaleValue: 0,
  avgItemsPerSale: 0,
}

/**
 * Finalised sales and credit sales in the period — the base of every figure.
 * Matches salesReports.ts exactly so the two can never disagree about what
 * counts as a sale.
 */
const LIVE_LINES = `
  FROM sales_document_lines l
  JOIN sales_documents d ON d.id = l.document_id
 WHERE d.status = 'finalised'
   AND d.doc_type IN ('invoice','credit_sale')
   AND d.document_date BETWEEN ? AND ?
`

/* ── Dates ────────────────────────────────────────────────────────────────── */

const ISO = /^\d{4}-\d{2}-\d{2}$/

/** True for a well-formed yyyy-mm-dd. The API layer rejects anything else. */
export function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && ISO.test(value)
}

function iso(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`
}

function parseIso(value: string): Date {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/**
 * The comparison period: the same range shifted back one calendar month.
 *
 * This is what makes the KPI deltas mean something intuitive — "this month"
 * compares to last month, "today" to the same day last month, and any custom
 * range to that range a month earlier. A day number the earlier month does not
 * have (31 May → April) clamps to that month's last day rather than silently
 * rolling into the month after, which is what a naive Date does.
 */
function previousMonth(range: DateRange): DateRange {
  const shift = (value: string) => {
    const d = parseIso(value)
    const year = d.getUTCFullYear()
    const month = d.getUTCMonth()
    const lastDayOfPrevMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return iso(new Date(Date.UTC(year, month - 1, Math.min(d.getUTCDate(), lastDayOfPrevMonth))))
  }
  return { from: shift(range.from), to: shift(range.to) }
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** "vs May 2026", "vs 12 May 2026", or "vs same period in May 2026". */
function compareLabelFor(range: DateRange): string {
  const from = parseIso(range.from)
  const to = parseIso(range.to)
  const month = MONTHS[from.getUTCMonth()]
  const year = from.getUTCFullYear()

  if (range.from === range.to) return `vs ${from.getUTCDate()} ${month} ${year}`

  const lastDay = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 0)).getUTCDate()
  const wholeMonth =
    from.getUTCDate() === 1 &&
    from.getUTCMonth() === to.getUTCMonth() &&
    from.getUTCFullYear() === to.getUTCFullYear() &&
    to.getUTCDate() === lastDay
  if (wholeMonth) return `vs ${month} ${year}`

  return `vs same period in ${month} ${year}`
}

/* ── KPIs ─────────────────────────────────────────────────────────────────── */

/**
 * The headline figures for one period.
 *
 * Line totals give turnover and GP; the document count gives the basket
 * measures. Both halves run as one query each rather than one joined query,
 * because joining lines to documents and then counting documents needs a
 * COUNT(DISTINCT) over a multiplied row set — correct, but markedly slower on
 * a busy month than simply asking twice.
 *
 * `saleCount` counts INVOICES only. Credit sales are netted out of the money
 * but must not count as sales, or the average basket drops every time someone
 * returns something.
 */
async function kpisFor(siteId: number, range: DateRange): Promise<SalesKpis> {
  const [totals, docs] = await Promise.all([
    siteQueryOne<Row>(
      siteId,
      `SELECT COALESCE(SUM(l.line_total_incl), 0) AS incl,
              COALESCE(SUM(l.line_total_excl), 0) AS excl,
              COALESCE(SUM(l.unit_cost_excl * l.qty), 0) AS cost,
              COALESCE(SUM(l.qty), 0) AS units
         ${LIVE_LINES}`,
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

  const turnoverIncl = toNum(totals?.incl)
  const turnoverExcl = toNum(totals?.excl)
  const grossProfit = round(turnoverExcl - toNum(totals?.cost), 2)
  const units = toNum(totals?.units)
  const saleCount = Number(docs?.n ?? 0)

  return {
    turnoverIncl,
    turnoverExcl,
    grossProfit,
    // GP is profit over SELLING price — not over cost, which is markup.
    grossProfitPct: turnoverExcl === 0 ? 0 : round((grossProfit / turnoverExcl) * 100, 2),
    saleCount,
    avgSaleValue: saleCount === 0 ? 0 : round(toNum(docs?.total) / saleCount, 2),
    avgItemsPerSale: saleCount === 0 ? 0 : round(units / saleCount, 2),
  }
}

/* ── Ranked dimensions ────────────────────────────────────────────────────── */

/**
 * The GROUP BY key, its label, and the measure each dimension ranks by.
 *
 * Products rank by QUANTITY and the other two by turnover, because "top
 * product" almost always means the one that moves, while "top cashier" and
 * "top department" mean the one that takes the most money.
 *
 * Products and cashiers group on the values SNAPSHOTTED onto the line and the
 * document — a re-filed product or a renamed user must not restate history.
 * Departments join `departments` for the current name, matching what
 * salesReports.salesByDepartment does, so the two screens agree.
 */
const DIMENSIONS: Record<
  DetailDimension,
  { key: string; label: string; join: string; rankBy: 'turnoverIncl' | 'qty' }
> = {
  products: {
    key: `COALESCE(NULLIF(l.product_code, ''), l.description)`,
    label: `MAX(l.description)`,
    join: '',
    rankBy: 'qty',
  },
  departments: {
    key: `COALESCE(dep.id, 0)`,
    label: `COALESCE(MAX(dep.name), 'Unfiled')`,
    join: 'LEFT JOIN departments dep ON dep.id = l.department_id',
    rankBy: 'turnoverIncl',
  },
  cashiers: {
    key: `COALESCE(d.user_id, 0)`,
    label: `COALESCE(NULLIF(MAX(d.user_name), ''), 'Unknown')`,
    join: '',
    rankBy: 'turnoverIncl',
  },
}

/**
 * A ranked list for one dimension. `limit` of null returns every row — that is
 * what the "View more" modal reads; the dashboard card passes 10.
 *
 * The JOIN has to be spliced in before the WHERE, so this cannot reuse
 * LIVE_LINES wholesale — a JOIN after WHERE is invalid SQL. The predicate is
 * repeated verbatim instead of being cleverly composed, because the two must
 * stay identical and a reader can check that at a glance.
 */
export async function rankedDimension(
  siteId: number,
  range: DateRange,
  dimension: DetailDimension,
  limit: number | null = 10,
): Promise<RankedRow[]> {
  const d = DIMENSIONS[dimension]
  const order = d.rankBy === 'qty' ? 'qty DESC' : 'incl DESC'
  // Interpolated, never bound: MySQL will not take a placeholder in LIMIT, and
  // the value is a clamped number rather than anything a caller supplies raw.
  const cap = limit === null ? '' : `LIMIT ${Math.min(Math.max(limit, 1), 500)}`

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT ${d.key}                        AS \`key\`,
            ${d.label}                      AS label,
            COALESCE(SUM(l.qty), 0)              AS qty,
            COALESCE(SUM(l.line_total_incl), 0)  AS incl,
            COALESCE(SUM(l.line_total_excl), 0)  AS excl,
            COALESCE(SUM(l.unit_cost_excl * l.qty), 0) AS cost,
            COUNT(DISTINCT d.id)                 AS documents
       FROM sales_document_lines l
       JOIN sales_documents d ON d.id = l.document_id
       ${d.join}
      WHERE d.status = 'finalised'
        AND d.doc_type IN ('invoice','credit_sale')
        AND d.document_date BETWEEN ? AND ?
      GROUP BY \`key\`
      ORDER BY ${order}
      ${cap}`,
    [range.from, range.to],
  )

  return rows.map((r) => {
    const turnoverExcl = toNum(r.excl)
    const grossProfit = round(turnoverExcl - toNum(r.cost), 2)
    return {
      key: String(r.key ?? ''),
      label: String(r.label ?? '—'),
      qty: toNum(r.qty),
      turnoverIncl: toNum(r.incl),
      saleCount: Number(r.documents ?? 0),
      grossProfit,
      grossProfitPct: turnoverExcl === 0 ? 0 : round((grossProfit / turnoverExcl) * 100, 2),
    }
  })
}

/* ── The dashboard payload ────────────────────────────────────────────────── */

/**
 * Every widget's data for one period, in one payload, so the client fetches
 * once per range change rather than once per widget.
 */
export async function getSalesDashboard(
  siteId: number,
  range: DateRange,
  opts: {
    /**
     * Voids, credits and no-receipt returns by cashier. Off by default and
     * gated on `reports.view` by the caller: this names staff, so a role that
     * may see turnover must not get it for free. A flag rather than an
     * unconditional fetch so the three extra queries are not run to have their
     * results thrown away.
     */
    includeExceptions?: boolean
  } = {},
): Promise<SalesDashboardData> {
  const comparison = previousMonth(range)
  const compareLabel = compareLabelFor(comparison)

  const exceptionsPromise = opts.includeExceptions ? exceptionReport(siteId, range) : null

  const [kpis, compareRaw, hourRows, dayRows, tenderRows, topProducts, topDepartments, topCashiers] =
    await Promise.all([
      kpisFor(siteId, range),
      kpisFor(siteId, comparison),

      // By hour of day. finalised_at is nullable in the schema; a finalised
      // document always has one, but COALESCE keeps a hand-migrated row from
      // silently landing in hour 0 and inventing a midnight rush.
      siteQuery<Row>(
        siteId,
        `SELECT HOUR(COALESCE(d.finalised_at, d.created_at)) AS hour,
                COALESCE(SUM(l.line_total_incl), 0) AS turnover,
                COUNT(DISTINCT d.id)                AS documents
           ${LIVE_LINES}
           GROUP BY hour`,
        [range.from, range.to],
      ),

      siteQuery<Row>(
        siteId,
        `SELECT d.document_date                     AS date,
                COALESCE(SUM(l.line_total_incl), 0) AS turnover,
                COUNT(DISTINCT d.id)                AS documents
           ${LIVE_LINES}
           GROUP BY d.document_date`,
        [range.from, range.to],
      ),

      // Tenders answer "what money arrived", so they read the tender table and
      // net off change given. This deliberately does NOT equal turnover: a
      // credit left on account moves no money, and a refund paid out is
      // negative here. See the note on salesReports.salesByTender.
      siteQuery<Row>(
        siteId,
        `SELECT t.tender_code AS \`key\`, t.tender_name AS label,
                COALESCE(SUM(t.amount - t.change_given), 0) AS amount
           FROM sales_tenders t
           JOIN sales_documents d ON d.id = t.document_id
          WHERE d.status = 'finalised'
            AND d.document_date BETWEEN ? AND ?
          GROUP BY t.tender_code, t.tender_name
          ORDER BY amount DESC`,
        [range.from, range.to],
      ),

      rankedDimension(siteId, range, 'products', 10),
      rankedDimension(siteId, range, 'departments', 10),
      rankedDimension(siteId, range, 'cashiers', 10),
    ])

  // Fill all 24 hours so the axis is continuous and a quiet hour reads as a
  // trough rather than as a gap in the data.
  const byHour = new Map<number, Row>(hourRows.map((r) => [Number(r.hour), r]))
  const perHour: HourBucket[] = Array.from({ length: 24 }, (_, hour) => {
    const row = byHour.get(hour)
    return {
      hour,
      turnover: toNum(row?.turnover),
      saleCount: Number(row?.documents ?? 0),
    }
  })

  // Same reasoning for days: every calendar day in the range appears, so a
  // closed Sunday is a zero rather than a skipped tick.
  const byDay = new Map<string, Row>(
    dayRows.map((r) => [r.date instanceof Date ? iso(r.date) : String(r.date).slice(0, 10), r]),
  )
  const perDay: DayBucket[] = []
  for (
    let t = parseIso(range.from).getTime();
    t <= parseIso(range.to).getTime();
    t += 86_400_000
  ) {
    const date = iso(new Date(t))
    const row = byDay.get(date)
    perDay.push({
      date,
      turnover: toNum(row?.turnover),
      saleCount: Number(row?.documents ?? 0),
    })
  }

  const tenderTypes: TenderBucket[] = tenderRows
    .map((r) => ({
      key: String(r.key ?? ''),
      label: String(r.label ?? '—'),
      amount: toNum(r.amount),
    }))
    // A donut cannot draw a negative slice. A tender that netted out to zero or
    // less over the period is a refund story, and belongs in the reports, not
    // in a share-of-takings chart.
    .filter((t) => t.amount > 0)

  return {
    kpis,
    // "No comparison data" is a real state worth showing, and it is not the
    // same as a month that traded zero — the tiles say so rather than
    // rendering a meaningless "100% up".
    compareKpis: compareRaw.saleCount === 0 && compareRaw.turnoverIncl === 0 ? null : compareRaw,
    compareLabel,
    perHour,
    perDay,
    tenderTypes,
    topProducts,
    topDepartments,
    topCashiers,
    /* Null means "not entitled", which the widget states plainly. An empty
       array means a clean period, which is a different and much better thing —
       so the two must not collapse into each other. Top five: this is a prompt
       to open the report, not a replacement for it. */
    exceptions: exceptionsPromise ? (await exceptionsPromise).slice(0, 5) : null,
    hasData: kpis.saleCount > 0 || kpis.turnoverIncl !== 0,
  }
}
