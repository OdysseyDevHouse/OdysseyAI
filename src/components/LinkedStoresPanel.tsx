'use client'

import { useState } from 'react'
import { Badge, Checkbox, TABLE, TABLE_HEAD_ROW, TABLE_ROW, TABLE_TD, TABLE_TH } from '@/components/ui'
import type { LinkedProductView } from '@/lib/site/productFanout'

/**
 * The same product in the other linked stores.
 *
 * Each linked store is a separate Odyssey site with its own master database, and
 * this product exists there as its own row matched by CODE. The two toggles
 * decide what a save does to those rows:
 *
 *   shared    -> this store's cost / prices are written to every linked store
 *   not shared -> each store keeps whatever it already has
 *
 * The figures below are read live from those databases, so a store showing a
 * different price is showing the truth rather than a cached guess.
 */

const money = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '0.00')

const TH = TABLE_TH
const TD = TABLE_TD

export default function LinkedStoresPanel({
  stores,
  currentSiteId,
  sharesCost,
  sharesSelling,
  onSharesCostChange,
  onSharesSellingChange,
}: {
  stores: LinkedProductView[]
  currentSiteId: number
  /* Controlled by ProductForm — the pricing tables read the same values to
     decide which rows are editable, so they cannot be owned here. */
  sharesCost: boolean
  sharesSelling: boolean
  onSharesCostChange: (value: boolean) => void
  onSharesSellingChange: (value: boolean) => void
}) {
  const others = stores.filter((s) => s.store.siteId !== currentSiteId)

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-col gap-3">
        {/* Hidden inputs carry the unchecked state too — an unchecked checkbox
            submits nothing, which would read as "leave unchanged" rather than
            "stop sharing". */}
        <input type="hidden" name="sharesCost" value={sharesCost ? '1' : '0'} />
        <input type="hidden" name="sharesSelling" value={sharesSelling ? '1' : '0'} />

        <Checkbox
          label="Share the cost price with the linked stores"
          checked={sharesCost}
          onChange={(e) => onSharesCostChange(e.target.checked)}
        />
        <p className="-mt-1 ml-6 text-xs text-muted">
          On: saving writes this cost to every linked store. Off: each store keeps its own cost and
          this edit stays here.
        </p>

        <Checkbox
          label="Share the selling prices with the linked stores"
          checked={sharesSelling}
          onChange={(e) => onSharesSellingChange(e.target.checked)}
        />
        <p className="-mt-1 ml-6 text-xs text-muted">
          On: saving writes every price tier to every linked store, matched by tier name. Off: each
          store&apos;s prices stay editable in the Selling price tables above.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className={TABLE}>
          <thead>
            <tr className={TABLE_HEAD_ROW}>
              <th className={TH}>Linked store</th>
              <th className={TH}>Product</th>
              <th className={`${TH} text-right`}>Cost excl.</th>
              <th className={TH}>Selling prices</th>
            </tr>
          </thead>
          <tbody>
            {others.map((view) => (
              <tr key={view.store.siteId} className={TABLE_ROW}>
                <td className={`${TD} text-ink`}>
                  {view.store.displayName}
                  <span className="ml-2 text-xs text-muted">{view.store.siteCode}</span>
                </td>

                <td className={TD}>
                  {view.found ? (
                    <Badge tone="success">carried</Badge>
                  ) : (
                    <Badge tone="warning">not carried yet</Badge>
                  )}
                </td>

                <td className={`numeric ${TD} text-right text-ink-2`}>
                  {view.found ? money(view.lastCost) : '—'}
                </td>

                <td className={TD}>
                  {view.found && view.prices.length ? (
                    <span className="text-ink-2">
                      {view.prices
                        .map((p) => `${p.structureName} ${money(p.sellIncl)}`)
                        .join(' · ')}
                    </span>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted">
        A store showing “not carried yet” will have this product created in it the next time you
        save. Linked stores are configured under{' '}
        <strong className="text-ink">Setup → Linked stores</strong>.
      </p>
    </div>
  )
}
