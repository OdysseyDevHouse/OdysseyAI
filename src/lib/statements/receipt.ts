import 'server-only'
import { round } from '../decimals'
import { getTransaction, allocationsFor } from '../site/customerLedger'
import { cycleBucketLabels } from '../statementCycles'
import type { StatementData } from './render'

/**
 * A receipt — "here is what you paid us, against these invoices".
 *
 * ── THE MIRROR OF buildRemittance, AND BUILT THE SAME WAY ─────────────────
 *
 * Same StatementData, same renderer, same on-screen document; only the wording
 * and the direction of the money differ. That is the shared-vs-duplicated line
 * this codebase already draws for the remittance advice, and a receipt is the
 * clearest possible case for it: a customer receipt and a supplier remittance
 * are the same piece of paper read from opposite sides of the counter.
 *
 * ── THERE IS NO RECEIPT TABLE TO READ ─────────────────────────────────────
 *
 * A customer payment is a `customer_transactions` row with doc_type='payment'
 * and nothing else — recordCustomerReceipt posts the ledger side and the bank
 * side, and neither is a document. So the receipt is DERIVED at print time from
 * the payment plus its allocations, rather than fetched.
 *
 * The consequence worth stating: a receipt reprinted after staff re-allocate
 * the payment shows the NEW allocation. That is the honest answer — the lines
 * say what this money is currently settling, and a receipt that kept an
 * allocation the ledger has since changed would contradict the statement
 * beside it. The figure the customer cares about, what they paid and when,
 * cannot change.
 *
 * ── IT REFUSES ANYTHING THAT IS NOT A PAYMENT ─────────────────────────────
 *
 * Null for an invoice, a credit note, interest or a write-off. "Receipt" for a
 * document that took money OFF a customer would be a lie on the shop's own
 * letterhead, and the caller must not be able to produce one by passing the
 * wrong id.
 */
export async function buildReceipt(
  siteId: number,
  siteName: string,
  siteVatNumber: string | null,
  customerId: number,
  transactionId: number,
  account: {
    code: string
    name: string
    contactName: string | null
    email: string | null
    phone: string | null
    vatNumber: string | null
    addressLines: string[]
    paymentTermsDays: number
  },
): Promise<StatementData | null> {
  const payment = await getTransaction(siteId, transactionId)
  if (!payment) return null

  /*
   * OWNERSHIP, here rather than only at the route. This function reads a
   * transaction by id and renders it onto the shop's letterhead, so it is
   * exactly the kind of helper whose customer filter must not be a caller's
   * responsibility — the customerOrders doctrine in customerAuth.ts.
   */
  if (payment.customerId !== customerId) return null

  // Only money coming IN. See the header.
  if (payment.docType !== 'payment') return null

  const allocations = await allocationsFor(siteId, transactionId)

  /*
   * What this payment was put against. Each allocation names the OTHER side —
   * the invoice — so the invoice has to be read for its number and date.
   *
   * Sequential rather than parallel: a payment settles a handful of invoices,
   * and a Promise.all here would fan out an unbounded query count from a
   * public route for no measurable gain.
   */
  const lines = []
  for (const allocation of allocations) {
    const invoice = await getTransaction(siteId, allocation.otherId)
    // An allocation whose other side has been reversed away. Skipped rather
    // than rendered blank: a line with no number and no date explains nothing.
    if (!invoice || invoice.customerId !== customerId) continue

    lines.push({
      date: invoice.docDate,
      docType: invoice.docLabel,
      docNumber: invoice.docNumber,
      description:
        // Whether this payment closed the invoice or only dented it. The
        // customer's next question after "what did I pay" is always "is that
        // one settled now", and the receipt should answer it without them
        // having to compare two figures themselves.
        invoice.amountOutstanding > 0.005
          ? `Part payment — ${round(invoice.amountOutstanding, 2).toFixed(2)} still owing`
          : 'Settled in full',
      reference: invoice.reference,
      debit: Math.abs(invoice.amountSigned),
      credit: allocation.amount,
      outstanding: round(invoice.amountOutstanding, 2),
      daysOverdue: 0,
      balance: allocation.amount,
    })
  }

  const paid = Math.abs(payment.amountSigned)

  /*
   * Money received that is not yet against anything.
   *
   * A payment on account, or one only partly allocated. Without this line the
   * receipt's own lines would add up to less than the amount received, and a
   * document whose parts do not sum to its total is the one that generates the
   * phone call. It is also good news worth stating plainly — the customer has
   * credit sitting on their account.
   */
  const allocated = allocations.reduce((sum, a) => round(sum + a.amount, 2), 0)
  const unallocated = round(paid - allocated, 2)
  if (unallocated > 0.005) {
    lines.push({
      date: payment.docDate,
      docType: 'On account',
      docNumber: null,
      description: 'Not yet applied to an invoice — held as credit on your account',
      reference: null,
      debit: 0,
      credit: unallocated,
      outstanding: 0,
      daysOverdue: 0,
      balance: unallocated,
    })
  }

  return {
    format: 'open-item',
    site: { name: siteName, vatNumber: siteVatNumber },
    account: {
      id: customerId,
      code: account.code,
      name: account.name,
      contactName: account.contactName,
      email: account.email,
      phone: account.phone,
      vatNumber: account.vatNumber,
      addressLines: account.addressLines,
      // Never shown on a payment advice — see isPaymentAdvice — but the shape
      // asks for it.
      creditLimit: 0,
      paymentTermsDays: account.paymentTermsDays,
    },
    // One payment on one day, so the period is that date rather than a range
    // this document does not have. Same reasoning as the remittance.
    period: { from: payment.docDate, to: payment.docDate },
    periodLabel: payment.docDate,
    cycle: 'monthly' as const,
    bucketLabels: cycleBucketLabels('monthly'),
    openingBalance: 0,
    // On a receipt this is the amount RECEIVED, which is what the document
    // labels it — see STATEMENT_DUE_LABELS.
    closingBalance: paid,
    lines,
    // Nothing is overdue on money already received.
    aging: { current: 0, d30: 0, d60: 0, d90: 0, d120: 0, total: 0 },
    dueNow: 0,
    generatedAt: new Date(),
  }
}
