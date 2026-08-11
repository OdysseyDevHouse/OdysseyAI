import type { RowOutcome } from './spec'

/**
 * Counting up what a run did.
 *
 * Deliberately NOT `server-only`, and separate from `apply.ts` for that reason:
 * the wizard folds each batch's outcomes as they come back, so this runs in the
 * browser. `apply.ts` touches the database and cannot cross that boundary.
 */

/**
 * How many rows one request carries.
 *
 * Small enough that 20,000 drafts never approach the 10MB server-action body
 * limit, and that a failed batch loses little; large enough that a 20k file is
 * a hundred round trips rather than a thousand.
 */
export const BATCH_SIZE = 200

export type RunTotals = {
  created: number
  updated: number
  skipped: number
  failed: number
  /** Wrote the record but not all of it — see RowOutcome.warnings. */
  partial: number
  /** Every outcome that was not a clean success. Shown, and downloadable. */
  problems: RowOutcome[]
}

export const emptyTotals = (): RunTotals => ({
  created: 0, updated: 0, skipped: 0, failed: 0, partial: 0, problems: [],
})

/**
 * Adds one batch's outcomes to the running totals.
 *
 * A row with warnings counts in BOTH its status and `partial`, on purpose: it
 * was created, and it is incomplete, and a screen that had to pick one of those
 * would be lying about the other. `partial` is what the summary leads with,
 * because "created but without its supplier link" is the outcome somebody has
 * to go and do something about.
 */
export function fold(totals: RunTotals, outcomes: readonly RowOutcome[]): RunTotals {
  const next: RunTotals = { ...totals, problems: [...totals.problems] }

  for (const outcome of outcomes) {
    next[outcome.status] += 1
    if (outcome.warnings?.length) next.partial += 1

    const clean =
      (outcome.status === 'created' || outcome.status === 'updated') && !outcome.warnings?.length
    if (!clean) next.problems.push(outcome)
  }

  return next
}
