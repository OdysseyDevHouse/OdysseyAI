import 'server-only'
import { round } from '../decimals'
import { getCustomer } from '../site/customers'
import { listLedger, agingFor } from '../site/customerLedger'
import { bucketFor, daysBetween, emptyAging, today, type Aging } from '../site/ledger'

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
  site: { name: string; vatNumber: string | null }
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
  openingBalance: number
  closingBalance: number
  lines: StatementLine[]
  aging: Aging
  /** The figure the customer should pay: everything already due. */
  dueNow: number
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
  const to = opts.to ?? today()
  const from = opts.from ?? defaultFrom(to)

  const [all, aging] = await Promise.all([
    listLedger(siteId, customerId, { limit: 2000 }),
    agingFor(siteId, customerId),
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
      ? // Open items regardless of when they were raised: a January invoice
        // still unpaid belongs on today's statement.
        all.filter((line) => line.amountOutstanding !== 0)
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
    site: { name: siteName, vatNumber: siteVatNumber },
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
    openingBalance: opening,
    closingBalance: customer.balance,
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
): Promise<{ id: number; code: string; name: string; email: string | null; balance: number }[]> {
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
  }))
}

export { emptyAging, bucketFor }
