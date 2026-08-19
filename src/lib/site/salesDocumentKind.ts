import type { SalesDocument } from './salesDocuments'

/**
 * What a sales document calls itself, and what it asks the reader to do.
 *
 * ── WHY THIS IS ITS OWN MODULE ────────────────────────────────────────────
 *
 * One screen captures quotes, sales orders and invoices as one document at
 * different moments, and a credit note is that document reversed. What the paper
 * is CALLED follows from the type and the status — and three things need that
 * answer: the printed page, the emailed PDF and the customer portal.
 *
 * It lived in a print COMPONENT that imported the UI kit, and pulling that into
 * an email path to read two string maps is the kind of import that quietly drags
 * a design system into a background job. The words moved here, where a server
 * module reads them without dragging anything — and the component itself is now
 * gone, replaced by the template renderer.
 *
 * ── THE WORDING IS NOT DECORATION ─────────────────────────────────────────
 *
 * A credit note headed TAX INVOICE asks a customer to claim input tax twice; a
 * quote that ends "please pay" asks for money against an offer nobody accepted.
 * Section 20(4) of the VAT Act governs the first, s21(3) the second. Two copies
 * of these maps is how one path ends up saying something the other does not.
 */

export type PrintKind = 'quote' | 'sales_order' | 'proforma' | 'tax_invoice' | 'credit_note'

/**
 * What this paper is, from the document itself.
 *
 * Every caller asks here rather than branching on docType itself, because two
 * copies of this branch is exactly how a pro forma would one day get logged as a
 * tax invoice.
 */
export function printKindFor(doc: SalesDocument): PrintKind {
  if (doc.docType === 'quote') return 'quote'
  if (doc.docType === 'sales_order') return 'sales_order'
  /*
   * A credit note is NOT an invoice, and the difference is legal rather than
   * cosmetic: a customer who claimed input tax on the original reverses it
   * against this document, and one calling itself a TAX INVOICE would be asking
   * them to claim twice.
   *
   * It used to fall through to the line below and reach exactly that, which is
   * why the print route refused to serve one at all — the Print button on every
   * finalised credit note gave a 404 rather than a wrong document. Naming the
   * kind is what lets it print correctly instead of not printing.
   */
  if (doc.docType === 'credit_sale') return 'credit_note'
  return doc.status === 'finalised' ? 'tax_invoice' : 'proforma'
}

export const HEADING: Record<PrintKind, string> = {
  quote: 'QUOTATION',
  sales_order: 'SALES ORDER',
  proforma: 'PRO FORMA INVOICE',
  tax_invoice: 'TAX INVOICE',
  credit_note: 'CREDIT NOTE',
}

/**
 * The closing line under the totals — what the reader is meant to DO.
 *
 * Each document asks for something different, and a tax invoice asks for nothing
 * in particular, which is why its line is empty.
 */
export const CLOSING: Record<PrintKind, string> = {
  quote:
    'This is a quotation, not an invoice. No goods are reserved and no payment is due until it is accepted.',
  sales_order:
    'This is a confirmation of your order, not a tax invoice. An invoice follows when the goods are delivered.',
  proforma:
    'This is a pro forma invoice. It is not a tax invoice, no VAT may be claimed against it, and a tax invoice follows once payment is received.',
  tax_invoice: '',
  /*
   * No payment is due on a credit note, and saying so stops a customer paying a
   * document that is already in their favour.
   */
  credit_note:
    'This is a credit note. No payment is due — the amount above is credited against your account.',
}
