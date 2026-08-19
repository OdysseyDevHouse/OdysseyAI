import type { Capability } from '../site/permissions'

/**
 * The stationery TOKEN CATALOG — the whitelist of everything a designed
 * document is allowed to print.
 *
 * ── THIS FILE IS THE SECURITY BOUNDARY ────────────────────────────────────
 *
 * A template arriving from the browser is markup with `{token}` holes in it. It
 * never carries a field path, a table name or an expression: the renderer looks
 * every token up here and reads the value through this file's own accessor. A
 * token that is NOT here prints nothing, however the template was composed.
 *
 * Consequently adding a field is a one-line change that appears in the designer
 * immediately, and no template can reach data a developer did not deliberately
 * expose — including data that merely happens to sit on the same view model.
 *
 * This is the same boundary reportBuilder/catalog.ts draws for reports, for the
 * same reason and with the same consequence.
 *
 * ── CLIENT-SAFE ───────────────────────────────────────────────────────────
 *
 * No `server-only`, no database import. The designer runs this exact catalog to
 * list available tokens and to validate a template, so what the editor says
 * about a template and what the server does with it cannot drift.
 *
 * ── PERMISSIONS DEGRADE SILENTLY ──────────────────────────────────────────
 *
 * A token may carry a capability. Rendered by someone without it, the token
 * resolves to empty rather than erroring — so one template serves a shop where
 * the buyer sees cost and the counter staff do not, and nobody maintains two
 * copies that will drift. This mirrors the field-level rule in the report
 * catalog: a document shared across a shop will be printed by people with
 * different rights, and it should degrade for the junior rather than break.
 *
 * The FORMAT matters as much as the value: money goes through formatMoney, so a
 * designed invoice can never print a bare 1234.5.
 */

/** How a value is turned into text. Never raw interpolation. */
export type TokenFormat =
  | 'text'
  | 'money'
  | 'qty'
  | 'percent'
  | 'date'
  | 'multiline'
  /**
   * Markup the SERVER composed, emitted without escaping.
   *
   * The one exception to "every value is escaped", and it is deliberately not
   * available to arbitrary fields: a token may only carry this format if its
   * value is built in TypeScript from something already proved safe. Today that
   * is exactly one token — `site.logo`, whose tag is assembled by
   * lib/site/documentLogo.ts around a UUID filename this site uploaded and
   * which was verified by magic bytes to be a picture.
   *
   * No value that originated as user text may ever be given this format.
   */
  | 'markup'

export type TokenDef = {
  /** What a template writes between braces. */
  key: string
  /** Shown in the designer's token panel. */
  label: string
  format: TokenFormat
  /** Withheld — silently — from anyone without this. */
  permission?: Capability
  /** One line in the token panel, where the name alone is ambiguous. */
  hint?: string
}

/**
 * The repeatable sections a template may loop over with `{#each}`.
 *
 * A document is a letterhead, some parties, a TABLE and some totals. The table
 * is the part plain substitution cannot express, so it gets a construct. See
 * render.ts for why the list is short and stays short.
 *
 * The age ladder is the second one, and it earns its place for the same reason rather
 * than by analogy: a statement's age ladder has headings that CHANGE with the
 * account — 7/14/21 days for a weekly account, 30/60/90 for a monthly one — so
 * the labels have to travel with the figures. Six fixed tokens would each be
 * wrong for half the accounts on the ledger.
 */
export type SectionKey = 'lines' | 'vatByRate' | 'tenders' | 'aging'

export type SectionDef = {
  key: SectionKey
  label: string
  /** Tokens legal INSIDE this section, in addition to the document's own. */
  tokens: readonly TokenDef[]
}

export type DocTypeDef = {
  key: string
  label: string
  /** How this document reaches paper. Decides which designer opens it. */
  medium: 'a4' | 'slip'
  tokens: readonly TokenDef[]
  sections: readonly SectionDef[]
}

/* ── shared token groups ───────────────────────────────────────────────────
 *
 * The letterhead is the same business on every document, so it is declared once
 * and spread into each. A site that fixes its VAT number fixes it everywhere,
 * and no document can invent a different name for the company issuing it.
 */

