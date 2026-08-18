'use client'

import { useEffect, useState } from 'react'
import {
  Button,
  Icons,
  EmptyState,
  TouchRow,
  CategoryTile,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { effectiveDiscountPct } from '@/lib/specialsEngine'
import { type BasketLine } from '@/lib/basket'
import { lineSessionState, minutesSince, type SessionBaseline } from '@/lib/lineSession'
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
  baseline,
  priceStructureName = null,
  onLineMore,
  onSelect,
  onStep,
  onEdit,
  onRemove,
  onCustomer,
  onClear,
  onPay,
  returning,
  docType = 'invoice',
  onDocDiscount,
  onFindReceipt,
  exchange = null,
  busy,
}: {
  lines: BasketLine[]
  totals: SaleTotals
  lineSpecials: ReturnType<typeof specialsFor>
  selectedKey: string | null
  /** The attached account, or a typed walk-in name, or null for nobody. */
  customerLabel: string | null
  /**
   * What the basket looked like when it was loaded, for the per-line state
   * chips. Null on a basket that was not recalled — every line of which is new.
   */
  baseline: SessionBaseline
  /** "Retail", "Wholesale" — the structure this basket is priced on. */
  priceStructureName?: string | null
  /** The overflow of per-line actions. Undefined leaves the More key out. */
  onLineMore?: (line: BasketLine) => void
  onSelect: (key: string) => void
  onStep: (key: string, delta: number) => void
  onEdit: (line: BasketLine) => void
  onRemove: (key: string) => void
  onCustomer: () => void
  onClear: () => void
  onPay: () => void
  /**
   * True when this basket is a return rather than a sale.
   *
   * Read-only here. The mode is entered by the credit-sale quick key and left when the
   * credit note posts — the pane reports it, it does not offer to change it.
   */
  returning: boolean
  /**
   * What KIND of document this basket will become.
   *
   * Decides what the finish button says and what colour it is — a quote and an
   * order are not tendered, so "Pay" on one is an instruction that cannot be
   * carried out. Defaulted to 'invoice' so every existing caller is unchanged.
   */
  docType?: 'invoice' | 'quote' | 'sales_order' | 'credit_sale'
  /** Opens the whole-sale discount dialog. Undefined leaves the row inert. */
  onDocDiscount?: () => void
  /** Opens the receipted-return flow. Shown in return mode only. */
  onFindReceipt?: () => void
  /** Exchange credit held from a return — shown as a banner until Pay. */
  exchange?: { label: string; onClear: () => void } | null
  busy: boolean
}) {
  const empty = lines.length === 0

  /*
   * What the big button at the bottom SAYS and IS.
   *
   * Three answers, because the till now builds three kinds of thing and only one
   * of them ends in money changing hands:
   *
   *   · a return REFUNDS — money out, so amber (see the button below)
   *   · a quote or an order SAVES — no tender at all, so the word is Save and
   *     the colour is not the money-green every other total on this screen uses
   *   · a sale PAYS, which is the ordinary case and stays exactly as it was
   *
   * Getting this wrong is not cosmetic. The finish button is the largest control
   * on the till, and one that says Pay on a document nobody can pay for sends a
   * counterhand looking for a tender pad that will never open.
   */
  const tendered = !returning && docType === 'invoice'
  const finishLabel = returning ? 'Refund' : tendered ? 'Pay' : 'Save'
  const finishTone = returning ? 'warning' : tendered ? 'success' : 'primary'

  const now = useMinuteClock()

  /* A FLOATING CARD, not a pane sharing a border with its neighbour. The three
     columns of the till each lift off the canvas on their own — which is what
     makes the basket read as a thing in its own right rather than a strip of the
     same surface as the product grid beside it. 500px because the line cards
     carry a name, a quantity and a price on one row. */
  return (
    <section className="flex w-[500px] shrink-0 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card">
      {/* NO TITLE ROW. The bar across the top of the till already says "Current
          Sale", and the pane sat directly under it repeating the same two words
          — so the basket now opens straight onto the customer row, and the
          heading is said once, in the top-left corner where the screen names
          itself. Return mode still announces itself, in the banner below. */}
      {/*
        ── RETURN BANNER ─────────────────────────────────────────────────────
        There is no Sale/Return switch here. Return mode is entered from the credit-sale
        quick key, and left when the credit note finishes — so the cashier never picks a
        direction, they press a key for the job they are doing.

        What the pane still owes them is the ANSWER to "which am I doing", because a
        cashier who thinks they are selling while taking a return hands over goods AND
        money. So the header stays silent in the ordinary case and turns into an
        unmissable band the moment the basket is crediting rather than selling.
      */}
      {/* Rendered ONLY when it has something to say. On a retail till that is selling
          there is no banner at all — and an always-present wrapper would leave an
          empty padded strip with a border under it, above the customer row.

          Send and Bill USED to sit here. They are quick keys now: two slips only a
          restaurant ever prints, costing every shop a strip of the basket whether or
          not it served tables. A hospitality shop puts them on a bar; a retail one
          never sees them. */}
      {(returning || exchange) && (
      <div className="border-b border-border p-3 pb-2">
        <div className="flex items-center gap-2">
          {returning && (
            <div className="min-w-0 flex-1">
              <span className="inline-flex items-center gap-1.5 rounded-control bg-warning-soft px-2.5 py-1 text-sm font-semibold text-warning-ink">
                <Icons.Undo size={15} />
                Return
              </span>
            </div>
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
      )}

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
              priceStructureName={priceStructureName}
              sessionState={lineSessionState(line, baseline)}
              /* No recorded order time means the line was rung before 167 or
                 restored from an old offline basket. `now` reads 0 minutes,
                 which is the honest answer when nothing is known — better than
                 dating it to 1970. */
              ageMinutes={minutesSince(line.orderedAt ?? now, now)}
              selected={selectedKey === line.key}
              onSelect={() => onSelect(line.key)}
              onStep={(delta) => onStep(line.key, delta)}
              onEdit={() => onEdit(line)}
              onRemove={() => onRemove(line.key)}
              onMore={onLineMore ? () => onLineMore(line) : undefined}
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

      {/* ── Close and Pay ──────────────────────────────────────────────────
          Straight after the totals now. A Save/recall row used to sit in this
          gap — a pair of keys every shop paid for in basket space, on the one
          strip a thumb passes over on its way to Pay, and the recall half of it
          could only ever reach the list belonging to the module already showing.
          Both are quick keys instead: Save is `save-sale`, and the lists are
          Quotes, Orders and Lay-bys, each reachable from any module. A shop that
          wants them keeps them; one that never parks a basket gets the space. */}
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
            hesitate over something they are supposed to do cheerfully.

            A QUOTE OR AN ORDER takes no money at all, so green would mislead in a
            third way: it is the biggest, brightest control on the screen, and on a
            document that cannot be tendered it invites the one press that will not
            work. `primary` says "this finishes what you are doing" without claiming
            a drawer is about to open. */}
        <Button
          variant={finishTone}
          size="touch-lg"
          className="flex-1 justify-between"
          disabled={empty || busy}
          onClick={onPay}
        >
          <span>{busy ? 'Working…' : finishLabel}</span>
          <span className="numeric">{formatMoney(totals.doc.totalIncl)}</span>
        </Button>
      </div>
    </section>
  )
}

/**
 * `Date.now()`, re-read every thirty seconds.
 *
 * The line ages have to count up on their own. A till showing a tab can sit
 * untouched for twenty minutes while a waiter is on the floor, and nothing else
 * on this screen would re-render in that time — so without a clock of its own
 * every line would still claim the age it had when the table was opened, which
 * is worse than showing no age at all.
 *
 * THIRTY seconds, for a figure that changes every sixty: a minute-long timer
 * started mid-minute shows each value for up to two minutes, and "2 minutes"
 * lingering while the customer's third minute passes is the kind of small lie
 * that stops the number being trusted. Two ticks a minute costs nothing and
 * bounds the error at thirty seconds.
 *
 * Initialised from a state initialiser rather than a module-level constant, so
 * every mount reads the clock fresh; and SSR renders the server's `now` and
 * hydration corrects it on the first tick, which is invisible because the till
 * is a client-rendered screen behind a gate.
 */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  return now
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
