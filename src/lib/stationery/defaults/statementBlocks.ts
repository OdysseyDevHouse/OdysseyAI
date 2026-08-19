import type { DocumentSpec } from '../blocks'

/**
 * The shipped statement, as BLOCKS.
 *
 * ── ONE DESIGN, THREE DOCUMENTS ───────────────────────────────────────────
 *
 * A customer statement, a supplier account and a remittance advice all print
 * from this. Everything that differs between them arrives as a token —
 * {doc.heading} names the paper, {totals.dueLabel} names the figure that
 * matters, {doc.closing} says what to do about it — and everything that does not
 * apply resolves to empty, so the block carrying it disappears.
 *
 * The age ladder is the clearest case: a remittance has none, because nothing is
 * overdue on money already paid, so its section emits no rows and the table goes
 * with them. No conditionals, and a shop that restyles its letterhead restyles
 * all three.
 *
 * ── THE LADDER IS A SECOND TABLE, NOT SIX TOKENS ──────────────────────────
 *
 * Its rung headings change with the account cycle — 7/14/21 days for a weekly
 * account, 30/60/90 for a monthly one — so the labels travel with the figures
 * as rows. The same lineTable block, pointed at the `aging` section.
 *
 * ── THE y NUMBERS ARE MEASURED ────────────────────────────────────────────
 *
 * Percent of the band, from the rendered blocks rather than arithmetic. The
 * purchase order's first set was calculated and printed the letterhead through
 * the rule below it.
 */
export const STATEMENT_BLOCKS: DocumentSpec = {
  version: 1,
  blocks: [
    /* ── the top of the page ──────────────────────────────────────────────── */

    {
      id: 'st-logo',
      kind: 'logo',
      band: 'header',
      x: 0,
      y: 0,
      w: 30,
      logoHeight: 56,
    },
    {
      id: 'st-letterhead',
      kind: 'letterhead',
      band: 'header',
      x: 0,
      y: 16,
      w: 58,
      tokens: ['site.name', 'site.address', 'site.vatLine'],
    },
    {
      id: 'st-title',
      kind: 'docTitle',
      band: 'header',
      x: 60,
      y: 16,
      w: 40,
      align: 'right',
      // The period identifies a statement — it has no number of its own.
      tokens: ['doc.heading', 'doc.period'],
    },

    { id: 'st-rule-1', kind: 'rule', band: 'header', x: 0, y: 40, w: 100 },

    {
      id: 'st-account',
      kind: 'partyBlock',
      band: 'header',
      x: 0,
      y: 46,
      w: 48,
      title: 'ACCOUNT',
      tokens: ['account.name', 'account.contactName', 'account.address', 'account.vatNumber'],
    },
    {
      id: 'st-details',
      kind: 'detailList',
      band: 'header',
      x: 52,
      y: 46,
      w: 48,
      rows: [
        { token: 'account.code', label: 'Account' },
        { token: 'account.terms', label: 'Terms' },
        // Never on a remittance — see the adapter. Empty there, so the row goes.
        { token: 'account.creditLimit', label: 'Credit limit' },
        { token: 'totals.opening', label: 'Opening balance' },
      ],
    },

    /* ── the account's movements ──────────────────────────────────────────── */

    {
      id: 'st-lines',
      kind: 'lineTable',
      band: 'body',
      x: 0,
      y: 0,
      w: 100,
      columns: [
        { token: 'line.date', heading: 'Date', width: 14 },
        { token: 'line.docNumber', heading: 'Document', subToken: 'line.description', width: 34 },
        { token: 'line.reference', heading: 'Reference', width: 16 },
        { token: 'line.debit', heading: 'Debit', width: 12, align: 'right' },
        { token: 'line.credit', heading: 'Credit', width: 12, align: 'right' },
        { token: 'line.owing', heading: 'Owing', width: 12, align: 'right' },
      ],
    },

    /* ── how old the debt is, and what to pay ─────────────────────────────── */

    /*
     * THE AGE LADDER.
     *
     * The same table block as the movements above, pointed at the `aging`
     * section — its rows are rungs rather than documents, and their headings
     * come from the data because a weekly account ages differently from a
     * monthly one.
     *
     * A remittance emits no rows here, so this table prints nothing at all.
     */
    {
      id: 'st-aging',
      kind: 'lineTable',
      band: 'footer',
      x: 0,
      y: 0,
      w: 62,
      columns: [
        { token: 'bucket.label', heading: 'Age', width: 50 },
        { token: 'bucket.amount', heading: 'Amount', width: 50, align: 'right' },
      ],
      // After the columns: parseSpec writes the keys in this order, and the
      // designer decides 'is this dirty?' by comparing JSON strings.
      section: 'aging',
    },
    {
      id: 'st-totals',
      kind: 'detailList',
      band: 'footer',
      x: 66,
      y: 0,
      w: 34,
      rows: [
        { token: 'totals.closing', label: 'Closing balance' },
        // Only a remittance has one; blank elsewhere, so the row goes.
        { token: 'totals.settlementDiscount', label: 'Less settlement discount' },
      ],
    },
    /*
     * The figure that matters, big — and labelled by a TOKEN, because the same
     * number is money we want, money we owe, or money already sent depending on
     * which of the three this is.
     */
    {
      id: 'st-due',
      kind: 'totals',
      band: 'footer',
      x: 66,
      y: 14,
      w: 34,
      title: '{totals.dueLabel}',
      tokens: ['totals.dueNow'],
    },

    // Clear of the age ladder, which is the tallest thing above it: five rungs
    // and a total, measured at 59.3.
    { id: 'st-rule-2', kind: 'rule', band: 'footer', x: 0, y: 64, w: 100 },

    {
      id: 'st-closing',
      kind: 'text',
      band: 'footer',
      x: 0,
      y: 70,
      w: 100,
      text: '{doc.closing}',
    },
    {
      id: 'st-printed',
      kind: 'text',
      band: 'footer',
      x: 0,
      y: 76,
      w: 100,
      text: 'Printed {doc.printedAt}',
    },
  ],
}
