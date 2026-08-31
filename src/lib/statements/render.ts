import 'server-only'
import { round } from '../decimals'
import { taxLabel } from '../site/taxIdentity'
import { getCustomer } from '../site/customers'
import { listLedger, agingFor, agingAsAt } from '../site/customerLedger'
import {
  bucketFor,
  daysBetween,
  emptyAging,
  today,
  type Aging,
  type AgingBucket,
} from '../site/ledger'
import {
  periodContaining,
  cycleBucketLabels,
  CYCLE_DAYS,
  type StatementCycle,
} from '../statementCycles'

/**
 * Turns a customer's ledger into a statement.
 *
 * The ONE place statement logic lives. The on-screen preview, the PDF and the
 * emailed attachment all render this same object, so the three can never show a
 * different closing balance — which is the failure nobody catches until a
 * customer phones about it.
 *
 * OPEN ITEM by default: the statement lists what is still unpaid, which is what
 * the customer needs in order to pay. `format: 'activity'` lists every movement
 * in the period instead, for the customer who wants to see the whole month.
 * Both are renderings over the same data — that is exactly why the ledger is
 * open-item and not balance-forward.
 */

export type { StatementVariant } from './variant'

export type StatementFormat = 'open-item' | 'activity'

export type StatementLine = {
  date: string
  docType: string
  docNumber: string | null
  description: string
  reference: string | null
  debit: number
  credit: number
  /** Still unpaid on this document. Zero on a settled or fully applied line. */
  outstanding: number
  daysOverdue: number
  balance: number
}

export type StatementData = {
  format: StatementFormat
  /** The business issuing it. */
  site: { name: string; vatNumber: string | null; taxLabel?: string }
  account: {
    id: number
    code: string
    name: string
    contactName: string | null
    email: string | null
    phone: string | null
    vatNumber: string | null
    addressLines: string[]
    creditLimit: number
    paymentTermsDays: number
  }
  period: { from: string; to: string }
  /**
   * The period as a person names it — "August 2026", "3–9 Aug 2026".
   *
   * What a customer recognises as the statement they were sent. Raw dates are a range
   * they have to translate, and a weekly account gets a lot of them.
   */
  periodLabel: string
  /** How often this account is statemented. Decides the ladder below. */
  cycle: StatementCycle
  /**
   * The age-ladder headings for this cycle.
   *
   * Not fixed at 30/60/90/120: a weekly account's first overdue rung is 7 days, and a
   * column headed "30 days" that actually holds 8-to-14-days-late debt is worse than an
   * unlabelled one.
   */
  bucketLabels: Record<AgingBucket, string>
  openingBalance: number
  closingBalance: number
  lines: StatementLine[]
  aging: Aging
  /** The figure the customer should pay: everything already due. */
  dueNow: number
  /**
   * Settlement discount deducted, on a remittance that took one.
   *
   * Optional because only a remittance can have it — a statement never does.
   * When set, the document shows invoices, less this, equals the amount paid,
   * so the advice reconciles on the supplier's side rather than looking like a
   * short payment.
   */
  settlementDiscount?: number
  generatedAt: Date
}

export type StatementOptions = {
  format?: StatementFormat
  /** Defaults to the last 90 days for an activity statement. */
  from?: string
  to?: string
}

