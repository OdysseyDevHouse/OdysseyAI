/**
 * The ageing buckets, and what they are called on screen.
 *
 * ── WHY THIS IS NOT IN site/ledger.ts ────────────────────────────────────
 *
 * It was, and `ledger.ts` is `server-only` — it carries the posting and
 * allocation rules, which must never reach a browser. But an ageing STRIP is
 * presentation: a component that draws five labelled cells needs the bucket
 * names and nothing else, and importing them from the ledger dragged the whole
 * server module into the client bundle and broke the build.
 *
 * So the shape of the thing lives here, where either side may read it, and the
 * rules that COMPUTE it stay where they were. `ledger.ts` re-exports these, so
 * every existing importer is unaffected and there is still exactly one
 * definition.
 *
 * No 'server-only' marker here, deliberately — that is the entire point.
 */

export const AGING_BUCKETS = ['current', 'd30', 'd60', 'd90', 'd120'] as const

export type AgingBucket = (typeof AGING_BUCKETS)[number]

export const BUCKET_LABELS: Record<AgingBucket, string> = {
  current: 'Current',
  d30: '30 days',
  d60: '60 days',
  d90: '90 days',
  d120: '120+ days',
}

/** A balance split across the buckets, plus what they add up to. */
export type Aging = Record<AgingBucket, number> & { total: number }

export function emptyAging(): Aging {
  return { current: 0, d30: 0, d60: 0, d90: 0, d120: 0, total: 0 }
}
