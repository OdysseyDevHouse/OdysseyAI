'use client'

import { useState } from 'react'
import {
  Badge,
  Card,
  CurrencyInput,
  NumberInput,
  Select,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_ROW,
  TABLE_TD_INPUT,
  TABLE_TH,
  SectionTitle,
  SectionBody,
} from '@/components/ui'
import { Coins, Banknote } from '@/components/ui/icons'
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
 * Cost and selling prices for this store AND every store linked to it.
 *
 * Each linked store is a separate Odyssey site with its own master database, and
 * every one of them is editable from here — that is the point of the screen:
 * you sign in to one store and maintain the whole group from it.
 *
 * What a save does with each figure depends on its sharing toggle:
 *   shared     -> this store's value is written to every linked store, and
 *                 their rows follow it rather than being independently editable
 *   not shared -> each store keeps the value typed against it
 *
 * Only two figures are ever stored: cost EXCLUSIVE of tax and selling price
 * INCLUSIVE of tax. Markup, GP and the exclusive selling price are views onto
 * those, editable in either direction.
 */

const money = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '0.00')

/* These tables can't be a <DataTable>: their cells hold live cross-computing
   inputs rather than rendered values. They wear DataTable's own skin from
   styles.ts, so a change there restyles them too. */
const TH = `${TABLE_TH} px-1.5`
const TD = TABLE_TD_INPUT

/* Controls fill their column; the <colgroup> fixes every input column to the
   same width, so a Select (which reserves space for its chevron) and a plain
   input still render as boxes of identical size. */
const CONTROL_W = 'w-full'
const COL_COST = 'w-[140px]'
const COL_SELL = 'w-[168px]'

/**
 * One linked store's editable figures.
 *
 * Only stores that CARRY the product get a line. A store that does not stock
 * it has no cost and no price there — showing editable boxes would invite
 * someone to price a product that store does not sell, and the figures typed
 * would be written on the next save. Which stores carry it is decided on the
 * Stores tab; this table follows that decision rather than second-guessing it.
 */
export type StoreLine = {
  siteId: number
  name: string
  siteCode: string
  /**
   * False when the store is switched ON but has no row yet — it will be
   * created on save, so pricing it now is meaningful.
   */
  carried: boolean
  lastCost: number
  averageCost: number
  /** Selling price incl. tax, keyed by THIS store's price_structure id. */
  prices: Record<number, number>
}

