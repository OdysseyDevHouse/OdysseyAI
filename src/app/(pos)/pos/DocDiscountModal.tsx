'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  Callout,
  Icons,
  Modal,
  NumPad,
  NumPadDisplay,
  SegmentedControl,
  numPadValue,
} from '@/components/ui'
import { formatMoney, formatQty, round } from '@/lib/decimals'
import type { BasketLine } from '@/lib/basket'
import {
  docDiscountShares,
  totalsFor,
  type DocDiscount,
  type specialsFor,
} from './saleSelectors'

/**
 * A discount on the whole sale.
 *
 * The amount is spread onto the lines pro-rata (documentMath rule 3), so VAT
 * stays exact per line and every report reads the reduction where it happened.
 * The preview shows the stacked outcome — a doc discount on top of a special
 * is explicit stacking the cashier can SEE, never a silent compound.
 *
 * A discount whose per-line effect stays inside every line's own ceiling needs
 * no special right — it is just a discount the cashier could have keyed line
 * by line. Past any line's cap, the supervisor pad takes over.
 */
export default function DocDiscountModal({
  open,
  lines,
  lineSpecials,
  current,
  canOverrideDiscount,
  onApply,
  onSupervisor,
  onClose,
}: {
  open: boolean
  lines: BasketLine[]
  lineSpecials: ReturnType<typeof specialsFor>
  /** The discount already on the sale, so reopening shows it. */
  current: DocDiscount
  canOverrideDiscount: boolean
  onApply: (discount: DocDiscount) => void
  /** Chain to the override pad; the shell applies on approval. */
  onSupervisor: (request: { discount: DocDiscount; actionLabel: string; amount: number }) => void
  onClose: () => void
}) {
  const [kind, setKind] = useState<'percent' | 'amount'>('percent')
  const [entry, setEntry] = useState('')

  useEffect(() => {
    if (!open) return
    setKind(current?.kind ?? 'percent')
    setEntry(current ? String(current.value) : '')
  }, [open, current])

  const value = numPadValue(entry)
  const proposed: DocDiscount = value > 0 ? { kind, value } : null

  const preview = useMemo(() => {
    const before = totalsFor(lines, lineSpecials).doc.totalIncl
    const shares = docDiscountShares(lines, lineSpecials, proposed)
    const after = totalsFor(lines, lineSpecials, shares).doc.totalIncl
    const saving = round(before - after, 2)

    /* Whether any line's TOTAL discount (its own plus its share) breaches that
       line's ceiling — the same effective-percentage test checkPricing runs. */
    let breaches: string | null = null
    for (const [index, line] of lines.entries()) {
      const share = shares[index]
      if (share <= 0) continue
      const gross = round(line.qty * line.unitPriceIncl, 2)
      if (gross <= 0) continue
      const own = round(gross * ((line.discountPct ?? 0) / 100), 2)
      const pct = ((own + share) / gross) * 100
      if (pct > line.maxDiscountPct + 0.01) {
        breaches = `${line.description} allows ${formatQty(line.maxDiscountPct)}% — this puts it at ${pct.toFixed(1)}%.`
        break
      }
    }
    return { before, after, saving, breaches }
  }, [lines, lineSpecials, proposed])

  const needsSupervisor = proposed !== null && preview.breaches !== null && !canOverrideDiscount

  function apply() {
    if (!proposed) return
    const label =
      kind === 'percent'
        ? `${formatQty(value)}% off the whole sale`
        : `${formatMoney(preview.saving)} off the whole sale`
    if (needsSupervisor) {
      onSupervisor({ discount: proposed, actionLabel: label, amount: preview.saving })
      return
    }
    onApply(proposed)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Discount the whole sale"
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="touch" onClick={onClose}>
            Cancel
          </Button>
          {current && (
            <Button
              variant="danger-ghost"
              size="touch"
              onClick={() => {
                onApply(null)
                onClose()
              }}
            >
              Remove it
            </Button>
          )}
          <Button
            variant={needsSupervisor ? 'warning' : 'primary'}
            size="touch-lg"
            className="flex-1 justify-center"
            disabled={proposed === null || preview.saving <= 0}
            onClick={apply}
          >
            <Icons.Check size={20} />
            {needsSupervisor ? 'Ask a supervisor' : 'Apply'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <SegmentedControl
          value={kind}
          onChange={(v) => setKind(v === 'amount' ? 'amount' : 'percent')}
          options={[
            { value: 'percent', label: 'Percent' },
            { value: 'amount', label: 'Rand' },
          ]}
        />

        <NumPadDisplay
          label={kind === 'percent' ? 'Percent off the sale' : 'Rand off the sale'}
          value={entry}
          tone={needsSupervisor ? 'danger' : 'default'}
        />
        <NumPad value={entry} onChange={setEntry} />

        {proposed && preview.saving > 0 && (
          <div className="rounded-card border border-border bg-surface-2 px-4 py-2.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">Total</span>
              <span className="numeric text-ink">
                {formatMoney(preview.before)} → <b>{formatMoney(preview.after)}</b>
              </span>
            </div>
            <div className="mt-1 flex justify-between">
              <span className="text-muted">Saving</span>
              <span className="numeric font-semibold text-success-ink">
                {formatMoney(preview.saving)}
              </span>
            </div>
          </div>
        )}

        {needsSupervisor && (
          <Callout tone="warning">
            {preview.breaches} A manager can approve it.
          </Callout>
        )}
      </div>
    </Modal>
  )
}
