'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  Callout,
  Field,
  Icons,
  Input,
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
  online = true,
  appliedCode = null,
  codeBusy = false,
  onCode,
  onClearCode,
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
  /** Codes need the server — the tab says so when the line is down. */
  online?: boolean
  /** A promo code already on the sale. Exclusive with the manual discount. */
  appliedCode?: { code: string; discountIncl: number } | null
  codeBusy?: boolean
  /** Validates and applies a typed code. Absent hides the Code tab. */
  onCode?: (raw: string) => void
  onClearCode?: () => void
  onApply: (discount: DocDiscount) => void
  /** Chain to the override pad; the shell applies on approval. */
  onSupervisor: (request: { discount: DocDiscount; actionLabel: string; amount: number }) => void
  onClose: () => void
}) {
  const [kind, setKind] = useState<'percent' | 'amount' | 'code'>('percent')
  const [entry, setEntry] = useState('')
  const [codeEntry, setCodeEntry] = useState('')

  useEffect(() => {
    if (!open) return
    setKind(appliedCode ? 'code' : (current?.kind ?? 'percent'))
    setEntry(current ? String(current.value) : '')
    setCodeEntry('')
  }, [open, current, appliedCode])

  const value = numPadValue(entry)
  const proposed: DocDiscount =
    kind !== 'code' && value > 0 ? { kind, value } : null

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
    if (!proposed || kind === 'code') return
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
      /* The screen's crest, in the kit's own slot — so the title and the close
         button keep the positions every other dialog in the app uses. */
      titleMedia={
        <span className="flex h-12 w-12 items-center justify-center rounded-card bg-brand-soft text-brand">
          <Icons.Tag size={24} />
        </span>
      }
      description="Apply a discount to the entire sale."
      /* `md`, not `sm`: the pad is full width here, and three touch-size tabs
         plus a Rand figure do not fit a 448px panel without the tab labels
         wrapping. */
      size="md"
      /* MEASURED on a 1366×768 till: tabs, plaque and pad come to 510px, past
         the default 60vh cap of 461. `bodyGrows` lifts it to 560, which keeps
         the whole pad on screen at rest — the state the cashier types in.

         The Total/Saving preview and the supervisor callout push past that, and
         are LEFT to scroll on purpose: both appear only after a figure is
         entered, and neither is something to type into. Scrolling to read the
         saving is fine; scrolling to reach a key is not. */
      bodyGrows
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
            {needsSupervisor ? 'Ask a supervisor' : 'Apply discount'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* Touch-size and full width — three keys a thumb picks between, not a
            toolbar filter. Each carries a glyph so the cashier meeting this
            forty times a day aims at the shape rather than reading the word;
            all three or none, per the control's own rule. */}
        <SegmentedControl
          size="touch"
          aria-label="How to discount"
          value={kind}
          onChange={(v) => setKind(v === 'amount' ? 'amount' : v === 'code' ? 'code' : 'percent')}
          options={[
            { value: 'percent', label: 'Percent', icon: <Icons.Percent size={18} /> },
            { value: 'amount', label: 'Rand', icon: <Icons.Money size={18} /> },
            ...(onCode
              ? [{ value: 'code' as const, label: 'Code', icon: <Icons.Ticket size={18} /> }]
              : []),
          ]}
        />

        {kind === 'code' ? (
          /* ── A promo code ──────────────────────────────────────────────
             One code per sale (the ledger's unique key says so); applying a
             second replaces the first. Validated server-side and SPENT
             transactionally at Pay, so the last use of a single-use code
             cannot go to two tills. */
          !online ? (
            <Callout tone="brand" title="Codes need the connection">
              A manager can give the discount instead — the Percent and Rand tabs work
              offline.
            </Callout>
          ) : appliedCode ? (
            <div className="flex items-center justify-between rounded-card border border-success/50 bg-success-soft px-4 py-2.5">
              <span className="text-sm font-semibold text-success-ink">
                {appliedCode.code} — {formatMoney(appliedCode.discountIncl)} off
              </span>
              <Button variant="danger-ghost" size="sm" onClick={onClearCode}>
                Remove
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <Field label="Promo code" hint="Scan it or type it — codes are letters and numbers.">
                <Input
                  value={codeEntry}
                  onChange={(e) => setCodeEntry(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && codeEntry.trim()) onCode?.(codeEntry)
                  }}
                  placeholder="SAVE20"
                  autoFocus
                />
              </Field>
              <Button
                variant="primary"
                disabled={codeBusy || !codeEntry.trim()}
                onClick={() => onCode?.(codeEntry)}
              >
                {codeBusy ? 'Checking…' : 'Apply the code'}
              </Button>
            </div>
          )
        ) : (
          <>
            <NumPadDisplay
              label={kind === 'percent' ? 'Percent off the sale' : 'Rand off the sale'}
              value={entry}
              /* Percent only. The app writes money with the mark LEADING —
                 formatMoney gives "R20.00" — so a trailing R here would be the
                 one place in the product that sets it after the figure. The
                 Rand tab's label already says which unit it is. */
              suffix={kind === 'percent' ? '%' : undefined}
              layout="plaque"
              tone={needsSupervisor ? 'danger' : 'default'}
            />
            <NumPad size="wide" value={entry} onChange={setEntry} />
          </>
        )}

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
