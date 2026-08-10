'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  SegmentedControl,
  useToast,
  type Column,
} from '@/components/ui'
import { createScheduleAction } from './actions'
import type { Schedule } from '@/lib/site/priceSchedules'

/**
 * Every price change, waiting or done.
 *
 * ── WHY "DUE NOW" IS ITS OWN STATUS ──────────────────────────────────────
 *
 * A change that is armed and past its moment means the tick has not run — the
 * tills are already charging the new prices while the back office is not. That
 * is this feature's one failure mode, and it has to be visible on the list
 * rather than something you work out by reading a timestamp.
 *
 * Computed against the BROWSER's clock, which is fine for a badge and would not
 * be fine for pricing. Nothing here decides what anything costs.
 */

type Status = 'draft' | 'scheduled' | 'due' | 'applied' | 'cancelled'
type Filter = 'all' | 'open' | 'applied' | 'cancelled'

const STATUS_TONE = {
  draft: 'neutral',
  scheduled: 'brand',
  due: 'warning',
  applied: 'success',
  cancelled: 'neutral',
} as const

const STATUS_LABEL = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  due: 'Due now',
  applied: 'Applied',
  cancelled: 'Cancelled',
} as const

const pad = (n: number) => String(n).padStart(2, '0')

/** Now, in the same wall-clock text the moments are stored in. */
function stamp(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

function statusOf(schedule: Schedule, now: string): Status {
  if (schedule.status === 'applied') return 'applied'
  if (schedule.status === 'cancelled') return 'cancelled'
  if (schedule.status === 'draft') return 'draft'
  return schedule.effectiveAt <= now ? 'due' : 'scheduled'
}

/**
 * "14 Aug, 06:00" from the stored text.
 *
 * Split rather than passed through `new Date()`: the string is local wall-clock
 * text, and parsing it as a date is exactly the timezone shift migration 057
 * exists to prevent.
 */
function whenLabel(value: string): string {
  if (!value) return '—'
  const [date, time] = value.split('T')
  const [y, m, d] = date.split('-').map(Number)
  const shown = new Date(y, m - 1, d).toLocaleDateString('en-ZA', {
    day: 'numeric',
    month: 'short',
  })
  return `${shown}, ${time}`
}

export default function ScheduleList({ schedules }: { schedules: Schedule[] }) {
  const router = useRouter()
  const toast = useToast()
  const [busy, startTransition] = useTransition()
  const [filter, setFilter] = useState<Filter>('all')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  /* Read once per render rather than ticking. A row that changes from
     "Scheduled" to "Due now" while somebody is looking at the list is not worth
     an interval — the next navigation catches it, and the tick that makes it
     moot runs every five minutes anyway. */
  const now = useMemo(() => stamp(new Date()), [])

  const rows = useMemo(
    () => schedules.map((s) => ({ ...s, uiStatus: statusOf(s, now) })),
    [schedules, now],
  )

  const counts = useMemo(
    () => ({
      all: rows.length,
      open: rows.filter((r) => r.uiStatus === 'draft' || r.uiStatus === 'scheduled' || r.uiStatus === 'due').length,
      applied: rows.filter((r) => r.uiStatus === 'applied').length,
      cancelled: rows.filter((r) => r.uiStatus === 'cancelled').length,
    }),
    [rows],
  )

  const visible = useMemo(() => {
    if (filter === 'all') return rows
    if (filter === 'open') {
      return rows.filter(
        (r) => r.uiStatus === 'draft' || r.uiStatus === 'scheduled' || r.uiStatus === 'due',
      )
    }
    return rows.filter((r) => r.uiStatus === filter)
  }, [rows, filter])

  function create() {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error('Give this price change a name.')
      return
    }
    startTransition(async () => {
      const result = await createScheduleAction({ name: trimmed, effectiveAt: '' })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setCreating(false)
      setName('')
      router.push(`/pricing-schedules/${result.id}`)
    })
  }

  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (r) => (
        <span className="flex flex-col">
          <span className="text-sm font-medium text-ink">{r.name}</span>
          {r.note && <span className="mt-0.5 text-xs text-muted">{r.note}</span>}
        </span>
      ),
      sortValue: (r) => r.name,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => <Badge tone={STATUS_TONE[r.uiStatus]}>{STATUS_LABEL[r.uiStatus]}</Badge>,
      sortValue: (r) => r.uiStatus,
    },
    {
      key: 'when',
      header: 'When',
      cell: (r) => <span className="numeric text-sm text-ink-2">{whenLabel(r.effectiveAt)}</span>,
      sortValue: (r) => r.effectiveAt,
    },
    {
      key: 'prices',
      header: 'Prices',
      numeric: true,
      cell: (r) => (
        <span className="numeric text-sm text-ink-2">
          {r.uiStatus === 'applied' ? r.appliedCount : r.changingCount}
        </span>
      ),
      sortValue: (r) => (r.uiStatus === 'applied' ? r.appliedCount : r.changingCount),
    },
    {
      key: 'by',
      header: 'Set up by',
      cell: (r) => <span className="text-sm text-muted">{r.createdBy || '—'}</span>,
      sortValue: (r) => r.createdBy,
    },
  ]

  return (
    <>
      <Card>
        <CardHeader
          title="Price changes"
          description="Prepare new prices, choose when they take effect, and the shop changes them itself — the tills switch on the minute even with no network."
          action={
            <Button onClick={() => setCreating(true)} disabled={busy}>
              <Icons.Plus size={15} />
              Prepare a price change
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-4">
          <SegmentedControl
            value={filter}
            onChange={(v) => setFilter(v as Filter)}
            options={[
              { value: 'all', label: `All (${counts.all})` },
              { value: 'open', label: `Not yet applied (${counts.open})` },
              { value: 'applied', label: `Applied (${counts.applied})` },
              { value: 'cancelled', label: `Cancelled (${counts.cancelled})` },
            ]}
          />

          {visible.length === 0 ? (
            <EmptyState
              icon={<Icons.CalendarClock size={22} />}
              title={filter === 'all' ? 'No price changes yet' : 'Nothing here'}
              hint={
                filter === 'all'
                  ? 'Start from the prices you charge today, change the ones you want, and pick a date and time. Nobody has to be here when it happens.'
                  : 'Try another filter to see the rest.'
              }
              action={
                filter === 'all' ? (
                  <Button onClick={() => setCreating(true)}>Prepare a price change</Button>
                ) : undefined
              }
            />
          ) : (
            <DataTable
              columns={columns}
              rows={visible}
              getRowKey={(r) => r.id}
              onRowClick={(r) => router.push(`/pricing-schedules/${r.id}`)}
            />
          )}
        </CardBody>
      </Card>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Prepare a price change"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={create} disabled={busy}>
              Start
            </Button>
          </>
        }
      >
        <Field
          label="What is this change?"
          hint="Something you will recognise later — “Winter menu”, “April increase”."
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create()
            }}
            placeholder="Winter menu"
            autoFocus
          />
        </Field>
      </Modal>
    </>
  )
}