export async function buildStatement(
  siteId: number,
  siteName: string,
  siteVatNumber: string | null,
  customerId: number,
  opts: StatementOptions = {},
): Promise<StatementData | null> {
  const customer = await getCustomer(siteId, customerId)
  if (!customer) return null

  const format = opts.format ?? 'open-item'

  /*
   * The account's own statement cycle decides two things the caller usually should not
   * have to state: which period "this statement" covers, and how wide each rung of the
   * age ladder is.
   *
   * `fallbackAnchor` is the account's creation date, so a 7- or 14-day cycle with no
   * anchor set still lands on a stable phase rather than drifting with whatever day the
   * statement is run on.
   */
  const cycleConfig = {
    cycle: customer.statementCycle,
    anchorDay: customer.statementAnchorDay,
    anchorDate: customer.statementAnchorDate,
    fallbackAnchor: customer.createdAt.toISOString().slice(0, 10),
  }

  /* An explicit range wins — a manager asking for February means February, whatever the
     cycle says. With neither end given, the account's CURRENT period is the honest
     default: for a weekly account, `to - 30 days` would span four statements. */
  const cyclePeriod = periodContaining(cycleConfig, opts.to ?? today())
  const explicit = opts.from !== undefined || opts.to !== undefined
  const to = opts.to ?? (explicit ? today() : cyclePeriod.to)
  const from = opts.from ?? (explicit ? defaultFrom(to) : cyclePeriod.from)

  const bucketWidth = CYCLE_DAYS[customer.statementCycle]

  /*
   * A statement of a PAST period reports that period as it stood.
   *
   * `agingFor` reads the live `amount_outstanding`, which is right for today and wrong
   * for February: a January invoice settled in April shows as nothing owing now, so a
   * February statement built from it would disagree with the one the customer was
   * actually sent — and would keep changing every time it was reprinted.
   *
   * So a period ending today takes the fast path, and any earlier one is reconstructed
   * from the allocations that existed by then. The distinction is `to < today`, not the
   * format: an open-item statement of a past period needs it just as much.
   */
  const asAt = to < today()

  const [all, aging] = await Promise.all([
    listLedger(siteId, customerId, { limit: 2000 }),
    asAt
      ? agingAsAt(siteId, customerId, to, bucketWidth)
      : agingFor(siteId, customerId, bucketWidth),
  ])

  // Everything before the period start is the opening balance, whichever
  // format is being rendered — a statement that starts mid-history without
  // saying what came before is unreadable.
  const opening = all
    .filter((line) => line.docDate < from)
    .reduce((sum, line) => round(sum + line.amountSigned, 2), 0)

  const inPeriod = all.filter((line) => line.docDate >= from && line.docDate <= to)

  const source =
    format === 'open-item'
      ? /*
         * Open items regardless of when they were raised: a January invoice still unpaid
         * belongs on today's statement.
         *
         * But never one raised AFTER the period. On a current statement that is
         * impossible, so the filter is invisible; on a February statement it is the
         * difference between the document the customer was sent and one that mentions a
         * March invoice they had not yet received.
         */
        all.filter((line) => line.amountOutstanding !== 0 && line.docDate <= to)
      : inPeriod

  const now = today()
  let running = format === 'open-item' ? 0 : opening

  const lines: StatementLine[] = source.map((line) => {
    running = round(running + line.amountSigned, 2)
    return {
      date: line.docDate,
      docType: line.docLabel,
      docNumber: line.docNumber,
      description: line.description ?? line.docLabel,
      reference: line.reference,
      debit: line.amountSigned > 0 ? line.amountSigned : 0,
      credit: line.amountSigned < 0 ? -line.amountSigned : 0,
      outstanding: line.amountOutstanding,
      daysOverdue:
        line.dueDate && line.amountOutstanding > 0 ? Math.max(daysBetween(line.dueDate, now), 0) : 0,
      balance: running,
    }
  })

  // "Due now" is everything except what is still within terms — the number the
  // customer is being asked for, as opposed to the total they will eventually
  // owe.
  const dueNow = round(aging.d30 + aging.d60 + aging.d90 + aging.d120, 2)

  return {
    format,
    site: { name: siteName, vatNumber: siteVatNumber, taxLabel: await taxLabel(siteId) },
    account: {
      id: customer.id,
      code: customer.code,
      name: customer.name,
      contactName: customer.contactName,
      email: customer.email,
      phone: customer.phone,
      vatNumber: customer.vatNumber,
      addressLines: [
        customer.addressLine1,
        customer.addressLine2,
        [customer.city, customer.postalCode].filter(Boolean).join(' ') || null,
      ].filter((l): l is string => Boolean(l)),
      creditLimit: customer.creditLimit,
      paymentTermsDays: customer.paymentTermsDays,
    },
    period: { from, to },
    /* Named rather than printed as raw dates. "August 2026" or "3–9 Aug 2026" is what a
       customer recognises as the statement they were sent; "2026-08-01 to 2026-08-31" is
       a database range they have to translate. A custom span falls back to the dates,
       because there is nothing else honest to call it. */
    periodLabel:
      from === cyclePeriod.from && to === cyclePeriod.to
        ? cyclePeriod.label
        : `${from} to ${to}`,
    cycle: customer.statementCycle,
    /* The ladder's headings, from the cycle. A weekly statement reading "30 days" over a
       column that means "8–14 days late" is worse than no heading at all. */
    bucketLabels: cycleBucketLabels(customer.statementCycle),
    openingBalance: opening,
    /*
     * What the account stood at ON THE PERIOD END, not what it stands at now.
     *
     * `customers.balance` is the live figure and is correct for a statement ending today.
     * For February it is not: it includes every March and April movement, so a February
     * statement would close at a number that never appeared on any February document.
     *
     * Summed from the ledger up to `to` — the same lines the statement lists, so the
     * running balance on the last line and this figure cannot disagree.
     */
    closingBalance: asAt
      ? all
          .filter((line) => line.docDate <= to)
          .reduce((sum, line) => round(sum + line.amountSigned, 2), 0)
      : customer.balance,
    lines,
    aging,
    dueNow,
    generatedAt: new Date(),
  }
}

