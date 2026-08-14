/**
 * A token bucket for the public API.
 *
 * The pure math is separated from the stateful wrapper so the test can prove
 * refill and refusal arithmetic without time or globals in the picture.
 *
 * HONEST LIMITATION: the buckets live in this one Node process, the same
 * assumption the site-pool cache in siteDb.ts already makes. A future
 * multi-instance deploy multiplies every limit by the instance count and a
 * restart resets them — acceptable abuse-damping for a single-server app,
 * not billing-grade metering.
 */

export type Bucket = { tokens: number; updatedAt: number }

export type LimitOpts = {
  /** Burst size — the most requests a quiet key can fire at once. */
  capacity: number
  /** Sustained rate. */
  refillPerMinute: number
  /** Tokens this request spends; heavy endpoints pass more. Default 1. */
  cost?: number
}

/** Pure: given the previous bucket (or none) and the clock, decide. */
export function takeToken(
  bucket: Bucket | undefined,
  now: number,
  opts: LimitOpts,
): { allowed: boolean; bucket: Bucket; remaining: number; retryAfterSeconds: number } {
  const cost = opts.cost ?? 1
  const refillPerMs = opts.refillPerMinute / 60_000

  let tokens = bucket ? bucket.tokens + (now - bucket.updatedAt) * refillPerMs : opts.capacity
  tokens = Math.min(tokens, opts.capacity)

  if (tokens >= cost) {
    const next = { tokens: tokens - cost, updatedAt: now }
    return { allowed: true, bucket: next, remaining: Math.floor(next.tokens), retryAfterSeconds: 0 }
  }

  const shortfall = cost - tokens
  return {
    allowed: false,
    bucket: { tokens, updatedAt: now },
    remaining: Math.floor(tokens),
    retryAfterSeconds: Math.max(1, Math.ceil(shortfall / refillPerMs / 1000)),
  }
}

/* Survives module reloads in dev the same way the site pools do. */
const globalBuckets = globalThis as unknown as { __apiRateBuckets?: Map<string, Bucket> }
const buckets = (globalBuckets.__apiRateBuckets ??= new Map())

/** Stateful wrapper, keyed by e.g. `${siteId}:${keyId}`. */
export function rateLimit(
  key: string,
  opts: LimitOpts,
): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
  const outcome = takeToken(buckets.get(key), Date.now(), opts)
  buckets.set(key, outcome.bucket)
  // A million distinct keys would be a leak; the map is bounded by trimming
  // the oldest entries well above any legitimate key count.
  if (buckets.size > 10_000) {
    const oldest = [...buckets.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    for (const [k] of oldest.slice(0, 5_000)) buckets.delete(k)
  }
  return { allowed: outcome.allowed, remaining: outcome.remaining, retryAfterSeconds: outcome.retryAfterSeconds }
}
