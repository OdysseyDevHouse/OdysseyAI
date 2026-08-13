import 'server-only'
import { can, type CapabilitySet } from './permissions'
import { today } from './ledger'
import type { Aging } from '../agingBuckets'
import { agingSummary } from './customerLedger'
import { supplierAging } from './aging'
import { creditSummary } from './creditControl'
import { customerSummary } from './customers'
import { listAccounts } from './bankAccounts'
import { listProducts } from './products'
import { openShifts } from './shifts'
import { offlineExceptionCounts } from './offlineExceptions'
import { quoteSummary } from './quotes'
import { listOrders } from './salesOrders'
import { listLaybys } from './laybys'
import { listLocations } from './stockLocations'
import { jobCounts, jobOpsCounts, jobBreakdowns } from './jobCards'
import { slaCounts } from './jobSla'
import { reorderSuggestions } from './reorderSuggestions'

/**
 * The dashboard's AS-AT-NOW half.
 *
 * ── WHY THIS IS NOT IN salesDashboard.ts ─────────────────────────────────
 *
 * Everything there answers "how did we trade between two dates" and moves when
 * the toolbar moves. Everything here answers "what is true right now" — who
 * owes us, what is running out, which tills are still open — and does NOT move
 * when the toolbar moves, because a debtor ageing "as at last March" is either
 * expensive to reconstruct or meaningless.
 *
 * Keeping them in one module would mean one of two lies: refetching figures
 * that cannot change with the range, or letting a reader believe an as-at
 * figure belongs to the period on screen. They are separate because they answer
 * different questions, and the split is what lets the screen label them
 * honestly.
 *
 * ── CAPABILITIES DECIDE WHAT IS QUERIED, NOT JUST WHAT IS SHOWN ──────────
 *
 * Every section is behind a `can()` check in the Promise.all itself, so a user
 * who may not see debtors does not merely get them hidden — the query never
 * runs and the figure is never on the wire. A null section is the ONLY signal
 * the client gets, which makes "did I remember to hide this?" impossible to get
 * wrong: there is nothing to hide.
 *
 * This differs from `withoutMargin()` in the sales route, which zeroes rather
 * than removes. That is right there — the row shape must survive a missing
 * COLUMN — and wrong here, where the whole SUBJECT is gated.
 */

/** A row in the action list: something that wants doing, and where to do it. */
export type AttentionItem = {
  /** Stable id, so React keys and tests do not depend on the label. */
  key: string
  /** The count that leads the row. Zero-count items are never emitted. */
  count: number
  label: string
  /** The money at stake, where there is one. Rendered after the label. */
  amount: number | null
  tone: 'danger' | 'warning'
  href: string
}

export type CashPosition = {
  accounts: { id: number; name: string; balance: number; unreconciled: number }[]
  total: number
  unreconciled: number
}

export type Pipeline = {
  openQuotes: number
  openQuoteValue: number
  expiringSoon: number
  conversionRate: number | null
  outstandingOrders: number
  activeLaybys: number
  overdueLaybys: number
}

export type ReorderLine = {
  productId: number
  code: string
  description: string
  stockOnHand: number
  minStock: number
  suggested: number
}

export type ReorderPanel = {
  /** Named because a suggestion is per-location and unlabelled is meaningless. */
  locationName: string
  /** Whether the site has more than one, so the screen knows to say which. */
  multipleLocations: boolean
  rows: ReorderLine[]
}

export type DashboardOverview = {
  /**
   * The server's date, stamped once. The "As at today" badge reads THIS rather
   * than the browser clock — a machine in another timezone, or simply set
   * wrong, must not be able to make the label disagree with the figures.
   */
  asAt: string
  attention: AttentionItem[]
  debtors: Aging | null
  creditors: Aging | null
  cash: CashPosition | null
  pipeline: Pipeline | null
  reorder: ReorderPanel | null
  /** Null when the reader may not see jobs, or the module is not migrated. */
  jobs: JobPanel | null
}

/**
 * What the job widgets read.
 *
 * One shape rather than a fetch per widget, because seven widgets on one screen
 * asking seven questions is seven round trips to draw a strip of numbers. The
 * dashboard already gathers everything in one pass; this joins it.
 */
export type JobPanel = {
  open: number
  unassigned: number
  overdue: number
  inProgress: number
  awaitingParts: number
  /** Closed with billable work still unbilled — the cash-flow figure. */
  notInvoiced: number
  /** Open jobs per stage, biggest first. Empty stages are dropped. */
  byStatus: { label: string; count: number; href: string }[]
  /**
   * Open jobs per owner, biggest first, with the unassigned pile LAST.
   *
   * Unassigned is included rather than filtered out: work nobody is doing is
   * exactly what a dispatcher opens this to find, and dropping it would make
   * the chart add up to less than the open count with no explanation.
   */
  byTechnician: { label: string; count: number; href: string }[]
}

