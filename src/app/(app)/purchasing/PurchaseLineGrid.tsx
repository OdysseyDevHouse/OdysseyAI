'use client'

import { Fragment, type ReactNode } from 'react'
import {
  Button,
  CurrencyInput,
  Field,
  Icons,
  Input,
  NumberInput,
  Select,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_ROW,
  TABLE_TD,
  TABLE_TD_INPUT,
  TABLE_TH,
  type ColumnOption,
} from '@/components/ui'
import { formatMoney, formatQty, round } from '@/lib/decimals'
import { weightedAverageCost } from '@/lib/documentMath'
import { addVat, removeVat, sellExclFromGp, sellExclFromMarkup } from '@/lib/pricing'
import {
  purchaseLineFigures,
  purchaseLineMargin,
  unitCostFromLineTotal,
  unitCostFromLineTotalIncl,
  type PurchaseLineValues,
} from './purchaseLine'

/**
 * The line grid for ordering AND receiving.
 *
 * One component rather than two, because the columns are the same question in
 * both places — what is it, how many, at what cost, and what does that do to
 * the margin. Two grids would drift within a month, and the drift would show up
 * as an order that priced a line one way and the GRV against it pricing the
 * same line another.
 *
 * ── THIS FILE IS THE ONLY PLACE THE GRID CHANGES ──────────────────────────
 *
 * A column, a cell, a width, a warning, an input behaviour: it belongs here,
 * and it lands on ordering and receiving at the same moment. Do NOT fix a grid
 * problem inside OrderScreen or ReceiveScreen — a wrapper around one of them is
 * exactly the drift this component exists to prevent, and it is invisible until
 * a buyer notices the two screens disagree about the same product.
 *
 * The two DEFAULT sets below are allowed to differ, and only those: they are
 * which columns a screen OPENS with, not what the grid can do. A user's own
 * choice via the ColumnPicker overrides them anyway. Anything beyond a default
 * that has to differ goes through `mode`, in `show()` below, so both cases sit
 * on one screen where you can read them against each other.
 *
 * ── WHY THE COLUMNS ARE TOGGLEABLE ────────────────────────────────────────
 *
 * There are twenty of them. A buyer pricing a delivery wants cost, markup, GP
 * and selling price on screen together; a receiver at the door with a delivery
 * note wants the item and a quantity box and nothing else in the way. Showing
 * all twenty to both makes the grid unreadable for each. So the set is chosen
 * per device — see useColumnPrefs, and useTileSize before it for the same
 * argument about the till.
 *
 * ── WHY IT IS HAND-BUILT AND NOT A <DataTable> ────────────────────────────
 *
 * Its cells hold live cross-computing inputs: typing a markup moves the selling
 * price, typing a selling price moves the markup and the GP. DataTable renders
 * values. So this wears DataTable's own skin from styles.ts — TABLE_TH,
 * TABLE_TD, TABLE_ROW — and a change there restyles both. PricingPanel.tsx
 * makes the same trade for the same reason.
 */

/**
 * A location a line can be sent to.
 *
 * Defined here rather than on either screen: both hand the same list to this
 * grid, and two copies of the shape would drift the first time one gained a
 * field. `isMain` is what a screen seeds a new line with.
 */
export type StockLocationOption = { id: number; code: string; name: string; isMain: boolean }

/** What the grid needs to know about a line. The screens hold the rest. */
export type GridLine = PurchaseLineValues & {
  key: string
  productId: number | null
  productCode: string | null
  supplierCode: string
  description: string
  productType: string
  locationId: number | null
  /** Ordered, for a receiving screen showing what is outstanding. */
  qtyOrdered: number
  /** The product's position now, for the cost preview. */
  currentAverage: number
  currentStock: number
  /**
   * What was paid LAST time, which is what a cost change is measured against.
   *
   * Not the average: that is a blend across every receipt ever, so a product
   * bought at 10 for a year and now offered at 30 would show a mild drift
   * rather than the tripling it is. The last invoice is the comparison a buyer
   * actually makes.
   */
  lastCost: number
  /** Shelf price, VAT inclusive. Editable here so a delivery can be repriced. */
  sellIncl: number
  /**
   * The job line this was bought for (163). Carried, never edited here.
   *
   * The grid does not show it and nobody sets it on this screen — it arrives on
   * a line raised from a job part request and has to survive a round trip,
   * because saveOrder deletes and re-inserts every line. Dropping it here is
   * how a buyer fixing a quantity silently severs every job from its parts.
   */
  jobCardLineId?: number | null
}

