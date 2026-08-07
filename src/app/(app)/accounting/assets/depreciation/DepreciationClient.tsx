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
import { monthKey } from '@/lib/assetModel'
import {
  proposeDepreciationAction,
  postDepreciationAction,
  cancelDepreciationAction,
  excludeDepreciationItemAction,
} from '../actions'

type Draft = {
  id: number
  periodMonth: string
  totalAmount: number
  assetCount: number
}

type Item = {
  id: number
  assetId: number
  assetCode: string
  assetName: string
  cost: number
  residualValue: number
  lifeMonths: number
  openingAccumulated: number
  amount: number
  status: 'pending' | 'posted' | 'skipped'
  skipReason: string | null
  closingBookValue: number
}

export function DepreciationClient({
  draft,
  nextPeriod,
  items,
}: {
  draft: Draft | null
  nextPeriod: string
  items: Item[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [period, setPeriod] = useState(monthKey(nextPeriod))

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
          title="Work out a month"
          description="Shows what each asset would depreciate. Nothing is posted until you review it."
        />
        <CardBody>
          <Field
            label="Month to charge"
            hint="Depreciation is charged monthly, dated the last day of the month."
          >
            <Input
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="max-w-48"
            />
          </Field>
        </CardBody>
        <CardFooter>
          <div className="flex w-full justify-end">
            <Button
              disabled={pending || !period}
              onClick={() => run(() => proposeDepreciationAction(`${period}-01`))}
            >
              <Icons.Clock size={15} />
              Work out the depreciation
            </Button>
          </div>
        </CardFooter>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title={`Review ${monthKey(draft.periodMonth)} before charging`}
        description="Nothing has been posted. Check the figures, then charge them."
        action={
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => run(() => cancelDepreciationAction(draft.id))}
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
                ? `${skipped.length} asset${skipped.length === 1 ? ' was' : 's were'} considered and skipped — see below for why.`
                : 'There are no assets in use for this month.'}
            </p>
          </div>
        </CardBody>
      ) : (
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH}>Asset</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Cost</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Already written off</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>This month</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Book value after</th>
                <th className={`${TABLE_TH} w-24`} />
              </tr>
            </thead>
            <tbody>
              {willCharge.map((i) => (
                <tr key={i.id} className={TABLE_ROW}>
                  <td className={TABLE_TD}>
                    <span className="text-ink">{i.assetName}</span>
                    <span className="mt-0.5 block text-xs text-muted">
                      {i.assetCode} · {i.lifeMonths} months
                      {i.residualValue > 0 ? ` · ${formatMoney(i.residualValue)} residual` : ''}
                    </span>
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(i.cost)}</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-muted`}>
                    {formatMoney(i.openingAccumulated)}
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    <span className="font-medium text-ink">{formatMoney(i.amount)}</span>
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-muted`}>
                    {formatMoney(i.closingBookValue)}
                  </td>
                  <td className={`${TABLE_TD} text-right`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        const reason = window.prompt(
                          `Why is ${i.assetName} being excluded from this run?`,
                        )
                        if (reason?.trim()) {
                          run(() => excludeDepreciationItemAction(i.id, reason.trim()))
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
              {skipped.length} asset{skipped.length === 1 ? '' : 's'} skipped — why
            </summary>
            <ul className="mt-2 divide-y divide-border">
              {skipped.map((i) => (
                <li key={i.id} className="flex items-center justify-between py-1.5 text-sm">
                  <span className="text-ink-2">{i.assetName}</span>
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
              {willCharge.length} asset{willCharge.length === 1 ? '' : 's'} · total{' '}
            </span>
            <span className="numeric font-semibold text-ink">
              {formatMoney(willCharge.reduce((sum, i) => sum + i.amount, 0))}
            </span>
          </div>
          <Button
            disabled={pending || willCharge.length === 0}
            onClick={() => run(() => postDepreciationAction(draft.id))}
          >
            <Icons.Check size={15} />
            Charge {monthKey(draft.periodMonth)}
          </Button>
        </div>
      </CardFooter>
    </Card>
  )
}
