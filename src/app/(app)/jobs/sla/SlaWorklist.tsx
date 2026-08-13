'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge, Button, DataTable, TextLink, useToast, type Column } from '@/components/ui'
import { formatBusinessMinutes, SLA_STATE_LABEL, storedDate } from '@/lib/jobStatusModel'
import type { SlaWorklistRow } from '@/lib/site/jobSla'
import { markRespondedAction } from '../actions'

/**
 * The worklist table.
 *
 * A client component because DataTable columns carry `cell` and `sortValue`
 * functions, which cannot cross the server boundary — and the failure hides until
 * there is a row, because an empty list early-returns an EmptyState on the page.
 *
 * ── WHY THE DEADLINE AND THE COUNTDOWN ARE BOTH SHOWN ──────────────────────
 *
 * Business hours are the right clock and they hide their arithmetic: "due Monday
 * 11:00" on a job logged Friday afternoon looks wrong until you know the doors
 * were shut. Showing the absolute deadline next to the business-hours countdown is
 * how somebody reconciles the two without opening a calculator. A red badge alone
 * would be an assertion nobody can check.
 */
export default function SlaWorklist({
  rows,
  kind,
  hoursPerDay,
  canRespond,
}: {
  rows: SlaWorklistRow[]
  kind: 'respond' | 'resolve'
  hoursPerDay: number
  canRespond: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  const [busyId, setBusyId] = useState<number | null>(null)

  function respond(jobId: number) {
    setBusyId(jobId)
    start(async () => {
      const result = await markRespondedAction(jobId)
      if (result.ok) {
        toast.success('Marked as picked up. The response clock has stopped.')
        router.refresh()
      } else {
        toast.error(result.error)
      }
      setBusyId(null)
    })
  }

  /** A stored wall clock as "Mon 17 Aug 11:00". Never a bare ISO string. */
  const when = (value: string | null): string => {
    const date = storedDate(value)
    if (!date) return '—'
    return date.toLocaleString('en-ZA', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    })
  }

  const columns: Column<SlaWorklistRow>[] = [
    {
      key: 'job',
      header: 'Job',
      sortable: true,
      sortValue: (r) => r.documentNumber ?? String(r.jobId),
      cell: (r) => (
        <div className="flex flex-col">
          <TextLink href={`/jobs/${r.jobId}`}>{r.documentNumber ?? `#${r.jobId}`}</TextLink>
          <span className="text-xs text-muted">{r.title}</span>
        </div>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      sortable: true,
      sortValue: (r) => r.customerName ?? '',
      cell: (r) => <span className="text-ink-2">{r.customerName ?? 'Walk-in'}</span>,
    },
    {
      key: 'priority',
      header: 'Priority',
      sortable: true,
      sortValue: (r) => ['urgent', 'high', 'normal', 'low'].indexOf(r.priority),
      cell: (r) => (
        <Badge
          tone={
            r.priority === 'urgent'
              ? 'danger'
              : r.priority === 'high'
                ? 'warning'
                : r.priority === 'low'
                  ? 'neutral'
                  : 'brand'
          }
        >
          {r.standing.policyName ?? r.priority}
        </Badge>
      ),
    },
    {
      key: 'owner',
      header: 'Assigned to',
      sortable: true,
      sortValue: (r) => r.ownerName ?? '',
      cell: (r) =>
        r.ownerName ? (
          <span className="text-ink-2">{r.ownerName}</span>
        ) : (
          // Nobody assigned on a job waiting for a reply is the likeliest cause
          // of the wait, so it is called out rather than left blank.
          <span className="text-warning-ink">Nobody</span>
        ),
    },
    {
      key: 'due',
      header: kind === 'respond' ? 'Reply by' : 'Fix by',
      sortable: true,
      sortValue: (r) => r.standing[kind === 'respond' ? 'respondBy' : 'resolveBy'] ?? '',
      cell: (r) => (
        <span className="text-ink-2">
          {when(kind === 'respond' ? r.standing.respondBy : r.standing.resolveBy)}
        </span>
      ),
    },
    {
      key: 'left',
      header: 'Business time',
      numeric: true,
      sortable: true,
      // Nulls last: a settled row has no countdown and belongs below the live ones.
      sortValue: (r) => {
        const mins =
          kind === 'respond' ? r.standing.respondMinutesLeft : r.standing.resolveMinutesLeft
        return mins ?? Number.MAX_SAFE_INTEGER
      },
      cell: (r) => {
        const state = kind === 'respond' ? r.standing.respondState : r.standing.resolveState
        const mins =
          kind === 'respond' ? r.standing.respondMinutesLeft : r.standing.resolveMinutesLeft

        if (state === 'met') return <Badge tone="success">{SLA_STATE_LABEL.met}</Badge>
        if (state === 'none') return <span className="text-muted">—</span>
        if (mins === null) return <span className="text-muted">—</span>

        // Negative means past the deadline. The word "over" beats a minus sign,
        // which reads as a subtraction rather than a state.
        return mins < 0 ? (
          <Badge tone="danger">{formatBusinessMinutes(mins, hoursPerDay)} over</Badge>
        ) : (
          <span className="text-ink-2">{formatBusinessMinutes(mins, hoursPerDay)} left</span>
        )
      },
    },
  ]

  if (kind === 'respond' && canRespond) {
    columns.push({
      key: 'act',
      header: '',
      numeric: true,
      cell: (r) => (
        <Button
          variant="secondary"
          size="sm"
          disabled={pending && busyId === r.jobId}
          onClick={() => respond(r.jobId)}
        >
          {pending && busyId === r.jobId ? 'Saving…' : 'Picked up'}
        </Button>
      ),
    })
  }

  if (kind === 'resolve') {
    columns.splice(5, 0, {
      key: 'responded',
      header: 'First reply',
      cell: (r) =>
        r.standing.responseTookMinutes === null ? (
          <span className="text-muted">Not yet</span>
        ) : (
          <span className="text-ink-2">
            {formatBusinessMinutes(r.standing.responseTookMinutes, hoursPerDay)}
            {r.standing.respondState === 'breached' && (
              <Badge tone="danger" className="ml-2">
                Late
              </Badge>
            )}
          </span>
        ),
    })
  }

  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.jobId} />
}