const SITE_TOKENS: readonly TokenDef[] = [
  { key: 'site.name', label: 'Business name', format: 'text' },
  { key: 'site.vatNumber', label: 'VAT number', format: 'text' },
  { key: 'site.registrationNumber', label: 'Company reg. number', format: 'text' },
  /*
   * Labelled variants, for the same reason as supplier.accountLine: a business
   * that is not a VAT vendor has no VAT number, and "VAT no." over a blank
   * reads as a number someone forgot to fill in rather than one that does not
   * exist. The bare tokens above stay, for a letterhead that lays the label out
   * itself.
   */
  {
    key: 'site.vatLine',
    label: 'VAT number (with label)',
    format: 'text',
    hint: 'Prints "VAT no. 4123456789", or nothing when the business has none.',
  },
  {
    key: 'site.registrationLine',
    label: 'Reg. number (with label)',
    format: 'text',
    hint: 'Prints "Reg. no. 2019/123456/07", or nothing when none is set.',
  },
  { key: 'site.address', label: 'Address (all lines)', format: 'multiline' },
  { key: 'site.address1', label: 'Address line 1', format: 'text' },
  { key: 'site.address2', label: 'Address line 2', format: 'text' },
  { key: 'site.address3', label: 'Address line 3', format: 'text' },
  { key: 'site.postalCode', label: 'Postal code', format: 'text' },
  { key: 'site.phone', label: 'Phone', format: 'text' },
  { key: 'site.email', label: 'Email', format: 'text' },
  {
    key: 'site.logo',
    label: 'Logo',
    format: 'markup',
    hint: 'The uploaded logo, as an image. Prints nothing when none is set.',
  },
]

/** Every document has a number, a date and a moment it was printed. */
const DOC_TOKENS: readonly TokenDef[] = [
  { key: 'doc.number', label: 'Document number', format: 'text' },
  { key: 'doc.date', label: 'Document date', format: 'date' },
  { key: 'doc.reference', label: 'Reference', format: 'text' },
  { key: 'doc.notes', label: 'Notes', format: 'multiline' },
  { key: 'doc.printedAt', label: 'Printed at', format: 'text' },
]

/* ── purchase order ────────────────────────────────────────────────────────
 *
 * The supplier's copy. Everything about the order's own life in our system —
 * received quantities, landed cost, the audit trail — is deliberately absent
 * from this catalog, not merely absent from the default template: a supplier
 * reading "3 of 10 received" would be reading our records, not their
 * instruction, and no amount of redesign should be able to put it on the page.
 *
 * Quantity is ORDERED, always. On a part-received order a reprint still says
 * ten, because the order was for ten.
 */

