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
export type TokenFormat = 'text' | 'money' | 'qty' | 'percent' | 'date' | 'multiline'

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
 * is the one part plain substitution cannot express, so it — and only it — gets
 * a construct. See render.ts for why the list stops here.
 */
export type SectionKey = 'lines' | 'vatByRate' | 'tenders'

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
    format: 'text',
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

export const DOC_TYPES: readonly DocTypeDef[] = [PURCHASE_ORDER]

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
