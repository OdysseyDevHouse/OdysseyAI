'use client'

import { useState, useTransition } from 'react'
import { Badge, Button, Callout, Icons, Select, TextLink, useToast } from '@/components/ui'
import { JOB_PRIORITIES, PRIORITY_LABEL } from '@/lib/jobStatusModel'
import type { JobBulkChange, JobBulkResult } from '@/lib/site/jobCards'
import { bulkUpdateJobsAction } from './actions'

/**
 * One change, applied to the jobs somebody ticked.
 *
 * ── THE SKIPPED LIST IS THE FEATURE ────────────────────────────────────────
 *
 * "38 changed, 2 skipped" with no list of which two, and why, is worse than not
 * offering the action: the user cannot tell whether the two that mattered went
 * through, so they have to check all forty by hand — which is what they were
 * avoiding.
 *
 * So the refusals stay on screen until dismissed, name the job, and quote the
 * reason the server gave. Those reasons are the real ones — each job goes
 * through the same door a person uses, so "this job is closed" or "still to do
 * before this job can be closed" arrives verbatim.
 *
 * ── WHY IT APPEARS RATHER THAN SITTING THERE ───────────────────────────────
 *
 * Hidden until something is selected. A permanently visible bar with three
 * disabled dropdowns is a row of furniture on a screen people use all day.
 */
export default function JobBulkBar({
  selected,
  statuses,
  users,
  canEdit,
  canAssign,
  onDone,
}: {
  selected: ReadonlySet<string>
  statuses: { id: number; name: string }[]
  users: { id: number; name: string }[]
  canEdit: boolean
  canAssign: boolean
  onDone: () => void
}) {
  const toast = useToast()
  const [pending, start] = useTransition()
  const [result, setResult] = useState<JobBulkResult | null>(null)

  const ids = [...selected].map(Number).filter((n) => Number.isFinite(n) && n > 0)

  function apply(change: JobBulkChange) {
    if (ids.length === 0) return
    start(async () => {
      const outcome = await bulkUpdateJobsAction(ids, change)
      if ('ok' in outcome && outcome.ok === false) {
        toast.error(outcome.error)
        return
      }
      const done = outcome as JobBulkResult
      setResult(done.skipped.length > 0 ? done : null)
      if (done.skipped.length === 0) {
        toast.success(`${done.changed} job${done.changed === 1 ? '' : 's'} changed.`)
      } else {
        // Not a toast: a toast disappears, and this is the half the user has to
        // read and act on.
        toast.success(`${done.changed} changed, ${done.skipped.length} skipped.`)
      }
      onDone()
    })
  }

  if (selected.size === 0 && result === null) return null

  return (
    <div className="mb-3 space-y-2">
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface-2 px-3 py-2">
          <Badge tone="brand">{selected.size} selected</Badge>

          {canEdit && (
            <div className="w-44">
              <Select
                value=""
                disabled={pending}
                onChange={(e) => {
                  const id = Number(e.target.value)
                  if (id) apply({ kind: 'status', statusId: id })
                }}
              >
                <option value="">Move to…</option>
                {statuses.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {canEdit && (
            <div className="w-40">
              <Select
                value=""
                disabled={pending}
                onChange={(e) => {
                  const p = e.target.value
                  if (p) apply({ kind: 'priority', priority: p as (typeof JOB_PRIORITIES)[number] })
                }}
              >
                <option value="">Priority…</option>
                {JOB_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {canAssign && (
            <div className="w-48">
              <Select
                value=""
                disabled={pending}
                onChange={(e) => {
                  const raw = e.target.value
                  if (!raw) return
                  if (raw === 'none') {
                    apply({ kind: 'owner', ownerUserId: null, ownerName: '' })
                    return
                  }
                  const user = users.find((u) => String(u.id) === raw)
                  if (user) apply({ kind: 'owner', ownerUserId: user.id, ownerName: user.name })
                }}
              >
                <option value="">Assign to…</option>
                <option value="none">Nobody</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {pending && <span className="text-xs text-muted">Working…</span>}
        </div>
      )}

      {result && result.skipped.length > 0 && (
        <Callout
          tone="warning"
          title={`${result.changed} changed, ${result.skipped.length} left alone`}
        >
          <ul className="mt-1 space-y-1">
            {result.skipped.map((s) => (
              <li key={s.id} className="text-sm">
                <TextLink href={`/jobs/${s.id}`}>{s.documentNumber ?? `Job ${s.id}`}</TextLink>
                {' — '}
                {s.reason}
              </li>
            ))}
          </ul>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => setResult(null)}
          >
            <Icons.Check size={15} />
            Got it
          </Button>
        </Callout>
      )}
    </div>
  )
}
