'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge, Button, Card, CardBody, CardHeader, Icons, useToast } from '@/components/ui'
import type { JobFeedback } from '@/lib/site/jobFeedback'
import { markFeedbackSeenAction } from '../actions'

/**
 * What the customer said about this job.
 *
 * ── ASKED-AND-SILENT IS SHOWN TOO ──────────────────────────────────────────
 *
 * A card that appeared only when somebody answered would make "we never asked"
 * and "they ignored us" look identical, and they are different problems: the
 * first is a setting, the second is ordinary. So a pending request says so.
 *
 * ── SEEN IS A FLAG, NOT A WORKFLOW ─────────────────────────────────────────
 *
 * One press, no states, no assignment. The value is only that a one-star rating
 * nobody has read is visible somewhere as a number — anything more elaborate
 * would be a complaints system, which this is not.
 */
export default function JobFeedbackCard({
  jobId,
  feedback,
  canEdit,
}: {
  jobId: number
  feedback: JobFeedback
  canEdit: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  function markSeen() {
    start(async () => {
      const result = await markFeedbackSeenAction(jobId)
      if (result.ok) {
        toast.success('Marked as read.')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const answered = feedback.respondedAt !== null && feedback.rating !== null
  const poor = feedback.rating !== null && feedback.rating <= 3

  return (
    <Card>
      <CardHeader
        title="What the customer said"
        description={
          answered
            ? `Answered ${feedback.respondedAt}.`
            : `Asked ${feedback.requestedAt}. No answer yet — most people do not reply, and the link lasts two months.`
        }
        action={
          answered && feedback.seenAt === null && canEdit ? (
            <Button variant="secondary" onClick={markSeen} disabled={pending}>
              <Icons.Check size={15} />
              Mark as read
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        {!answered ? (
          <p className="text-sm text-muted">Nothing back yet.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="flex" aria-label={`${feedback.rating} out of 5`}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <Icons.Star
                    key={n}
                    size={20}
                    aria-hidden
                    className={n <= (feedback.rating ?? 0) ? 'text-warning' : 'text-faint'}
                    fill={n <= (feedback.rating ?? 0) ? 'currentColor' : 'none'}
                  />
                ))}
              </span>
              <span className="numeric text-sm text-ink">{feedback.rating} out of 5</span>
              {/* Three or fewer is the threshold the reconciliation screen uses
                  too, so the two cannot disagree about what "poor" means. */}
              {poor && <Badge tone="danger">Worth a look</Badge>}
              {feedback.seenAt !== null && (
                <Badge tone="neutral">
                  Read{feedback.seenByName ? ` by ${feedback.seenByName}` : ''}
                </Badge>
              )}
            </div>

            {feedback.comment ? (
              <p className="whitespace-pre-line text-sm text-ink-2">
                &ldquo;{feedback.comment}&rdquo;
              </p>
            ) : (
              <p className="text-sm text-muted">They left no comment.</p>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