const PURCHASE_ORDER: DocTypeDef = {
  key: 'purchase_order',
  label: 'Purchase order',
  medium: 'a4',
  tokens: [
    ...SITE_TOKENS,
    ...DOC_TOKENS,
    { key: 'doc.expectedDate', label: 'Required by', format: 'date' },
    { key: 'doc.orderedBy', label: 'Ordered by', format: 'text' },
    { key: 'doc.status', label: 'Status', format: 'text' },
    {
      key: 'doc.statusBanner',
      label: 'Status banner',
      format: 'text',
      hint: 'Prints DRAFT, CANCELLED or REPRINT when they apply, and nothing when they do not.',
    },
    { key: 'supplier.name', label: 'Supplier name', format: 'text' },
    { key: 'supplier.contactName', label: 'Supplier contact', format: 'text' },
    { key: 'supplier.address', label: 'Supplier address', format: 'multiline' },
    { key: 'supplier.email', label: 'Supplier email', format: 'text' },
    { key: 'supplier.phone', label: 'Supplier phone', format: 'text' },
    { key: 'supplier.vatNumber', label: 'Supplier VAT number', format: 'text' },
    { key: 'supplier.accountNumber', label: 'Our account number', format: 'text' },
    { key: 'supplier.paymentTerms', label: 'Payment terms (days)', format: 'text' },
    /*
     * Pre-composed variants of the two fields above.
     *
     * A label belongs with its value when the value is optional: "Our account:"
     * over a blank is a caption for nothing, and "Terms" against an empty box
     * reads as terms that were forgotten rather than terms that do not apply.
     * The template language has no conditionals on purpose, so the CONDITION
     * lives in the adapter — the same reasoning as doc.statusBanner.
     */
    {
      key: 'supplier.accountLine',
      label: 'Our account (with label)',
      format: 'text',
      hint: 'Prints "Our account: 12345", or nothing when there is no account number.',
    },
    {
      key: 'supplier.paymentTermsLine',
      label: 'Payment terms (with unit)',
      format: 'text',
      hint: 'Prints "30 days", or nothing when no terms are set.',
    },
    { key: 'deliverTo', label: 'Deliver to (all lines)', format: 'multiline' },
    { key: 'totals.goodsExcl', label: 'Goods (excl.)', format: 'money' },
    { key: 'totals.chargesExcl', label: 'Delivery / charges', format: 'money' },
    { key: 'totals.discountExcl', label: 'Discount', format: 'money' },
    { key: 'totals.vat', label: 'VAT', format: 'money' },
    { key: 'totals.totalIncl', label: 'Total', format: 'money' },
  ],
  sections: [
    {
      key: 'lines',
      label: 'Order lines',
      tokens: [
        { key: 'line.number', label: 'Line number', format: 'text' },
        { key: 'line.description', label: 'Description', format: 'text' },
        { key: 'line.productCode', label: 'Our stock code', format: 'text' },
        {
          key: 'line.supplierCode',
          label: 'Supplier code',
          format: 'text',
          hint: 'Their catalogue number — what the supplier picks from.',
        },
        { key: 'line.qty', label: 'Quantity ordered', format: 'qty' },
        /* Cost on a purchase order is the whole reason this feature exists.
           Gated, so one template serves shops that show it and shops that do
           not, decided by who is printing rather than by a second template. */
        {
          key: 'line.unitCostExcl',
          label: 'Unit cost (excl.)',
          format: 'money',
          permission: 'products.cost',
        },
        {
          key: 'line.discountPct',
          label: 'Discount %',
          format: 'percent',
          permission: 'products.cost',
        },
        {
          key: 'line.discountAmount',
          label: 'Discount amount',
          format: 'money',
          permission: 'products.cost',
        },
        { key: 'line.vatRatePct', label: 'VAT rate %', format: 'percent' },
        {
          key: 'line.totalExcl',
          label: 'Line total (excl.)',
          format: 'money',
          permission: 'products.cost',
        },
      ],
    },
  ],
}

/* ── invoice ───────────────────────────────────────────────────────────────
 *
 * The customer's copy, and the one document in this catalog with a STATUTE
 * behind it. Section 20(4) of the VAT Act requires a tax invoice to carry the
 * words "tax invoice", both parties' names and addresses, the supplier's VAT
 * number, a serial number, the date, and the VAT either shown separately or
 * stated as included. A customer cannot claim input VAT on a document missing
 * any of them, so those are not decoration — an invoice without them comes
 * back. validate.ts refuses to save a template that drops one.
 *
 * Cost and margin are absent from this catalog entirely, and unlike the
 * purchase order that is not a permission question: what a shop paid for the
 * goods is nobody's business but the shop's, and there is no capability that
 * should put it on a document going to the person buying them.
 */

