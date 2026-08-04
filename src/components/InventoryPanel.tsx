'use client'

import {
  Button,
  NumberInput,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_ROW,
  TABLE_TD_INPUT,
  TABLE_TH,
} from '@/components/ui'

/* This table can't be a <DataTable>: its cells hold editable level inputs
   rather than rendered values. It wears DataTable's own skin from styles.ts, so
   a change there restyles this table too. */
const TH = `${TABLE_TH} px-1.5`
const TD = TABLE_TD_INPUT

/**
 * Stock on hand and reorder levels, one row per store.
 *
 * Stock on hand is deliberately read-only here: it is a consequence of receipts,
 * sales and adjustments, so letting the edit form set it would silently falsify
 * stock valuation. Minimum and maximum levels are plain settings and save with
 * the product.
 *
 * Levels are genuinely per-store — never shared — because a level is only
 * meaningful against the stock it governs, and stock is a fact about one
 * physical location.
 */

export type InventoryRow = {
  storeId: number
  storeName: string
  stockOnHand: number
  minStock: number
  maxStock: number
}

export default function InventoryPanel({
  rows,
  isNew,
}: {
  rows: InventoryRow[]
  isNew: boolean
}) {
  return (
    <div className="flex flex-col gap-3 p-6">
      <div className="overflow-x-auto">
        <table className={`${TABLE} table-fixed`}>
          {/* Narrow enough that "Minimum product level" wraps to two lines,
              which is what keeps the boxes compact rather than stretched. */}
          {/* Stock on hand carries an Adjust button beside its box, so it needs
              more room than the two level columns. */}
          <colgroup>
            <col />
            <col className="w-[215px]" />
            <col className="w-[175px]" />
            <col className="w-[175px]" />
          </colgroup>
          <thead>
            <tr className={TABLE_HEAD_ROW}>
              <th className={TH}>Store name</th>
              <th className={TH}>{isNew ? 'Opening stock' : 'Stock on hand'}</th>
              <th className={TH}>Minimum product level</th>
              <th className={TH}>Maximum product level</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.storeId} className={TABLE_ROW}>
                <td className={`${TD} text-ink`}>{row.storeName}</td>

                <td className={TD}>
                  {isNew ? (
                    <NumberInput
                      name="openingStock"
                      step="0.001"
                      defaultValue={row.stockOnHand}
                      className="w-full"
                    />
                  ) : (
                    <div className="flex items-center justify-end gap-2">
                      {/* Same border as an editable control so the row reads as
                          one set of boxes; the tint is what marks it read-only. */}
                      <div className="numeric h-control min-w-24 rounded-control border border-border-strong bg-warning-soft px-3 py-2 text-right text-sm text-ink">
                        {row.stockOnHand.toFixed(2)}
                      </div>
                      {/* Adjustments are a stock movement with their own audit
                          trail, not a field on this form. */}
                      <Button type="button" variant="ghost" size="sm" disabled>
                        Adjust
                      </Button>
                    </div>
                  )}
                </td>

                <td className={TD}>
                  <NumberInput
                    // storeId 0 is the store being edited; its fields keep the
                    // plain names the ordinary save path already reads.
                    name={row.storeId === 0 ? 'minStock' : `minStock_${row.storeId}`}
                    min="0"
                    defaultValue={row.minStock}
                    className="w-full"
                  />
                </td>

                <td className={TD}>
                  <NumberInput
                    name={row.storeId === 0 ? 'maxStock' : `maxStock_${row.storeId}`}
                    min="0"
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
        {isNew
          ? 'Opening stock is recorded once when the product is created. Minimum and maximum levels are saved when you save the product.'
          : 'Stock on hand is adjusted elsewhere. Minimum and maximum levels are saved when you save the product.'}
      </p>
    </div>
  )
}
