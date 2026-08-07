import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQuery, siteQueryOne } from '../siteDb'

/**
 * Product reviews and their moderation.
 *
 * EVERY review is moderated. Nothing reaches the storefront until a person
 * approves it, and there is no auto-approve — see 035_product_reviews.sql for
 * why that omission is deliberate rather than unfinished.
 *
 * `orderNumber` is whatever the shopper typed and is NOT verified. It is shown
 * to staff while moderating, as a weak signal that the reviewer is a real
 * customer, and must never be surfaced to shoppers as a "verified purchase".
 */

type Row = RowDataPacket & Record<string, unknown>

export type ReviewStatus = 'pending' | 'approved' | 'rejected'

export type ProductReview = {
  id: number
  productId: number
  productCode: string | null
  productDescription: string
  rating: number
  title: string
  body: string
  authorName: string
  /** Unverified. Never present this as proof of purchase. */
  orderNumber: string
  status: ReviewStatus
  declineReason: string
  submittedAt: Date
  moderatedAt: Date | null
  moderatedBy: string
}

export type SaveResult = { ok: true } | { ok: false; error: string }

function mapReview(r: Row): ProductReview {
  return {
    id: Number(r.id),
    productId: Number(r.product_id),
    productCode: (r.product_code as string | null) ?? null,
    productDescription: String(r.product_description ?? ''),
    rating: Number(r.rating),
    title: String(r.title ?? ''),
    body: String(r.body ?? ''),
    authorName: String(r.author_name ?? ''),
    orderNumber: String(r.order_number ?? ''),
    status: String(r.status) as ReviewStatus,
    declineReason: String(r.decline_reason ?? ''),
    submittedAt: r.submitted_at instanceof Date ? r.submitted_at : new Date(0),
    moderatedAt: r.moderated_at instanceof Date ? r.moderated_at : null,
    moderatedBy: String(r.moderated_by ?? ''),
  }
}

const SELECT_REVIEW = `
  SELECT r.*, p.code AS product_code, p.description AS product_description
    FROM product_reviews r
    JOIN products p ON p.id = r.product_id
`

export async function listReviews(
  siteId: number,
  status?: ReviewStatus,
  limit = 200,
): Promise<ProductReview[]> {
  const capped = Math.min(Math.max(limit, 1), 500)
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_REVIEW}
      ${status ? 'WHERE r.status = ?' : ''}
      -- Oldest first: a moderation queue is worked from the front, and the
      -- review that has been waiting longest is the one holding a shopper up.
      ORDER BY r.status = 'pending' DESC, r.submitted_at
      LIMIT ${capped}`,
    status ? [status] : [],
  )
  return rows.map(mapReview)
}

export async function reviewCounts(siteId: number): Promise<Record<ReviewStatus, number>> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT status, COUNT(*) AS n FROM product_reviews GROUP BY status`,
  )
  const counts: Record<ReviewStatus, number> = { pending: 0, approved: 0, rejected: 0 }
  for (const r of rows) counts[String(r.status) as ReviewStatus] = Number(r.n)
  return counts
}

/**
 * Approve or reject a review.
 *
 * A rejection needs a reason. Not for the shopper — they are never told — but
 * because the next person to look at the queue has to know whether this was
 * spam, abuse, or a genuine complaint someone decided to bury. A rejected
 * review with no reason is indistinguishable from censorship after the fact.
 */
export async function moderateReview(
  siteId: number,
  reviewId: number,
  status: 'approved' | 'rejected',
  moderatedBy: string,
  reason = '',
): Promise<SaveResult> {
  if (status === 'rejected' && !reason.trim()) {
    return { ok: false, error: 'Say why it was rejected, so the decision is on record.' }
  }

  const result = await siteExecute(
    siteId,
    `UPDATE product_reviews
        SET status = ?, decline_reason = ?, moderated_at = NOW(), moderated_by = ?
      WHERE id = ?`,
    [status, status === 'rejected' ? reason.trim().slice(0, 190) : '', moderatedBy.slice(0, 120), reviewId],
  )

  if (result.affectedRows === 0) return { ok: false, error: 'That review no longer exists.' }
  return { ok: true }
}

