import type { DocumentSpec } from '../blocks'

/**
 * The shipped purchase order, as BLOCKS.
 *
 * The same document `defaults/purchaseOrder.ts` expresses as markup — and the
 * test suite compares what the two render, word for word. That comparison is
 * the point of this file existing separately: if the block model cannot express
 * the document we already ship, the model is wrong, and finding that out here
 * is far cheaper than finding it out after a shop has designed against it.
 *
 * Ids are literal rather than minted, because a shipped default is a constant:
 * two shops forking it should get the same document, and a random id would make
 * every stored copy differ from every other for no reason anyone could see.
 *
 * ── SIDE BY SIDE IS NOW A COORDINATE ──────────────────────────────────────
 *
 * The letterhead at x:0 w:58 and the title at x:60 w:40 print beside each other
 * because that is where they are, not because they were put in a two-cell row.
 * A shop that wants the title on the left drags it there; the old model needed
 * them to understand cells first.
 *
 * The uneven split is still the right default and still for the same reason: the
 * letterhead carries an address and four contact lines and wants the room, while
 * the title is a number and a date.
 *
 * ── THE y NUMBERS ARE MEASURED, NOT CALCULATED ────────────────────────────
 *
 * Percent of the band, and they encode the ONE thing free placement cannot
 * infer: that the letterhead is seven lines tall, so the rule and the party
 * blocks have to clear it.
 *
 * The first set of these was arithmetic, and it was wrong — the browser showed
 * the letterhead running straight through the rule below it, and DELIVER TO
 * running into the detail list. The parity test passed the whole time, because it
 * compares the WORDS on the page in order and two overlapping blocks say the same
 * words in the same order.
 *
 * So these come from measuring the real rendered blocks, with headroom left over
 * rather than packed tight: a shop with a longer address gets a taller
 * letterhead, and a default that only fits this site's details is not a default.
 * `test-stationery-blocks` now asserts the clearance directly.
 */
export const PURCHASE_ORDER_BLOCKS: DocumentSpec = {
  version: 1,
  blocks: [
    /* ── the top of the page ──────────────────────────────────────────────── */

    /*
     * THE LOGO IS ITS OWN BLOCK IN THE SHIPPED DEFAULT.
     *
     * It used to be a token inside the letterhead, which printed correctly and
     * could not be moved: a token has no box to take hold of, so "drag the logo
     * where I want it" had no answer for the design every shop actually starts
     * from. Adding a logo block from the palette gave you a second one.
     *
     * Split out, it is draggable and sizable from the moment the designer opens,
     * and the letterhead below it is just the words. `site.logo` remains a
     * letterhead token for anyone who wants them welded together again.
     */
    {
      id: 'po-logo',
      kind: 'logo',
      band: 'header',
      x: 0,
      y: 0,
      w: 30,
      logoHeight: 56,
    },
    {
      id: 'po-letterhead',
      kind: 'letterhead',
      band: 'header',
      x: 0,
      // Clear of the logo above it, which is why the letterhead does not start at 0
      // even though it usually looks as though it could.
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
      id: 'po-title',
      kind: 'docTitle',
      band: 'header',
      x: 60,
      // Level with the business name rather than with the logo above it, which
      // is both how the markup default reads and the better-looking answer: a
      // title floating above the letterhead lines up with nothing.
      y: 16,
      w: 40,
      align: 'right',
      title: 'PURCHASE ORDER',
      tokens: ['doc.number', 'doc.date', 'doc.statusBanner'],
    },

    // Clear of the letterhead, which is the tallest thing above it.
    { id: 'po-rule-1', kind: 'rule', band: 'header', x: 0, y: 50, w: 100 },

    {
      id: 'po-supplier',
      kind: 'partyBlock',
      band: 'header',
      x: 0,
      y: 56,
      w: 48,
      title: 'TO',
      tokens: [
        'supplier.name',
        'supplier.contactName',
        'supplier.address',
        'supplier.email',
        'supplier.phone',
        'supplier.accountLine',
      ],
    },
    {
      id: 'po-deliver',
      kind: 'partyBlock',
      band: 'header',
      x: 52,
      y: 56,
      w: 48,
      title: 'DELIVER TO',
      tokens: ['deliverTo'],
    },
    {
      id: 'po-details',
      kind: 'detailList',
      band: 'header',
      x: 52,
      y: 84,
      w: 48,
      rows: [
        { token: 'doc.expectedDate', label: 'Required by' },
        { token: 'doc.reference', label: 'Reference' },
        { token: 'supplier.paymentTermsLine', label: 'Terms' },
        { token: 'doc.orderedBy', label: 'Ordered by' },
      ],
    },

    /* ── the items ────────────────────────────────────────────────────────── */

    {
      id: 'po-lines',
      kind: 'lineTable',
      band: 'body',
      x: 0,
      y: 0,
      w: 100,
      columns: [
        { token: 'line.description', heading: 'Item', subToken: 'line.supplierCode' },
        { token: 'line.qty', heading: 'Qty', align: 'right' },
        { token: 'line.unitCostExcl', heading: 'Unit cost', align: 'right' },
        { token: 'line.totalExcl', heading: 'Total (excl.)', align: 'right' },
      ],
    },

    /* ── below the items ──────────────────────────────────────────────────── */

    // The totals sit right, the notes left, so a long note and a tall totals box
    // do not fight each other for the same room.
    {
      id: 'po-totals',
      kind: 'totals',
      band: 'footer',
      x: 60,
      y: 0,
      w: 40,
      tokens: ['totals.goodsExcl', 'totals.vat', 'totals.totalIncl'],
    },
    {
      id: 'po-notes',
      kind: 'notes',
      band: 'footer',
      x: 0,
      y: 0,
      w: 55,
      title: 'NOTES',
    },

    { id: 'po-rule-2', kind: 'rule', band: 'footer', x: 0, y: 30, w: 100 },

    {
      id: 'po-terms',
      kind: 'text',
      band: 'footer',
      x: 0,
      y: 36,
      w: 100,
      text:
        'Please quote {doc.number} on your delivery note and invoice. ' +
        'Deliveries not matching this order may be refused.',
    },

    {
      id: 'po-printed',
      kind: 'text',
      band: 'footer',
      x: 0,
      y: 42,
      w: 100,
      text: 'Printed {doc.printedAt}',
    },
  ],
}