const INVOICE: DocTypeDef = {
  key: 'invoice',
  label: 'Invoice',
  medium: 'a4',
  tokens: [
    ...SITE_TOKENS,
    ...DOC_TOKENS,
    { key: 'doc.dueDate', label: 'Due date', format: 'date' },
    { key: 'doc.heading', label: 'Document heading', format: 'text', hint: 'Prints TAX INVOICE, or INVOICE when the business is not a VAT vendor.' },
    { key: 'doc.soldBy', label: 'Served by', format: 'text' },

    /*
     * ── TWO FIELDS THE EMAILED PDF CARRIES AND THE PRINTED PAGE DOES NOT ──
     *
     * A pay-online link is useless on paper and is the point of an emailed
     * invoice; a foot note names the contract a recurring invoice came from.
     * Both are tokens rather than a second document shape, so ONE design drives
     * both media and a shop that wants the link on its printed copy may put it
     * there.
     *
     * Empty on any document that has neither, and a detail row or lone-token
     * text block drops itself when empty — so the design needs no conditional.
     */
    { key: 'doc.paymentUrl', label: 'Pay-online link', format: 'text', hint: 'Where a customer can pay this invoice. Empty when none has been minted, and on a printed copy.' },
    { key: 'doc.footNote', label: 'Foot note', format: 'text', hint: 'Free text under the totals — the contract a recurring invoice came from, for instance.' },

    /*
     * ── THE FIELDS THE PRINTED PAGE CARRIES THAT THIS CATALOG DID NOT ─────
     *
     * One route prints quotes, sales orders, pro formas and tax invoices, and
     * each kind has a date of its own: a quote EXPIRES, an order is promised for
     * a day, an invoice on account falls DUE. The React component this replaces
     * branched on the kind to pick one; a template has no conditionals, so all
     * three are tokens and each is empty on the kinds it does not apply to.
     *
     * A design can therefore show all three as labelled rows — and a detail list
     * already drops a row whose value is empty, so one design prints "Valid
     * until" on a quote and "Due" on an invoice with nothing to configure.
     */
    { key: 'doc.validUntil', label: 'Valid until (quotes)', format: 'date', hint: 'A quote\'s expiry. Empty on any other document.' },
    { key: 'doc.deliveryDate', label: 'Delivery date (orders)', format: 'date', hint: 'A sales order\'s promised date. Empty on any other document.' },
    {
      key: 'doc.customerReference',
      label: 'Their reference',
      format: 'text',
      hint: 'The customer\'s own order number where they gave one, otherwise the reference on this document.',
    },
    {
      key: 'doc.statusBanner',
      label: 'Status banner',
      format: 'text',
      hint: 'Prints DRAFT, CANCELLED or REPRINT when they apply, and nothing when they do not.',
    },
    { key: 'doc.closing', label: 'Closing line', format: 'text', hint: 'What the reader should do — pay by the due date, accept the quote. Set by the document kind.' },
    { key: 'customer.name', label: 'Customer name', format: 'text' },
    { key: 'customer.code', label: 'Customer account code', format: 'text' },
    { key: 'customer.address', label: 'Customer address', format: 'multiline' },
    { key: 'customer.phone', label: 'Customer phone', format: 'text' },
    { key: 'customer.vatNumber', label: 'Customer VAT number', format: 'text' },
    /*
     * Banking is all or nothing, as lib/invoices/build.ts puts it: "an invoice
     * with a half-filled banking block is worse than one with none, because it
     * looks like enough information to pay against." So it is ONE token, not
     * four — a template cannot print a bank name without an account number.
     */
    { key: 'banking', label: 'Banking details', format: 'multiline', hint: 'Bank, account name, number and branch. Prints nothing unless all are set.' },
    { key: 'totals.goodsExcl', label: 'Subtotal (excl.)', format: 'money' },
    { key: 'totals.discountIncl', label: 'Discount', format: 'money' },
    { key: 'totals.vat', label: 'VAT', format: 'money' },
    { key: 'totals.roundingAdj', label: 'Rounding', format: 'money' },
    { key: 'totals.totalIncl', label: 'Total', format: 'money' },
    { key: 'totals.vatSummary', label: 'VAT by rate', format: 'multiline', hint: 'One line per VAT rate — the analysis a vendor must show.' },
  ],
  sections: [
    {
      key: 'lines',
      label: 'Invoice lines',
      tokens: [
        { key: 'line.number', label: 'Line number', format: 'text' },
        { key: 'line.description', label: 'Description', format: 'text' },
        { key: 'line.productCode', label: 'Product code', format: 'text' },
        { key: 'line.qty', label: 'Quantity', format: 'qty' },
        { key: 'line.unitPriceIncl', label: 'Unit price (incl.)', format: 'money' },
        { key: 'line.discountPct', label: 'Discount %', format: 'percent' },
        { key: 'line.vatRatePct', label: 'VAT rate %', format: 'percent' },
        { key: 'line.totalExcl', label: 'Line total (excl.)', format: 'money' },
        { key: 'line.totalIncl', label: 'Line total (incl.)', format: 'money' },
      ],
    },
  ],
}

