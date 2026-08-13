'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  DataTable,
  Field,
  Input,
  Modal,
  NumberInput,
  TextLink,
  useToast,
  type Column,
} from '@/components/ui'
import { storedDate } from '@/lib/jobStatusModel'
import { verifyTravelAction } from '../actions'

export type TravelRow = {
  travelId: number
  jobId: number
  userName: string
  travelledOn: string
  fromLabel: string | null
  toLabel: string | null
  expectedKm: number | null
  recordedKm: number
  isReturn: boolean
  chargeableKm: number
}

/**
 * Travel claims nobody has looked at.
 *
 * ── WHY THE EXPECTATION IS SHOWN, NOT JUST THE VARIANCE ────────────────────
 *
 * `expected_km` is straight-line distance times a road factor, and nothing here
 * talks to a routing service. So a claim over it is a QUESTION, not evidence — a
 * detour round roadworks is a legitimate 88km on a 42km estimate. Showing both
 * figures and labelling the estimate as an estimate is what keeps this screen a
 * prompt to ask rather than a list of accusations.
 *
 * ── THE FIELD OPENS PRE-FILLED WITH THE CLAIM ──────────────────────────────
 *
 * Because accepting the claim is the commonest outcome and should be one click.
 * The alternative — an empty box — quietly biases towards whatever number the
 * manager happens to type, and `verified_km IS NULL` already carries the "nobody
 * has looked" state, so there is no information lost by defaulting it.
 */
export default function TravelToCheck({
  rows,
  canVerify,
}: {
  rows: TravelRow[]
  canVerify: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [open, setOpen] = useState<TravelRow | null>(null)
  const [km, setKm] = useState(0)
  const [note, setNote] = useState('')

  function begin(row: TravelRow) {
    setOpen(row)
    setKm(row.recordedKm)
    setNote('')
  }

  function save() {
    if (!open) return
    start(async () => {
      const result = await verifyTravelAction(open.jobId, open.travelId, km, note || null)
      if (result.ok) {
        toast.success('Trip verified.')
        setOpen(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const when = (value: string): string => {
    const date = storedDate(value)
    if (!date) return '—'
    return date.toLocaleDateString('en-ZA', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    })
  }

  const columns: Column<TravelRow>[] = [
    {
      key: 'job',
      header: 'Job',
      sortable: true,
      sortValue: (r) => r.jobId,
      cell: (r) => <TextLink href={`/jobs/${r.jobId}?tab=visits`}>#{r.jobId}</TextLink>,
    },
    {
      key: 'who',
      header: 'Driven by',
      sortable: true,
      sortValue: (r) => r.userName,
      cell: (r) => <span className="text-ink-2">{r.userName}</span>,
    },
    {
      key: 'when',
      header: 'When',
      sortable: true,
      sortValue: (r) => r.travelledOn,
      cell: (r) => <span className="text-ink-2">{when(r.travelledOn)}</span>,
    },
    {
      key: 'route',
      header: 'Route',
      cell: (r) => (
        <span className="text-muted">
          {r.fromLabel ?? '—'} → {r.toLabel ?? '—'}
          {r.isReturn && <span className="ml-2 text-xs">and back</span>}
        </span>
      ),
    },
    {
      key: 'expected',
      header: 'Estimated',
      numeric: true,
      cell: (r) => (
        <span className="text-muted">
          {r.expectedKm === null ? '—' : `${r.expectedKm.toFixed(1)} km`}
        </span>
      ),
    },
    {
      key: 'recorded',
      header: 'Claimed',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.recordedKm,
      cell: (r) => <span className="text-ink">{r.recordedKm.toFixed(1)} km</span>,
    },
    {
      key: 'over',
      header: 'Over by',
      numeric: true,
      sortable: true,
      // Nulls last: a trip with no estimate cannot be ranked by variance.
      sortValue: (r) =>
        r.expectedKm === null || r.expectedKm === 0
          ? -1
          : ((r.recordedKm - r.expectedKm) / r.expectedKm) * 100,
      cell: (r) => {
        if (r.expectedKm === null || r.expectedKm === 0) {
          return <span className="text-muted">no estimate</span>
        }
        const pct = ((r.recordedKm - r.expectedKm) / r.expectedKm) * 100
        return <Badge tone="warning">{pct.toFixed(0)}%</Badge>
      },
    },
  ]

  if (canVerify) {
    columns.push({
      key: 'act',
      header: '',
      numeric: true,
      cell: (r) => (
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => begin(r)}>
          Check it
        </Button>
      ),
    })
  }

  return (
    <>
      <DataTable columns={columns} rows={rows} getRowKey={(r) => r.travelId} />

      <Modal
        open={open !== null}
        onClose={() => setOpen(null)}
        title="Verify the distance"
        size="sm"
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(null)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={pending}>
              {pending ? 'Saving…' : 'Verify'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            {open?.userName} claimed{' '}
            <span className="text-ink-2">{open?.recordedKm.toFixed(1)} km</span>
            {open?.expectedKm !== null && open?.expectedKm !== undefined && (
              <>
                {' '}
                against an estimated{' '}
                <span className="text-ink-2">{open.expectedKm.toFixed(1)} km</span>
              </>
            )}
            . The estimate is straight-line distance times a road factor, so a longer
            real route is normal.
          </p>

          <Field
            label="Accept this distance"
            hint="Pre-filled with what was claimed. Change it only if you are reducing it."
          >
            <div className="w-32">
              <NumberInput
                value={km}
                onChange={(e) => setKm(Number(e.target.value) || 0)}
                step={0.1}
                min={0}
              />
            </div>
          </Field>

          {open !== null && km < open.recordedKm && (
            <Field
              label="Why it was reduced"
              hint="Required when accepting less than was claimed — the technician will see this."
            >
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={190} />
            </Field>
          )}
        </div>
      </Modal>
    </>
  )
}