/** A cell showing a figure this form cannot set. */
function ReadOnlyCell({ value, suffix }: { value: number; suffix?: string }) {
  return (
    <div
      className={`numeric ${CONTROL_W} h-control rounded-control border border-border bg-surface-2 px-3 py-2 text-right text-sm text-faint`}
    >
      {money(value)}
      {suffix}
    </div>
  )
}

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
  storeName,
  linkedLines,
  sharesCost,
  sharesSelling,
  derivedCost = null,
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
  storeName: string
  /** Other stores in the group. Empty when this store is standalone. */
  linkedLines: StoreLine[]
  /** Live toggle state, owned by the form so this panel reacts to it. */
  sharesCost: boolean
  sharesSelling: boolean
  /**
   * Cost worked out from something else, and therefore not editable here.
   *
   * Set for a recipe product, where the cost IS the sum of the ingredients:
   * nothing was ever bought called "burger", so a typed figure would be a guess
   * that silently overrides the real one and makes every GP report wrong.
   * Null — the default — leaves cost editable as it always was.
   */
  derivedCost?: number | null
}) {
  const purchaseRates = vatRates.filter((v) => v.vatType === 'purchase')
  const salesRates = vatRates.filter((v) => v.vatType === 'sales')

  const [purchaseVatId, setPurchaseVatId] = useState<number | ''>(defaultPurchaseVatId ?? '')
  const [sellingVatId, setSellingVatId] = useState<number | ''>(defaultSellingVatId ?? '')
  const [typedCostExcl, setCostExcl] = useState(defaultCostExcl)

  // A derived cost wins outright. Kept separate from the typed value rather
  // than overwriting it, so switching a product's type back to normal restores
  // whatever cost it had rather than freezing the last recipe total.
  const isDerived = derivedCost !== null
  const costExcl = isDerived ? derivedCost : typedCostExcl
  const [prices, setPrices] = useState<Record<number, number>>(defaultPrices)
  const [lines, setLines] = useState<StoreLine[]>(linkedLines)

  // Both open to start with. These tables are the reason somebody opened the
  // product screen, so the fold is there to get a finished section out of the
  // way — not to hide the figures until they are asked for.
  const [costOpen, setCostOpen] = useState(true)
  const [sellingOpen, setSellingOpen] = useState(true)

  const purchaseVat = purchaseRates.find((v) => v.id === purchaseVatId)?.rate ?? 0
  const sellingVat = salesRates.find((v) => v.id === sellingVatId)?.rate ?? 0

  // Margin is measured against whichever cost this site prices from. On a new
  // product there is no purchase history, so the entered cost is the only
  // figure available and average would otherwise sit at zero.
  //
  // A derived cost ignores the basis setting entirely: "average cost" for a
  // recipe is 0, and pricing a burger off 0 shows a 100% margin on every tier.
  const basisFor = (last: number, average: number) =>
    isDerived || isNew || costBasis === 'last' ? last : average

  const basisCost = basisFor(costExcl, defaultAverageCost)
  const costIncl = addVat(costExcl, purchaseVat)

  const setPrice = (structureId: number, incl: number) =>
    setPrices((p) => ({ ...p, [structureId]: incl }))

  const setLineCost = (siteId: number, value: number) =>
    setLines((all) => all.map((l) => (l.siteId === siteId ? { ...l, lastCost: value } : l)))

  const setLinePrice = (siteId: number, structureId: number, incl: number) =>
    setLines((all) =>
      all.map((l) =>
        l.siteId === siteId ? { ...l, prices: { ...l.prices, [structureId]: incl } } : l,
      ),
    )

  return (
    /* Two cards rather than one: cost and selling are separate concerns that
       happen to share state (cost drives the margin basis, and the tax rates
       live in the cost table), so they stay one component but read as two. */
    <div className="flex flex-col gap-4">
      {/* ── Cost price & taxes ───────────────────────────────────────── */}
      <Card>
        <SectionTitle
          icon={<Coins size={16} />}
          open={costOpen}
          onToggle={() => setCostOpen((v) => !v)}
        >
          Cost price &amp; TAXES
        </SectionTitle>
        <SectionBody open={costOpen}>
        <section className="flex flex-col gap-3 p-6">
          <div className="overflow-x-auto">
              <table className={`${TABLE} table-fixed`}>
                <colgroup>
                  <col />
                  <col className={COL_COST} />
                  <col className={COL_COST} />
                  <col className={COL_COST} />
                  <col className={COL_COST} />
                  <col className={COL_COST} />
                  <col className={COL_COST} />
                </colgroup>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TH}>Store</th>
                    <th className={TH}>Supplier price</th>
                    <th className={TH}>Cost excl.</th>
                    <th className={TH}>Purchase TAXES</th>
                    <th className={TH}>Cost incl.</th>
                    <th className={TH}>Average cost</th>
                    <th className={TH}>Selling TAXES</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className={TABLE_ROW}>
                    {/* Named for the GROUP when cost is shared, because that is
                        what the figure is. Labelling it with this store's name
                        while every other store silently follows it reads as a
                        per-store cost that happens to be copied. */}
                    <td className={`${TD} text-ink`}>
                      {sharesCost && lines.length > 0 ? (
                        <>
                          All stores
                          <span className="ml-2 text-xs text-muted">
                            {lines.length + 1} sharing
                          </span>
                        </>
                      ) : (
                        storeName
                      )}
                    </td>

                    {/* Supplier price comes from the supplier catalogue, which isn't
                        linked to products yet — shown so the column reads correctly
                        rather than silently missing. */}
                    <td className={TD}>
                      <div
                        className={`${CONTROL_W} h-control rounded-control border border-border bg-surface-2 px-3 py-2 text-center text-sm text-faint`}
                      >
                        —
                      </div>
                    </td>

                    <td className={TD}>
                      {isDerived ? (
                        /* Read-only, but still submitted: the save path writes
                           products.last_cost from this field, and a bare
                           ReadOnlyCell posts nothing — every save would store a
                           cost of zero. */
                        <>
                          <ReadOnlyCell value={costExcl} />
                          <input type="hidden" name="lastCost" value={costExcl.toFixed(4)} />
                        </>
                      ) : (
                        <CurrencyInput
                          name="lastCost"
                          min="0"
                          value={costExcl}
                          onChange={(e) => setCostExcl(Number(e.target.value) || 0)}
                          className={CONTROL_W}
                        />
                      )}
                    </td>

                    <td className={TD}>
                      <Select
                        name="purchaseVatRateId"
                        value={purchaseVatId}
                        onChange={(e) =>
                          setPurchaseVatId(e.target.value === '' ? '' : Number(e.target.value))
                        }
                        className={CONTROL_W}
                      >
                        <option value="">&lt;None&gt;</option>
                        {purchaseRates.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.rate}%
                          </option>
                        ))}
                      </Select>
                    </td>

                    <td className={TD}>
                      {/* Locks with cost excl. — this box edits the same figure
                          backwards through tax, so leaving it live would be an
                          editable cost box wearing a different label. */}
                      {isDerived ? (
                        <ReadOnlyCell value={costIncl} />
                      ) : (
                        <CurrencyInput
                          min="0"
                          value={costIncl}
                          onChange={(e) =>
                            setCostExcl(removeVat(Number(e.target.value) || 0, purchaseVat))
                          }
                          className={CONTROL_W}
                        />
                      )}
                    </td>

                    <td className={TD}>
                      {/* A recipe has no purchase history of its own, so its
                          stored average is 0 and would read as a free product.
                          The ingredient total is the honest figure. */}
                      <ReadOnlyCell value={isDerived ? costExcl : defaultAverageCost} />
                    </td>

                    <td className={TD}>
                      <Select
                        name="sellingVatRateId"
                        value={sellingVatId}
                        onChange={(e) =>
                          setSellingVatId(e.target.value === '' ? '' : Number(e.target.value))
                        }
                        className={CONTROL_W}
                      >
                        <option value="">&lt;None&gt;</option>
                        {salesRates.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.rate}%
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>

                  {/* A linked store's own cost row — shown only when cost is NOT
                      shared, because then each store genuinely has its own figure
                      to type.

                      When cost IS shared these rows said nothing: every one
                      mirrored the row above, greyed out. Harmless at two stores
                      and unreadable at forty, where the real information — "one
                      cost, and these are the stores on it" — was buried under
                      forty identical copies of it. The row above now carries
                      that, and the stores are listed once beneath the table. */}
                  {!sharesCost && lines.map((line) => (
                    <tr key={line.siteId} className={TABLE_ROW}>
                      <td className={`${TD} text-ink`}>
                        {line.name}
                        <span className="ml-2 text-xs text-muted">{line.siteCode}</span>
                        {!line.carried && (
                          <Badge tone="warning" className="ml-2">
                            will be created
                          </Badge>
                        )}
                      </td>

                      <td className={TD}>
                        <div
                          className={`${CONTROL_W} h-control rounded-control border border-border bg-surface-2 px-3 py-2 text-center text-sm text-faint`}
                        >
                          —
                        </div>
                      </td>

                      {/* A derived cost locks every store's row, not just this
                          one: the other store's copy is the same recipe, so a
                          figure typed there would be just as invented. */}
                      <td className={TD}>
                        {sharesCost || isDerived ? (
                          <ReadOnlyCell value={sharesCost ? costExcl : line.lastCost} />
                        ) : (
                          <CurrencyInput
                            name={`storeCost_${line.siteId}`}
                            min="0"
                            value={line.lastCost}
                            onChange={(e) => setLineCost(line.siteId, Number(e.target.value) || 0)}
                            className={CONTROL_W}
                          />
                        )}
                      </td>

                      {/* Tax rates are matched across databases by PERCENTAGE, not
                          id — the ids differ per store. A shared figure carries its
                          rate with it, so the row mirrors this store's. */}
                      <td className={TD}>
                        <ReadOnlyCell value={purchaseVat} suffix="%" />
                      </td>

                      <td className={TD}>
                        {sharesCost || isDerived ? (
                          <ReadOnlyCell
                            value={addVat(sharesCost ? costExcl : line.lastCost, purchaseVat)}
                          />
                        ) : (
                          <CurrencyInput
                            min="0"
                            value={addVat(line.lastCost, purchaseVat)}
                            onChange={(e) =>
                              setLineCost(
                                line.siteId,
                                removeVat(Number(e.target.value) || 0, purchaseVat),
                              )
                            }
                            className={CONTROL_W}
                          />
                        )}
                      </td>

                      <td className={TD}>
                        <ReadOnlyCell value={line.averageCost} />
                      </td>

                      <td className={TD}>
                        <ReadOnlyCell value={sellingVat} suffix="%" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
          </div>

          <p className="text-xs text-muted">
            {isDerived ? (
              <>
                This is a recipe product, so its cost is the total of its ingredients and cannot be
                typed in. Change it on the <strong className="text-ink">Recipe</strong> tab — adjust
                a quantity or an ingredient&apos;s own cost and this figure follows. Margin is
                calculated on <strong className="text-ink">{money(basisCost)}</strong>.
              </>
            ) : (
              <>
                {/* The stores are NAMED rather than counted. "4 stores" leaves
                    somebody wondering which four, and at forty the list is the
                    only place that answer exists now the rows are gone. */}
                {lines.length > 0 && sharesCost ? (
                  <>
                    One cost for {storeName} and{' '}
                    <strong className="text-ink">
                      {lines.map((l) => l.name).join(', ')}
                    </strong>
                    . Saving writes it to all of them.{' '}
                  </>
                ) : lines.length > 0 ? (
                  'Cost is not shared: each store keeps the cost typed against it. '
                ) : (
                  ''
                )}
                Average cost is a consequence of purchases and cannot be typed in. Margin is
                calculated on{' '}
                <strong className="text-ink">
                  {isNew
                    ? 'the cost entered above'
                    : costBasis === 'last'
                      ? 'last cost'
                      : 'average cost'}
                </strong>
                {!isNew && ` (${money(basisCost)})`}.
              </>
            )}
          </p>
        </section>
        </SectionBody>
      </Card>

      {/* ── Selling price ────────────────────────────────────────────── */}
      <Card>
        <SectionTitle
          icon={<Banknote size={16} />}
          open={sellingOpen}
          onToggle={() => setSellingOpen((v) => !v)}
        >
          Selling price
        </SectionTitle>
        <SectionBody open={sellingOpen}>
        <section className="flex flex-col gap-4 p-6">
          {/* Headed for the GROUP when selling is shared — one table, one set of
              prices, which is what the figures actually are. */}
          <SellingTable
            heading={sharesSelling && lines.length > 0 ? 'All stores' : storeName}
            headingNote={
              sharesSelling && lines.length > 0 ? `${lines.length + 1} sharing` : undefined
            }
            structures={structures}
            basis={basisCost}
            sellingVat={sellingVat}
            valueFor={(id) => prices[id] ?? 0}
            onChange={setPrice}
            fieldName={(id) => `price_${id}`}
          />

          {/* One table PER STORE, and only when prices are not shared. Shared,
              each was a read-only copy of the table above — a whole table per
              store saying nothing, which at forty stores is forty tables to
              scroll past to reach the one editable figure. */}
          {!sharesSelling && lines.map((line) => (
            <SellingTable
              key={line.siteId}
              heading={line.name}
              headingNote={line.siteCode}
              structures={structures}
              basis={basisFor(
                sharesCost ? costExcl : line.lastCost,
                sharesCost ? defaultAverageCost : line.averageCost,
              )}
              sellingVat={sellingVat}
              // A shared price mirrors this store's, and is read-only for the
              // same reason the cost row is: saving is about to overwrite it.
              readOnly={sharesSelling}
              valueFor={(id) => (sharesSelling ? (prices[id] ?? 0) : (line.prices[id] ?? 0))}
              onChange={(id, incl) => setLinePrice(line.siteId, id, incl)}
              fieldName={(id) => `storePrice_${line.siteId}_${id}`}
            />
          ))}

          {lines.length > 0 && (
            <p className="text-xs text-muted">
              {sharesSelling ? (
                <>
                  These prices apply at {storeName} and{' '}
                  <strong className="text-ink">{lines.map((l) => l.name).join(', ')}</strong>,
                  matched by tier name.
                </>
              ) : (
                'Selling prices are not shared: each store keeps the prices typed against it. Saving updates every store from here.'
              )}
            </p>
          )}
        </section>
        </SectionBody>
      </Card>
    </div>
  )
}

/** One store's tier table. Read-only when the value is about to be overwritten. */
function SellingTable({
  heading,
  headingNote,
  structures,
  basis,
  sellingVat,
  valueFor,
  onChange,
  fieldName,
  readOnly = false,
}: {
  heading: string
  headingNote?: string
  structures: PriceStructure[]
  basis: number
  sellingVat: number
  valueFor: (structureId: number) => number
  onChange: (structureId: number, incl: number) => void
  fieldName: (structureId: number) => string
  readOnly?: boolean
}) {
  return (
    /* The store name still labels each block — with several stores listed the
       tables are otherwise a single run of rows and it stops being obvious
       which price belongs to which store. The card around the whole section
       supplies the border, so this needs none of its own. */
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1 text-sm font-medium text-ink">
        {heading}
        {headingNote && <span className="text-xs font-normal text-muted">{headingNote}</span>}
        {readOnly && <Badge tone="neutral">follows shared</Badge>}
      </div>

      <div className="overflow-x-auto">
        <table className={`${TABLE} table-fixed`}>
          <colgroup>
            <col />
            <col className={COL_SELL} />
            <col className={COL_SELL} />
            <col className={COL_SELL} />
            <col className={COL_SELL} />
          </colgroup>
          <thead>
            <tr className={TABLE_HEAD_ROW}>
              <th className={TH}>Tier</th>
              <th className={TH}>Markup (%)</th>
              <th className={TH}>Gross profit (%)</th>
              <th className={TH}>Selling price excl.</th>
              <th className={TH}>Selling price incl.</th>
            </tr>
          </thead>
          <tbody>
            {structures.map((s) => {
              const incl = valueFor(s.id)
              const excl = removeVat(incl, sellingVat)

              return (
                <tr key={s.id} className={TABLE_ROW}>
                  <td className={`${TD} text-ink`}>- {s.name}</td>

                  <td className={TD}>
                    <NumberInput
                      step="0.01"
                      value={markupPercent(basis, excl)}
                      precision={2}
                      readOnly={readOnly}
                      disabled={readOnly}
                      onChange={(e) =>
                        onChange(
                          s.id,
                          addVat(sellExclFromMarkup(basis, Number(e.target.value) || 0), sellingVat),
                        )
                      }
                      className={CONTROL_W}
                    />
                  </td>

                  <td className={TD}>
                    <NumberInput
                      step="0.01"
                      max="99.99"
                      value={gpPercent(basis, excl)}
                      precision={2}
                      readOnly={readOnly}
                      disabled={readOnly}
                      onChange={(e) => {
                        // A GP of 100% or more has no finite price; ignore it
                        // rather than writing Infinity into the field.
                        const next = sellExclFromGp(basis, Number(e.target.value) || 0)
                        if (next !== null) onChange(s.id, addVat(next, sellingVat))
                      }}
                      className={CONTROL_W}
                    />
                  </td>

                  <td className={TD}>
                    <CurrencyInput
                      min="0"
                      value={excl}
                      readOnly={readOnly}
                      disabled={readOnly}
                      onChange={(e) => onChange(s.id, addVat(Number(e.target.value) || 0, sellingVat))}
                      className={CONTROL_W}
                    />
                  </td>

                  <td className={TD}>
                    <CurrencyInput
                      // A read-only row submits nothing: the shared value is
                      // already being sent by the origin store's own field.
                      name={readOnly ? undefined : fieldName(s.id)}
                      min="0"
                      value={incl}
                      readOnly={readOnly}
                      disabled={readOnly}
                      onChange={(e) => onChange(s.id, Number(e.target.value) || 0)}
                      className={CONTROL_W}
                    />
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
