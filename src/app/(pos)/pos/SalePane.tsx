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
  onBill,
  onDocDiscount,
  onFindReceipt,
  exchange = null,
  showParkKeys = true,
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
  /**
   * Prints the pro-forma bill for the open tab. Hospitality only, and only
   * once the tab has a parked document — undefined hides the button, which is
   * every retail till and every basket not yet on a table.
   */
  onBill?: () => void
  /** Opens the whole-sale discount dialog. Undefined leaves the row inert. */
  onDocDiscount?: () => void
  /** Opens the receipted-return flow. Shown in return mode only. */
  onFindReceipt?: () => void
  /** Exchange credit held from a return — shown as a banner until Pay. */
  exchange?: { label: string; onClear: () => void } | null
  /**
   * Whether to offer Save / Saved at all.
   *
   * OFF in hospitality. There, Close IS the save — a waiter rings up drinks and
   * walks away, and the tab parks itself under the table's name — so a separate
   * "Save" key would be a second way to do the thing Close already did, and
   * "Saved" a second floor beside the one the gate already shows.
   */
  showParkKeys?: boolean
  busy: boolean
}) {
  const empty = lines.length === 0

  /* A FLOATING CARD, not a pane sharing a border with its neighbour. The three
     columns of the till each lift off the canvas on their own — which is what
     makes the basket read as a thing in its own right rather than a strip of the
     same surface as the product grid beside it. 500px because the line cards
     carry a name, a quantity and a price on one row. */
  return (
    <section className="flex w-[500px] shrink-0 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card">
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
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <SegmentedControl
              value={returning ? 'return' : 'sale'}
              onChange={(next) => onToggleReturning(next === 'return')}
              options={[
                { value: 'sale', label: 'Sale' },
                { value: 'return', label: 'Return' },
              ]}
            />
          </div>
          {/* The pro-forma bill — the slip a waiter drops on the table before
              payment. Only rendered when the shell says this basket IS a tab. */}
          {onBill && !returning && (
            <Button variant="secondary" disabled={busy} onClick={onBill}>
              <Icons.Printer size={15} />
              Bill
            </Button>
          )}
        </div>
        {/* Said only in return mode, and it says the thing a cashier needs to know rather
            than the thing the code is doing: no receipt is checked, so the credit is at
            today's shelf price. That is inherent to a till return, not a defect — but a
            manager reviewing it later should not be the first to discover it. */}
        {returning && (
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-xs text-muted">
              No receipt is checked here — the credit is at today’s price.
            </p>
            {/* The other kind of return: with the slip, at the prices they PAID. */}
            {onFindReceipt && (
              <Button variant="secondary" size="sm" disabled={busy} onClick={onFindReceipt}>
                <Icons.Search size={14} />
                Find receipt
              </Button>
            )}
          </div>
        )}

        {/* Credit held from a receipted return, waiting for the replacement.
            Loud, because everything rung up below it is being paid with it. */}
        {!returning && exchange && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-control border border-warning/50 bg-warning-soft px-3 py-1.5">
            <span className="text-xs font-semibold text-warning-ink">{exchange.label}</span>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Drop the exchange credit"
              onClick={exchange.onClear}
            >
              <Icons.Close size={14} />
            </Button>
          </div>
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
        /* Bigger than the kit's EmptyState, on purpose. This is the largest area
           on the till and it is empty at the start of every single sale — so it
           is the shape a cashier sees more than any other, and a small grey glyph
           in the middle of 600px of nothing reads as a screen that has failed to
           load rather than one waiting for a barcode. */
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <span className="mb-5 flex h-[104px] w-[104px] items-center justify-center rounded-pill bg-brand-soft text-brand">
            <Icons.ShoppingCart size={44} />
          </span>
          <span className="text-[17px] font-bold text-ink">
            {returning ? 'Nothing to return yet' : 'No items added'}
          </span>
          <span className="mt-1 text-[13px] text-muted">
            {returning
              ? 'Scan or tap what the customer is bringing back.'
              : 'Scan or add products to get started'}
          </span>
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
      {/* BOXED, not two loose rows. Fenced off from the line list above and from
          the Pay key below, the figures read as a summary of the sale rather than
          as two more lines of it — which is what stops a cashier reading "VAT
          included" as an item somebody is buying. */}
      <div className="border-t border-border px-3 pb-2 pt-3 text-sm">
        <div className="rounded-card border border-border">
          {/* Always shown, even at zero. A discount row that appears only when a
              discount exists means the row a cashier is checking for is missing
              exactly when they want to confirm there is no discount. */}
          {/* Tappable when the till offers a whole-sale discount: the row IS
              where a cashier looks for the discount, so it is also where they
              set one. A plain row (retail permissions unchanged) when not. */}
          {onDocDiscount && !returning ? (
            <button
              type="button"
              data-kit-ok /* a full-width row-button matching the Row skin — a kit Button would break the box's rhythm */
              onClick={onDocDiscount}
              disabled={empty || busy}
              className="flex w-full items-center justify-between px-3.5 py-2 text-left hover:bg-surface-2 disabled:pointer-events-none"
            >
              <span className="flex items-center gap-1.5 text-muted">
                Sale discount
                <Icons.ChevronRight size={13} />
              </span>
              <span className="numeric text-ink-2">
                {totals.doc.discountTotal > 0
                  ? `−${formatMoney(totals.doc.discountTotal)}`
                  : formatMoney(0)}
              </span>
            </button>
          ) : (
            <Row label="Sale discount">
              {totals.doc.discountTotal > 0
                ? `−${formatMoney(totals.doc.discountTotal)}`
                : formatMoney(0)}
            </Row>
          )}
          <Row label="VAT included" divided>
            {formatMoney(totals.doc.vatTotal)}
          </Row>
        </div>
      </div>

      {/* ── Park and recall ──────────────────────────────────────────────
          Above Close/Pay, not beside them: these two are used a few times a day
          and those two are used on every sale, so they must not share a row and
          risk being hit instead. */}
      {showParkKeys && (
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
          <Button
            variant="ghost"
            size="touch"
            className="flex-1"
            disabled={busy}
            onClick={onShowSaved}
          >
            <Icons.Archive size={18} />
            Saved
            {savedCount > 0 && <Badge tone="brand">{savedCount}</Badge>}
          </Button>
        </div>
      )}

      {/* ── Close and Pay ────────────────────────────────────────────────── */}
      {/* Side by side, always in the same place: the way OUT and the way to
          FINISH are the two things a cashier reaches for without looking, and a
          Pay button that moves as the basket grows is a Pay button that gets
          missed. touch-lg because these are the only two keys that end a sale. */}
      <div className="flex items-stretch gap-2 px-3 pb-4 pt-1">
        {/* NOT disabled on an empty basket.
            In hospitality this key is the way back to the floor as well as the
            way to park a tab — a waiter who opens a table and is called away has
            an empty basket and still has to be able to leave. Disabling it there
            traps them on the till with no exit but the header. */}
        <Button
          variant={empty ? 'ghost' : 'danger'}
          size="touch-lg"
          className="shrink-0 px-8"
          disabled={busy}
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

function Row({
  label,
  children,
  divided = false,
}: {
  label: string
  children: React.ReactNode
  /** A hairline above, for every row after the first in the box. */
  divided?: boolean
}) {
  return (
    <div
      className={`flex items-center justify-between px-3.5 py-2.5 text-muted ${
        divided ? 'border-t border-border' : ''
      }`}
    >
      <span>{label}</span>
      <span className="numeric">{children}</span>
    </div>
  )
}