/*
 * The delivery note.
 *
 * ── WHAT IT IS FOR, AND WHO READS IT ──────────────────────────────────────
 *
 * The copy that travels with the goods. A driver hands it over, someone at the
 * receiving end counts what is in the boxes against what is on the paper, and
 * signs. That is the whole job.
 *
 * ── IT CARRIES NO PRICES, AND CANNOT BE MADE TO ───────────────────────────
 *
 * There is not one money token in this list — no unit price, no line total, no
 * totals block, no banking. That is the security boundary doing its work rather
 * than a default someone can change: the catalog is what a design may name, so a
 * shop CANNOT put prices on a delivery note however they redesign it, and a
 * template that names {line.unitPriceIncl} resolves it to nothing.
 *
 * The reason is ordinary trade. Goods are routinely delivered to a receiving
 * bay, a site foreman or a tenant who has no business seeing what the customer
 * is paying — and to a customer's own staff, where the margin on the order is
 * nobody's business but the buyer's. A price on the driver's copy is a
 * commercial leak with no upside, and one that only shows up after it has
 * happened.
 *
 * ── QUANTITIES ARE THREE NUMBERS, NOT ONE ─────────────────────────────────
 *
 * Ordered, delivered before, and going now. sales_document_lines carries
 * qty_delivered per line and sales_order_details a fulfilment_status, so a part
 * delivery is a fact the system already knows — and the person signing needs to
 * see all three or they cannot tell a short delivery from a second one.
 */
const DELIVERY_NOTE: DocTypeDef = {
  key: 'delivery_note',
  label: 'Delivery note',
  medium: 'a4',
  tokens: [
    ...SITE_TOKENS,
    ...DOC_TOKENS,
    { key: 'doc.heading', label: 'Document heading', format: 'text', hint: 'Prints DELIVERY NOTE.' },
    { key: 'doc.orderNumber', label: 'Order number', format: 'text', hint: 'The sales order these goods are against.' },
    { key: 'doc.deliveryDate', label: 'Delivery date', format: 'date' },
    { key: 'doc.customerReference', label: 'Their order number', format: 'text' },
    { key: 'doc.soldBy', label: 'Taken by', format: 'text' },
    {
      key: 'doc.fulfilment',
      label: 'Delivery status',
      format: 'text',
      hint: 'Prints PART DELIVERY when some of the order is still to come, and nothing when it is complete.',
    },
    { key: 'doc.closing', label: 'Closing line', format: 'text', hint: 'What the reader should do — check the goods before signing.' },
    { key: 'customer.name', label: 'Customer name', format: 'text' },
    { key: 'customer.code', label: 'Customer account code', format: 'text' },
    { key: 'customer.address', label: 'Customer address', format: 'multiline' },
    { key: 'customer.phone', label: 'Customer phone', format: 'text' },
    /*
     * Where the goods are GOING, which is not always where the invoice is sent —
     * a head office pays and a site takes delivery.
     */
    { key: 'deliverTo', label: 'Deliver to', format: 'multiline' },
    { key: 'doc.deliveryNotes', label: 'Delivery instructions', format: 'multiline', hint: 'Gate code, contact on site, where to unload.' },
  ],
  sections: [
    {
      key: 'lines',
      label: 'Delivery lines',
      tokens: [
        { key: 'line.number', label: 'Line number', format: 'text' },
        { key: 'line.description', label: 'Description', format: 'text' },
        { key: 'line.productCode', label: 'Product code', format: 'text' },
        { key: 'line.qtyOrdered', label: 'Quantity ordered', format: 'qty' },
        { key: 'line.qtyDeliveredBefore', label: 'Delivered before now', format: 'qty' },
        { key: 'line.qty', label: 'Quantity delivered now', format: 'qty' },
        { key: 'line.qtyOutstanding', label: 'Still to come', format: 'qty' },
        /*
         * NO PRICE TOKENS. See the note above — this is the boundary, not a
         * preference, and adding one here would let every shop's delivery note
         * carry what the customer is paying.
         */
      ],
    },
  ],
}

