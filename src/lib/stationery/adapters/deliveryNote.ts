import type { RenderInput, TokenValues } from '../render'
import type { SalesDocument } from '../../site/salesDocuments'
import type { OrderDetails } from '../../site/salesOrders'

/**
 * A sales order's goods, as the paper that travels with them.
 *
 * ── NOT AN INVOICE WITH THE PRICES REMOVED ────────────────────────────────
 *
 * It would be easy to reuse the invoice adapter and leave the money out, and it
 * would be wrong in the way that matters: the invoice's catalog EXPOSES those
 * tokens, so a shop redesigning its delivery note could put them back. The
 * delivery note has its own document type whose token list contains no money at
 * all, and this adapter fills that list. A price on the driver's copy is then
 * impossible rather than merely absent — see the catalog for why that is worth
 * a separate document type.
 *
 * ── THREE QUANTITIES, BECAUSE A PART DELIVERY IS ORDINARY ─────────────────
 *
 * sales_document_lines carries qty_delivered, so the system already knows what
 * has gone before. The person signing needs ordered, delivered-before and
 * going-now, or they cannot tell a short delivery from a second one — and "you
 * are 4 short" against an order for 10 that already had 6 is an argument nobody
 * needs to have at a loading bay.
 */

/**
 * A non-breaking space, written as an escape so it is visible in a diff.
 *
 * A literal one in the source looks exactly like an ordinary space and would be
 * "tidied up" by the next person to read this file — taking the signature block
 * with it. See where it is used.
 */
const SIGNATURE_SPACE = '\u00a0'

const lines = (parts: (string | null | undefined)[]) =>
  parts.filter((p): p is string => !!p && p.trim() !== '').join('\n')

export type DeliveryNoteSources = {
  doc: SalesDocument
  details: OrderDetails | null
  site: {
    name: string
    vatNumber: string | null
    registrationNumber: string | null
    address1: string | null
    address2: string | null
    address3: string | null
    postalCode: string | null
    phone: string | null
    email: string | null
  }
  /** Where the goods are going, which is not always where the invoice is sent. */
  deliverTo: string[]
  printedAt: string
  logoHtml?: string | null
  /** What the paper calls itself. Passed in, as on every other document. */
  heading?: string
  closing?: string
}

export function deliveryNoteTokens(src: DeliveryNoteSources): RenderInput {
  const { doc, details, site } = src

  /*
   * Whether anything is still to come, decided from the LINES rather than from
   * fulfilment_status alone. The status is maintained by the ordering screen and
   * is right; the lines are the arithmetic, and a driver holding the paper wants
   * the arithmetic. Where the two disagree the lines win, because they are what
   * the reader can check against the boxes.
   */
  const outstanding = doc.lines.reduce(
    (sum, l) => sum + Math.max(0, l.qty - (l.qtyDelivered ?? 0)),
    0,
  )

  const values: TokenValues = {
    'site.name': site.name,
    'site.vatNumber': site.vatNumber,
    'site.registrationNumber': site.registrationNumber,
    'site.vatLine': site.vatNumber ? `VAT no. ${site.vatNumber}` : '',
    'site.registrationLine': site.registrationNumber
      ? `Reg. no. ${site.registrationNumber}`
      : '',
    'site.address': lines([site.address1, site.address2, site.address3, site.postalCode]),
    'site.address1': site.address1,
    'site.address2': site.address2,
    'site.address3': site.address3,
    'site.postalCode': site.postalCode,
    'site.phone': site.phone,
    'site.email': site.email,
    'site.logo': src.logoHtml ?? '',

    'doc.heading': src.heading ?? 'DELIVERY NOTE',
    'doc.number': doc.documentNumber ?? `Order #${doc.id}`,
    'doc.orderNumber': doc.documentNumber ?? '',
    'doc.date': doc.documentDate,
    'doc.deliveryDate': details?.deliveryDate ?? '',
    'doc.reference': doc.reference,
    'doc.customerReference': details?.customerOrderNo ?? doc.reference ?? '',
    'doc.notes': doc.notes?.trim() ?? '',
    'doc.deliveryNotes': doc.notes?.trim() ?? '',
    'doc.printedAt': src.printedAt,
    'doc.soldBy': doc.userName,
    'doc.closing':
      src.closing ??
      'Please check the goods against this note before signing. Shortages or damage must be reported on delivery.',

    /*
     * PART DELIVERY, in one token, so a design needs no conditional — the same
     * shape doc.statusBanner uses on the other documents. Empty when the order
     * is complete, and a block showing only this token hides itself.
     */
    'doc.fulfilment': outstanding > 0.0005 ? 'PART DELIVERY — the balance is still to come' : '',

    'customer.name': doc.customerName ?? 'Cash sale',
    'customer.code': doc.customerCode ?? '',
    'customer.address': doc.customerAddress ?? '',
    'customer.phone': doc.customerPhone ?? '',

    deliverTo: src.deliverTo.filter(Boolean).join('\n'),

  }

  const rows: TokenValues[] = doc.lines.map((line) => {
    const before = line.qtyDelivered ?? 0
    const now = Math.max(0, line.qty - before)
    /*
     * What is left AFTER this delivery. On a note that ships everything still
     * outstanding that is nothing, which is the ordinary case — so it prints
     * blank rather than a column of noughts saying nothing.
     */
    const left = Math.max(0, line.qty - before - now)

    return {
      'line.number': String(line.lineNumber),
      'line.description': line.description,
      'line.productCode': line.productCode ?? '',
      'line.qtyOrdered': line.qty,
      'line.qtyDeliveredBefore': before > 0.0005 ? before : null,
      /*
       * BLANK rather than 0 when nothing on this line is going today.
       *
       * The line stays on the note, because the receiver is checking against the
       * whole order and a line that silently disappeared would read as an order
       * we had forgotten. But the column says "Delivered now", and a 0 under it
       * is a claim that contradicts its own heading — so the row shows what was
       * ordered and what came before, and leaves today blank.
       */
      'line.qty': now > 0.0005 ? now : null,
      'line.qtyOutstanding': left > 0.0005 ? left : null,
    }
  })

  return { values, sections: { lines: rows }, capabilities: { isOwner: false, granted: new Set() } }
}
