'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  ButtonLink,
  Callout,
  Card,
  ConfirmModal,
  DataTable,
  Badge,
  Modal,
  Field,
  Input,
  Icons,
  TableToolbar,
  TextLink,
  useToast,
  type Column,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { CommissionRun } from '@/lib/site/commissionRuns'
import {
  createRunAction,
  calculateRunAction,
  lockRunAction,
  unlockRunAction,
  deleteRunAction,
  updateRunPeriodAction,
} from './actions'

/**
 * Commission periods.
 *
 * The status column is the point of this screen: open means the figures can
 * still move, locked means somebody has been paid on them. Everything else is
 * detail.
 */
export default function RunsScreen({
  runs,
  canRun,
  canEdit,
}: {
  runs: CommissionRun[]
  canRun: boolean
  canEdit: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<CommissionRun | null>(null)
  const [removing, setRemoving] = useState<CommissionRun | null>(null)
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
          <TextLink href={`/commission/${r.id}`}>
            {r.periodStart} to {r.periodEnd}
          </TextLink>
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
          <Badge tone="neutral">Open</Badge>
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
      {/* Both controls sit on the LEFT — TableToolbar's `children` slot — so
          they read as one group at the start of the line rather than being
          split across the width of the screen.

          The bar still hides while the list is empty and the user cannot edit
          rules: the empty state below carries the same primary, and one
          primary per screen is the rule. It DOES show for an empty list when
          Rules is available, because that button has nowhere else to live. */}
      {(canEdit || (canRun && runs.length > 0)) && (
        <TableToolbar>
          {canRun && runs.length > 0 && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Icons.Plus size={16} />
              Open a period
            </Button>
          )}
          {canEdit && (
            <ButtonLink href="/commission/rules" variant="secondary">
              <Icons.Percent size={16} />
              Manage rules
            </ButtonLink>
          )}
        </TableToolbar>
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
                          iconOnly
                          disabled={pending}
                          aria-label="Calculate this period"
                          title="Work out what everyone earned"
                          onClick={() => run(() => calculateRunAction(r.id))}
                        >
                          <Icons.Calculator size={15} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          disabled={pending}
                          aria-label="Edit this period"
                          title="Change the dates or the note"
                          onClick={() => setEditing(r)}
                        >
                          <Icons.Pencil size={15} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          disabled={pending || !r.calculatedAt}
                          aria-label="Lock this period"
                          title={
                            r.calculatedAt
                              ? 'Freeze these figures for payment'
                              : 'Calculate it first'
                          }
                          onClick={() => run(() => lockRunAction(r.id))}
                        >
                          <Icons.Lock size={15} />
                        </Button>
                        {/* Only on an open run. A locked period is somebody's
                            pay record — reopening it first is the audited way
                            through, and the action refuses it regardless. */}
                        <Button
                          variant="danger-ghost"
                          size="sm"
                          iconOnly
                          disabled={pending}
                          aria-label="Delete this period"
                          title="Delete this period"
                          onClick={() => setRemoving(r)}
                        >
                          <Icons.Trash size={15} />
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        disabled={pending}
                        aria-label="Reopen this period"
                        title="Reopen so the figures can be recalculated"
                        onClick={() => run(() => unlockRunAction(r.id))}
                      >
                        <Icons.Reverse size={15} />
                      </Button>
                    )}
                  </div>
                )
              : undefined
          }
          empty={{
            title: 'No commission periods yet',
            hint: 'Open one for the month you want to pay, then calculate it.',
            icon: <Icons.CalendarRange size={28} strokeWidth={1.75} />,
            action: canRun ? (
              <Button variant="primary" onClick={() => setAdding(true)}>
                <Icons.Plus size={16} />
                Open a period
              </Button>
            ) : undefined,
          }}
        />
      </Card>

      {adding && <RunForm onClose={() => setAdding(false)} />}
      {editing && <RunForm run={editing} onClose={() => setEditing(null)} />}

      <ConfirmModal
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing
          if (!target) return
          startTransition(async () => {
            const result = await deleteRunAction(target.id)
            if (!result.ok) return toast.error(result.error)
            toast.success(result.message)
            setRemoving(null)
            router.refresh()
          })
        }}
        busy={pending}
        title="Delete this period?"
        confirmLabel="Delete period"
        message={
          removing?.calculatedAt ? (
            <>
              <p>
                {removing.periodStart} to {removing.periodEnd} has been calculated
                — deleting it throws those figures away.
              </p>
              <p className="mt-2 text-muted">
                Nobody has been paid on it, because it was never locked. You can
                open the period again and recalculate.
              </p>
            </>
          ) : (
            <>
              <p>
                {removing?.periodStart} to {removing?.periodEnd} will be removed.
              </p>
              <p className="mt-2 text-muted">
                Nothing has been calculated for it yet, so nothing is lost.
              </p>
            </>
          )
        }
      />
    </>
  )
}

/**
 * Opens a period, or edits one that is already open.
 *
 * One form for both because the fields are identical — and because a period
 * typed wrongly is corrected by the same shape of thought that created it.
 */
function RunForm({ run, onClose }: { run?: CommissionRun; onClose: () => void }) {
  // Defaults to last month, which is what anyone opening this screen on the
  // first of the month is almost certainly about to pay.
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const last = new Date(now.getFullYear(), now.getMonth(), 0)
  const iso = (d: Date) => d.toISOString().slice(0, 10)

  const [periodStart, setPeriodStart] = useState(run?.periodStart ?? iso(first))
  const [periodEnd, setPeriodEnd] = useState(run?.periodEnd ?? iso(last))
  const [note, setNote] = useState(run?.note ?? '')
  const [error, setError] = useState<string | null>(null)

  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = run
        ? await updateRunPeriodAction(run.id, periodStart, periodEnd, note)
        : await createRunAction(periodStart, periodEnd, note)
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
      title={run ? 'Edit this commission period' : 'Open a commission period'}
      description={
        run
          ? 'Moving the dates clears any figures already calculated for the old ones.'
          : 'Every sale must fall in exactly one period, so periods cannot overlap.'
      }
      closeOnBackdrop={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? (run ? 'Saving…' : 'Opening…') : run ? 'Save' : 'Open'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {error && <Callout tone="danger">{error}</Callout>}

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
