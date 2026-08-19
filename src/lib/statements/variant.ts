/**
 * Which of the three statement documents this is.
 *
 * ── A MODULE OF ITS OWN, AND WHY ──────────────────────────────────────────
 *
 * It began in pdf.ts, next to the renderer that branched on it. But it is a fact
 * about the DOCUMENT rather than about how the document is drawn — and both
 * pdf.ts and render.ts are `server-only`, so anything client-safe that needs to
 * know what a statement is called could not import it without dragging the
 * whole PDF stack along.
 *
 * The stationery adapter is exactly that: pure, client-safe, and shared with the
 * designer so a preview cannot disagree with the printed page.
 *
 * ── THE THREE ARE ONE DOCUMENT WITH THREE THINGS TO SAY ───────────────────
 *
 * A customer statement demands money, a supplier statement reports what we owe,
 * and a remittance advice says what we have just paid. Same shape, three
 * messages — which is why they share a design and differ only in tokens.
 */
export type StatementVariant = 'statement' | 'remittance' | 'supplier-statement'

/** What each one calls itself at the top of the page. */
export const STATEMENT_HEADINGS: Record<StatementVariant, string> = {
  statement: 'STATEMENT',
  'supplier-statement': 'SUPPLIER ACCOUNT',
  remittance: 'REMITTANCE ADVICE',
}

/**
 * What each one calls the figure that matters.
 *
 * The same number means three different things: money we want, money we owe,
 * and money already sent. A single label for all three would be wrong twice.
 */
export const STATEMENT_DUE_LABELS: Record<StatementVariant, string> = {
  statement: 'Amount due',
  'supplier-statement': 'Balance owed',
  remittance: 'Amount paid',
}

/**
 * What the reader should do about it.
 *
 * Nothing, on a remittance: it is a courtesy telling a supplier that money is on
 * its way, and one ending "please pay" would be asking for the payment it exists
 * to announce. A supplier statement is a record rather than a demand, so it says
 * nothing either.
 */
export const STATEMENT_CLOSINGS: Record<StatementVariant, string> = {
  statement:
    'Please settle the amount due by the date shown. Contact us if any item on this statement is queried.',
  'supplier-statement': '',
  remittance: 'This advice confirms a payment already made. No action is required.',
}
