'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, actorFor } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import {
  deleteReview,
  moderateReview,
  reopenReview,
  type SaveResult,
} from '@/lib/site/productReviews'

/**
 * Moderation actions.
 *
 * Every one is audited: approving puts words on the shop's own page, and
 * rejecting buries a customer's complaint. Both are decisions someone may have
 * to answer for, so both record who made them.
 */

export async function moderateReviewAction(
  reviewId: number,
  status: 'approved' | 'rejected',
  reason = '',
): Promise<SaveResult> {
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await moderateReview(siteId, reviewId, status, actor.userName, reason)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: reviewId,
    action: status === 'approved' ? 'review_approved' : 'review_rejected',
    detail:
      status === 'approved'
        ? 'Review published to the storefront'
        : `Review rejected — ${reason.trim().slice(0, 160)}`,
  })

  revalidatePath('/online-store/reviews')
  return result
}

export async function reopenReviewAction(reviewId: number): Promise<SaveResult> {
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await reopenReview(siteId, reviewId)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: reviewId,
    action: 'review_reopened',
    detail: 'Review put back in the moderation queue',
  })

  revalidatePath('/online-store/reviews')
  return result
}

export async function deleteReviewAction(reviewId: number): Promise<SaveResult> {
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await deleteReview(siteId, reviewId)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: reviewId,
    action: 'review_deleted',
    detail: 'Review deleted',
  })

  revalidatePath('/online-store/reviews')
  return result
}
