'use client'

import { useEffect, useState } from 'react'
import { Badge, Modal, EmptyState, Icons } from '@/components/ui'
import type { AlertRow } from './AlertModal'
import { listAlertRunsAction, type AlertRunRow } from './actions'

/**
 * What this alert has actually done.
 *
 * The answer to the question the list can only hint at: not "did the last one
 * work" but "has this been watching anything at all". A column of `0 found`
 * over three weeks is a rule in perfect health that may still be pointed at
 * the wrong thing — and that is only visible with the history side by side.
 */
export default function RunsModal({ rule, onClose }: { rule: AlertRow; onClose: () => void }) {
  const [runs, setRuns] = useState<AlertRunRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    listAlertRunsAction(rule.id).then((result) => {
      if (!live) return
      if (result.ok) setRuns(result.runs)
      else setError(result.error)
    })
    return () => {
      live = false
    }
  }, [rule.id])

  return (
    <Modal open size="lg" title={`${rule.name} — history`} onClose={onClose}>
      {error && <p className="text-sm text-danger">{error}</p>}

      {runs === null && !error && <p className="text-sm text-muted">Reading the history…</p>}

      {runs !== null && runs.length === 0 && (
        <EmptyState
          icon={<Icons.Clock size={28} strokeWidth={1.75} />}
          title="It has not run yet"
          hint={
            rule.isActive
              ? `The first check is due ${rule.nextCheck ? formatWhen(rule.nextCheck) : 'at its next scheduled time'}. Use “Check now” to try it immediately.`
              : 'This alert is paused, so nothing is scheduled.'
          }
        />
      )}

      {runs !== null && runs.length > 0 && (
        <ul className="flex flex-col divide-y divide-border">
          {runs.map((run) => (
            <li key={run.dueAt} className="flex items-start gap-3 py-2.5">
              <div className="w-36 shrink-0 text-sm text-ink-2">{formatWhen(run.dueAt)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Outcome run={run} />
                  {run.createdDocs && (
                    <span className="text-xs text-muted">Raised {run.createdDocs}</span>
                  )}
                </div>
                {run.recipients && (
                  <p className="mt-0.5 truncate text-xs text-muted" title={run.recipients}>
                    Told {run.recipients}
                  </p>
                )}
                {run.errorText && <p className="mt-0.5 text-xs text-muted">{run.errorText}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

/**
 * What one run amounted to.
 *
 * A run that found nothing is deliberately a plain, quiet line rather than a
 * green tick — it is the ordinary case, and a column of ticks would make the
 * one row that matters harder to find, not easier.
 */
function Outcome({ run }: { run: AlertRunRow }) {
  if (run.status === 'failed') return <Badge tone="danger">Failed</Badge>
  if (run.status === 'skipped') return <Badge tone="warning">Missed</Badge>
  if (run.status === 'claimed') return <Badge tone="neutral">Still running</Badge>

  if (run.itemCount === 0) return <span className="text-sm text-muted">Nothing to report</span>
  return (
    <Badge tone="warning">
      Found {run.itemCount.toLocaleString('en-ZA')}
    </Badge>
  )
}

function formatWhen(iso: string): string {
  const at = new Date(iso)
  const time = at.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false })
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(at) - startOfDay(new Date())) / 86_400_000)

  if (days === 0) return `Today ${time}`
  if (days === 1) return `Tomorrow ${time}`
  if (days === -1) return `Yesterday ${time}`
  return `${at.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`
}
