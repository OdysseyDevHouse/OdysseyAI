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
 * ── THE FOUR ARE ONE DOCUMENT WITH FOUR THINGS TO SAY ─────────────────────
 *
 * A customer statement demands money, a supplier statement reports what we owe,
 * a remittance advice says what we have just paid, and a receipt confirms what
 * we have just been paid. Same shape, four messages — which is why they share a
 * design and differ only in tokens.
 *
 * ── A RECEIPT IS THE MIRROR OF A REMITTANCE ───────────────────────────────
 *
 * Both describe one payment on one day and list the invoices it settled. The
 * only difference is which way the money went, and therefore who is being
 * thanked. That is a difference in wording, not in layout — so it is a variant
 * here rather than a fifth stationery document type with its own designer,
 * blocks and adapter to keep in step.
 */
export type StatementVariant = 'statement' | 'remittance' | 'supplier-statement' | 'receipt'

/** What each one calls itself at the top of the page. */
export const STATEMENT_HEADINGS: Record<StatementVariant, string> = {
  statement: 'STATEMENT',
  'supplier-statement': 'SUPPLIER ACCOUNT',
  remittance: 'REMITTANCE ADVICE',
  receipt: 'RECEIPT',
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
  // "Received", not "paid": the same figure from the other side of the counter.
  receipt: 'Amount received',
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
  /*
   * Nothing to do here either, and for a stronger reason than the remittance:
   * this is the customer's PROOF that they paid. A closing line asking them for
   * anything would undercut the one job the document has.
   */
  receipt: 'Received with thanks. Please retain this receipt for your records.',
}

/**
 * Whether this document describes ONE PAYMENT rather than an account.
 *
 * ── WHY THIS IS ONE PREDICATE AND NOT A CHECK PER SITE ────────────────────
 *
 * The renderer, the token adapter and the on-screen document each used to ask
 * `variant === 'remittance'` for their own reasons — and every one of those
 * reasons was really this question. A payment advice has nothing overdue, so
 * there is no age ladder and no "amount due"; and it is about a single
 * settlement, so the account's credit limit is not its business.
 *
 * A receipt is the same document pointed the other way, so adding it as a
 * fourth variant meant three separate `|| 'receipt'`s that nothing would catch
 * if one were missed — the page would simply print an empty ageing table and a
 * credit limit on somebody's receipt. Naming the question fixes it in one place.
 */
export function isPaymentAdvice(variant: StatementVariant): boolean {
  return variant === 'remittance' || variant === 'receipt'
}
