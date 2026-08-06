/*
 * Deliberately NOT `server-only`.
 *
 * Everything here is pure arithmetic and vocabulary — matching scores, labels,
 * reference comparison — with no database and no Node builtins. The account
 * form in the browser needs the same labels and the same rules the server
 * applies, and marking this server-only forced mysql2 into the client bundle
 * through the modules that re-export it.
 *
 * The WRITES still live in bankAccounts.ts / cashbook.ts, which are server-only
 * for real reasons.
 */
import { round } from '../decimals'

/**
 * The rules the cashbook obeys, as PURE functions.
 *
 * Same split as ledger.ts against customerLedger.ts, for the same reason: the
 * interesting part of a bank reconciliation is the MATCHING, and matching is a
 * pile of heuristics that must be reasoned about and tested on their own. None
 * of this touches a database.
 *
 * ── SIGN CONVENTION ──────────────────────────────────────────────────────
 *
 *   positive = money INTO the bank account
 *
 * Restated here because this file is where it gets used hardest. A customer
 * receipt is positive; a supplier payment is negative. Note that this is the
 * OPPOSITE of the sub-ledger convention for the same event: a customer payment
 * is negative in customer_transactions (they owe us less) and positive here
 * (we hold more). Every link therefore joins rows of opposite sign, which is
 * exactly what `signsOppose` below asserts.
 */

export const BANK_ACCOUNT_TYPES = ['bank', 'cash', 'card'] as const
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number]

export const ACCOUNT_TYPE_LABELS: Record<BankAccountType, string> = {
  bank: 'Bank account',
  cash: 'Cash on hand',
  card: 'Card settlement',
}

export type BankTxnStatus = 'unreconciled' | 'reconciled' | 'void'

/* ── Matching ────────────────────────────────────────────────────────────── */

/** One side of a candidate match, as the matcher needs to see it. */
export type MatchCandidate = {
  id: number
  /** yyyy-mm-dd. */
  date: string
  /** Signed in that side's own convention. */
  amount: number
  reference: string | null
  description: string | null
  /** Set on sub-ledger rows: the account the money belongs to. */
  partyName?: string | null
  partyCode?: string | null
}

export type MatchScore = {
  candidateId: number
  /** 0-100. Stored on the link so a weak guess is visibly weak. */
  confidence: number
  /** Why it scored what it did, for the screen to show. */
  reasons: string[]
}

/**
 * How close two dates are, as a score contribution.
 *
 * A bank posts an EFT the same day, a cheque three to five days later, and a
 * weekend deposit on Monday. So same-day is ideal, within a week is normal, and
 * beyond a month is almost certainly a different transaction that happens to
 * share an amount — which is the false positive this curve exists to avoid.
 */
export function dateProximityScore(daysApart: number): number {
  const gap = Math.abs(daysApart)
  if (gap === 0) return 30
  if (gap <= 2) return 26
  if (gap <= 5) return 20
  if (gap <= 10) return 14
  if (gap <= 30) return 6
  return 0
}

/**
 * Normalises a reference for comparison.
 *
 * Banks mangle references without mercy: they upper-case them, strip
 * punctuation, truncate to 20 characters and prepend their own noise. So the
 * comparison happens on letters and digits only — 'INV-000041' from our side
 * and 'inv 000041 eft' from theirs must be recognisably the same string.
 */
