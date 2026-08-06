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
  Badge,
  Icons,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
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
          <div className="rounded-control bg-surface-2 px-4 py-6 text-center">
            <p className="text-sm font-medium text-ink">Nothing would be charged</p>
            <p className="mt-1 text-sm text-muted">
              {skipped.length > 0
                ? `${skipped.length} account${skipped.length === 1 ? ' was' : 's were'} considered and skipped — see below for why.`
                : 'No account has interest enabled, or nothing is overdue past its grace period.'}
            </p>
          </div>
        </CardBody>
      ) : (
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH}>Account</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Overdue</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Rate</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Days</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Interest</th>
                <th className={`${TABLE_TH} w-24`} />
              </tr>
            </thead>
            <tbody>
              {willCharge.map((i) => (
                <tr key={i.id} className={TABLE_ROW}>
                  <td className={TABLE_TD}>
                    <span className="text-ink">{i.customerName}</span>
                    <span className="ml-2 text-xs text-muted">{i.customerCode}</span>
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(i.baseAmount)}</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{i.ratePct.toFixed(2)}%</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{i.days}</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    <span className="font-medium text-ink">{formatMoney(i.amount)}</span>
                  </td>
                  <td className={`${TABLE_TD} text-right`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        const reason = window.prompt(
                          `Why is ${i.customerName} being excluded from this run?`,
                        )
                        if (reason?.trim()) {
                          run(() => excludeInterestItemAction(i.id, reason.trim()))
                        }
                      }}
                    >
                      Exclude
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
            <span className="numeric font-semibold text-ink">
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
    </Card>
  )
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
