'use client'

import {
  Badge,
  Button,
  Icons,
  EmptyState,
  TouchRow,
  CategoryTile,
  SegmentedControl,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { effectiveDiscountPct } from '@/lib/specialsEngine'
import type { BasketLine } from '@/lib/basket'
import { SaleLineCard } from './SaleLineCard'
import type { SaleTotals, specialsFor } from './saleSelectors'

/**
 * The left column: who is buying, what they are buying, what it costs, and the
 * two keys that end the sale.
 *
 * Top to bottom in the order a cashier's eye travels — customer, lines, total,
 * pay. The total sits directly above the Pay button carrying the same figure,
 * because the moment a cashier reads a total is the moment before they take money
 * for it, and making them look elsewhere to find one or the other is what puts a
 * wrong amount in a drawer.
 */
export function SalePane({
  lines,
  totals,
  lineSpecials,
  selectedKey,
  customerLabel,
  onSelect,
  onStep,
  onEdit,
  onRemove,
  onCustomer,
  onClear,
  onPay,
  returning,
  onToggleReturning,
  onPark,
  onShowSaved,
  savedCount,
  busy,
}: {
  lines: BasketLine[]
  totals: SaleTotals
  lineSpecials: ReturnType<typeof specialsFor>
  selectedKey: string | null
  /** The attached account, or a typed walk-in name, or null for nobody. */
  customerLabel: string | null
  onSelect: (key: string) => void
  onStep: (key: string, delta: number) => void
  onEdit: (line: BasketLine) => void
  onRemove: (key: string) => void
  onCustomer: () => void
  onClear: () => void
  onPay: () => void
  /** True when this basket is a return rather than a sale. */
  returning: boolean
  /** Switches the mode. CLEARS the basket — see the reducer's SET_RETURNING. */
  onToggleReturning: (next: boolean) => void
  onPark: () => void
  onShowSaved: () => void
  /** How many baskets are parked, for the badge. */
  savedCount: number
  busy: boolean
}) {
  const empty = lines.length === 0

  return (
    <section className="flex w-[440px] shrink-0 flex-col border-r border-border bg-surface">
      {/*
        ── SALE OR RETURN ────────────────────────────────────────────────────
        At the TOP of the pane, above everything, because it changes the meaning of every
        figure below it. A cashier who thinks they are selling while taking a return hands
        over goods AND money, and the only thing standing in the way is this being
        impossible to miss.

        A SegmentedControl rather than a toggle or a checkbox: two named states, both
        visible, with the active one filled — so the answer to "which am I doing" is
        readable at a glance from arm's length rather than inferred from a switch position.
      */}
      <div className="border-b border-border p-3 pb-2">
        <SegmentedControl
          value={returning ? 'return' : 'sale'}
          onChange={(next) => onToggleReturning(next === 'return')}
          options={[
            { value: 'sale', label: 'Sale' },
            { value: 'return', label: 'Return' },
          ]}
        />
        {/* Said only in return mode, and it says the thing a cashier needs to know rather
            than the thing the code is doing: no receipt is checked, so the credit is at
            today's shelf price. That is inherent to a till return, not a defect — but a
            manager reviewing it later should not be the first to discover it. */}
        {returning && (
          <p className="mt-2 text-xs text-muted">
            No receipt is checked here — the credit is at today’s price. For a specific
            invoice, use Returns in the back office.
          </p>
        )}
      </div>

      {/* ── Customer ─────────────────────────────────────────────────────── */}
      <div className="border-b border-border p-3">
        <TouchRow
          tone={customerLabel ? 'active' : 'default'}
          icon={<CategoryTile icon={<Icons.UserPlus size={20} />} tone="indigo" size="lg" />}
          title={customerLabel ?? 'Attach customer'}
          subtitle={customerLabel ? 'Tap to change' : 'For account sales and loyalty'}
          onClick={onCustomer}
        />
      </div>

      {/* ── Lines ────────────────────────────────────────────────────────── */}
      {empty ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            icon={<Icons.ShoppingCart size={28} />}
            title={returning ? 'Nothing to return yet' : 'No items yet'}
            hint={
              returning
                ? 'Scan or tap what the customer is bringing back.'
                : 'Scan a barcode, or tap a product to start the sale.'
            }
          />
        </div>
      ) : (
        <ul className="till-pane flex-1 overflow-y-auto py-1">
          {lines.map((line, index) => (
            <SaleLineCard
              key={line.key}
              line={line}
              lineTotal={totals.perLine[index]?.lineTotalIncl ?? 0}
              effectiveDiscountPct={effectiveDiscountPct(line.discountPct, lineSpecials[index])}
              specialName={lineSpecials[index]?.name ?? null}
              selected={selectedKey === line.key}
              onSelect={() => onSelect(line.key)}
              onStep={(delta) => onStep(line.key, delta)}
              onEdit={() => onEdit(line)}
              onRemove={() => onRemove(line.key)}
            />
          ))}
        </ul>
      )}

      {/* ── Totals ───────────────────────────────────────────────────────── */}
      {/* No subtotal row. The Pay button carries the total, so a subtotal above it
          is a second big number next to the only one that matters — and on a till
          two large figures side by side is how the wrong one gets read out. */}
      <div className="border-t border-border px-3 pb-2 pt-3 text-sm">
        {totals.doc.discountTotal > 0 && (
          <Row label="Discount">−{formatMoney(totals.doc.discountTotal)}</Row>
        )}
        <Row label="VAT included">{formatMoney(totals.doc.vatTotal)}</Row>
      </div>

      {/* ── Park and recall ──────────────────────────────────────────────
          Above Close/Pay, not beside them: these two are used a few times a day
          and those two are used on every sale, so they must not share a row and
          risk being hit instead. */}
      <div className="flex items-stretch gap-2 px-3 pt-1">
        <Button
          variant="ghost"
          size="touch"
          className="flex-1"
          disabled={empty || busy}
          onClick={onPark}
        >
          <Icons.Save size={18} />
          Save
        </Button>
        <Button variant="ghost" size="touch" className="flex-1" disabled={busy} onClick={onShowSaved}>
          <Icons.Archive size={18} />
          Saved
          {savedCount > 0 && <Badge tone="brand">{savedCount}</Badge>}
        </Button>
      </div>

      {/* ── Close and Pay ────────────────────────────────────────────────── */}
      {/* Side by side, always in the same place: the way OUT and the way to
          FINISH are the two things a cashier reaches for without looking, and a
          Pay button that moves as the basket grows is a Pay button that gets
          missed. touch-lg because these are the only two keys that end a sale. */}
      <div className="flex items-stretch gap-2 px-3 pb-4 pt-1">
        <Button
          variant={empty ? 'ghost' : 'danger'}
          size="touch-lg"
          disabled={empty || busy}
          onClick={onClear}
        >
          <Icons.Close size={20} />
          Close
        </Button>
        {/* `warning` on a return, not `success`.
            Green means "money coming in" everywhere else on this screen, and a green
            button that pays a customer OUT is the one piece of colour on the till that
            could actively mislead. Not `danger` either — a return is a normal, correct
            thing to do, and painting it as a destructive act would make cashiers
            hesitate over something they are supposed to do cheerfully. */}
        <Button
          variant={returning ? 'warning' : 'success'}
          size="touch-lg"
          className="flex-1 justify-between"
          disabled={empty || busy}
          onClick={onPay}
        >
          <span>{busy ? 'Working…' : returning ? 'Refund' : 'Pay'}</span>
          <span className="numeric">{formatMoney(totals.doc.totalIncl)}</span>
        </Button>
      </div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between py-0.5 text-muted">
      <span>{label}</span>
      <span className="numeric">{children}</span>
    </div>
  )
}
