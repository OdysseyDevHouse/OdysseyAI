'use server'

import { readFeedbackToken } from '@/lib/feedbackToken'
import { recordFeedback } from '@/lib/site/jobFeedback'

/**
 * The customer's answer.
 *
 * ── THE TOKEN IS RE-READ HERE, NOT TRUSTED FROM THE PAGE ───────────────────
 *
 * A server action is a public HTTP endpoint. The page's check protected the
 * page; this is a separate request that anybody can make with any arguments, so
 * it verifies the signature itself and takes the siteId and jobId from the
 * CLAIM rather than from its own parameters.
 *
 * That is the whole security model. There is no jobId parameter to tamper with,
 * because the signed token is the only thing that says which job this is.
 */
export async function submitFeedbackAction(
  token: string,
  rating: number,
  comment: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const claim = await readFeedbackToken(token)
  // The same message for every failure — expired, forged, malformed — so the
  // form cannot be used to learn which jobs exist.
  if (!claim) return { ok: false, error: 'That link is no longer valid.' }

  return recordFeedback(claim.siteId, claim.jobId, rating, comment)
}
