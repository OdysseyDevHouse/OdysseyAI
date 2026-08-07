'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Field,
  Input,
  CurrencyInput,
  Icons,
  Modal,
  EmptyState,
  DataTable,
  type Column,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import {
  proposeInterestRunAction,
  postInterestRunAction,
  cancelInterestRunAction,
  excludeInterestItemAction,
} from '../actions'

type Draft = {
  id: number
  asAtDate: string
  periodFrom: string
  periodTo: string
  totalAmount: number
  accountCount: number
  minimumCharge: number
}

type Item = {
  id: number
  customerId: number
  customerCode: string
  customerName: string
  baseAmount: number
  ratePct: number
  days: number
  amount: number
  status: 'pending' | 'posted' | 'skipped'
  skipReason: string | null
}

export function InterestClient({ draft, items }: { draft: Draft | null; items: Item[] }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  // Default to last month, which is what is being charged for.
  const now = new Date()
  const firstOfThis = new Date(now.getFullYear(), now.getMonth(), 1)
  const lastMonthEnd = new Date(firstOfThis.getTime() - 86_400_000)
  const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1)

  const [periodFrom, setPeriodFrom] = useState(iso(lastMonthStart))
  const [periodTo, setPeriodTo] = useState(iso(lastMonthEnd))
  const [minimumCharge, setMinimumCharge] = useState(25)

  // The exclusion dialog — replaces window.prompt, so the reason gets a real
  // field, a visible error, and the customer's name repeated back.
  const [excluding, setExcluding] = useState<Item | null>(null)
  const [excludeReason, setExcludeReason] = useState('')
  const [excludeTouched, setExcludeTouched] = useState(false)

  const excludeError =
    excludeTouched && !excludeReason.trim()
      ? 'Give a reason — it stays on the run’s record.'
      : undefined

  function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await action()
      if (result.ok) {
        toast.success(result.message ?? 'Done.')
        router.refresh()
      } else {
        toast.error(result.error ?? 'That did not work.')
      }
    })
  }

  const willCharge = items.filter((i) => i.status === 'pending')
  const skipped = items.filter((i) => i.status === 'skipped')

  const columns: Column<Item>[] = [
    {
      key: 'account',
      header: 'Account',
      cell: (i) => (
        <>
          <span className="text-ink">{i.customerName}</span>
          <span className="ml-2 text-xs text-muted">{i.customerCode}</span>
        </>
      ),
      sortValue: (i) => i.customerName,
    },
    {
      key: 'overdue',
      header: 'Overdue',
      numeric: true,
      cell: (i) => formatMoney(i.baseAmount),
      sortValue: (i) => i.baseAmount,
    },
    {
      key: 'rate',
      header: 'Rate',
      numeric: true,
      cell: (i) => `${i.ratePct.toFixed(2)}%`,
      sortValue: (i) => i.ratePct,
    },
    {
      key: 'days',
      header: 'Days',
      numeric: true,
      cell: (i) => i.days,
      sortValue: (i) => i.days,
    },
    {
      key: 'interest',
      header: 'Interest',
      numeric: true,
      cell: (i) => <span className="font-medium text-ink">{formatMoney(i.amount)}</span>,
      sortValue: (i) => i.amount,
    },
  ]

  if (!draft) {
    return (
      <Card>
        <CardHeader
          title="Propose a run"
          description="Works out what each account would be charged. Nothing is posted until you review it."
        />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Period from">
              <Input
                type="date"
                value={periodFrom}
                onChange={(e) => setPeriodFrom(e.target.value)}
              />
            </Field>
            <Field label="Period to" hint="Interest is charged on balances overdue at this date.">
              <Input type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} />
            </Field>
            <Field label="Minimum charge" hint="Below this, an account is skipped.">
              <CurrencyInput
                value={minimumCharge}
                onChange={(e) =>
                  setMinimumCharge(Number(String(e.target.value).replace(',', '.')) || 0)
                }
              />
            </Field>
          </div>
        </CardBody>
        <CardFooter>
          <div className="flex w-full justify-end">
            <Button
              disabled={pending}
              onClick={() =>
                run(() =>
                  proposeInterestRunAction({
                    periodFrom,
                    periodTo,
                    asAtDate: periodTo,
                    minimumCharge,
                  }),
                )
              }
            >
              <Icons.Percent size={15} />
              Work out the interest
            </Button>
          </div>
        </CardFooter>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title="Review before charging"
        description={`${draft.periodFrom} → ${draft.periodTo}, on balances overdue at ${draft.asAtDate}. Nothing has been posted.`}
        action={
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => run(() => cancelInterestRunAction(draft.id))}
          >
            Discard
          </Button>
        }
      />

      {willCharge.length === 0 ? (
        <CardBody>
          <EmptyState
            title="Nothing would be charged"
            hint={
              skipped.length > 0
                ? `${skipped.length} account${skipped.length === 1 ? ' was' : 's were'} considered and skipped — see below for why.`
                : 'No account has interest enabled, or nothing is overdue past its grace period.'
            }
          />
        </CardBody>
      ) : (
        <DataTable
          columns={columns}
          rows={willCharge}
          getRowKey={(i) => i.id}
          actionsOnHover
          actions={(i) => (
            <Button
              variant="danger-ghost"
              size="sm"
              iconOnly
              aria-label={`Exclude ${i.customerName} from this run`}
              disabled={pending}
              onClick={() => {
                setExcludeReason('')
                setExcludeTouched(false)
                setExcluding(i)
              }}
            >
              <Icons.Ban size={15} />
            </Button>
          )}
        />
      )}

      {skipped.length > 0 && (
        <CardBody>
          <details>
            <summary className="cursor-pointer text-sm text-muted">
              {skipped.length} account{skipped.length === 1 ? '' : 's'} skipped — why
            </summary>
            <ul className="mt-2 divide-y divide-border">
              {skipped.map((i) => (
                <li key={i.id} className="flex items-center justify-between py-1.5 text-sm">
                  <span className="text-ink-2">{i.customerName}</span>
                  <span className="text-xs text-muted">{i.skipReason}</span>
                </li>
              ))}
            </ul>
          </details>
        </CardBody>
      )}

      <CardFooter>
        <div className="flex w-full items-center justify-between">
          <div className="text-sm">
            <span className="text-muted">
              {willCharge.length} account{willCharge.length === 1 ? '' : 's'} · total{' '}
            </span>
            {/* The figure being confirmed — the loudest thing in the footer. */}
            <span className="numeric text-lg font-semibold text-ink">
              {formatMoney(willCharge.reduce((sum, i) => sum + i.amount, 0))}
            </span>
          </div>
          <Button
            disabled={pending || willCharge.length === 0}
            onClick={() => run(() => postInterestRunAction(draft.id))}
          >
            <Icons.Check size={15} />
            Charge {willCharge.length} account{willCharge.length === 1 ? '' : 's'}
          </Button>
        </div>
      </CardFooter>

      <Modal
        open={excluding !== null}
        onClose={() => setExcluding(null)}
        title="Exclude from this run"
        footer={
          <>
            <Button variant="secondary" onClick={() => setExcluding(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={pending || !excludeReason.trim()}
              onClick={() => {
                if (excluding) {
                  run(() => excludeInterestItemAction(excluding.id, excludeReason.trim()))
                }
                setExcluding(null)
              }}
            >
              Exclude
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {excluding?.customerName} will not be charged{' '}
            {excluding ? formatMoney(excluding.amount) : ''} in this run. The reason is kept
            with the run.
          </p>
          <Field label={`Why is ${excluding?.customerName ?? 'this account'} being excluded?`} error={excludeError}>
            <Input
              value={excludeReason}
              onChange={(e) => setExcludeReason(e.target.value)}
              onBlur={() => setExcludeTouched(true)}
              placeholder="e.g. Charge waived — payment arrangement agreed"
            />
          </Field>
        </div>
      </Modal>
    </Card>
  )
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
