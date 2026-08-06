'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Button,
  Card,
  DataTable,
  Badge,
  Modal,
  Field,
  Input,
  Icons,
  useToast,
  type Column,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { CommissionRun } from '@/lib/site/commissionRuns'
import { createRunAction, calculateRunAction, lockRunAction, unlockRunAction } from './actions'

/**
 * Commission periods.
 *
 * The status column is the point of this screen: open means the figures can
 * still move, locked means somebody has been paid on them. Everything else is
 * detail.
 */
export default function RunsScreen({ runs, canRun }: { runs: CommissionRun[]; canRun: boolean }) {
  const [adding, setAdding] = useState(false)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await action()
      if (!result.ok) return toast.error(result.error ?? 'That did not work.')
      toast.success(result.message ?? 'Done.')
      router.refresh()
    })
  }

  const columns: Column<CommissionRun>[] = [
    {
      key: 'period',
      header: 'Period',
      sortValue: (r) => r.periodStart,
      cell: (r) => (
        <div>
          <Link href={`/commission/${r.id}`} className="font-medium text-brand hover:underline">
            {r.periodStart} to {r.periodEnd}
          </Link>
          {r.note && <div className="text-xs text-muted">{r.note}</div>}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      cell: (r) =>
        r.status === 'locked' ? (
          <div>
            <Badge tone="success">Locked</Badge>
            {r.lockedByName && (
              <div className="text-xs text-muted">by {r.lockedByName}</div>
            )}
          </div>
        ) : r.calculatedAt ? (
          <Badge tone="warning">Calculated</Badge>
        ) : (
          <Badge tone="default">Open</Badge>
        ),
    },
    {
      key: 'total',
      header: 'Total',
      numeric: true,
      sortValue: (r) => r.totalAmount,
      cell: (r) => <span className="numeric text-ink">{formatMoney(r.totalAmount)}</span>,
    },
  ]

  return (
    <>
      {canRun && (
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Icons.Plus size={16} />
            Open a period
          </Button>
        </div>
      )}

      <Card>
        <DataTable
          columns={columns}
          rows={runs}
          getRowKey={(r) => r.id}
          actions={
            canRun
              ? (r) => (
                  <div className="flex justify-end gap-1">
                    {r.status === 'open' ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => run(() => calculateRunAction(r.id))}
                        >
                          <Icons.Refresh size={15} />
                          Calculate
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending || !r.calculatedAt}
                          title={
                            r.calculatedAt
                              ? 'Freeze these figures for payment'
                              : 'Calculate it first'
                          }
                          onClick={() => run(() => lockRunAction(r.id))}
                        >
                          <Icons.Lock size={15} />
                          Lock
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        title="Reopen so the figures can be recalculated"
                        onClick={() => run(() => unlockRunAction(r.id))}
                      >
                        <Icons.Refresh size={15} />
                        Reopen
                      </Button>
                    )}
                  </div>
                )
              : undefined
          }
          empty={{
            title: 'No commission periods yet',
            hint: 'Open one for the month you want to pay, then calculate it.',
          }}
        />
      </Card>

      {adding && <RunForm onClose={() => setAdding(false)} />}
    </>
  )
}

function RunForm({ onClose }: { onClose: () => void }) {
  // Defaults to last month, which is what anyone opening this screen on the
  // first of the month is almost certainly about to pay.
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const last = new Date(now.getFullYear(), now.getMonth(), 0)
  const iso = (d: Date) => d.toISOString().slice(0, 10)

  const [periodStart, setPeriodStart] = useState(iso(first))
  const [periodEnd, setPeriodEnd] = useState(iso(last))
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await createRunAction(periodStart, periodEnd, note)
      if (!result.ok) {
        setError(result.error)
        return
      }
      toast.success(result.message)
      router.refresh()
      onClose()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Open a commission period"
      description="Every sale must fall in exactly one period, so periods cannot overlap."
      closeOnBackdrop={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? 'Opening…' : 'Open'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {error && (
          <div className="flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2.5 text-sm">
            <Icons.StatusWarning size={16} className="mt-0.5 shrink-0 text-danger" />
            <span className="text-ink">{error}</span>
          </div>
        )}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="From">
            <Input
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
            />
          </Field>
          <Field label="To" hint="Inclusive.">
            <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </Field>
        </div>

        <Field label="Note" hint="Optional.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="August payroll" />
        </Field>
      </div>
    </Modal>
  )
}