/**
 * Put an already-moderated review back in the queue.
 *
 * The way out of a mistake. Approving something abusive, or rejecting a fair
 * complaint, both need an undo that does not involve editing the database by
 * hand.
 */
export async function reopenReview(siteId: number, reviewId: number): Promise<SaveResult> {
  const result = await siteExecute(
    siteId,
    `UPDATE product_reviews
        SET status = 'pending', decline_reason = '', moderated_at = NULL, moderated_by = ''
      WHERE id = ?`,
    [reviewId],
  )
  if (result.affectedRows === 0) return { ok: false, error: 'That review no longer exists.' }
  return { ok: true }
}

export async function deleteReview(siteId: number, reviewId: number): Promise<SaveResult> {
  const result = await siteExecute(siteId, `DELETE FROM product_reviews WHERE id = ?`, [reviewId])
  if (result.affectedRows === 0) return { ok: false, error: 'That review no longer exists.' }
  return { ok: true }
}

/**
 * A review written by a member of the public.
 *
 * ── IT IS NEVER PUBLISHED BY WRITING IT ──────────────────────────────────
 *
 * Always lands as 'pending'. There is no auto-approve path and no setting to
 * add one: this is an unauthenticated write to a public page, and a shop that
 * discovered abuse on its own product page after the fact would be right never
 * to trust the feature again. Staff approve, then it shows.
 *
 * ── THE ORDER NUMBER IS NOT PROOF ────────────────────────────────────────
 *
 * Stored as typed, unverified, and labelled that way on the type. It helps a
 * shop recognise a genuine customer during moderation. It must never be
 * rendered to shoppers as a "verified purchase" badge.
 */
export async function submitReview(
  siteId: number,
  input: {
    productId: number
    rating: number
    title: string
    body: string
    authorName: string
    orderNumber: string
  },
): Promise<SaveResult> {
  const body = input.body.trim()
  if (!body) return { ok: false, error: 'Please write a few words about the product.' }

  // Clamped, not rejected: a rating outside 1–5 can only come from a crafted
  // payload, and refusing it teaches nothing that clamping does not.
  const rating = Math.min(Math.max(Math.round(Number(input.rating) || 5), 1), 5)

  /*
   * The product must be one this shop actually sells. Without this a script
   * could seed reviews against arbitrary ids — including products of another
   * site, since only the id is supplied.
   */
  const exists = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM products WHERE id = ? AND is_archived = 0`,
    [input.productId],
  )
  if (!exists) return { ok: false, error: 'That product is not available.' }

  await siteExecute(
    siteId,
    `INSERT INTO product_reviews
       (product_id, rating, title, body, author_name, order_number, status, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NOW())`,
    [
      input.productId,
      rating,
      input.title.trim().slice(0, 120),
      body.slice(0, 1000),
      input.authorName.trim().slice(0, 80),
      input.orderNumber.trim().slice(0, 30),
    ],
  )

  return { ok: true }
}

/**
 * What the storefront shows on a product page: approved reviews only, plus the
 * average. Unused until the storefront exists, but it is the reason the table
 * is indexed on (product_id, status) and belongs with the rest.
 */
export async function approvedReviewsFor(
  siteId: number,
  productId: number,
): Promise<{ reviews: ProductReview[]; average: number; count: number }> {
  const [rows, summary] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `${SELECT_REVIEW} WHERE r.product_id = ? AND r.status = 'approved'
        ORDER BY r.submitted_at DESC LIMIT 100`,
      [productId],
    ),
    siteQueryOne<Row>(
      siteId,
      `SELECT COUNT(*) AS n, COALESCE(AVG(rating), 0) AS avg_rating
         FROM product_reviews WHERE product_id = ? AND status = 'approved'`,
      [productId],
    ),
  ])

  return {
    reviews: rows.map(mapReview),
    average: Math.round(Number(summary?.avg_rating ?? 0) * 10) / 10,
    count: Number(summary?.n ?? 0),
  }
}
