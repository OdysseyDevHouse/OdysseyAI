import 'server-only'
import { SignJWT, jwtVerify } from 'jose'

/**
 * The link that lets a customer rate a finished job.
 *
 * ── IT EXPIRES, AND SIXTY DAYS IS THE ARGUMENT ─────────────────────────────
 *
 * orderTrackToken uses ninety days because a delivery question can surface late.
 * This one is shorter for the opposite reason: an opinion about work done in
 * March, submitted in September, is not feedback about that job — it is noise in
 * a trend somebody is trying to read. Sixty days is far longer than anybody
 * takes to answer an email, and short enough that a forwarded link stops working
 * before it is forgotten about.
 *
 * ── IT NAMES ONE JOB, AND ONE SITE ─────────────────────────────────────────
 *
 * Both checked coming back in, as the order token does. Job ids are per-site, so
 * without the site check the same integer would address a different business's
 * job — and this token WRITES, which makes that worse than a leak.
 *
 * ── WHAT HOLDING IT ALLOWS ─────────────────────────────────────────────────
 *
 * Exactly one thing: leaving or correcting a rating and a comment on that job.
 * It cannot read the job, see what was charged, reach the customer's other jobs,
 * or change anything else. That is narrower than the order-tracking token, which
 * SHOWS an order — this one barely shows the job title.
 */

/** Its own audience, so no other signed token in the app can be replayed here. */
const AUDIENCE = 'ody-job-feedback'

/** Long enough for anybody who is going to answer, short enough to lapse. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 60

export type FeedbackClaim = {
  siteId: number
  jobId: number
}

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET
  if (!raw) throw new Error('SESSION_SECRET is not configured.')
  return new TextEncoder().encode(raw)
}

export async function createFeedbackToken(claim: FeedbackClaim): Promise<string> {
  return new SignJWT({ siteId: claim.siteId, jobId: claim.jobId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret())
}

/**
 * Resolve a feedback link back to the job it names, or null.
 *
 * Null for every failure — bad signature, wrong audience, expired, malformed —
 * and the page turns all of them into the same message, so the link cannot be
 * used to probe which jobs exist.
 */
export async function readFeedbackToken(token: string): Promise<FeedbackClaim | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE })
    const siteId = Number(payload.siteId)
    const jobId = Number(payload.jobId)
    if (!Number.isInteger(siteId) || siteId <= 0) return null
    if (!Number.isInteger(jobId) || jobId <= 0) return null
    return { siteId, jobId }
  } catch {
    return null
  }
}
