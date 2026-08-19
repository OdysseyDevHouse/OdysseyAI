import type { DocumentSpec } from '../blocks'

/**
 * The shipped invoice, as BLOCKS.
 *
 * The same document `defaults/invoice.ts` expresses as markup, and the test
 * suite compares what the two render. That comparison is why this file exists
 * separately: if the block model cannot express the invoice we already ship, the
 * model is wrong, and finding that out here is cheaper than finding it out after
 * a shop has designed against it.
 *
 * Ids are literal rather than minted, because a shipped default is a constant:
 * two shops forking it should get the same document.
 *
 * ── WHAT AN INVOICE ADDS OVER A PURCHASE ORDER ────────────────────────────
 *
 * Three blocks the purchase order has no use for, and each is here for a
 * reason a shop must not be able to design away:
 *
 *   VAT SUMMARY — VAT by rate. A vendor is obliged to show it, and validate.ts
 *   refuses to save a fork that drops it.
 *
 *   BANKING — where to pay. Prints nothing at all unless every detail is set,
 *   so a shop that has not filled them in gets no empty caption.
 *
 *   The totals carry FIVE rows rather than three: discount and rounding sit
 *   between the subtotal and the VAT. Both hide themselves when zero, which is
 *   the ordinary case, so the everyday invoice still reads as three lines.
 *
 * ── THE LEGAL FIELDS ARE ORDINARY BLOCKS ──────────────────────────────────
 *
 * Nothing here is pinned or special-cased. `doc.heading` (which says TAX
 * INVOICE for a VAT vendor and INVOICE otherwise), the number, the date, both
 * parties' names and the VAT summary are just blocks — and validate.ts runs
 * over the COMPILED markup, so a design that drops one cannot be saved. The
 * enforcement is in one place, and it is the same place a hand-written template
 * answers to.
 *
 * ── THE y NUMBERS ARE MEASURED ────────────────────────────────────────────
 *
 * Percent of the band, taken from the real rendered blocks rather than
 * calculated — the purchase order's first set was arithmetic and put the
 * letterhead through the rule below it. Headroom is left over rather than packed
 * tight, because a customer with a longer address makes the block above taller.
 */
export const INVOICE_BLOCKS: DocumentSpec = {
  version: 1,
  blocks: [
    /* ── the top of the page ──────────────────────────────────────────────── */

    // Its own block, so it can be dragged and sized. See purchaseOrderBlocks
    // for why this is not a letterhead token.
    {
      id: 'inv-logo',
      kind: 'logo',
      band: 'header',
      x: 0,
      y: 0,
      w: 30,
      logoHeight: 56,
    },
    {
      id: 'inv-letterhead',
      kind: 'letterhead',
      band: 'header',
      x: 0,
      y: 16,
      w: 58,
      tokens: [
        'site.name',
        'site.address',
        'site.vatLine',
        'site.registrationLine',
        'site.phone',
        'site.email',
      ],
    },
    {
      id: 'inv-title',
      kind: 'docTitle',
      band: 'header',
      x: 60,
      // Level with the business name, as on the purchase order.
      y: 16,
      w: 40,
      align: 'right',
      // No literal title: {doc.heading} decides between TAX INVOICE and INVOICE
      // from whether this shop is a VAT vendor, and hard-coding either would
      // print a claim about the business that might not be true.
      tokens: ['doc.heading', 'doc.number', 'doc.date'],
    },

    { id: 'inv-rule-1', kind: 'rule', band: 'header', x: 0, y: 50, w: 100 },

    {
      id: 'inv-customer',
      kind: 'partyBlock',
      band: 'header',
      x: 0,
      y: 56,
      w: 48,
      title: 'BILL TO',
      tokens: ['customer.name', 'customer.address', 'customer.phone', 'customer.vatNumber'],
    },
    {
      id: 'inv-details',
      kind: 'detailList',
      band: 'header',
      x: 52,
      y: 56,
      w: 48,
      rows: [
        { token: 'customer.code', label: 'Account' },
        { token: 'doc.dueDate', label: 'Due' },
        { token: 'doc.reference', label: 'Reference' },
        { token: 'doc.soldBy', label: 'Served by' },
      ],
    },

    /* ── the items ────────────────────────────────────────────────────────── */

    {
      id: 'inv-lines',
      kind: 'lineTable',
      band: 'body',
      x: 0,
      y: 0,
      w: 100,
      columns: [
        // The product code under the description, the way a real invoice reads.
        { token: 'line.description', heading: 'Item', subToken: 'line.productCode' },
        { token: 'line.qty', heading: 'Qty', align: 'right' },
        // INCLUSIVE prices, unlike the purchase order's cost columns: a customer
        // reads what they pay, a buyer reads what the goods cost before VAT.
        { token: 'line.unitPriceIncl', heading: 'Unit price', align: 'right' },
        { token: 'line.totalIncl', heading: 'Amount', align: 'right' },
      ],
    },

    /* ── below the items ──────────────────────────────────────────────────── */

    {
      id: 'inv-totals',
      kind: 'totals',
      band: 'footer',
      x: 60,
      y: 0,
      w: 40,
      // The last token is the grand total — see the totals compiler. Discount
      // and rounding hide themselves when zero.
      tokens: [
        'totals.goodsExcl',
        'totals.discountIncl',
        'totals.vat',
        'totals.roundingAdj',
        'totals.totalIncl',
      ],
    },
    {
      id: 'inv-vat',
      kind: 'vatSummary',
      band: 'footer',
      x: 0,
      y: 0,
      w: 55,
      title: 'VAT SUMMARY',
    },

    { id: 'inv-rule-2', kind: 'rule', band: 'footer', x: 0, y: 34, w: 100 },

    {
      id: 'inv-banking',
      kind: 'banking',
      band: 'footer',
      x: 0,
      y: 40,
      w: 48,
      title: 'BANKING DETAILS',
    },
    {
      id: 'inv-notes',
      kind: 'notes',
      band: 'footer',
      x: 52,
      y: 40,
      w: 48,
      title: 'NOTES',
    },

    // Clear of the banking block, which is the tallest thing above it and grows
    // with a longer bank name. Measured at 66; 72 leaves room for that.
    { id: 'inv-rule-3', kind: 'rule', band: 'footer', x: 0, y: 72, w: 100 },

    {
      id: 'inv-closing',
      kind: 'text',
      band: 'footer',
      x: 0,
      y: 78,
      w: 100,
      // A token rather than typed words: the closing line differs between an
      // invoice and a quote, and the document kind decides it.
      text: '{doc.closing}',
    },
    {
      id: 'inv-printed',
      kind: 'text',
      band: 'footer',
      x: 0,
      y: 84,
      w: 100,
      text: 'Printed {doc.printedAt}',
    },
  ],
}
