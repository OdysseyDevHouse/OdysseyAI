'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge, Button, Card, CardBody, CardHeader, useToast } from '@/components/ui'
import {
  formatBusinessMinutes,
  SLA_STATE_LABEL,
  SLA_STATE_TONE,
  storedDate,
  type SlaState,
} from '@/lib/jobStatusModel'
import type { SlaStanding } from '@/lib/site/jobSla'
import { markRespondedAction } from '../actions'

/**
 * What was promised on this job.
 *
 * ── WHY THE DEADLINE IS SPELLED OUT AND NOT JUST BADGED ────────────────────
 *
 * Business hours are the right clock for an SLA and they hide their own
 * arithmetic: "due Monday 11:00" on a job logged Friday at four looks like a bug
 * until you know the doors were shut. So the card gives the absolute time AND the
 * business-hours remainder, and names who responded. A red badge on its own is an
 * assertion the reader cannot check, and the first time somebody disputes it the
 * badge loses.
 *
 * ── WHY "PICKED UP" IS A BUTTON AND NOT AUTOMATIC ──────────────────────────
 *
 * The response clock could have been stopped by the first status change or the
 * first comment. Both are wrong: a status can be changed by a batch tidy-up, and
 * the activity log records the creation itself, so a job would count as answered
 * the instant it was typed in. Somebody saying "I have this" is the actual event,
 * so it is an actual button.
 */
export default function JobSlaCard({
  jobId,
  standing,
  hoursPerDay,
  canRespond,
}: {
  jobId: number
  standing: SlaStanding
  hoursPerDay: number
  canRespond: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  function respond() {
    start(async () => {
      const result = await markRespondedAction(jobId)
      if (result.ok) {
        toast.success('Marked as picked up. The response clock has stopped.')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const when = (value: string | null): string => {
    const date = storedDate(value)
    if (!date) return 'no target'
    return date.toLocaleString('en-ZA', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    })
  }

  const tone = (state: SlaState) => SLA_STATE_TONE[state]

  return (
    <Card>
      <CardHeader
        title="What we promised"
        description={
          standing.policyName
            ? `${standing.policyName} — business hours only, so a job logged before closing is not late by morning.`
            : 'Business hours only, so a job logged before closing is not late by morning.'
        }
        action={
          canRespond && standing.respondedAt === null && standing.respondBy !== null ? (
            <Button variant="primary" onClick={respond} disabled={pending}>
              {pending ? 'Saving…' : 'I have this'}
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        <div className="flex flex-col gap-3 text-sm">
          {standing.respondBy !== null && (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-muted">First reply by</span>
              <span className="text-ink-2">{when(standing.respondBy)}</span>
              <Badge tone={tone(standing.respondState)}>
                {SLA_STATE_LABEL[standing.respondState]}
              </Badge>
              {standing.respondedAt === null && standing.respondMinutesLeft !== null && (
                <span className={standing.respondMinutesLeft < 0 ? 'text-danger-ink' : 'text-muted'}>
                  {standing.respondMinutesLeft < 0
                    ? `${formatBusinessMinutes(standing.respondMinutesLeft, hoursPerDay)} over`
                    : `${formatBusinessMinutes(standing.respondMinutesLeft, hoursPerDay)} left`}
                </span>
              )}
            </div>
          )}

          {/* Who, and how long it actually took. The figure an owner asks for
              later is this one, so it is recorded on the job rather than only
              aggregated into a report. */}
          {standing.respondedAt !== null && (
            <p className="text-muted">
              Picked up by{' '}
              <span className="text-ink-2">{standing.respondedByName ?? 'somebody'}</span> on{' '}
              <span className="text-ink-2">{when(standing.respondedAt)}</span>
              {standing.responseTookMinutes !== null && (
                <>
                  {' '}
                  — {formatBusinessMinutes(standing.responseTookMinutes, hoursPerDay)} of working time
                </>
              )}
              .
            </p>
          )}

          {standing.resolveBy !== null && (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-muted">Fixed by</span>
              <span className="text-ink-2">{when(standing.resolveBy)}</span>
              <Badge tone={tone(standing.resolveState)}>
                {SLA_STATE_LABEL[standing.resolveState]}
              </Badge>
              {standing.resolveMinutesLeft !== null && (
                <span className={standing.resolveMinutesLeft < 0 ? 'text-danger-ink' : 'text-muted'}>
                  {standing.resolveMinutesLeft < 0
                    ? `${formatBusinessMinutes(standing.resolveMinutesLeft, hoursPerDay)} over`
                    : `${formatBusinessMinutes(standing.resolveMinutesLeft, hoursPerDay)} left`}
                </span>
              )}
            </div>
          )}

          {standing.resolveBy === null && (
            <p className="text-muted">
              No fix date was promised for this priority — common when a repair waits on a part.
            </p>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
