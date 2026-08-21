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
 *
 * ── WHY A SHARED CUSTOMER FILE MAKES THIS SUM EVERY BRANCH ───────────────
 *
 * The limit is ONE number on ONE account. When a group shares its customer
 * file, that account is the group's — but the tenders that draw against it stay
 * in the shop that took them, because a sale belongs to the branch that made
 * it.
 *
 * Summed locally, each branch measures only its own tenders against a
 * group-wide cap. A customer with a R5,000 daily limit draws R5,000 at every
 * one of five branches on the same day and each till approves, because none of
 * them can see the other four. R25,000 goes out against a R5,000 cap. The
 * credit limit still binds — it is checked against the shared BALANCE, which is
 * one figure — so this is bounded rather than unbounded, but the daily and
 * monthly caps exist precisely to govern the RATE of drawdown and locally they
 * do not govern it at all.
 *
 * So under sharing the sum fans out across the member stores. That is the only
 * honest measurement: there is nowhere else the tenders could be read from,
 * since they were never copied anywhere.
 *
 * ── WHAT THE FAN-OUT COSTS, AND WHY IT IS ACCEPTABLE HERE ────────────────
 *
 * One query per member store, on the till's path to finalising an account
 * sale. Three things keep it small:
 *
 *   · The caller skips this entirely unless a daily or monthly cap is set,
 *     which is the uncommon case (salesPosting.ts).
 *   · Every member is on the same MariaDB instance — a precondition of sharing
 *     (015) — so these are local connections from a warm pool.
 *   · A single store, and a group that does not share, take the original
 *     single-query path untouched.
 *
 * A store that cannot be read is NOT silently skipped: dropping it would make
 * the spend look smaller and let a limit through that should have refused.
 * The refusal for an unreadable member is the caller's decision, so this
 * reports what it could not read rather than deciding for it.
 */

type Row = RowDataPacket & Record<string, unknown>

/** The first of the month containing `date`, as yyyy-mm-dd. */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`
}

/**
 * The stores whose tenders draw against this site's customer limits.
 *
 * Just [siteId] for a single shop and for a group that does not share, which
 * keeps every existing site on exactly one query.
 *
 * Never throws: a control-database problem must not stop a sale. Falling back
 * to the local store is what the site did before sharing existed — it can
 * under-measure, but the caller is told, and the alternative is a till that
 * cannot finalise because a sibling's registry row was slow.
 */
async function spendSites(siteId: number): Promise<number[]> {
  try {
    const { customerFileIsShared, customerOwnerSite, groupForSite, membersOfGroup } = await import(
      '../storeGroups'
    )
    if (!(await customerFileIsShared(siteId))) return [siteId]

    const owner = await customerOwnerSite(siteId)
    const group = await groupForSite(siteId)
    if (!group) return [siteId]

    // Only members that actually route to the same owner. shares_customers is
    // what a member asked for, not what the resolver does — see
    // debtorsGroupScope() in chartOfAccounts.ts for the same distinction.
    const sites: number[] = []
    for (const m of await membersOfGroup(group.id)) {
      if (!m.hasDatabase) continue
      const theirOwner = await customerOwnerSite(m.siteId)
      if (theirOwner.siteId === owner.siteId) sites.push(m.siteId)
    }
    return sites.length > 0 ? sites : [siteId]
  } catch {
    return [siteId]
  }
}

/** The same SQL as the single-site path, run once per store and added up. */
const SPEND_SQL = `SELECT
       COALESCE(SUM(CASE WHEN d.document_date = ? THEN t.amount ELSE 0 END), 0) AS spent_today,
       COALESCE(SUM(t.amount), 0) AS spent_month
     FROM sales_documents d
     JOIN sales_tenders t   ON t.document_id = d.id
     JOIN tender_types  tt  ON tt.id = t.tender_type_id
    WHERE d.customer_id = ?
      AND d.status = 'finalised'
      AND tt.posts_to_debtor = 1
      AND d.document_date BETWEEN ? AND ?`

/**
 * One customer's spend across every member store.
 *
 * Sequential rather than parallel on purpose: these are the till's own pool
 * connections, and firing ten at once to answer one credit check would compete
 * with the sale being finalised. The stores are on one instance, so each is a
 * local round trip.
 *
 * customer_id is the OWNER's id in every branch's sales_documents, which is
 * what makes this sum meaningful — a branch records the shared customer's id,
 * not a local one. See 197.
 */
async function spendAcross(
  sites: number[],
  customerId: number,
  asAt: string,
): Promise<PeriodSpend> {
  let spentToday = 0
  let spentMonth = 0
  const unreadable: number[] = []

  for (const site of sites) {
    try {
      const row = await siteQueryOne<Row>(site, SPEND_SQL, [
        asAt,
        customerId,
        monthStart(asAt),
        asAt,
      ])
      spentToday += toNum(row?.spent_today)
      spentMonth += toNum(row?.spent_month)
    } catch {
      unreadable.push(site)
    }
  }

  return {
    today: spentToday,
    month: spentMonth,
    ...(unreadable.length > 0 ? { unreadable } : {}),
  }
}

/**
 * Account spend for one customer, today and this month.
 *
 * `asAt` is threaded rather than defaulted inside the query so a back-dated
 * invoice is measured against the window it actually falls in — the same rule
 * the rest of the billing code follows. Defaults to today for the till, where
 * the sale is always now.
 *
 * Sums every member store when the customer file is shared; one query
 * otherwise. Check `unreadable` before treating the result as a total.
 */
export async function accountSpend(
  siteId: number,
  customerId: number,
  asAt: string = today(),
): Promise<PeriodSpend> {
  const sites = await spendSites(siteId)
  if (sites.length > 1) return spendAcross(sites, customerId, asAt)

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

  // One query per member store, as accountSpend does, and for the same reason:
  // the tenders never left the branch that took them. Still one query per store
  // for the WHOLE list rather than per customer, so a group of five costs five
  // queries to price fifty accounts.
  const sites = await spendSites(siteId)
  const unreadable: number[] = []

  for (const site of sites) {
    try {
      const rows = await siteQuery<Row>(
        site,
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
        const id = Number(r.customer_id)
        const prior = spend.get(id)
        spend.set(id, {
          today: toNum(prior?.today) + toNum(r.spent_today),
          month: toNum(prior?.month) + toNum(r.spent_month),
        })
      }
    } catch {
      unreadable.push(site)
    }
  }

  // Stamped on every entry rather than returned separately, so a caller reading
  // one customer out of the map cannot miss it. A miss in the map still means
  // "nothing charged", exactly as before — but with an unreadable store that
  // now means "nothing charged WHERE WE COULD LOOK", which is why the callers
  // that enforce a limit must consult accountSpend for the account they are
  // about to charge rather than trusting a list figure.
  if (unreadable.length > 0) {
    for (const [id, value] of spend) spend.set(id, { ...value, unreadable })
  }
  return spend
}
