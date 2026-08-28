import 'server-only'
import { getDocument } from './salesDocuments'
import { outstandingForDocument } from './paidInvoices'
import { getCustomer } from './customers'
import { getLayby } from './laybys'
import { depositSummary } from './deposits'
import { siteQueryOne } from '../siteDb'
import type { RowDataPacket } from 'mysql2/promise'
import type { PayLink, PayableSummary } from './payLinks'

/**
 * What a scanned pay-link is asking for.
 *
 * Split out of payLinks.ts so that module stays about LINKS — minting,
 * resolving, revoking — and does not pull the whole document, ledger, lay-by
 * and deposit graph in behind it. Every print path imports payLinks; only the
 * landing page imports this.
 *
 * ── EVERY BRANCH READS WHAT IS OWED TODAY ─────────────────────────────────
 *
 * Not what the paper said when it was printed. An invoice part-paid by EFT last
 * week, a lay-by three instalments in, a statement paid down since it was
 * posted — each must ask for the remainder. A link that keeps demanding the
 * original figure takes money the customer does not owe, which is a refund and
 * an awkward phone call rather than a payment.
 *
 * ── AND SAYS AS LITTLE AS IT CAN ──────────────────────────────────────────
 *
 * Anyone holding the code can open it: it is printed on paper that is left on
 * desks, photographed and forwarded. So each branch returns a title, at most
 * one line of context, and an amount. No line detail, no history, no other
 * documents, no contact details.
 */

type Row = RowDataPacket & Record<string, unknown>

export async function payableSummary(
  siteId: number,
  link: PayLink,
): Promise<PayableSummary | null> {
  switch (link.purpose) {
    case 'debtor_invoice':
      return invoiceSummary(siteId, link.targetId)
    case 'customer_account':
      return accountSummary(siteId, link.targetId)
    case 'layby':
      return laybySummary(siteId, link.targetId)
    case 'document_deposit':
      return documentDepositSummary(siteId, link)
    case 'job_deposit':
      return jobDepositSummary(siteId, link)
  }
}

async function invoiceSummary(
  siteId: number,
  documentId: number,
): Promise<PayableSummary | null> {
  const document = await getDocument(siteId, documentId)
  if (!document || document.status !== 'finalised') return null

  const outstanding = await outstandingForDocument(siteId, document)
  return {
    title: `Invoice ${document.documentNumber ?? `#${documentId}`}`,
    subtitle: document.dueDate ? `Due ${document.dueDate}` : null,
    outstanding,
  }
}

/**
 * A statement — the whole account balance.
 *
 * `balance` rather than a sum of open items: it is the figure the statement the
 * customer is holding actually showed, and the one their own records will name.
 * A credit balance yields zero, not a negative — asking somebody to pay a
 * negative amount is nonsense, and the gateway would refuse it anyway.
 */
async function accountSummary(
  siteId: number,
  customerId: number,
): Promise<PayableSummary | null> {
  const customer = await getCustomer(siteId, customerId)
  if (!customer) return null

  return {
    title: `Account ${customer.code}`,
    // The account NAME, which is on the statement they are holding anyway.
    // Nothing else off the customer record travels this far.
    subtitle: customer.name,
    outstanding: Math.max(0, customer.balance),
  }
}

async function laybySummary(siteId: number, laybyId: number): Promise<PayableSummary | null> {
  const layby = await getLayby(siteId, laybyId)
  if (!layby) return null

  // A cancelled or completed lay-by is not payable. Completed especially: the
  // goods have gone and an instalment against it would be money with nothing
  // to settle.
  if (layby.status !== 'open') return null

  return {
    title: `Lay-by ${layby.laybyNumber ?? `#${laybyId}`}`,
    subtitle: `${layby.paidTotal.toFixed(2)} of ${layby.totalIncl.toFixed(2)} paid`,
    outstanding: layby.outstanding,
  }
}

/**
 * A deposit against a quote or a sales order.
 *
 * ── THE AMOUNT IS THE LINK'S, NOT THE DOCUMENT'S ──────────────────────────
 *
 * Unlike every other branch. A deposit is a PART payment by definition, so
 * "what is outstanding" is not the question — the shop decided what to ask for
 * when it printed the paper, and that promise is what the customer agreed to.
 *
 * With no amount pinned on the link it falls back to what is still unpaid on
 * the document, less anything already deposited, which is the sensible reading
 * of "pay for your order online".
 */
async function documentDepositSummary(
  siteId: number,
  link: PayLink,
): Promise<PayableSummary | null> {
  const document = await getDocument(siteId, link.targetId)
  if (!document) return null

  // A cancelled quote or a voided order is not payable.
  if (document.status === 'cancelled') return null

  const held = await depositSummary(siteId, link.targetId)
  const remaining = Math.max(0, document.totalIncl - held.held)

  return {
    title: `${document.docLabel} ${document.documentNumber ?? `#${link.targetId}`}`,
    subtitle:
      held.held > 0
        ? `${held.held.toFixed(2)} already paid of ${document.totalIncl.toFixed(2)}`
        : `Total ${document.totalIncl.toFixed(2)}`,
    outstanding: link.amountIncl == null ? remaining : Math.min(link.amountIncl, remaining),
  }
}

/**
 * A deposit against a job card.
 *
 * Read directly rather than through jobCards.ts: this needs a number and a
 * title and nothing else, and the full job record carries a customer's address,
 * their equipment and the history of the work — none of which belongs on a page
 * anyone holding a slip can open.
 */
async function jobDepositSummary(
  siteId: number,
  link: PayLink,
): Promise<PayableSummary | null> {
  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT document_number, title, status FROM job_cards WHERE id = ? LIMIT 1`,
    [link.targetId],
  )
  if (!job) return null
  if (String(job.status) !== 'open') return null

  // A job has no single "outstanding" figure — the work is not costed until it
  // is done — so a deposit link MUST carry its amount. Without one there is
  // nothing honest to ask for.
  if (link.amountIncl == null || link.amountIncl <= 0) return null

  return {
    title: `Job ${job.document_number ?? `#${link.targetId}`}`,
    subtitle: (job.title as string | null) ?? null,
    outstanding: link.amountIncl,
  }
}
