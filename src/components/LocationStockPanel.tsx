'use client'

import {
  Badge,
  NumberInput,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_ROW,
  TABLE_TD_INPUT,
  TABLE_TH,
} from '@/components/ui'

/* Same reasoning as InventoryPanel: this table cannot be a <DataTable> because
   its cells hold editable level inputs rather than rendered values. It wears
   DataTable's own skin from styles.ts, so a change there restyles this too. */
const TH = `${TABLE_TH} px-1.5`
const TD = TABLE_TD_INPUT

/**
 * Stock on hand and reorder levels, one row per LOCATION.
 *
 * ── WHY THIS IS NOT InventoryPanel ────────────────────────────────────────
 *
 * InventoryPanel's rows are SITES — this store plus each linked store, which
 * are separate databases matched by product code. These rows are ROOMS INSIDE
 * ONE SITE, sharing a single product row.
 *
 * The two axes multiply rather than nest: a site with four locations can also
 * be linked to another site with its own four. Putting both in one table would
 * conflate a store with a stock room, which is the exact distinction
 * 003_drop_stores.sql was written to establish.
 *
 * Stock on hand is read-only here, for the reason it is read-only there: it is
 * a consequence of receipts, sales and adjustments, so letting the edit form
 * set it would silently falsify stock valuation. Levels are plain settings and
 * save with the product.
 */

export type LocationStockRow = {
  locationId: number
  code: string
  name: string
  isMain: boolean
  isActive: boolean
  stockOnHand: number
  minStock: number
  maxStock: number
}

export default function LocationStockPanel({
  rows,
  isNew,
}: {
  rows: LocationStockRow[]
  isNew: boolean
}) {
  // A new product has no piles yet, and opening stock is captured once on the
  // Inventory panel above. Showing an empty per-location table beside it would
  // offer two places to type the same figure.
  if (isNew) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <p className="text-sm text-muted">
          Opening stock goes into the main location. Once the product is saved, stock received into
          other locations appears here.
        </p>
      </div>
    )
  }

  const total = rows.reduce((sum, row) => sum + row.stockOnHand, 0)

  return (
    <div className="flex flex-col gap-3 p-6">
      <div className="overflow-x-auto">
        <table className={`${TABLE} table-fixed`}>
          <colgroup>
            <col />
            <col className="w-[175px]" />
            <col className="w-[175px]" />
            <col className="w-[175px]" />
          </colgroup>
          <thead>
            <tr className={TABLE_HEAD_ROW}>
              <th className={TH}>Location</th>
              <th className={TH}>Stock on hand</th>
              <th className={TH}>Minimum level</th>
              <th className={TH}>Maximum level</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.locationId} className={TABLE_ROW}>
                <td className={`${TD} text-ink`}>
                  <div className="flex items-center gap-2">
                    <span>
                      {row.code} — {row.name}
                    </span>
                    {row.isMain && <Badge tone="success">Main</Badge>}
                    {!row.isActive && <Badge tone="neutral">Off</Badge>}
                  </div>
                </td>

                <td className={TD}>
                  {/* Same border as an editable control so the row reads as one
                      set of boxes; the tint is what marks it read-only. */}
                  <div className="numeric h-control min-w-24 rounded-control border border-border-strong bg-warning-soft px-3 py-2 text-right text-sm text-ink">
                    {row.stockOnHand.toFixed(3)}
                  </div>
                </td>

                <td className={TD}>
                  <NumberInput
                    name={`locMinStock_${row.locationId}`}
                    min="0"
                    step="0.001"
                    defaultValue={row.minStock}
                    className="w-full"
                  />
                </td>

                <td className={TD}>
                  <NumberInput
                    name={`locMaxStock_${row.locationId}`}
                    min="0"
                    step="0.001"
                    defaultValue={row.maxStock}
                    className="w-full"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted">
        {/* The total is what products.stock_on_hand holds, and it is the sum of
            the rows above. Showing it makes that relationship visible rather
            than something the user has to take on trust. */}
        Total across all locations: <span className="numeric text-ink">{total.toFixed(3)}</span>. The
        till sells from the main location only. Stock on hand changes through receipts, sales and
        adjustments; levels save with the product.
      </p>
    </div>
  )
}
