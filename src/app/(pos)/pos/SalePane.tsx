'use client'

import { Badge, Button, Icons, EmptyState, TouchRow, CategoryTile } from '@/components/ui'
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
  onPark: () => void
  onShowSaved: () => void
  /** How many baskets are parked, for the badge. */
  savedCount: number
  busy: boolean
}) {
  const empty = lines.length === 0

  return (
    <section className="flex w-[440px] shrink-0 flex-col border-r border-border bg-surface">
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
            title="No items yet"
            hint="Scan a barcode, or tap a product to start the sale."
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
        <Button
          variant="success"
          size="touch-lg"
          className="flex-1 justify-between"
          disabled={empty || busy}
          onClick={onPay}
        >
          <span>{busy ? 'Working…' : 'Pay'}</span>
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
