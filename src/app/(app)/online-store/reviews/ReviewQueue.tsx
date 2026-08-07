'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  ConfirmModal,
  EmptyState,
  Field,
  Icons,
  LinkSegmentedControl,
  Modal,
  TableToolbar,
  Textarea,
  useToast,
} from '@/components/ui'
import type { ProductReview, ReviewStatus } from '@/lib/site/productReviews'
import { deleteReviewAction, moderateReviewAction, reopenReviewAction } from './actions'

/**
 * The moderation queue.
 *
 * Reviews are shown as cards rather than table rows because the thing being
 * judged is prose: a moderator has to read the whole body to decide, and a
 * truncated cell in a table would mean opening every one to do the job.
 */

/** Filled and empty stars. A rating is read at a glance, not counted. */
function Stars({ rating }: { rating: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-label={`${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Icons.Star
          key={n}
          size={14}
          className={n <= rating ? 'fill-warning text-warning' : 'text-faint'}
          aria-hidden
        />
      ))}
    </span>
  )
}

const TONE: Record<ReviewStatus, 'warning' | 'success' | 'danger'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
}

/** The tabs' vocabulary, so a badge never shows a raw enum like "pending". */
const LABEL: Record<ReviewStatus, string> = {
  pending: 'Waiting',
  approved: 'Published',
  rejected: 'Rejected',
}

export default function ReviewQueue({
  reviews,
  counts,
  status,
}: {
  reviews: ProductReview[]
  counts: Record<ReviewStatus, number>
  status: ReviewStatus
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, startAction] = useTransition()

  const [rejecting, setRejecting] = useState<ProductReview | null>(null)
  const [reason, setReason] = useState('')
  const [deleting, setDeleting] = useState<ProductReview | null>(null)

  function approve(review: ProductReview) {
    startAction(async () => {
      const result = await moderateReviewAction(review.id, 'approved')
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Review published.')
      router.refresh()
    })
  }

  function confirmReject() {
    if (!rejecting) return
    startAction(async () => {
      const result = await moderateReviewAction(rejecting.id, 'rejected', reason)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Review rejected.')
      setRejecting(null)
      setReason('')
      router.refresh()
    })
  }

  function reopen(review: ProductReview) {
    startAction(async () => {
      const result = await reopenReviewAction(review.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Back in the queue.')
      router.refresh()
    })
  }

  function confirmDelete() {
    if (!deleting) return
    startAction(async () => {
      const result = await deleteReviewAction(deleting.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Review deleted.')
      setDeleting(null)
      router.refresh()
    })
  }

  return (
    <>
      {/* Same toolbar-card treatment as the orders queue, so the two
          moderation screens read as siblings. */}
      <Card>
        <TableToolbar className="px-4 py-3.5">
          <LinkSegmentedControl
            aria-label="Review status"
            value={status}
            options={[
              {
                value: 'pending',
                label: `Waiting (${counts.pending})`,
                href: '/online-store/reviews?status=pending',
              },
              {
                value: 'approved',
                label: `Published (${counts.approved})`,
                href: '/online-store/reviews?status=approved',
              },
              {
                value: 'rejected',
                label: `Rejected (${counts.rejected})`,
                href: '/online-store/reviews?status=rejected',
              },
            ]}
          />
        </TableToolbar>
      </Card>

      {reviews.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Icons.MessageSquare size={22} />}
            title={
              status === 'pending'
                ? 'Nothing waiting'
                : status === 'approved'
                  ? 'No published reviews'
                  : 'Nothing rejected'
            }
            hint={
              status === 'pending'
                ? 'Reviews customers write appear here for you to approve before anyone else sees them.'
                : status === 'approved'
                  ? 'Reviews you approve show on the product page in your online store.'
                  : 'Reviews you turn down are kept here rather than deleted, so the decision stays on record.'
            }
            action={
              status === 'pending' ? (
                <ButtonLink variant="secondary" href="/online-store/reviews?status=approved">
                  See published reviews
                </ButtonLink>
              ) : status === 'approved' ? (
                <ButtonLink variant="secondary" href="/online-store/setup">
                  Check review settings
                </ButtonLink>
              ) : (
                <ButtonLink variant="secondary" href="/online-store/reviews?status=pending">
                  See what&apos;s waiting
                </ButtonLink>
              )
            }
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {reviews.map((review) => (
            <Card key={review.id}>
              <div className="flex flex-col gap-3 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Stars rating={review.rating} />
                      {review.title && (
                        <span className="font-medium text-ink">{review.title}</span>
                      )}
                      {/* The tab already says what every card here is; a badge
                          repeating it on each card is decoration. Only badge a
                          status that CONTRADICTS the filter. */}
                      {review.status !== status && (
                        <Badge tone={TONE[review.status]}>{LABEL[review.status]}</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-muted">
                      {review.productDescription}
                      {review.productCode && ` · ${review.productCode}`}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-muted">
                    {review.submittedAt.toLocaleDateString('en-ZA', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </span>
                </div>

                <p className="whitespace-pre-wrap text-sm text-ink-2">{review.body}</p>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                  <span>{review.authorName || 'Anonymous'}</span>
                  {review.orderNumber && (
                    // Deliberately hedged. Nothing checks this number, so it
                    // must not read as a verified-purchase badge — to staff or,
                    // later, to shoppers.
                    <span title="Typed by the reviewer. Not verified.">
                      Claims order {review.orderNumber}
                    </span>
                  )}
                  {review.moderatedBy && (
                    <span>
                      {review.status === 'approved' ? 'Approved' : 'Rejected'} by{' '}
                      {review.moderatedBy}
                    </span>
                  )}
                </div>

                {review.declineReason && (
                  <p className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                    {review.declineReason}
                  </p>
                )}

                <div className="flex flex-wrap items-center justify-end gap-2">
                  {review.status === 'pending' ? (
                    <>
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setRejecting(review)
                          setReason('')
                        }}
                      >
                        Reject
                      </Button>
                      {/* success, not primary: every waiting card carries one,
                          and publishing is the positive go. */}
                      <Button
                        variant="success"
                        size="sm"
                        disabled={busy}
                        onClick={() => approve(review)}
                      >
                        Publish
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => setDeleting(review)}
                      >
                        <Icons.Trash size={15} />
                        Delete
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => reopen(review)}
                      >
                        Put back in the queue
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title="Reject this review"
        description="The customer is not told. The reason is for whoever looks at this next."
        footer={
          <>
            <Button variant="secondary" onClick={() => setRejecting(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmReject} disabled={busy}>
              {busy ? 'Rejecting…' : 'Reject it'}
            </Button>
          </>
        }
      >
        <Field
          label="Why"
          hint="Spam, abuse, or about the wrong product — say which, so a rejection never looks like a complaint being buried."
        >
          <Textarea
            value={reason}
            rows={3}
            maxLength={190}
            placeholder="e.g. Spam — links to another shop"
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </Modal>

      {/* Deleting really destroys the review — rejecting is the reversible
          path — so it has to be answered, not just clicked. */}
      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title="Delete this review"
        message={
          <>
            The review of <strong>{deleting?.productDescription}</strong> by{' '}
            {deleting?.authorName || 'an anonymous customer'} will be gone for good. Rejecting
            keeps a review on record; deleting does not.
          </>
        }
        confirmLabel="Delete review"
        busy={busy}
      />
    </>
  )
}
