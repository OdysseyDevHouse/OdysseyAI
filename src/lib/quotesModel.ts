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
export type QuoteState = 'draft' | 'open' | 'expired' | 'accepted' | 'declined' | 'cancelled'

export const QUOTE_STATE_LABELS: Record<QuoteState, string> = {
  draft: 'Draft',
  open: 'Awaiting a decision',
  expired: 'Expired',
  accepted: 'Accepted',
  declined: 'Declined',
  cancelled: 'Cancelled',
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
  asAt?: string
}): QuoteState {
  if (input.status === 'cancelled') return 'cancelled'
  if (input.outcome === 'accepted') return 'accepted'
  if (input.outcome === 'declined') return 'declined'
  if (input.status === 'draft' || input.status === 'saved') return 'draft'

  const asAt = input.asAt ?? todayLocal()
  if (input.validUntil && input.validUntil < asAt) return 'expired'
  return 'open'
}
