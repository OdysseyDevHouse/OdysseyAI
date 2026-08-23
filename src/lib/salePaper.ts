import { type PosMode } from './posMode'

/**
 * Which paper a till hands a customer for a finished sale.
 *
 * ── ONE ANSWER, BECAUSE IT IS ONE QUESTION ────────────────────────────────
 *
 * A retail queue and a restaurant table both end in an 80mm slip: the customer
 * is standing there, and the paper records what they just paid.
 *
 * A TRADE COUNTER ends in an invoice. It goes into an account customer's books
 * and carries the banking block, VAT number and terms that only the A4 document
 * has — hand that customer a till slip and they have the wrong document.
 *
 * So the choice follows the till's MODE, not the printer bolted to it: a trade
 * counter with a thermal printer beside it still owes A4.
 *
 * Plain and dependency-free like posMode.ts itself, so the shell, the print
 * routes and a pure test can all name the same rule rather than each restating
 * it — a restatement is where a till and its own reprint start disagreeing.
 *
 * Takes the MODE rather than a boolean so a fourth mode has to answer this
 * question explicitly instead of falling into slip paper by default.
 */
export function salePaperRoute(mode: PosMode): 'document' | 'slip' {
  return mode === 'invoicing' ? 'document' : 'slip'
}