export function normaliseReference(value: string | null | undefined): string {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

/**
 * Whether one reference contains the other, both normalised.
 *
 * Containment rather than equality because the bank line is usually our
 * reference plus their noise ('ABSA EFT INV000041 CRD'). Short strings are
 * refused: a 3-character reference is contained in half the statement, and a
 * false match here silently settles the wrong invoice.
 */
export function referencesMatch(a: string | null, b: string | null): boolean {
  const left = normaliseReference(a)
  const right = normaliseReference(b)
  if (left.length < 4 || right.length < 4) return false
  return left.includes(right) || right.includes(left)
}

/**
 * Whether a bank line mentions the party by name.
 *
 * Weaker evidence than a reference and treated as such — 'HARBOUR' matching
 * 'Harbour Cafe' is suggestive, not conclusive, because a second Harbour
 * account is entirely possible. Requires 5 characters for the same reason
 * referencesMatch requires 4.
 */
export function mentionsParty(description: string | null, partyName: string | null): boolean {
  if (!partyName) return false
  const haystack = normaliseReference(description)
  const needle = normaliseReference(partyName)
  if (needle.length < 5 || haystack.length < 5) return false
  return haystack.includes(needle.slice(0, Math.min(needle.length, 12)))
}

/**
 * True when two amounts are the same money seen from opposite sides.
 *
 * The magnitudes must agree to the cent AND the signs must oppose. The sign
 * test is what stops a R500 receipt matching a R500 payment — same magnitude,
 * same day, entirely different events, and a matcher without this check will
 * confidently pair them.
 */
export function signsOppose(bankAmount: number, ledgerAmount: number): boolean {
  if (bankAmount === 0 || ledgerAmount === 0) return false
  return bankAmount > 0 !== ledgerAmount > 0
}

export function amountsAgree(bankAmount: number, ledgerAmount: number): boolean {
  return round(Math.abs(bankAmount), 2) === round(Math.abs(ledgerAmount), 2)
}

/**
 * Scores one candidate against a bank line.
 *
 * ── THE WEIGHTING, AND WHY ───────────────────────────────────────────────
 *
 *   Exact amount + opposing sign   40   the precondition; without it, no match
 *   Reference containment          30   the strongest signal a bank line carries
 *   Date proximity              0..30   see dateProximityScore
 *   Party name in description      15   suggestive only
 *
 * Amount is a gate rather than a slider: a payment that is out by a cent is a
 * DIFFERENT transaction as far as this is concerned, because a part-payment
 * and a fee deduction both look like "nearly right" and both need a human.
 * Returning null rather than a low score keeps them off the screen entirely.
 */
export function scoreMatch(bank: MatchCandidate, ledger: MatchCandidate): MatchScore | null {
  if (!amountsAgree(bank.amount, ledger.amount)) return null
  if (!signsOppose(bank.amount, ledger.amount)) return null

  const reasons: string[] = ['Amount matches exactly']
  let confidence = 40

  if (referencesMatch(bank.reference, ledger.reference) ||
      referencesMatch(bank.description, ledger.reference)) {
    confidence += 30
    reasons.push('Reference matches')
  }

  const gap = daysApart(bank.date, ledger.date)
  const dateScore = dateProximityScore(gap)
  confidence += dateScore
  if (gap === 0) reasons.push('Same date')
  else if (dateScore > 0) reasons.push(`${Math.abs(gap)} day${Math.abs(gap) === 1 ? '' : 's'} apart`)

  if (mentionsParty(bank.description, ledger.partyName ?? null)) {
    confidence += 15
    reasons.push('Account name appears on the statement line')
  }

  return { candidateId: ledger.id, confidence: Math.min(confidence, 100), reasons }
}

/**
 * The best candidates for one bank line, strongest first.
 *
 * Returns a LIST, never a decision. Auto-linking the top scorer regardless of
 * the runner-up is how a reconciliation quietly settles the wrong invoice when
 * two customers pay the same round amount on the same day — see
 * `isConfidentMatch` for the rule that governs acting on this.
 */
export function rankMatches(
  bank: MatchCandidate,
  candidates: readonly MatchCandidate[],
  limit = 5,
): MatchScore[] {
  return candidates
    .map((candidate) => scoreMatch(bank, candidate))
    .filter((score): score is MatchScore => score !== null)
    .sort((a, b) => b.confidence - a.confidence || a.candidateId - b.candidateId)
    .slice(0, Math.max(limit, 1))
}

/**
 * Whether the matcher may link this automatically.
 *
 * TWO conditions, and the second is the one that matters:
 *
 *   1. The best score is at least 85 — amount, reference and a near date.
 *   2. It beats the runner-up by at least 15.
 *
 * Condition 2 is the ambiguity guard. Two invoices for R1 200 on the same day
 * both score identically; picking either is a coin toss, and a coin toss that
 * writes to the ledger is worse than leaving both for a person to look at. So
 * a tie is never automatic, however high it scores.
 */
export function isConfidentMatch(ranked: readonly MatchScore[]): boolean {
  if (ranked.length === 0) return false
  const [best, second] = ranked
  if (best.confidence < 85) return false
  if (second && best.confidence - second.confidence < 15) return false
  return true
}

/* ── Reconciliation arithmetic ───────────────────────────────────────────── */

export type ReconciliationInput = {
  /** What the bank statement says the closing balance is. */
  statementBalance: number
  /** What our books say, per the account's own balance column. */
  bookBalance: number
  /** Signed sum of everything we have recorded that the bank has not confirmed. */
  unreconciledTotal: number
}

export type ReconciliationResult = {
  statementBalance: number
  bookBalance: number
  unreconciledTotal: number
  /** Zero when it reconciles. Anything else is unexplained. */
  difference: number
  balanced: boolean
}

/**
 * Does it reconcile?
 *
 *   book balance − everything the bank hasn't seen yet = statement balance
 *
 * Read it as: our books include uncleared items; the bank's do not. Subtracting
 * them from our side should land exactly on theirs. Whatever is left over is
 * unexplained — a missing transaction, a wrong amount, a duplicate — and is the
 * only number on the reconciliation screen that matters.
 *
 * `balanced` is an exact zero test to the cent, not a tolerance. A
 * reconciliation that is "close enough" is one that has silently absorbed a
 * real error, and the whole point of the exercise is that it cannot.
 */
export function reconcile(input: ReconciliationInput): ReconciliationResult {
  const statementBalance = round(input.statementBalance, 2)
  const bookBalance = round(input.bookBalance, 2)
  const unreconciledTotal = round(input.unreconciledTotal, 2)
  const difference = round(bookBalance - unreconciledTotal - statementBalance, 2)

  return {
    statementBalance,
    bookBalance,
    unreconciledTotal,
    difference,
    balanced: difference === 0,
  }
}

/**
 * Why this link cannot be made. Null means it can.
 *
 * Mirrors refuseAllocation in ledger.ts, and exists for the same reason: a
 * half-made link leaves a bank row and a ledger row disagreeing about how much
 * of each is settled, and nothing would report it.
 */
export function refuseLink(
  bankAmount: number,
  ledgerAmount: number,
  alreadyLinked: number,
  amount: number,
): string | null {
  const value = round(amount, 2)
  if (value <= 0) return 'A link must be for a positive amount.'
  if (!signsOppose(bankAmount, ledgerAmount)) {
    return 'Those two are on the same side — a receipt cannot settle a payment.'
  }

  const bankRoom = round(Math.abs(bankAmount) - Math.abs(alreadyLinked), 2)
  if (value > bankRoom) {
    return bankRoom <= 0
      ? 'That bank line is already fully matched.'
      : `Only ${bankRoom.toFixed(2)} of that bank line is unmatched.`
  }
  if (value > round(Math.abs(ledgerAmount), 2)) {
    return `That transaction is only ${Math.abs(ledgerAmount).toFixed(2)}.`
  }
  return null
}

/** Whole days between two yyyy-mm-dd dates. Negative when `to` is earlier. */
export function daysApart(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime()
  const b = new Date(`${to}T00:00:00`).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}