export type GridColumnId =
  | 'ordered'
  | 'received'
  | 'bonus'
  | 'costExcl'
  | 'costIncl'
  | 'discountPct'
  | 'discountValue'
  | 'netCost'
  | 'landed'
  | 'avgNow'
  | 'avgAfter'
  | 'sellIncl'
  | 'sellExcl'
  | 'markup'
  | 'gp'
  | 'vat'
  | 'supplierCode'
  | 'location'
  | 'onHand'
  | 'lineTotalExcl'
  | 'lineTotalIncl'

/**
 * Every column, in the order the picker lists them.
 *
 * Grouped so twenty entries read as four short lists rather than one long one.
 * 'Item' is not here: it is the row's identity and is always drawn.
 */
export const PURCHASE_COLUMNS: readonly (ColumnOption & { id: GridColumnId })[] = [
  { id: 'ordered', label: 'Ordered', group: 'Quantity' },
  { id: 'received', label: 'Received', group: 'Quantity' },
  { id: 'bonus', label: 'Bonus qty', group: 'Quantity' },
  { id: 'onHand', label: 'On hand', group: 'Quantity' },
  { id: 'location', label: 'Into location', group: 'Quantity' },

  { id: 'costExcl', label: 'Unit cost (excl.)', group: 'Cost' },
  { id: 'costIncl', label: 'Unit cost (incl.)', group: 'Cost' },
  { id: 'discountPct', label: 'Discount %', group: 'Cost' },
  { id: 'discountValue', label: 'Discount value', group: 'Cost' },
  { id: 'netCost', label: 'Net unit cost', group: 'Cost' },
  { id: 'landed', label: 'New / landed cost', group: 'Cost' },
  { id: 'avgNow', label: 'Average cost now', group: 'Cost' },
  { id: 'avgAfter', label: 'Average cost after', group: 'Cost' },

  { id: 'sellIncl', label: 'Selling (incl.)', group: 'Pricing' },
  { id: 'sellExcl', label: 'Selling (excl.)', group: 'Pricing' },
  { id: 'markup', label: 'Markup %', group: 'Pricing' },
  { id: 'gp', label: 'GP %', group: 'Pricing' },

  { id: 'vat', label: 'VAT rate', group: 'Line' },
  { id: 'supplierCode', label: 'Their code', group: 'Line' },
  { id: 'lineTotalExcl', label: 'Line total (excl.)', group: 'Line' },
  { id: 'lineTotalIncl', label: 'Line total (incl.)', group: 'Line' },
]

/**
 * What a receiving screen opens with.
 *
 * Both line totals, because they are the fastest way to key a delivery: a
 * supplier invoice states the line rather than the unit, and one supplier
 * quotes it exclusive while the next quotes it inclusive. Whichever box matches
 * the paper in hand gets typed into, and the unit cost falls out of it.
 */
export const RECEIVE_DEFAULT_COLUMNS: GridColumnId[] = [
  'received',
  'costExcl',
  'supplierCode',
  'location',
  'lineTotalExcl',
  'lineTotalIncl',
]

/**
 * What an ordering screen opens with. No landed cost: nothing has arrived.
 *
 * 'location' is here for the same reason receiving opens with it — a buyer
 * splitting an order across rooms should not have to find the column first —
 * and it costs a single-location site nothing, because show() hides it when
 * there is only one place for goods to go.
 */
export const ORDER_DEFAULT_COLUMNS: GridColumnId[] = [
  'ordered',
  'costExcl',
  'discountPct',
  'supplierCode',
  'location',
  'onHand',
  'lineTotalExcl',
]

export const PURCHASE_COLUMN_IDS: GridColumnId[] = PURCHASE_COLUMNS.map((c) => c.id)

