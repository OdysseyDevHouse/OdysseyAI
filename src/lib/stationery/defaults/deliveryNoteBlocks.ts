import type { DocumentSpec } from '../blocks'

/**
 * The shipped delivery note, as BLOCKS.
 *
 * ── IT LOOKS LIKE THE OTHER PAPERWORK ON PURPOSE ──────────────────────────
 *
 * Same letterhead, same title block, same table. A driver arriving with a
 * document that looks nothing like the invoice that follows it invites the
 * question "is this from you?", and a business whose paperwork does not match is
 * a business that looks careless.
 *
 * ── WHAT IS DIFFERENT, AND WHY ────────────────────────────────────────────
 *
 * NO PRICES. Not one, and not by choice: the delivery note's token catalog has
 * no money in it at all, so a shop redesigning this cannot put them back. The
 * reason is in catalog.ts — goods go to receiving bays, site foremen and
 * tenants, and what the customer is paying is none of their business.
 *
 * THREE QUANTITY COLUMNS. Ordered, already delivered, and going now. A part
 * delivery is ordinary, and somebody signing for four of ten needs to see
 * whether the other six came last week or are still to come.
 *
 * A SIGNATURE BLOCK. Two labelled rules at the bottom, side by side. A block
 * kind rather than a pair of always-empty tokens: the renderer treats an empty
 * value as absent, quite rightly, so tokens vanished from the page. A line to
 * sign on is a rule DRAWN, not a value that happens to be blank.
 *
 * ── THE y NUMBERS ARE MEASURED ────────────────────────────────────────────
 *
 * Percent of the band, taken from the rendered blocks rather than calculated —
 * the purchase order's first set was arithmetic and printed the letterhead
 * through the rule below it.
 */
export const DELIVERY_NOTE_BLOCKS: DocumentSpec = {
  version: 1,
  blocks: [
    /* ── the top of the page ──────────────────────────────────────────────── */

    {
      id: 'dn-logo',
      kind: 'logo',
      band: 'header',
      x: 0,
      y: 0,
      w: 30,
      logoHeight: 56,
    },
    {
      id: 'dn-letterhead',
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
      id: 'dn-title',
      kind: 'docTitle',
      band: 'header',
      x: 60,
      y: 16,
      w: 40,
      align: 'right',
      // A token rather than a literal, as on every other document: one place
      // decides what the paper calls itself.
      tokens: ['doc.heading', 'doc.number', 'doc.date', 'doc.fulfilment'],
    },

    { id: 'dn-rule-1', kind: 'rule', band: 'header', x: 0, y: 50, w: 100 },

    /*
     * WHERE THE GOODS GO, not where the invoice is sent. A head office pays and
     * a site takes delivery, and the driver needs the second address.
     */
    {
      id: 'dn-deliver',
      kind: 'partyBlock',
      band: 'header',
      x: 0,
      y: 56,
      w: 48,
      title: 'DELIVER TO',
      tokens: ['customer.name', 'deliverTo', 'customer.phone'],
    },
    {
      id: 'dn-details',
      kind: 'detailList',
      band: 'header',
      x: 52,
      y: 56,
      w: 48,
      rows: [
        { token: 'customer.code', label: 'Account' },
        { token: 'doc.orderNumber', label: 'Order' },
        { token: 'doc.deliveryDate', label: 'Delivery date' },
        { token: 'doc.customerReference', label: 'Your order no.' },
        { token: 'doc.soldBy', label: 'Taken by' },
      ],
    },

    /* ── what is in the boxes ─────────────────────────────────────────────── */

    {
      id: 'dn-lines',
      kind: 'lineTable',
      band: 'body',
      x: 0,
      y: 0,
      w: 100,
      columns: [
        { token: 'line.description', heading: 'Item', subToken: 'line.productCode', width: 52 },
        { token: 'line.qtyOrdered', heading: 'Ordered', width: 16, align: 'right' },
        // Blank on a first delivery — see the adapter: a column of noughts says
        // nothing and reads as a fault.
        { token: 'line.qtyDeliveredBefore', heading: 'Sent before', width: 16, align: 'right' },
        { token: 'line.qty', heading: 'Delivered now', width: 16, align: 'right' },
      ],
    },

    /* ── below the goods ──────────────────────────────────────────────────── */

    {
      id: 'dn-instructions',
      kind: 'notes',
      band: 'footer',
      x: 0,
      y: 0,
      w: 55,
      title: 'DELIVERY INSTRUCTIONS',
    },

    { id: 'dn-rule-2', kind: 'rule', band: 'footer', x: 0, y: 14, w: 100 },

    /*
     * THE SIGNATURE BLOCK.
     *
     * Two labelled rules, side by side. A block rather than a pair of tokens:
     * a blank line to sign on is a rule DRAWN on the page, not a value that
     * happens to be empty — and the renderer rightly treats an empty value as
     * absent, so tokens vanished. See the block catalog.
     */
    { id: 'dn-sign-name', kind: 'signature', band: 'footer', x: 0, y: 20, w: 48,
      title: 'Received by (print name and sign)' },
    { id: 'dn-sign-date', kind: 'signature', band: 'footer', x: 52, y: 20, w: 48,
      title: 'Date received' },

    {
      id: 'dn-closing',
      kind: 'text',
      band: 'footer',
      x: 0,
      y: 40,
      w: 100,
      text: '{doc.closing}',
    },
    {
      id: 'dn-printed',
      kind: 'text',
      band: 'footer',
      x: 0,
      y: 46,
      w: 100,
      text: 'Printed {doc.printedAt}',
    },
  ],
}
