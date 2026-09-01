'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  CardHeader,
  DataTable,
  Field,
  Icons,
  Input,
  Modal,
  Select,
  StatStrip,
  StatTile,
  TableToolbar,
  useToast,
  type Column,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { CostLine, CostReport, PayPeriod } from '@/lib/site/staffCost'
import {
  createPeriodAction,
  calculatePeriodAction,
  lockPeriodAction,
  unlockPeriodAction,
} from './actions'

/**
 * Cost per employee.
 *
 * The hours columns come first and the money after, because the question this
 * screen answers is "what did that cost" — and somebody checking it needs to
 * see the hours the figure came from beside the figure itself.
 *
 * Contribution is last and is the only column carrying a judgement: below zero
 * means that person cost more than the margin they generated, which is worth
 * catching at a glance and worth NOT reading too literally — a bookkeeper
 * generates no margin at all.
 */
export default function CostScreen({
  report,
  periods,
  selectedPeriodId,
  selectedStatus,
  from,
  to,
  canRun,
}: {
  report: CostReport
  periods: PayPeriod[]
  selectedPeriodId: number | null
  selectedStatus: 'open' | 'locked' | null
  from: string
  to: string
  canRun: boolean
}) {
  const [opening, setOpening] = useState(false)
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

  function go(changes: Record<string, string | null>) {
    const next = new URLSearchParams()
    const merged = { from, to, period: selectedPeriodId ? String(selectedPeriodId) : null, ...changes }
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v)
    router.push(`/staff/cost?${next.toString()}`)
  }

  const locked = selectedStatus === 'locked'
  const selected = periods.find((p) => p.id === selectedPeriodId)

  const columns: Column<CostLine>[] = [
    {
      key: 'name',
      header: 'Person',
      sortable: true,
      sortValue: (l) => l.userName,
      cell: (l) => (
        <div>
          <div className="font-medium text-ink">{l.userName}</div>
          {l.employeeNumber && <div className="text-xs text-muted">{l.employeeNumber}</div>}
        </div>
      ),
    },
    {
      key: 'hours',
      header: 'Hours',
      numeric: true,
      sortable: true,
      sortValue: (l) => l.ordinaryHours + l.overtimeHours + l.premiumHours,
      cell: (l) => (
        <div className="text-right">
          <div className="numeric text-ink">
            {(l.ordinaryHours + l.overtimeHours + l.premiumHours).toFixed(2)}
          </div>
          {(l.overtimeHours > 0 || l.premiumHours > 0) && (
            <div className="text-xs text-muted">
              {l.overtimeHours > 0 && `${l.overtimeHours} OT`}
              {l.overtimeHours > 0 && l.premiumHours > 0 && ' · '}
              {l.premiumHours > 0 && `${l.premiumHours} Sun`}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'leave',
      header: 'Leave',
      numeric: true,
      sortable: true,
      sortValue: (l) => l.leaveDays,
      cell: (l) =>
        l.leaveDays > 0 ? (
          <span className="numeric text-ink-2">{l.leaveDays}d</span>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: 'wages',
      header: 'Wages',
      numeric: true,
      sortable: true,
      sortValue: (l) => (l.totalCost ?? 0) - (l.commission ?? 0),
      cell: (l) =>
        l.noRateOnFile ? (
          // Deliberately not zero — that would read as free labour.
          <Badge tone="warning">No rate</Badge>
        ) : (
          <span className="numeric text-ink">
            {formatMoney((l.totalCost ?? 0) - (l.commission ?? 0))}
          </span>
        ),
    },
    {
      key: 'commission',
      header: 'Commission',
      numeric: true,
      sortable: true,
      sortValue: (l) => l.commission ?? 0,
      cell: (l) =>
        l.commission ? (
          <span className="numeric text-ink-2">{formatMoney(l.commission)}</span>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: 'total',
      header: 'Total cost',
      numeric: true,
      sortable: true,
      sortValue: (l) => l.totalCost ?? 0,
      cell: (l) =>
        l.totalCost === null ? (
          <span className="text-faint">—</span>
        ) : (
          <span className="numeric font-medium text-ink">{formatMoney(l.totalCost)}</span>
        ),
    },
    {
      key: 'profit',
      header: 'GP generated',
      numeric: true,
      sortable: true,
      sortValue: (l) => l.grossProfit,
      cell: (l) =>
        l.grossProfit !== 0 ? (
          <span className="numeric text-ink-2">{formatMoney(l.grossProfit)}</span>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: 'contribution',
      header: 'Contribution',
      numeric: true,
      sortable: true,
      sortValue: (l) => l.contribution ?? 0,
      cell: (l) => {
        if (l.contribution === null) return <span className="text-faint">—</span>
        // Only flagged where they actually generated margin. A bookkeeper
        // generates none and is not therefore a loss.
        if (l.grossProfit === 0) {
          return <span className="numeric text-muted">{formatMoney(l.contribution)}</span>
        }
        return l.contribution < 0 ? (
          <Badge tone="danger">{formatMoney(l.contribution)}</Badge>
        ) : (
          <span className="numeric text-success">{formatMoney(l.contribution)}</span>
        )
      },
    },
  ]

  return (
    <>
      <TableToolbar
        actions={
          /* Pay rules sits OUTSIDE the `canRun` branch below, because it is not
             a period action: the multipliers are what every figure on this
             screen is computed from, and somebody who cannot open or lock a
             period can still be the person who notices an overtime rate looks
             wrong. Ghost, so the period buttons keep the emphasis. */
          <div className="flex items-center gap-2">
            <ButtonLink href="/staff/pay-rules" variant="ghost">
              <Icons.Percent size={15} />
              Pay rules
            </ButtonLink>
            {canRun && (
              <>
                {selected && !locked && (
                <>
                  <Button
                    variant="secondary"
                    disabled={pending}
                    onClick={() => run(() => calculatePeriodAction(selected.id))}
                  >
                    <Icons.Calculator size={15} />
                    Calculate
                  </Button>
                  <Button
                    variant="primary"
                    disabled={pending || !selected.calculatedAt}
                    title={selected.calculatedAt ? 'Freeze these figures' : 'Calculate it first'}
                    onClick={() => run(() => lockPeriodAction(selected.id))}
                  >
                    <Icons.Lock size={15} />
                    Lock
                  </Button>
                </>
              )}
              {locked && selected && (
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => run(() => unlockPeriodAction(selected.id))}
                >
                  <Icons.Reverse size={15} />
                  Reopen
                </Button>
              )}
                <Button variant="secondary" onClick={() => setOpening(true)}>
                  <Icons.Plus size={15} />
                  Open a period
                </Button>
              </>
            )}
          </div>
        }
      >
        {periods.length > 0 && (
          <Field label="" className="min-w-[15rem]">
            <Select
              aria-label="Pay period"
              value={selectedPeriodId ? String(selectedPeriodId) : ''}
              onChange={(e) => go({ period: e.target.value || null })}
            >
              <option value="">Any dates</option>
              {periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.periodStart} to {p.periodEnd}
                  {p.status === 'locked' ? ' (locked)' : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {!selectedPeriodId && (
          <>
            <Field label="" className="min-w-[9rem]">
              <Input type="date" value={from} onChange={(e) => go({ from: e.target.value })} />
            </Field>
            <Field label="" className="min-w-[9rem]">
              <Input type="date" value={to} onChange={(e) => go({ to: e.target.value })} />
            </Field>
          </>
        )}
      </TableToolbar>

      {locked && selected && (
        <Callout tone="success" title="These figures are frozen.">
          Locked{selected.lockedByName ? ` by ${selected.lockedByName}` : ''}. Correcting hours
          now lands in the next open period rather than restating what was paid.
        </Callout>
      )}

      {selected && !locked && !selected.calculatedAt && (
        <Callout tone="neutral" title="Not calculated yet">
          Press Calculate to work out what this period cost. You can recalculate as often as you
          like until it is locked.
        </Callout>
      )}

      <StatStrip>
        <StatTile
          label="Total cost"
          value={formatMoney(report.totalCost ?? 0)}
          hint="Wages, leave and commission"
          icon={<Icons.Coins size={16} />}
        />
        <StatTile
          label="GP generated"
          value={formatMoney(report.totalProfit)}
          hint="On lines attributed to a person"
          icon={<Icons.BarChart size={16} />}
        />
        <StatTile
          label="Contribution"
          value={formatMoney(report.totalProfit - (report.totalCost ?? 0))}
          tone={report.totalProfit - (report.totalCost ?? 0) < 0 ? 'warning' : 'default'}
          hint="Margin less what staff cost"
          icon={<Icons.LineChart size={16} />}
        />
        <StatTile
          label="People"
          value={String(report.lines.length)}
          icon={<Icons.Users size={16} />}
        />
      </StatStrip>

      <Card>
        <CardHeader
          title="What each person cost"
          description={
            locked
              ? 'As frozen when the period was locked, at the rates in force then.'
              : 'Computed live — correcting hours or a rate changes these figures.'
          }
        />
        <DataTable
          columns={columns}
          rows={report.lines}
          getRowKey={(l) => l.userId}
          empty={{
            title: 'Nobody worked in this period',
            hint: 'Try different dates, or check that people are clocking in.',
            icon: <Icons.Users size={28} strokeWidth={1.75} />,
          }}
        />
      </Card>

      {/* The distinction 047 exists for. A store that means one and reads the
          other gets a wrong answer, so both are named rather than one picked. */}
      <Callout tone="neutral" title="Two ways to read “what they brought in”">
        <strong>GP generated</strong> is margin on lines attributed to that person — who SOLD it,
        which is what commission pays on. Sales they merely rang up at the till are not counted
        here. Somebody with no attributed lines shows no margin, which for a bookkeeper or a
        packer is the right answer rather than a poor one.
      </Callout>

      {opening && <PeriodModal onClose={() => setOpening(false)} />}
    </>
  )
}

function PeriodModal({ onClose }: { onClose: () => void }) {
  // Defaults to last month, which is what anybody opening this is about to pay.
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const last = new Date(now.getFullYear(), now.getMonth(), 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

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
      const result = await createPeriodAction(periodStart, periodEnd, note)
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
      title="Open a pay period"
      description="Every day belongs to exactly one period, so they cannot overlap."
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
        {error && <Callout tone="danger">{error}</Callout>}

        <div className="grid gap-4 sm:grid-cols-2">
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
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="March payroll"
          />
        </Field>
      </div>
    </Modal>
  )
}
