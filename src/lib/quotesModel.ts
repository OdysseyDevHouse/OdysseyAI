/**
 * The quote MODEL — shared by the server and the browser.
 *
 * Deliberately free of `server-only` and of any database import, because the
 * quote register renders in the browser and needs the same states and labels
 * the server derives. Importing this from a client component must not drag the
 * database layer into the bundle — which is exactly what happened when these
 * lived alongside the queries: a `'use client'` table importing
 * QUOTE_STATE_LABELS pulled siteDb, and through it mysql2, into the client
 * graph and broke the build app-wide.
 *
 * The reading and writing half lives in site/quotes.ts, which re-exports this
 * so a server caller still has one import.
 *
 * Same split, and the same reasoning, as storefrontModel.ts /
 * site/storefrontLayout.ts.
 */

export type QuoteOutcome = 'open' | 'accepted' | 'declined'

/**
 * What a quote is, right now.
 *
 * `expired` is DERIVED rather than stored: a date passing is not an event
 * anybody triggers, so a stored status would need a nightly job to stay true
 * and would be wrong in between. Computed on read, it is always right.
 */
export type QuoteState =
  | 'draft'
  | 'open'
  | 'sent'
  | 'viewed'
  | 'expired'
  | 'accepted'
  | 'declined'
  | 'cancelled'

export const QUOTE_STATE_LABELS: Record<QuoteState, string> = {
  draft: 'Draft',
  open: 'Awaiting a decision',
  /*
   * "Sent" and "Seen" rather than "Emailed" and "Viewed".
   *
   * Both are what a person would say out loud about a quote, and "Seen" is the
   * weaker word on purpose — see 227's header on what a view actually proves.
   * "Viewed" reads like a fact about the customer's attention; it is a fact
   * about a link being opened.
   */
  sent: 'Sent',
  viewed: 'Seen by the customer',
  expired: 'Expired',
  accepted: 'Accepted',
  declined: 'Declined',
  cancelled: 'Cancelled',
}

/**
 * What colour each state wears.
 *
 * Here rather than at the call site because there are now TWO screens showing a
 * quote's state — the back-office register and the till's list — and a state
 * that reads green on one and grey on the other is two answers to one question.
 * The register had this inline first; it moved when the till needed the same
 * mapping, which is the moment a duplicated rule becomes a drifting one.
 *
 * Tone names are the kit's Badge tones, so this stays a lookup rather than
 * something each screen re-decides.
 *
 * `warning` for a quote awaiting a decision is not an error: it is the one
 * state with something still to DO, and amber is what says so in a list where
 * everything else has been settled one way or the other.
 */
export const QUOTE_STATE_TONES: Record<QuoteState, 'success' | 'danger' | 'warning' | 'default'> = {
  draft: 'warning',
  open: 'warning',
  /*
   * Both still amber: sent and seen are steps ALONG the way to a decision, not
   * decisions. Colouring "seen" green would read as good news on a quote the
   * customer has looked at twice and not replied to, which is the one that most
   * needs chasing.
   */
  sent: 'warning',
  viewed: 'warning',
  expired: 'danger',
  accepted: 'success',
  declined: 'default',
  cancelled: 'default',
}

/**
 * Today, as a plain YYYY-MM-DD string.
 *
 * A local copy of `today()` from site/ledger.ts rather than an import: that
 * module is `server-only`, and pulling it in here would defeat the entire
 * purpose of this file. The function is four lines of date formatting with no
 * dependencies, and duplicating it is cheaper than making the ledger — which
 * owns posting and VAT — importable by a browser.
 */
function todayLocal(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * The state of a quote, from its stored fields and today's date.
 *
 * Order matters. A declined quote that has also expired is DECLINED — the
 * customer answered, and the date passing afterwards changes nothing. Reading
 * expiry first would relabel every old decision as "expired" and lose the
 * outcome that was recorded.
 */
export function quoteState(input: {
  status: string
  outcome: QuoteOutcome
  validUntil: string | null
  /** When it was last emailed to the customer (227). */
  sentAt?: string | Date | null
  /** When the customer first opened it (227). */
  viewedAt?: string | Date | null
  asAt?: string
}): QuoteState {
  if (input.status === 'cancelled') return 'cancelled'
  if (input.outcome === 'accepted') return 'accepted'
  if (input.outcome === 'declined') return 'declined'
  if (input.status === 'draft' || input.status === 'saved') return 'draft'

  /*
   * EXPIRY BEATS SENT AND SEEN, and that ordering is the whole point.
   *
   * A quote emailed in March and opened in April is still expired today, and
   * the state a person needs to see is the one that says the prices no longer
   * stand. Reading sent/viewed first would leave every stale quote in the
   * register showing "Seen by the customer" — encouraging a follow-up call
   * offering prices the business has withdrawn.
   */
  const asAt = input.asAt ?? todayLocal()
  if (input.validUntil && input.validUntil < asAt) return 'expired'

  /*
   * Seen beats sent, because it is the later thing that happened. Neither is an
   * outcome: both mean the quote is still open, said more precisely.
   */
  if (input.viewedAt) return 'viewed'
  if (input.sentAt) return 'sent'
  return 'open'
}
