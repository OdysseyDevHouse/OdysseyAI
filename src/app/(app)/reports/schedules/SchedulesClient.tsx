'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  ConfirmModal,
  DataTable,
  EmptyState,
  Icons,
  Switch,
  useToast,
  type Column,
} from '@/components/ui'
import ScheduleModal, { type ScheduleRow, type ReportOption, type UserOption } from './ScheduleModal'
import { deleteScheduleAction, sendNowAction, toggleScheduleAction } from './actions'

/**
 * The list of rules.
 *
 * Each row answers the three questions someone opens this screen with: is it
 * on, when does it go, and did the last one work. Anything else is in the
 * editor.
 */
export default function SchedulesClient({
  schedules,
  reportOptions,
  users,
}: {
  schedules: ScheduleRow[]
  reportOptions: ReportOption[]
  users: UserOption[]
}) {
  const toast = useToast()
  const [, startTransition] = useTransition()
  const [editing, setEditing] = useState<ScheduleRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<ScheduleRow | null>(null)
  const [sending, setSending] = useState<number | null>(null)

  function onToggle(row: ScheduleRow, active: boolean) {
    startTransition(async () => {
      const result = await toggleScheduleAction(row.id, active)
      if (result.ok) toast.success(active ? `${row.name} is on.` : `${row.name} is off.`)
      else toast.error(result.error)
    })
  }

  function onSendNow(row: ScheduleRow) {
    setSending(row.id)
    startTransition(async () => {
      const result = await sendNowAction(row.id)
      setSending(null)
      if (result.ok) toast.success(`${row.name} sent.`)
      else toast.error(result.error)
    })
  }

  function onDelete() {
    if (!deleting) return
    const row = deleting
    setDeleting(null)
    startTransition(async () => {
      const result = await deleteScheduleAction(row.id)
      if (result.ok) toast.success(`${row.name} deleted.`)
      else toast.error(result.error)
    })
  }

  const columns: Column<ScheduleRow>[] = [
    {
      key: 'active',
      header: 'On',
      width: 'w-16',
      sortValue: (r) => (r.isActive ? 1 : 0),
      cell: (r) => (
        <Switch
          checked={r.isActive}
          onChange={(checked) => onToggle(r, checked)}
          aria-label={`${r.isActive ? 'Turn off' : 'Turn on'} ${r.name}`}
        />
      ),
    },
    {
      key: 'name',
      header: 'Schedule',
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{r.name}</div>
          <div className="truncate text-xs text-muted">{r.reportName}</div>
        </div>
      ),
      sortValue: (r) => r.name,
    },
    {
      key: 'cadence',
      header: 'When',
      cell: (r) => <span className="text-ink-2">{r.cadence}</span>,
      sortValue: (r) => r.cadence,
    },
    {
      key: 'next',
      header: 'Next send',
      cell: (r) =>
        r.nextSend ? (
          <span className="text-ink-2">{formatWhen(r.nextSend)}</span>
        ) : (
          <span className="text-faint">Paused</span>
        ),
      sortValue: (r) => r.nextSend ?? '',
    },
    {
      key: 'recipients',
      header: 'To',
      numeric: true,
      cell: (r) => <span className="numeric text-ink-2">{r.recipientCount}</span>,
      sortValue: (r) => r.recipientCount,
    },
    {
      key: 'last',
      header: 'Last run',
      cell: (r) => <LastRun row={r} />,
      sortValue: (r) => r.lastRunAt ?? '',
    },
  ]

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <ButtonLink href="/reports" variant="secondary">
          <Icons.ChevronLeft size={16} />
          All reports
        </ButtonLink>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icons.Plus size={16} />
          New schedule
        </Button>
      </div>

      <Card>
        <DataTable
          columns={columns}
          rows={schedules}
          getRowKey={(r) => r.id}
          actions={(r) => (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSendNow(r)}
                disabled={sending === r.id}
                title="Send it now, to check it works"
              >
                {sending === r.id ? 'Sending…' : 'Send now'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={`Edit ${r.name}`}
                onClick={() => setEditing(r)}
              >
                <Icons.Pencil size={15} />
              </Button>
              <Button
                variant="danger-ghost"
                size="sm"
                iconOnly
                aria-label={`Delete ${r.name}`}
                onClick={() => setDeleting(r)}
              >
                <Icons.Trash size={15} />
              </Button>
            </div>
          )}
          empty={{
            title: 'No scheduled reports yet',
            hint: 'Put a report on a timer and it will arrive by email without anyone opening the app.',
            icon: <Icons.Clock size={28} strokeWidth={1.75} />,
            action: (
              <Button variant="primary" onClick={() => setCreating(true)}>
                New schedule
              </Button>
            ),
          }}
        />
      </Card>

      {(creating || editing) && (
        <ScheduleModal
          schedule={editing}
          reportOptions={reportOptions}
          users={users}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
        />
      )}

      <ConfirmModal
        open={deleting !== null}
        title={deleting ? `Delete “${deleting.name}”?` : ''}
        message="It will stop sending immediately. The report itself is not affected."
        confirmLabel="Delete schedule"
        tone="danger"
        onConfirm={onDelete}
        onClose={() => setDeleting(null)}
      />
    </>
  )
}

function LastRun({ row }: { row: ScheduleRow }) {
  if (!row.lastRunAt) return <span className="text-faint">Never</span>

  const tone =
    row.lastRunStatus === 'sent'
      ? 'success'
      : row.lastRunStatus === 'failed'
        ? 'danger'
        : 'warning'

  return (
    <div className="flex flex-col gap-0.5">
      <Badge tone={tone}>{row.lastRunStatus || 'unknown'}</Badge>
      <span className="text-xs text-muted">{formatWhen(row.lastRunAt)}</span>
      {row.lastRunError && (
        <span className="max-w-64 truncate text-xs text-danger" title={row.lastRunError}>
          {row.lastRunError}
        </span>
      )}
    </div>
  )
}

/** "Tomorrow 07:00" reads better than a full timestamp on a list you scan. */
function formatWhen(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `Today ${time}`

  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${time}`
}
