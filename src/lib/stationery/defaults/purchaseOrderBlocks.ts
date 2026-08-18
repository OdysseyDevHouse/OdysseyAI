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
 */
export const PURCHASE_ORDER_BLOCKS: DocumentSpec = {
  version: 1,
  blocks: [
    {
      id: 'po-letterhead',
      kind: 'letterhead',
      span: 'left',
      tokens: [
        'site.logo',
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
      span: 'right',
      title: 'PURCHASE ORDER',
      tokens: ['doc.number', 'doc.date', 'doc.statusBanner'],
    },

    { id: 'po-rule-1', kind: 'rule' },

    {
      id: 'po-supplier',
      kind: 'partyBlock',
      span: 'left',
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
      span: 'right',
      align: 'left',
      title: 'DELIVER TO',
      tokens: ['deliverTo'],
    },

    {
      id: 'po-details',
      kind: 'detailList',
      rows: [
        { token: 'doc.expectedDate', label: 'Required by' },
        { token: 'doc.reference', label: 'Reference' },
        { token: 'supplier.paymentTermsLine', label: 'Terms' },
        { token: 'doc.orderedBy', label: 'Ordered by' },
      ],
    },

    {
      id: 'po-lines',
      kind: 'lineTable',
      columns: [
        { token: 'line.description', heading: 'Item', subToken: 'line.supplierCode' },
        { token: 'line.qty', heading: 'Qty', align: 'right' },
        { token: 'line.unitCostExcl', heading: 'Unit cost', align: 'right' },
        { token: 'line.totalExcl', heading: 'Total (excl.)', align: 'right' },
      ],
    },

    {
      id: 'po-totals',
      kind: 'totals',
      tokens: ['totals.goodsExcl', 'totals.vat', 'totals.totalIncl'],
    },

    { id: 'po-notes', kind: 'notes', title: 'NOTES' },

    { id: 'po-rule-2', kind: 'rule' },

    {
      id: 'po-terms',
      kind: 'text',
      text:
        'Please quote {doc.number} on your delivery note and invoice. ' +
        'Deliveries not matching this order may be refused.',
    },

    {
      id: 'po-printed',
      kind: 'text',
      text: 'Printed {doc.printedAt}',
    },
  ],
}
