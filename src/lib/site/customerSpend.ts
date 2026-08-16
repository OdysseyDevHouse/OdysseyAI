import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQueryOne } from '../siteDb'
import { toNum } from '../decimals'
import { today } from './ledger'
import type { PeriodSpend } from '../creditRules'

/**
 * How much has been charged to an account in the current day and month.
 *
 * The measurement behind the daily and monthly spend limits. The RULES that
 * use it are in lib/creditRules.ts — pure, so the till can apply them — and
 * this module is the SQL half, exactly as tillCustomers.ts is to the credit
 * limit.
 *
 * ── WHY THIS SUMS TENDERS, NOT DOCUMENT TOTALS ───────────────────────────
 *
 * A spend limit governs what was put ON THE ACCOUNT. A customer who settles a
 * R1,000 invoice with R900 cash and R100 on account has drawn R100 of credit,
 * and counting the document total would refuse them nine times too early.
 *
 * So the sum is over sales_tenders rows whose tender posts to the debtor,
 * which is the same flag the posting engine branches on when it decides an
 * account sale is happening at all.
 *
 * ── WHY IT IS DERIVED RATHER THAN A COUNTER ──────────────────────────────
 *
 * See the header of 175_customer_spend_limits.sql. Briefly: a stored counter
 * needs a reset, and every reset is a way to be wrong at midnight or after a
 * day the system was off. This has no reset, and a voided sale corrects it for
 * free because a void leaves status <> 'finalised'.
 *
 * ── CREDIT NOTES ─────────────────────────────────────────────────────────
 *
 * A credit note refunded to the account REDUCES the spend, and is included
 * for that reason: goods returned the same day were not, in the end, drawn
 * against the limit. Its tender amount is already negative on a credit note,
 * so the plain SUM does the right thing without a CASE.
 */

type Row = RowDataPacket & Record<string, unknown>

/** The first of the month containing `date`, as yyyy-mm-dd. */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`
}

/**
 * Account spend for one customer, today and this month.
 *
 * `asAt` is threaded rather than defaulted inside the query so a back-dated
 * invoice is measured against the window it actually falls in — the same rule
 * the rest of the billing code follows. Defaults to today for the till, where
 * the sale is always now.
 */
export async function accountSpend(
  siteId: number,
  customerId: number,
  asAt: string = today(),
): Promise<PeriodSpend> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT
       COALESCE(SUM(CASE WHEN d.document_date = ? THEN t.amount ELSE 0 END), 0) AS spent_today,
       COALESCE(SUM(t.amount), 0) AS spent_month
     FROM sales_documents d
     JOIN sales_tenders t   ON t.document_id = d.id
     JOIN tender_types  tt  ON tt.id = t.tender_type_id
    WHERE d.customer_id = ?
      AND d.status = 'finalised'
      AND tt.posts_to_debtor = 1
      AND d.document_date BETWEEN ? AND ?`,
    [asAt, customerId, monthStart(asAt), asAt],
  )

  return {
    today: toNum(row?.spent_today),
    month: toNum(row?.spent_month),
  }
}

/**
 * Spend for several accounts at once, keyed by customer id.
 *
 * For list screens, which would otherwise fire one query per row. Absent from
 * the map means nothing charged in the window — callers should read a miss as
 * zero rather than as unknown.
 */
export async function accountSpendFor(
  siteId: number,
  customerIds: number[],
  asAt: string = today(),
): Promise<Map<number, PeriodSpend>> {
  const spend = new Map<number, PeriodSpend>()
  if (customerIds.length === 0) return spend

  const holes = customerIds.map(() => '?').join(',')
  const { siteQuery } = await import('../siteDb')
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT d.customer_id,
       COALESCE(SUM(CASE WHEN d.document_date = ? THEN t.amount ELSE 0 END), 0) AS spent_today,
       COALESCE(SUM(t.amount), 0) AS spent_month
     FROM sales_documents d
     JOIN sales_tenders t   ON t.document_id = d.id
     JOIN tender_types  tt  ON tt.id = t.tender_type_id
    WHERE d.customer_id IN (${holes})
      AND d.status = 'finalised'
      AND tt.posts_to_debtor = 1
      AND d.document_date BETWEEN ? AND ?
    GROUP BY d.customer_id`,
    [asAt, ...customerIds, monthStart(asAt), asAt],
  )

  for (const r of rows) {
    spend.set(Number(r.customer_id), {
      today: toNum(r.spent_today),
      month: toNum(r.spent_month),
    })
  }
  return spend
}