/** How many reorder lines the panel shows before it is a worse /purchasing. */
const REORDER_LIMIT = 8

export async function getDashboardOverview(
  siteId: number,
  capabilities: CapabilitySet,
): Promise<DashboardOverview> {
  const seeCustomers = can(capabilities, 'customers.view')
  const seeCredit = can(capabilities, 'customers.credit')
  const seeSuppliers = can(capabilities, 'suppliers.view')
  const seeCash = can(capabilities, 'cashbook.view')
  const reconcileCash = can(capabilities, 'cashbook.reconcile')
  const seeStock = can(capabilities, 'stock.view')
  const seeSales = can(capabilities, 'sales.view')
  const seeCashup = can(capabilities, 'sales.cashup')
  // Reorder is a stock reading that produces a buying decision, so it needs
  // both — a storeman who may not raise an order has no use for a suggestion.
  const seeReorder = seeStock && can(capabilities, 'purchasing.view')
  const seeJobs = can(capabilities, 'jobs.view')

  /*
   * One batch, so the slowest call sets the wall clock rather than the sum.
   * `supplierAging` and `reorderSuggestions` are the two expensive ones; being
   * in the same batch as the cheap counters costs them nothing extra.
   */
  const [
    debtors,
    creditorsResult,
    credit,
    customers,
    accounts,
    lowStock,
    shifts,
    offline,
    quotes,
    orders,
    laybysActive,
    laybysOverdue,
    locations,
    jobs,
    jobSla,
    jobOps,
    jobSplit,
  ] = await Promise.all([
    seeCustomers ? agingSummary(siteId) : null,
    seeSuppliers ? supplierAging(siteId, {}) : null,
    seeCustomers ? creditSummary(siteId) : null,
    seeCredit ? customerSummary(siteId) : null,
    seeCash || reconcileCash ? listAccounts(siteId) : null,
    // limit 1 — only `total` is read, so the rows are dead weight.
    seeStock ? listProducts(siteId, { belowMinimum: true, limit: 1 }) : null,
    seeCashup ? openShifts(siteId) : null,
    seeSales ? offlineExceptionCounts(siteId) : null,
    // No range: quoteSummary's open/expiring figures are computed against
    // today regardless, so passing the dashboard's range would only narrow
    // which quotes are considered at all — silently hiding a quote raised
    // last month from a dashboard scoped to this one.
    seeSales ? quoteSummary(siteId) : null,
    seeSales ? listOrders(siteId, { fulfilment: 'outstanding', limit: 1 }) : null,
    seeSales ? listLaybys(siteId, { status: 'active', limit: 1 }) : null,
    seeSales ? listLaybys(siteId, { overdueOnly: true, limit: 1 }) : null,
    seeReorder ? listLocations(siteId, false, true) : null,
    /*
     * Tolerant, unlike every other call in this batch: the job tables arrived in
     * migration 104 and the SLA ones in 113, so a site part-way through migrating
     * would otherwise take the WHOLE dashboard down — and the dashboard is the
     * screen somebody opens to find out what is wrong.
     */
    seeJobs ? jobCounts(siteId).catch(() => null) : null,
    seeJobs ? slaCounts(siteId).catch(() => null) : null,
    // Both already swallow their own errors — a site without the job tables
    // returns zeroes rather than taking down the dashboard.
    seeJobs ? jobOpsCounts(siteId) : null,
    seeJobs ? jobBreakdowns(siteId) : null,
  ])

  /*
   * Reorder needs a location and there is no sensible default, so it is
   * resolved from the batch above rather than guessed. A site with no active
   * location gets no widget at all — better than a panel confidently
   * suggesting nothing.
   */
  const mainLocation = locations?.find((l) => l.isMain) ?? locations?.[0] ?? null
  const reorderRows = mainLocation
    ? await reorderSuggestions(siteId, {
        locationId: mainLocation.id,
        basis: 'below_minimum',
        limit: REORDER_LIMIT,
      })
    : []

  const attention: AttentionItem[] = []
  const add = (item: AttentionItem) => {
    // A zero count is not an action, and a list padded with "0 things to do"
    // is a list nobody reads. This is the only filter the rows get.
    if (item.count > 0) attention.push(item)
  }

  if (credit) {
    add({
      key: 'overdue',
      count: credit.overdueAccounts,
      label: credit.overdueAccounts === 1 ? 'account overdue' : 'accounts overdue',
      amount: credit.overdueTotal,
      // Past 90 days is a collections problem rather than a timing one.
      tone: credit.worstDays >= 90 ? 'danger' : 'warning',
      href: '/credit',
    })
    add({
      key: 'promises-broken',
      count: credit.promisesBroken,
      label: credit.promisesBroken === 1 ? 'promise broken' : 'promises broken',
      amount: null,
      tone: 'danger',
      href: '/credit/promises',
    })
  }

  if (customers) {
    add({
      key: 'over-limit',
      count: customers.overLimit,
      label: customers.overLimit === 1 ? 'account over its limit' : 'accounts over their limit',
      amount: null,
      tone: 'warning',
      href: '/customers',
    })
  }

  if (offline) {
    add({
      key: 'quarantined',
      count: offline.quarantined,
      label: offline.quarantined === 1 ? 'offline sale quarantined' : 'offline sales quarantined',
      amount: offline.quarantinedValue,
      tone: 'danger',
      href: '/sales/offline',
    })
  }

  if (lowStock) {
    add({
      key: 'below-minimum',
      count: lowStock.total,
      label: lowStock.total === 1 ? 'product below minimum' : 'products below minimum',
      amount: null,
      tone: 'warning',
      href: '/products?belowMinimum=1',
    })
  }

  if (shifts) {
    add({
      key: 'open-tills',
      count: shifts.length,
      label: shifts.length === 1 ? 'till still open' : 'tills still open',
      amount: null,
      tone: 'warning',
      href: '/sales/cashup',
    })
  }

  if (accounts && reconcileCash) {
    const unreconciled = accounts.reduce((sum, a) => sum + (a.unreconciledCount ?? 0), 0)
    add({
      key: 'unreconciled',
      count: unreconciled,
      label: unreconciled === 1 ? 'bank item unreconciled' : 'bank items unreconciled',
      amount: null,
      tone: 'warning',
      href: '/cashbook',
    })
  }

  /*
   * Jobs. THREE rows at most, and each one is a different action by a different
   * person: a breached promise is the owner's problem, an unassigned job is the
   * dispatcher's, an undecided cost is the manager's. Merging them into "12 jobs
   * need attention" would be a number nobody can act on.
   *
   * `overdue` is deliberately NOT one of them. It counts jobs past their due date,
   * which the SLA breach already covers for anything carrying a promise — two rows
   * saying almost the same thing is how a list gets skimmed.
   */
  if (jobSla) {
    add({
      key: 'job-response-breached',
      count: jobSla.responseBreached,
      label:
        jobSla.responseBreached === 1
          ? 'job past its reply promise'
          : 'jobs past their reply promise',
      amount: null,
      // Danger: a customer was promised a reply and has not had one.
      tone: 'danger',
      href: '/jobs/sla',
    })
    add({
      key: 'job-resolve-breached',
      count: jobSla.resolveBreached,
      label: jobSla.resolveBreached === 1 ? 'job past its fix date' : 'jobs past their fix date',
      amount: null,
      tone: 'danger',
      href: '/jobs/sla?tab=resolve',
    })
  }

  if (jobs) {
    add({
      key: 'jobs-unassigned',
      count: jobs.unassigned,
      label: jobs.unassigned === 1 ? 'job with nobody on it' : 'jobs with nobody on them',
      amount: null,
      tone: 'warning',
      href: '/jobs?state=open',
    })
  }

  // Danger before warning, then biggest first — the order someone would work
  // the list in. Stable within a tone so the rows do not shuffle between loads.
  const TONE_RANK = { danger: 0, warning: 1 }
  attention.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.count - a.count)

  const jobPanel: JobPanel | null =
    jobs && jobOps && jobSplit
      ? {
          open: jobs.open,
          unassigned: jobs.unassigned,
          overdue: jobs.overdue,
          inProgress: jobOps.inProgress,
          awaitingParts: jobOps.awaitingParts,
          notInvoiced: jobOps.completedNotInvoiced,
          byStatus: jobSplit.byStatus,
          byTechnician: jobSplit.byTechnician,
        }
      : null

  return {
    asAt: today(),
    attention,
    debtors,
    creditors: creditorsResult?.totals ?? null,
    cash:
      accounts && seeCash
        ? {
            accounts: accounts.map((a) => ({
              id: a.id,
              name: a.name,
              balance: a.balance,
              unreconciled: a.unreconciledCount ?? 0,
            })),
            total: accounts.reduce((sum, a) => sum + a.balance, 0),
            unreconciled: accounts.reduce((sum, a) => sum + (a.unreconciledCount ?? 0), 0),
          }
        : null,
    pipeline:
      quotes && orders && laybysActive && laybysOverdue
        ? {
            openQuotes: quotes.openCount,
            openQuoteValue: quotes.openValue,
            expiringSoon: quotes.expiringSoon,
            conversionRate: quotes.conversionRate,
            outstandingOrders: orders.total,
            activeLaybys: laybysActive.total,
            overdueLaybys: laybysOverdue.total,
          }
        : null,
    reorder: mainLocation
      ? {
          locationName: mainLocation.name,
          multipleLocations: (locations?.length ?? 0) > 1,
          rows: reorderRows.map((r) => ({
            productId: r.productId,
            code: r.code,
            description: r.description,
            stockOnHand: r.stockOnHand,
            minStock: r.minStock,
            suggested: r.suggested,
          })),
        }
      : null,
    jobs: jobPanel,
  }
}
