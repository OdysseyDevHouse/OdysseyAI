import type { CustomerStatementLine } from '@/lib/site/customerAuth'

/**
 * Which ledger lines have paper the customer can download, and where it lives.
 *
 * ── ONE DECISION, TWO PAGES ────────────────────────────────────────────────
 *
 * The transactions list and the statement both show ledger lines and both offer
 * a PDF on the ones that have one. Written twice, they drift: one grows a
 * receipt link and the other does not, and a customer finds their receipt on one
 * tab and not the other with no way to tell which is right.
 *
 * It is also the one place that knows a line WITHOUT paper is normal rather
 * than broken. Interest raised by a run, a write-off, an opening balance
 * brought over at go-live — none of those is a document anybody issued, so the
 * honest answer is no link at all rather than a route that 404s.
 */

/** What each ledger doc type is called in front of a customer. */
export const DOC_LABEL: Record<string, string> = {
  invoice: 'Invoice',
  payment: 'Payment',
  credit_note: 'Credit note',
  interest: 'Interest',
  write_off: 'Write-off',
  opening: 'Opening balance',
  journal: 'Adjustment',
}

/**
 * The download for one line, or null when there is nothing to download.
 *
 * ── AN INVOICE IS ADDRESSED BY ITS DOCUMENT, A PAYMENT BY ITS LEDGER ROW ──
 *
 * They are genuinely different things and the ids are not interchangeable. An
 * invoice line points at a `sales_documents` row, which is where the lines, the
 * VAT breakdown and the stationery template live — `sourceDocId`. A payment has
 * no document of its own anywhere; the receipt is DERIVED from the ledger row
 * and its allocations, so it is addressed by `transactionId`.
 *
 * Getting that backwards is a route that renders somebody else's paperwork or
 * nothing at all, which is why the two live in one function rather than being
 * spelled out at each call site.
 */
export function documentHref(token: string, line: CustomerStatementLine): string | null {
  const base = `/portal/${token}`

  /*
   * An invoice or a credit note, both of which ARE sales documents. Credit
   * notes are included deliberately: the invoice route heads the page by the
   * document's own kind (see printKindFor), so a credit note downloads as a
   * credit note rather than as an invoice with a negative total.
   */
  if ((line.docType === 'invoice' || line.docType === 'credit_note') && line.sourceDocId) {
    return `${base}/invoice/${line.sourceDocId}`
  }

  if (line.docType === 'payment') {
    return `${base}/receipt/${line.transactionId}`
  }

  // Interest, write-offs, opening balances, journals. Real movements on the
  // account, but nobody issued a document for them.
  return null
}
