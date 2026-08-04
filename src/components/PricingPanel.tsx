'use client'

import { useState } from 'react'
import {
  addVat,
  removeVat,
  markupPercent,
  gpPercent,
  sellExclFromMarkup,
  sellExclFromGp,
  type CostBasis,
} from '@/lib/pricing'
import type { VatRate, PriceStructure } from '@/lib/site/lookups'

/**
 * Cost and selling prices, all cross-computed live.
 *
 * Only two things are actually submitted: cost EXCLUSIVE of VAT, and each
 * structure's selling price INCLUSIVE of VAT. Inclusive cost, exclusive selling
 * price, markup and GP are views onto those, editable in either direction —
 * type a markup and the price moves, type a price and the markup moves.
 */

const field = 'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink numeric'
const labelText = 'text-xs font-medium text-muted'

const money = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '0.00')

export default function PricingPanel({
  vatRates,
  structures,
  costBasis,
  defaultCostExcl,
  defaultAverageCost,
  defaultPurchaseVatId,
  defaultSellingVatId,
  defaultPrices,
  isNew,
}: {
  vatRates: VatRate[]
  structures: PriceStructure[]
  costBasis: CostBasis
  defaultCostExcl: number
  defaultAverageCost: number
  defaultPurchaseVatId: number | null
  defaultSellingVatId: number | null
  defaultPrices: Record<number, number>
  isNew: boolean
}) {
  const purchaseRates = vatRates.filter((v) => v.vatType === 'purchase')
  const salesRates = vatRates.filter((v) => v.vatType === 'sales')

  const [purchaseVatId, setPurchaseVatId] = useState<number | ''>(defaultPurchaseVatId ?? '')
  const [sellingVatId, setSellingVatId] = useState<number | ''>(defaultSellingVatId ?? '')
  const [costExcl, setCostExcl] = useState(defaultCostExcl)
  const [prices, setPrices] = useState<Record<number, number>>(defaultPrices)

  const purchaseVat = purchaseRates.find((v) => v.id === purchaseVatId)?.rate ?? 0
  const sellingVat = salesRates.find((v) => v.id === sellingVatId)?.rate ?? 0

  // Margin is measured against whichever cost this site prices from. On a new
  // product there is no purchase history, so the entered cost is the only
  // figure available and average would otherwise sit at zero.
  const basisCost = isNew || costBasis === 'last' ? costExcl : defaultAverageCost
  const costIncl = addVat(costExcl, purchaseVat)

  const setPrice = (structureId: number, incl: number) =>
    setPrices((p) => ({ ...p, [structureId]: incl }))

  return (
    <div className="flex flex-col gap-5 p-6">
      <section className="grid gap-4 sm:grid-cols-4">
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Cost excl. VAT</span>
          <input
            name="lastCost"
            type="number"
            step="0.0001"
            min="0"
            value={costExcl}
            onChange={(e) => setCostExcl(Number(e.target.value) || 0)}
            className={field}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Cost incl. VAT</span>
          <input
            type="number"
            step="0.0001"
            min="0"
            value={money(costIncl)}
            onChange={(e) => setCostExcl(removeVat(Number(e.target.value) || 0, purchaseVat))}
            className={field}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={labelText}>
            Average cost
            <span className="ml-1 font-normal opacity-70">(from purchases)</span>
          </span>
          <input
            type="number"
            value={money(defaultAverageCost)}
            readOnly
            disabled
            className={`${field} opacity-60`}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Purchase VAT</span>
          <select
            name="purchaseVatRateId"
            value={purchaseVatId}
            onChange={(e) => setPurchaseVatId(e.target.value === '' ? '' : Number(e.target.value))}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink"
          >
            <option value="">&lt;None&gt;</option>
            {purchaseRates.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.rate}%)
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="grid gap-4 sm:grid-cols-4">
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Selling VAT</span>
          <select
            name="sellingVatRateId"
            value={sellingVatId}
            onChange={(e) => setSellingVatId(e.target.value === '' ? '' : Number(e.target.value))}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink"
          >
            <option value="">&lt;None&gt;</option>
            {salesRates.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.rate}%)
              </option>
            ))}
          </select>
        </label>
        <div className="sm:col-span-3 flex items-end text-xs text-muted">
          Margin is calculated on{' '}
          <strong className="mx-1 text-ink">
            {isNew ? 'the cost entered above' : costBasis === 'last' ? 'last cost' : 'average cost'}
          </strong>
          {!isNew && <>({money(basisCost)})</>}
        </div>
      </section>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2 text-left text-xs text-muted">
              <th className="px-3 py-2 font-medium">Price structure</th>
              <th className="px-3 py-2 font-medium">Markup %</th>
              <th className="px-3 py-2 font-medium">GP %</th>
              <th className="px-3 py-2 font-medium">Selling excl.</th>
              <th className="px-3 py-2 font-medium">Selling incl.</th>
              <th className="px-3 py-2 text-right font-medium">Profit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {structures.map((s) => {
              const incl = prices[s.id] ?? 0
              const excl = removeVat(incl, sellingVat)
              const markup = markupPercent(basisCost, excl)
              const gp = gpPercent(basisCost, excl)
              const profit = excl - basisCost

              return (
                <tr key={s.id}>
                  <td className="px-3 py-2 text-ink">
                    {s.name}
                    {s.isDefault && <span className="ml-1.5 text-xs text-muted">default</span>}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="0.01"
                      value={money(markup)}
                      onChange={(e) =>
                        setPrice(
                          s.id,
                          addVat(sellExclFromMarkup(basisCost, Number(e.target.value) || 0), sellingVat),
                        )
                      }
                      className={`${field} max-w-24`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="0.01"
                      max="99.99"
                      value={money(gp)}
                      onChange={(e) => {
                        // A GP of 100% or more has no finite price; ignore it
                        // rather than writing Infinity into the field.
                        const next = sellExclFromGp(basisCost, Number(e.target.value) || 0)
                        if (next !== null) setPrice(s.id, addVat(next, sellingVat))
                      }}
                      className={`${field} max-w-24`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="0.0001"
                      min="0"
                      value={money(excl)}
                      onChange={(e) =>
                        setPrice(s.id, addVat(Number(e.target.value) || 0, sellingVat))
                      }
                      className={`${field} max-w-32`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      name={`price_${s.id}`}
                      type="number"
                      step="0.0001"
                      min="0"
                      value={incl}
                      onChange={(e) => setPrice(s.id, Number(e.target.value) || 0)}
                      className={`${field} max-w-32`}
                    />
                  </td>
                  <td
                    className={`numeric px-3 py-2 text-right ${profit < 0 ? 'text-danger' : 'text-muted'}`}
                  >
                    {money(profit)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
