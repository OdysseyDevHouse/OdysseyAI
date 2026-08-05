'use client'

import {
  Badge,
  Checkbox,
  Switch,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_ROW,
  TABLE_TD,
  TABLE_TH,
} from '@/components/ui'
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
  availability,
  onAvailabilityChange,
  onSharesCostChange,
  onSharesSellingChange,
}: {
  stores: LinkedProductView[]
  currentSiteId: number
  /* Controlled by ProductForm — the pricing tables read the same values to
     decide which rows are editable, so they cannot be owned here. */
  sharesCost: boolean
  sharesSelling: boolean
  /** Which stores carry this product, keyed by site id. */
  availability: Record<number, boolean>
  onAvailabilityChange: (siteId: number, value: boolean) => void
  onSharesCostChange: (value: boolean) => void
  onSharesSellingChange: (value: boolean) => void
}) {
  const others = stores.filter((s) => s.store.siteId !== currentSiteId)
  const current = stores.find((s) => s.store.siteId === currentSiteId)

  // The store being edited always carries the product and is shown first, so
  // the list reads as "here, and where else".
  const rows = current ? [current, ...others] : others

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          Which of your stores carry this product. A store is only written to once you switch it on
          — saving never adds this product to a store on its own. Switching a store off archives it
          there, keeping its stock and sales history.
        </p>

        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TH}>Store</th>
                <th className={TH}>Status</th>
                <th className={`${TH} text-right`}>Available</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((view) => {
                const siteId = view.store.siteId
                const isCurrent = siteId === currentSiteId
                // Defaults off, not on: a store is only written to once someone
                // deliberately switches it on.
                const on = availability[siteId] ?? false

                return (
                  <tr key={siteId} className={TABLE_ROW}>
                    <td className={`${TD} text-ink`}>
                      {view.store.displayName}
                      {isCurrent && (
                        <Badge className="ml-2" tone="neutral">
                          current
                        </Badge>
                      )}
                    </td>

                    <td className={TD}>
                      {isCurrent ? (
                        <span className="text-success">Available</span>
                      ) : on ? (
                        <span className="text-success">
                          {view.found && !view.archived ? 'Available' : 'Will be added on save'}
                        </span>
                      ) : (
                        <span className="text-muted">
                          {view.found && !view.archived ? 'Will be removed on save' : 'Not available'}
                        </span>
                      )}
                    </td>

                    <td className={`${TD} text-right`}>
                      <div className="flex justify-end">
                        {/* The store you are signed into cannot un-stock itself —
                            you would be archiving the product you are editing. */}
                        <Switch
                          checked={isCurrent ? true : on}
                          disabled={isCurrent}
                          onChange={(next) => onAvailabilityChange(siteId, next)}
                        />
                      </div>
                      {!isCurrent && (
                        <input
                          type="hidden"
                          name={`available_${siteId}`}
                          value={on ? '1' : '0'}
                        />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

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
                  {!view.found ? (
                    <Badge tone="neutral">not in this store</Badge>
                  ) : view.archived ? (
                    <Badge tone="warning">archived</Badge>
                  ) : (
                    <Badge tone="success">carried</Badge>
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
        Only the stores switched on above are written to when you save. Which stores are linked at
        all is configured under <strong className="text-ink">Setup → Linked stores</strong>.
      </p>
    </div>
  )
}