/**
 * A supplier's account, in the same shape.
 *
 * The creditors mirror of buildStatement. Not the same function with a flag:
 * the two read different tables, and threading a table name through shared SQL
 * is how an injection bug gets in — the same reasoning supplierLedger.ts is
 * written out for. What genuinely is shared is the rendering, and that is
 * already shared, because this returns StatementData unchanged.
 *
 * Sign convention differs and it matters here. On the creditors table positive
 * means WE owe THEM, so a supplier invoice is a debit exactly as a customer
 * invoice is, and the document needs no variant to read correctly.
 *
 * This is a statement OF ACCOUNT — what we owe a supplier and how old it is —
 * which is a different document from the remittance advice in remittance.ts.
 * A remittance answers "what did this payment cover"; this answers "where does
 * the account stand", and is what you reconcile against the supplier's own
 * statement at month-end.
 */
export async function buildSupplierStatement(
  siteId: number,
  siteName: string,
  siteVatNumber: string | null,
  supplierId: number,
  opts: StatementOptions = {},
): Promise<StatementData | null> {
  const { getSupplier } = await import('../site/suppliers')
  const { listSupplierLedger, supplierAgingAsAt } = await import('../site/supplierLedger')

  const supplier = await getSupplier(siteId, supplierId)
  if (!supplier) return null

  const format = opts.format ?? 'open-item'
  const to = opts.to ?? today()
  const from = opts.from ?? defaultFrom(to)
  const historic = to < today()

  const [all, aging] = await Promise.all([
    listSupplierLedger(siteId, supplierId, { limit: 2000 }),
    // As at the period end, exactly as the debtors side does it. A creditor has
    // no cycle, but "what did this account look like in June" is the same
    // question and has the same wrong answer if measured from today.
    supplierAgingAsAt(siteId, supplierId, to),
  ])

  const opening = all
    .filter((line) => line.docDate < from)
    .reduce((sum, line) => round(sum + line.amountSigned, 2), 0)

  const inPeriod = all.filter((line) => line.docDate >= from && line.docDate <= to)

  const source =
    format === 'open-item'
      ? // On a historic period, documents raised after it are excluded — listing
        // a July invoice on a June statement is plainly wrong.
        all.filter((line) => line.amountOutstanding !== 0 && (!historic || line.docDate <= to))
      : inPeriod

  const asAt = to
  let running = format === 'open-item' ? 0 : opening

  const lines: StatementLine[] = source.map((line) => {
    running = round(running + line.amountSigned, 2)
    return {
      date: line.docDate,
      docType: line.docLabel,
      docNumber: line.docNumber,
      description: line.description ?? line.docLabel,
      reference: line.reference,
      debit: line.amountSigned > 0 ? line.amountSigned : 0,
      credit: line.amountSigned < 0 ? -line.amountSigned : 0,
      outstanding: line.amountOutstanding,
      daysOverdue:
        line.dueDate && line.amountOutstanding > 0
          ? Math.max(daysBetween(line.dueDate, asAt), 0)
          : 0,
      balance: running,
    }
  })

  const dueNow = round(aging.d30 + aging.d60 + aging.d90 + aging.d120, 2)

  // Every posted movement up to the period end, not supplier.balance — that is
  // today's figure and would contradict the lines above it on a past period.
  // Allocations do not move a balance, so no reconstruction is needed here.
  const closing = round(
    all
      .filter((line) => line.docDate <= to)
      .reduce((sum, line) => round(sum + line.amountSigned, 2), 0),
    2,
  )

  return {
    format,
    site: { name: siteName, vatNumber: siteVatNumber, taxLabel: await taxLabel(siteId) },
    account: {
      id: supplier.id,
      // Our account number with them, when we have one — that is the reference
      // the supplier files it under, not our internal code.
      code: supplier.accountNumber ?? supplier.code,
      name: supplier.name,
      contactName: supplier.contactName,
      email: supplier.email,
      phone: supplier.phone,
      vatNumber: supplier.vatNumber,
      addressLines: [
        supplier.addressLine1,
        supplier.addressLine2,
        [supplier.city, supplier.postalCode].filter(Boolean).join(' ') || null,
      ].filter((l): l is string => Boolean(l)),
      // Suppliers carry no credit limit of ours; the document hides the row at 0.
      creditLimit: 0,
      paymentTermsDays: supplier.paymentTermsDays,
    },
    period: { from, to },
    /*
     * A SUPPLIER has no statement cycle. That setting lives on a debtor — it decides
     * when we send a statement out — and a creditor's account is read on whatever span
     * the person paying them asked for.
     *
     * So: the dates as the label, and the familiar 30-day ladder. Naming a supplier
     * period after a cycle it does not have would be a fiction, and inventing a
     * per-supplier cycle to fill this field would be a feature nobody asked for.
     */
    periodLabel: `${from} to ${to}`,
    cycle: 'monthly' as const,
    bucketLabels: cycleBucketLabels('monthly'),
    openingBalance: opening,
    closingBalance: closing,
    lines,
    aging,
    dueNow,
    generatedAt: new Date(),
  }
}

/** 90 days back — long enough to show a payment pattern, short enough to read. */
function defaultFrom(to: string): string {
  const date = new Date(`${to}T00:00:00`)
  date.setDate(date.getDate() - 90)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`
}

/**
 * Accounts worth sending a statement to.
 *
 * Zero-balance accounts are excluded by default: a statement saying "you owe
 * nothing" is postage and inbox noise. Closed accounts never get one.
 */
export async function statementCandidates(
  siteId: number,
  opts: { includeZero?: boolean; overdueOnly?: boolean } = {},
): Promise<
  {
    id: number
    code: string
    name: string
    email: string | null
    balance: number
    cycle: StatementCycle
  }[]
> {
  const { listCustomers } = await import('../site/customers')
  const { items } = await listCustomers(siteId, {
    statuses: ['active', 'on_hold', 'inactive'],
    withBalanceOnly: !opts.includeZero,
    limit: 500,
  })

  return items.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    email: c.email,
    balance: c.balance,
    // So the run screen can warn when one send spans several cycles.
    cycle: c.statementCycle,
  }))
}

export { emptyAging, bucketFor }
