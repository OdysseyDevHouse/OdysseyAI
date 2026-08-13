'use client'

import { Fragment, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  ButtonLink,
  Card,
  CardFooter,
  CardHeader,
  CurrencyInput,
  Field,
  Icons,
  Modal,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_TD_INPUT,
  TABLE_ROW,
  TABLE_NUMERIC,
  TABLE_TOTAL_ROW,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { spreadAnnual } from '@/lib/glModel'
import type { BudgetGrid as Grid, BudgetGridRow } from '@/lib/site/budgets'
import { saveBudgetsAction, copyPriorYearAction, copyActualsAction } from './actions'

/**
 * The budget grid: accounts down, months across, every cell editable.
 *
 * Only CHANGED cells are sent on save — a fifty-account grid is six hundred
 * cells, and posting them all would turn one edited rent figure into six
 * hundred writes and an activity entry claiming somebody re-budgeted the
 * whole year.
 *
 * Cells hold live inputs, which DataTable cannot express, so the table is
 * hand-built wearing the shared skin — the documented exception.
 */

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function BudgetGrid({ grid, currentYear }: { grid: Grid; currentYear: number }) {
  const [edits, setEdits] = useState<Record<string, number>>({})
  const [spreading, setSpreading] = useState<BudgetGridRow | null>(null)
  const [annual, setAnnual] = useState<number>(0)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  const cellKey = (accountId: number, monthIndex: number) => `${accountId}:${monthIndex}`
  const valueOf = (row: BudgetGridRow, i: number) =>
    edits[cellKey(row.accountId, i)] ?? row.months[i]

  const dirtyCount = Object.keys(edits).length

  const groups = useMemo(() => {
    const out = new Map<string, BudgetGridRow[]>()
    for (const row of grid.rows) {
      const list = out.get(row.subtypeLabel) ?? []
      list.push(row)
      out.set(row.subtypeLabel, list)
    }
    return [...out.entries()]
  }, [grid.rows])

  function setCell(row: BudgetGridRow, i: number, value: number) {
    const key = cellKey(row.accountId, i)
    setEdits((prev) => {
      // A cell typed back to its stored figure is no longer an edit.
      if (value === row.months[i]) {
        const { [key]: _gone, ...rest } = prev
        return rest
      }
      return { ...prev, [key]: value }
    })
  }

  function save() {
    const entries = Object.entries(edits).map(([key, amount]) => {
      const [accountId, monthIndex] = key.split(':').map(Number)
      return {
        accountId,
        periodMonth: `${grid.year}-${String(monthIndex + 1).padStart(2, '0')}`,
        amount,
      }
    })
    startTransition(async () => {
      const result = await saveBudgetsAction(entries)
      if (result.ok) {
        toast.success(result.message)
        setEdits({})
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

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

  const rowTotal = (row: BudgetGridRow) =>
    MONTH_LABELS.reduce((sum, _m, i) => sum + valueOf(row, i), 0)

  return (
    <Card>
      <CardHeader
        title={`Budget for ${grid.year}`}
        description="Positive figures throughout — the expected amount of the thing each account names."
        action={
          <div className="flex items-center gap-2">
            <ButtonLink variant="ghost" size="sm" href={`/accounting/budgets?year=${grid.year - 1}`}>
              <Icons.ChevronLeft size={15} />
              {grid.year - 1}
            </ButtonLink>
            {grid.year < currentYear + 5 && (
              <ButtonLink variant="ghost" size="sm" href={`/accounting/budgets?year=${grid.year + 1}`}>
                {grid.year + 1}
                <Icons.ChevronRight size={15} />
              </ButtonLink>
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => run(() => copyPriorYearAction(grid.year))}
            >
              <Icons.Copy size={15} />
              Copy {grid.year - 1}&rsquo;s budget
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => run(() => copyActualsAction(grid.year, grid.year - 1))}
            >
              <Icons.Download size={15} />
              Write in {grid.year - 1}&rsquo;s actuals
            </Button>
          </div>
        }
      />

      <div className="overflow-x-auto">
        <table className={TABLE}>
          <thead>
            <tr className={TABLE_HEAD_ROW}>
              {/* Sticky, so the account names survive the horizontal scroll
                  a 14-column grid forces on a laptop. */}
              <th className={`${TABLE_TH} sticky left-0 z-10 bg-surface`}>Account</th>
              {MONTH_LABELS.map((m) => (
                <th key={m} className={`${TABLE_TH} ${TABLE_NUMERIC}`}>{m}</th>
              ))}
              <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Year</th>
              <th className={`${TABLE_TH} w-px`} />
            </tr>
          </thead>
          <tbody>
            {groups.map(([label, rows]) => (
              <Fragment key={label}>
                <tr className="bg-surface-2">
                  <td className={`${TABLE_TD} sticky left-0 bg-surface-2 font-medium text-ink`} colSpan={15}>
                    {label}
                  </td>
                </tr>
                {rows.map((row) => (
                  <tr key={row.accountId} className={TABLE_ROW}>
                    <td className={`${TABLE_TD} sticky left-0 bg-surface`}>
                      <span className="text-ink-2">{row.name}</span>
                      <span className="ml-2 text-xs text-muted">{row.accountCode}</span>
                    </td>
                    {MONTH_LABELS.map((_m, i) => (
                      <td key={i} className={TABLE_TD_INPUT}>
                        <CurrencyInput
                          aria-label={`${row.name} ${MONTH_LABELS[i]}`}
                          className="w-24 text-right"
                          value={valueOf(row, i) || ''}
                          onChange={(e) =>
                            setCell(row, i, Number(String(e.target.value).replace(',', '.')) || 0)
                          }
                        />
                      </td>
                    ))}
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-ink`}>
                      {formatMoney(rowTotal(row))}
                    </td>
                    <td className={`${TABLE_TD} text-right`}>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Spread an annual amount across ${row.name}`}
                        onClick={() => {
                          setAnnual(rowTotal(row))
                          setSpreading(row)
                        }}
                      >
                        <Icons.Wand size={15} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
            <tr className={TABLE_TOTAL_ROW}>
              <td className={`${TABLE_TD} sticky left-0 bg-surface font-semibold`}>Budgeted result</td>
              {grid.monthTotals.map((t, i) => (
                <td key={i} className={`${TABLE_TD} ${TABLE_NUMERIC} font-medium`}>
                  {formatMoney(t)}
                </td>
              ))}
              <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>
                {formatMoney(grid.monthTotals.reduce((s, t) => s + t, 0))}
              </td>
              <td className={TABLE_TD} />
            </tr>
          </tbody>
        </table>
      </div>

      <CardFooter>
        <div className="flex w-full items-center justify-between">
          <span className="text-sm text-muted">
            {dirtyCount === 0
              ? 'Saved figures compare against actuals on the profit and loss.'
              : `${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}. The month totals above already include them.`}
          </span>
          <Button disabled={pending || dirtyCount === 0} onClick={save}>
            <Icons.Save size={15} />
            Save changes
          </Button>
        </div>
      </CardFooter>

      <Modal
        open={spreading !== null}
        onClose={() => setSpreading(null)}
        title={spreading ? `Spread across ${spreading.name}` : ''}
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            An annual figure divided over the twelve months, cents landing on December.
            Nothing is saved until you save the grid.
          </p>
          <Field label="Annual amount">
            <CurrencyInput
              value={annual || ''}
              onChange={(e) => setAnnual(Number(String(e.target.value).replace(',', '.')) || 0)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSpreading(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const row = spreading
                if (!row) return
                spreadAnnual(annual).forEach((amount, i) => setCell(row, i, amount))
                setSpreading(null)
              }}
            >
              Spread it
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  )
}
