'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Card,
  ConfirmModal,
  DataTable,
  Icons,
  StatStrip,
  StatTile,
  Switch,
  useToast,
  type Column,
} from '@/components/ui'
import AlertModal, { type AlertRow, type ChannelReadiness, type UserOption } from './AlertModal'
import RunsModal from './RunsModal'
import { deleteAlertAction, runAlertNowAction, setAlertActiveAction } from './actions'

/**
 * The shop's alert rules.
 *
 * Each row answers the four questions somebody opens this screen with: is it
 * on, what does it watch, when does it check, and DID THE LAST ONE WORK.
 *
 * That last one is why the status badge is never absent. An alert that has been
 * quietly failing for a week is this feature's worst failure mode — its success
 * state is also silence, so "nothing has happened" and "nothing is working"
 * look identical unless the screen says which.
 */
export default function AlertsClient({
  rules,
  users,
  channels,
}: {
  rules: AlertRow[]
  users: UserOption[]
  channels: ChannelReadiness
}) {
  const toast = useToast()
  const [, startTransition] = useTransition()
  const [editing, setEditing] = useState<AlertRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<AlertRow | null>(null)
  const [history, setHistory] = useState<AlertRow | null>(null)
  const [running, setRunning] = useState<number | null>(null)

  const stats = useMemo(() => {
    const active = rules.filter((r) => r.isActive)
    return {
      active: active.length,
      paused: rules.length - active.length,
      // The number that means ACT: a rule that failed or was missed is not
      // watching anything, and nobody would find out any other way.
      broken: active.filter(
        (r) => r.lastRunStatus === 'failed' || r.lastRunStatus === 'skipped',
      ).length,
      automating: active.filter((r) => r.kind === 'low_stock' && r.config.createOrders).length,
    }
  }, [rules])

  function onToggle(row: AlertRow, active: boolean) {
    startTransition(async () => {
      const result = await setAlertActiveAction(row.id, active)
      if (result.ok) toast.success(active ? `${row.name} is watching.` : `${row.name} is paused.`)
      else toast.error(result.error)
    })
  }

  function onRunNow(row: AlertRow) {
    setRunning(row.id)
    startTransition(async () => {
      const result = await runAlertNowAction(row.id)
      setRunning(null)
      if (result.ok) toast.success(`${row.name} checked — see its history for what it found.`)
      else toast.error(result.error)
    })
  }

  function onDelete() {
    if (!deleting) return
    const row = deleting
    setDeleting(null)
    startTransition(async () => {
      const result = await deleteAlertAction(row.id)
      if (result.ok) toast.success(`${row.name} deleted.`)
      else toast.error(result.error)
    })
  }

  const columns: Column<AlertRow>[] = [
    {
      key: 'active',
      header: 'On',
      width: 'w-16',
      sortValue: (r) => (r.isActive ? 1 : 0),
      cell: (r) => (
        <Switch
          checked={r.isActive}
          onChange={(checked) => onToggle(r, checked)}
          aria-label={`${r.isActive ? 'Pause' : 'Resume'} ${r.name}`}
        />
      ),
    },
    {
      key: 'name',
      header: 'Alert',
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{r.name}</div>
          <div className="truncate text-xs text-muted">
            {r.kindLabel}
            {r.kind === 'low_stock' && r.config.createOrders ? ' · drafts the orders' : ''}
          </div>
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
      header: 'Next check',
      cell: (r) =>
        r.nextCheck ? (
          <span className="text-ink-2">{formatWhen(r.nextCheck)}</span>
        ) : (
          <span className="text-faint">Paused</span>
        ),
      sortValue: (r) => r.nextCheck ?? '',
    },
    {
      key: 'channels',
      header: 'How',
      cell: (r) => <Channels row={r} />,
      sortValue: (r) => channelNames(r).join(','),
    },
    {
      key: 'to',
      header: 'To',
      numeric: true,
      cell: (r) => <span className="numeric text-ink-2">{r.recipientCount}</span>,
      sortValue: (r) => r.recipientCount,
    },
    {
      key: 'last',
      header: 'Last check',
      cell: (r) => <LastRun row={r} />,
      sortValue: (r) => r.lastRunAt ?? '',
    },
  ]

  return (
    <>
      {rules.length > 0 && (
        <StatStrip columns={4}>
          <StatTile label="Watching" value={String(stats.active)} icon={<Icons.Bell size={18} />} />
          <StatTile
            label="Not working"
            value={String(stats.broken)}
            // The only tile that ever colours: a failing alert is telling
            // nobody, and its silence looks exactly like good news.
            tone={stats.broken > 0 ? 'danger' : 'default'}
            hint={stats.broken > 0 ? 'Last check failed or was missed' : 'Every check ran'}
            icon={<Icons.StatusWarning size={18} />}
          />
          <StatTile label="Paused" value={String(stats.paused)} icon={<Icons.Pause size={18} />} />
          <StatTile
            label="Raising orders"
            value={String(stats.automating)}
            hint="Drafts, never sent"
            icon={<Icons.Truck size={18} />}
          />
        </StatStrip>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Checks run in the background, even when nobody is signed in.
        </p>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icons.Plus size={16} />
          New alert
        </Button>
      </div>

      <Card>
        <DataTable
          columns={columns}
          rows={rules}
          getRowKey={(r) => r.id}
          actions={(r) => (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRunNow(r)}
                disabled={running === r.id}
                title="Run the check now, to see what it finds"
              >
                {running === r.id ? 'Checking…' : 'Check now'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={`History for ${r.name}`}
                onClick={() => setHistory(r)}
              >
                <Icons.Clock size={15} />
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
            title: 'No alerts yet',
            hint: 'Set one up and the shop will watch for you — a daily low-stock check that drafts your supplier orders is the usual first one.',
            icon: <Icons.Bell size={28} strokeWidth={1.75} />,
            action: (
              <Button variant="primary" onClick={() => setCreating(true)}>
                New alert
              </Button>
            ),
          }}
        />
      </Card>

      {(creating || editing) && (
        <AlertModal
          rule={editing}
          users={users}
          channels={channels}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
        />
      )}

      {history && <RunsModal rule={history} onClose={() => setHistory(null)} />}

      <ConfirmModal
        open={deleting !== null}
        title={deleting ? `Delete “${deleting.name}”?` : ''}
        message="It stops watching immediately, and its history goes with it. Anything it already created stays."
        confirmLabel="Delete alert"
        tone="danger"
        onConfirm={onDelete}
        onClose={() => setDeleting(null)}
      />
    </>
  )
}

function channelNames(row: AlertRow): string[] {
  return [
    row.notifyBell ? 'Bell' : '',
    row.notifyEmail ? 'Email' : '',
    row.notifyWhatsapp ? 'WhatsApp' : '',
    row.notifySms ? 'SMS' : '',
  ].filter(Boolean)
}

/** Plain text, not badges: every rule has channels, so a badge here is noise. */
function Channels({ row }: { row: AlertRow }) {
  return <span className="text-xs text-muted">{channelNames(row).join(' · ')}</span>
}

/**
 * What happened last time — never absent.
 *
 * "Found 12" rather than a bare tick: the count is what tells somebody whether
 * the rule is watching something real. A rule that reports zero every day for a
 * month is working perfectly and may still be pointed at the wrong thing.
 */
function LastRun({ row }: { row: AlertRow }) {
  if (!row.isActive) return <span className="text-faint">Paused</span>
  if (!row.lastRunAt) return <span className="text-faint">Not yet</span>

  const when = formatWhen(row.lastRunAt)

  if (row.lastRunStatus === 'failed') {
    return (
      <div className="min-w-0">
        <Badge tone="danger">Failed</Badge>
        <div className="truncate text-xs text-muted" title={row.lastRunError}>
          {row.lastRunError || when}
        </div>
      </div>
    )
  }

  if (row.lastRunStatus === 'skipped') {
    return (
      <div className="min-w-0">
        <Badge tone="warning">Missed</Badge>
        <div className="truncate text-xs text-muted" title={row.lastRunError}>
          {row.lastRunError || when}
        </div>
      </div>
    )
  }

  return (
    <div className="min-w-0">
      <span className="text-ink-2">{when}</span>
      {row.lastRunError && (
        <div className="truncate text-xs text-warning-ink" title={row.lastRunError}>
          {row.lastRunError}
        </div>
      )}
    </div>
  )
}

/** "Today 07:00" / "Tomorrow 07:00" / "Mon 18 Aug 07:00". */
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