/*
 * The statement.
 *
 * ── ONE DOCUMENT, THREE VARIANTS ──────────────────────────────────────────
 *
 * A customer statement demands money, a supplier statement reports what we owe,
 * and a remittance advice says what we have just paid. Same shape — a letterhead,
 * an account, a list of documents, a summary — and three different things to say
 * about it.
 *
 * They are variants rather than three document types because the DESIGN is the
 * same: change the letterhead once and all three follow, which is the whole
 * point of the feature. What differs arrives as tokens. `doc.heading` says
 * STATEMENT or SUPPLIER ACCOUNT or REMITTANCE ADVICE; `totals.dueLabel` says
 * "Amount due", "Balance owed" or "Amount paid"; and the ageing ladder simply
 * has nothing to show on a remittance, so the block carrying it hides itself.
 *
 * ── THE AGEING LADDER IS A SECTION, NOT SIX TOKENS ────────────────────────
 *
 * Its headings are not fixed. A weekly account's first overdue rung is 7 days,
 * a monthly account's is 30, and a column headed "30 days" that actually holds
 * eight-days-late debt is worse than an unlabelled one — so the labels travel
 * with the data.
 *
 * That makes it a repeating section like `lines`: each rung is a row with a
 * label and an amount, and a design lays it out as a table rather than naming
 * six tokens that would each be wrong for half the accounts.
 *
 * ── NO COST, NO MARGIN ────────────────────────────────────────────────────
 *
 * A statement lists documents and what is owed on them. What the goods cost is
 * not among the tokens, on the customer's copy or the supplier's.
 */
const STATEMENT: DocTypeDef = {
  key: 'statement',
  label: 'Statement',
  medium: 'a4',
  tokens: [
    ...SITE_TOKENS,
    ...DOC_TOKENS,
    {
      key: 'doc.heading',
      label: 'Document heading',
      format: 'text',
      hint: 'STATEMENT, SUPPLIER ACCOUNT or REMITTANCE ADVICE — set by which is being produced.',
    },
    { key: 'doc.period', label: 'Period', format: 'text', hint: 'As a person names it — "August 2026".' },
    { key: 'doc.periodFrom', label: 'Period from', format: 'date' },
    { key: 'doc.periodTo', label: 'Period to', format: 'date' },
    {
      key: 'doc.closing',
      label: 'Closing line',
      format: 'text',
      hint: 'What the reader should do — pay by the due date, or nothing at all on a remittance.',
    },

    /* The account this is about — a customer on a statement, a supplier on the
       other two. One set of tokens, because a design should not have to know. */
    { key: 'account.name', label: 'Account name', format: 'text' },
    { key: 'account.code', label: 'Account code', format: 'text' },
    { key: 'account.contactName', label: 'Contact name', format: 'text' },
    { key: 'account.address', label: 'Account address', format: 'multiline' },
    { key: 'account.email', label: 'Account email', format: 'text' },
    { key: 'account.phone', label: 'Account phone', format: 'text' },
    { key: 'account.vatNumber', label: 'Account VAT number', format: 'text' },
    { key: 'account.terms', label: 'Payment terms', format: 'text', hint: 'Just the days. Prints nothing when none are set.' },
    { key: 'account.creditLimit', label: 'Credit limit', format: 'money', hint: 'The figure alone. Prints nothing on a remittance, or when there is no limit.' },
    /*
     * The same two with their captions built in, for a design that shows them
     * as a line of their own rather than as a labelled row. Both exist because
     * a caption over a blank reads as something forgotten, and the template
     * language has no conditionals on purpose.
     */
    { key: 'account.termsLine', label: 'Payment terms (with label)', format: 'text', hint: 'Prints nothing when no terms are set.' },
    {
      key: 'account.creditLimitLine',
      label: 'Credit limit (with label)',
      format: 'text',
      hint: 'Prints nothing when there is no limit, and never on a remittance.',
    },

    { key: 'totals.opening', label: 'Opening balance', format: 'money' },
    { key: 'totals.closing', label: 'Closing balance', format: 'money' },
    {
      key: 'totals.dueNow',
      label: 'The figure to pay',
      format: 'money',
      hint: 'Everything already due. On a remittance this is what was paid.',
    },
    {
      key: 'totals.dueLabel',
      label: 'What that figure is called',
      format: 'text',
      hint: '"Amount due", "Balance owed" or "Amount paid" — set by which document this is.',
    },
    {
      key: 'totals.settlementDiscount',
      label: 'Settlement discount taken',
      format: 'money',
      hint: 'Only a remittance has one. Prints nothing on a statement.',
    },
    { key: 'totals.agingTotal', label: 'Ageing total', format: 'money' },
  ],
  sections: [
    {
      key: 'lines',
      label: 'Statement lines',
      tokens: [
        { key: 'line.date', label: 'Date', format: 'date' },
        { key: 'line.docType', label: 'Document type', format: 'text' },
        { key: 'line.docNumber', label: 'Document number', format: 'text' },
        { key: 'line.description', label: 'Description', format: 'text' },
        { key: 'line.reference', label: 'Reference', format: 'text' },
        { key: 'line.debit', label: 'Debit', format: 'money' },
        { key: 'line.credit', label: 'Credit', format: 'money' },
        {
          key: 'line.owing',
          label: 'Owing',
          format: 'money',
          hint: 'What is still unpaid on an open-item statement, or the running balance on an activity one.',
        },
        { key: 'line.daysOverdue', label: 'Days overdue', format: 'text' },
      ],
    },
    {
      key: 'aging',
      label: 'Ageing ladder',
      tokens: [
        {
          key: 'bucket.label',
          label: 'Rung heading',
          format: 'text',
          hint: 'Current, 30 days, 60 days — or 7, 14, 21 for a weekly account. Travels with the figure.',
        },
        { key: 'bucket.amount', label: 'Amount in that rung', format: 'money' },
      ],
    },
  ],
}