export default function PurchaseLineGrid({
  lines,
  visible,
  mode,
  locations,
  documentDiscounts,
  charges,
  sellingVatPct,
  costWarnPct = 0,
  onPatch,
  onRemove,
  renderAfterRow,
}: {
  lines: GridLine[]
  visible: ReadonlySet<string>
  /** Ordering shows what was asked for; receiving shows what turned up. */
  mode: 'order' | 'receive'
  locations: StockLocationOption[]
  /** Each line's share of the document discount, from purchaseDocumentFigures. */
  documentDiscounts: number[]
  /** Each line's share of freight, from purchaseDocumentFigures. */
  charges: number[]
  sellingVatPct: number
  /**
   * Percentage a unit cost may move from the last one paid before the line
   * says so. Zero switches it off.
   *
   * A note, never a block: prices genuinely move, and a buyer who knows the
   * supplier put 30% on is better placed than a setting. It exists so that
   * R1,000 keyed for R100 is noticed while the invoice is still in hand.
   */
  costWarnPct?: number
  onPatch: (key: string, patch: Partial<GridLine>) => void
  onRemove: (key: string) => void
  /** Serial capture, rendered under its line. */
  renderAfterRow?: (line: GridLine) => ReactNode
}) {
  // A column the caller asked for, that also makes sense in this mode. Ordering
  // has nothing received and no landed cost; receiving has both.
  const show = (id: GridColumnId) => {
    if (mode === 'order' && (id === 'received' || id === 'bonus' || id === 'avgAfter')) return false
    if (mode === 'receive' && id === 'ordered') return false
    if (id === 'location' && locations.length <= 1) return false
    return visible.has(id)
  }

  const shown = PURCHASE_COLUMN_IDS.filter(show)
  // Item, the shown columns, and the remove button.
  const colSpan = shown.length + 2

  const qtyLabel = mode === 'order' ? 'Ordered' : 'Received'
  const qtyId: GridColumnId = mode === 'order' ? 'ordered' : 'received'

  return (
    <div className="overflow-x-auto">
      <table className={TABLE}>
        <thead>
          <tr className={TABLE_HEAD_ROW}>
            <th scope="col" className={`${TABLE_TH} min-w-56`}>
              Item
            </th>
            {/* whitespace-nowrap: these captions are two and three words —
                "Unit cost (excl.)", "Average cost after" — and a column sized
                to its INPUT is narrower than its own heading. Left to wrap,
                every header became two or three lines and the row of boxes
                underneath sat at the bottom of a tall band of text. The table
                already scrolls horizontally, so the width goes there instead. */}
            {shown.map((id) => (
              <th
                key={id}
                scope="col"
                className={`${TABLE_TH} whitespace-nowrap ${HEAD_ALIGN[id] ?? ''} ${
                  HEAD_WIDTH[id] ?? ''
                }`}
              >
                {id === qtyId ? qtyLabel : LABELS[id]}
              </th>
            ))}
            <th scope="col" className={`${TABLE_TH} w-px`} />
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => {
            const figures = purchaseLineFigures(
              line,
              documentDiscounts[index] ?? 0,
              charges[index] ?? 0,
            )
            const margin = purchaseLineMargin(
              figures.landedCostExcl,
              line.sellIncl,
              sellingVatPct,
            )
            const newAverage = weightedAverageCost({
              existingQty: line.currentStock,
              existingCostExcl: line.currentAverage,
              receivedQty: figures.qtyTotal,
              receivedCostExcl: figures.landedCostExcl,
            })

            /** Writes a selling price back from a markup or GP the user typed. */
            const setSellFromExcl = (sellExcl: number | null) => {
              if (sellExcl === null) return
              onPatch(line.key, { sellIncl: addVat(sellExcl, sellingVatPct) })
            }

            /**
             * Writes a unit cost back from a line total the user typed.
             *
             * Null means the figure could not be inverted — no quantity to
             * divide by, or a discount that makes the target unreachable. The
             * box then simply keeps its old value rather than writing NaN into
             * the line and poisoning every figure derived from it.
             */
            const setCostFromTotal = (unitCostExcl: number | null) => {
              if (unitCostExcl === null) return
              onPatch(line.key, { unitCostExcl })
            }

            const cell = (id: GridColumnId) => {
              switch (id) {
                case 'ordered':
                  return (
                    <NumberInput
                      value={line.qty}
                      precision={3}
                      aria-label={`Quantity of ${line.description} ordered`}
                      onChange={(e) => onPatch(line.key, { qty: num(e.target.value) })}
                    />
                  )

                case 'received':
                  return (
                    <Field error={line.qty <= 0 ? 'Quantity needed.' : undefined}>
                      <NumberInput
                        value={line.qty}
                        precision={3}
                        aria-label={`Quantity of ${line.description} received`}
                        onChange={(e) => onPatch(line.key, { qty: num(e.target.value) })}
                      />
                    </Field>
                  )

                case 'bonus':
                  return (
                    <NumberInput
                      value={line.qtyBonus}
                      precision={3}
                      aria-label={`Free units of ${line.description}`}
                      onChange={(e) => onPatch(line.key, { qtyBonus: num(e.target.value) })}
                    />
                  )

                case 'costExcl':
                  return (
                    <CurrencyInput
                      value={line.unitCostExcl}
                      aria-label={`Unit cost of ${line.description}, excluding VAT`}
                      onChange={(e) => onPatch(line.key, { unitCostExcl: num(e.target.value) })}
                    />
                  )

                case 'costIncl':
                  // Typed inclusive, stored exclusive — the supplier invoice
                  // sometimes quotes one and sometimes the other.
                  return (
                    <CurrencyInput
                      value={figures.unitCostIncl}
                      aria-label={`Unit cost of ${line.description}, including VAT`}
                      onChange={(e) =>
                        onPatch(line.key, {
                          unitCostExcl: removeVat(num(e.target.value), line.vatRatePct),
                        })
                      }
                    />
                  )

                case 'discountPct':
                  return (
                    <NumberInput
                      value={line.discountAmount > 0 ? figures.effectiveDiscountPct : line.discountPct}
                      precision={2}
                      aria-label={`Discount percent on ${line.description}`}
                      // Clears the absolute amount: the two are alternatives,
                      // and leaving a stale amount behind would make it win
                      // silently over the percentage just typed.
                      onChange={(e) =>
                        onPatch(line.key, {
                          discountPct: clampPct(num(e.target.value)),
                          discountAmount: 0,
                        })
                      }
                    />
                  )

                case 'discountValue':
                  return (
                    <CurrencyInput
                      value={figures.discountExcl}
                      aria-label={`Discount value on ${line.description}`}
                      onChange={(e) =>
                        onPatch(line.key, { discountAmount: num(e.target.value), discountPct: 0 })
                      }
                    />
                  )

                case 'netCost':
                  return (
                    <span className="text-ink-2">
                      {formatMoney(line.qty === 0 ? 0 : round(figures.netExcl / line.qty, 4))}
                    </span>
                  )

                case 'landed':
                  return <span className="text-ink">{formatMoney(figures.landedCostExcl)}</span>

                case 'avgNow':
                  return <span className="text-muted">{formatMoney(line.currentAverage)}</span>

                case 'avgAfter': {
                  const moved = line.currentAverage > 0 && newAverage !== line.currentAverage
                  return (
                    <span
                      className={
                        !moved
                          ? 'text-ink-2'
                          : newAverage > line.currentAverage
                            ? 'text-warning'
                            : 'text-success'
                      }
                    >
                      {formatMoney(newAverage)}
                    </span>
                  )
                }

                case 'sellIncl':
                  return (
                    <CurrencyInput
                      value={line.sellIncl}
                      aria-label={`Selling price of ${line.description}, including VAT`}
                      onChange={(e) => onPatch(line.key, { sellIncl: num(e.target.value) })}
                    />
                  )

                case 'sellExcl':
                  return (
                    <CurrencyInput
                      value={margin.sellExcl}
                      aria-label={`Selling price of ${line.description}, excluding VAT`}
                      onChange={(e) => setSellFromExcl(num(e.target.value))}
                    />
                  )

                case 'markup':
                  return (
                    <NumberInput
                      value={margin.markup}
                      precision={2}
                      aria-label={`Markup percent on ${line.description}`}
                      onChange={(e) =>
                        setSellFromExcl(
                          sellExclFromMarkup(figures.landedCostExcl, num(e.target.value)),
                        )
                      }
                    />
                  )

                case 'gp':
                  return (
                    <NumberInput
                      value={margin.gp}
                      precision={2}
                      aria-label={`Gross profit percent on ${line.description}`}
                      // sellExclFromGp returns null at 100% or more — an
                      // unreachable price — and setSellFromExcl ignores it, so
                      // the box simply refuses rather than showing Infinity.
                      onChange={(e) =>
                        setSellFromExcl(sellExclFromGp(figures.landedCostExcl, num(e.target.value)))
                      }
                    />
                  )

                case 'vat':
                  return (
                    <NumberInput
                      value={line.vatRatePct}
                      precision={2}
                      aria-label={`VAT rate on ${line.description}`}
                      onChange={(e) => onPatch(line.key, { vatRatePct: clampPct(num(e.target.value)) })}
                    />
                  )

                case 'supplierCode':
                  return (
                    <Input
                      value={line.supplierCode}
                      aria-label={`Supplier's code for ${line.description}`}
                      onChange={(e) => onPatch(line.key, { supplierCode: e.target.value })}
                    />
                  )

                case 'location':
                  return (
                    <Select
                      value={line.locationId === null ? '' : String(line.locationId)}
                      aria-label={`Location for ${line.description}`}
                      onChange={(e) =>
                        onPatch(line.key, { locationId: Number(e.target.value) || null })
                      }
                    >
                      {/* An ORDER is allowed to leave this blank — it states an
                          intention, and "wherever main is when it lands" is a
                          real answer to give in January about February. A
                          RECEIPT is not: the goods are physically going into a
                          pile, and it has to be named. Orders raised before the
                          column existed come back through here as blanks, so
                          the option has to survive even once every new line is
                          seeded with main. */}
                      {mode === 'order' && <option value="">— At receipt —</option>}
                      {locations.map((loc) => (
                        <option key={loc.id} value={loc.id}>
                          {loc.code}
                        </option>
                      ))}
                    </Select>
                  )

                case 'onHand':
                  return <span className="text-muted">{formatQty(line.currentStock)}</span>

                /*
                 * BOTH LINE TOTALS ARE EDITABLE, AND THEY WRITE THE UNIT COST.
                 *
                 * A supplier invoice frequently states the line and not the
                 * unit — "10 of these, R120" — and a receiver keying that had
                 * to divide it by hand, at four decimal places, on every line.
                 * Typing 120 against a quantity of 10 now settles the cost at
                 * 12 and everything downstream (landed cost, average cost
                 * after, GP) recomputes from it, because the cost is still the
                 * one stored figure. These boxes are a way IN to it, not a
                 * second source of truth — which is why they keep rendering
                 * the computed total and never hold a value of their own.
                 *
                 * The charges note stays: freight is apportioned across the
                 * document and is not part of what this line was invoiced at,
                 * so it is shown beside the total rather than folded into the
                 * figure being inverted.
                 */
                case 'lineTotalExcl':
                  return (
                    <>
                      <CurrencyInput
                        value={figures.taxableExcl}
                        aria-label={`Line total for ${line.description}, excluding VAT`}
                        onChange={(e) =>
                          setCostFromTotal(
                            unitCostFromLineTotal(
                              line,
                              num(e.target.value),
                              documentDiscounts[index] ?? 0,
                            ),
                          )
                        }
                      />
                      {figures.chargeExcl > 0 && (
                        <div className="mt-0.5 text-xs text-muted">
                          +{formatMoney(figures.chargeExcl)} charges
                        </div>
                      )}
                    </>
                  )

                case 'lineTotalIncl':
                  return (
                    <CurrencyInput
                      value={figures.lineTotalIncl}
                      aria-label={`Line total for ${line.description}, including VAT`}
                      onChange={(e) =>
                        setCostFromTotal(
                          unitCostFromLineTotalIncl(
                            line,
                            num(e.target.value),
                            documentDiscounts[index] ?? 0,
                          ),
                        )
                      }
                    />
                  )
              }
            }

            // Resolved before rendering: a caller that returns null for most
            // lines (serial capture, which only some products need) must not
            // leave an empty <tr> behind on every other one.
            const extra = renderAfterRow?.(line)

            // Against the LAST cost paid, not the average — see the field's
            // own note. Only where there is a previous cost to compare with: a
            // product never bought before has not "changed" price.
            const costShift =
              costWarnPct > 0 && line.lastCost > 0 && line.unitCostExcl > 0
                ? round(((line.unitCostExcl - line.lastCost) / line.lastCost) * 100, 1)
                : 0
            const costWarned = Math.abs(costShift) >= costWarnPct

            return (
              <Fragment key={line.key}>
                <tr className={TABLE_ROW}>
                  <td className={TABLE_TD}>
                    <div className="text-ink">{line.description}</div>
                    <div className="text-xs text-muted">
                      {line.productCode}
                      {mode === 'receive' && line.qtyOrdered > 0 && (
                        <span className="ml-2">{formatQty(line.qtyOrdered)} ordered</span>
                      )}
                      {line.qtyBonus > 0 && (
                        <span className="ml-2 text-success">
                          +{formatQty(line.qtyBonus)} free
                        </span>
                      )}
                    </div>

                    {/* The cost moved. Shown on the line rather than as a
                        banner, because a fifty-line delivery with three
                        surprises needs to say WHICH three. A rise is the
                        warning case; a fall is worth seeing but is good news,
                        so it wears the calmer tone. */}
                    {costWarned && (
                      <div
                        className={`mt-0.5 text-xs ${
                          costShift > 0 ? 'text-warning' : 'text-success'
                        }`}
                      >
                        {costShift > 0 ? '↑' : '↓'} {Math.abs(costShift)}% on the last cost of{' '}
                        <span className="numeric">{formatMoney(line.lastCost)}</span>
                      </div>
                    )}
                  </td>

                  {shown.map((id) => (
                    <td
                      key={id}
                      className={`${INPUT_COLUMNS.has(id) ? TABLE_TD_INPUT : TABLE_TD} ${
                        INPUT_COLUMNS.has(id) ? '' : TABLE_NUMERIC
                      } ${HEAD_WIDTH[id] ?? ''}`}
                    >
                      {cell(id)}
                    </td>
                  ))}

                  <td className="px-4 py-1.5">
                    <Button
                      variant="bare"
                      size="sm"
                      iconOnly
                      aria-label={`Remove ${line.description}`}
                      onClick={() => onRemove(line.key)}
                    >
                      <Icons.Close size={15} />
                    </Button>
                  </td>
                </tr>

                {extra && (
                  <tr className={TABLE_ROW}>
                    <td colSpan={colSpan} className={TABLE_TD}>
                      {extra}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ── Column presentation ──────────────────────────────────────────────────
   Kept as lookup maps rather than built into class strings at the call site:
   Tailwind scans source text, so a `w-${n}` would never be emitted. */

const LABELS: Record<GridColumnId, string> = Object.fromEntries(
  PURCHASE_COLUMNS.map((c) => [c.id, c.label]),
) as Record<GridColumnId, string>

/** Columns whose cell is a control rather than a rendered value. */
const INPUT_COLUMNS = new Set<GridColumnId>([
  'ordered',
  'received',
  'bonus',
  'costExcl',
  'costIncl',
  'discountPct',
  'discountValue',
  'sellIncl',
  'sellExcl',
  'markup',
  'gp',
  'vat',
  'supplierCode',
  'location',
  'lineTotalExcl',
  'lineTotalIncl',
])

const HEAD_ALIGN: Partial<Record<GridColumnId, string>> = {
  ordered: 'text-right',
  received: 'text-right',
  bonus: 'text-right',
  costExcl: 'text-right',
  costIncl: 'text-right',
  discountPct: 'text-right',
  discountValue: 'text-right',
  netCost: 'text-right',
  landed: 'text-right',
  avgNow: 'text-right',
  avgAfter: 'text-right',
  sellIncl: 'text-right',
  sellExcl: 'text-right',
  markup: 'text-right',
  gp: 'text-right',
  vat: 'text-right',
  onHand: 'text-right',
  lineTotalExcl: 'text-right',
  lineTotalIncl: 'text-right',
}

/**
 * Column widths, sized to the HEADING rather than to the input.
 *
 * A currency box needs about 7rem; "Average cost after" needs 10. Sizing to the
 * control and letting the caption wrap put a two-line heading above every
 * money column — so these are the wider of the two, and the boxes simply fill
 * them. The table scrolls horizontally when the chosen set is wide, which is
 * the right trade: a buyer who turned on twelve columns wants to scroll, not to
 * read headings stacked three lines deep.
 */
const HEAD_WIDTH: Partial<Record<GridColumnId, string>> = {
  ordered: 'w-24',
  received: 'w-24',
  bonus: 'w-24',
  costExcl: 'w-36',
  costIncl: 'w-36',
  discountPct: 'w-28',
  discountValue: 'w-32',
  netCost: 'w-32',
  landed: 'w-36',
  avgNow: 'w-36',
  avgAfter: 'w-36',
  sellIncl: 'w-32',
  sellExcl: 'w-32',
  markup: 'w-24',
  gp: 'w-20',
  vat: 'w-24',
  supplierCode: 'w-32',
  location: 'w-28',
  onHand: 'w-24',
  lineTotalExcl: 'w-36',
  lineTotalIncl: 'w-36',
}

/** A decimal comma is what a South African keyboard produces. */
function num(raw: unknown): number {
  return Number(String(raw).replace(',', '.')) || 0
}

function clampPct(value: number): number {
  return Math.min(Math.max(value, 0), 100)
}