/*
 * The till slip.
 *
 * Present so the designer's document picker and the storage layer know it
 * exists, with NO tokens and NO sections — a slip is not designed as markup and
 * has no token language. Its design is an ordered block list; see
 * lib/stationery/slip.ts for why, and lib/escpos/slipSpec.ts for what a block
 * becomes on the roll.
 *
 * `medium: 'slip'` is what tells the designer to open the block editor rather
 * than the markup editor, and what stops the A4 validator being run against a
 * document that has no markup to validate.
 */
const TILL_SLIP: DocTypeDef = {
  key: 'slip',
  label: 'Till slip',
  medium: 'slip',
  tokens: [],
  sections: [],
}

export const DOC_TYPES: readonly DocTypeDef[] = [
  PURCHASE_ORDER,
  INVOICE,
  DELIVERY_NOTE,
  STATEMENT,
  TILL_SLIP,
]

/* ── lookups ─────────────────────────────────────────────────────────────── */

const BY_KEY = new Map(DOC_TYPES.map((d) => [d.key, d]))

export function getDocType(key: string): DocTypeDef | null {
  return BY_KEY.get(key) ?? null
}

export function isDocType(key: string): boolean {
  return BY_KEY.has(key)
}

/**
 * Every token legal in a template, document-level and section-level together.
 *
 * Section tokens are included because validation walks the whole template: a
 * `{line.qty}` written outside `{#each lines}` is a MISPLACED token, not an
 * unknown one, and the two deserve different messages.
 */
export function allTokens(doc: DocTypeDef): TokenDef[] {
  return [...doc.tokens, ...doc.sections.flatMap((s) => s.tokens)]
}

export function findToken(doc: DocTypeDef, key: string): TokenDef | null {
  return allTokens(doc).find((t) => t.key === key) ?? null
}

export function getSection(doc: DocTypeDef, key: string): SectionDef | null {
  return doc.sections.find((s) => s.key === key) ?? null
}

/**
 * The tokens this caller may actually use.
 *
 * The designer shows only these, so nobody composes a template around a column
 * that will be blank every time they print it. `isOwner` short-circuits, as it
 * does everywhere: an owner's set is "everything", including capabilities a
 * later migration adds.
 */
export function tokensFor(
  doc: DocTypeDef,
  capabilities: { isOwner: boolean; granted: ReadonlySet<string> },
): TokenDef[] {
  return allTokens(doc).filter(
    (t) => !t.permission || capabilities.isOwner || capabilities.granted.has(t.permission),
  )
}
