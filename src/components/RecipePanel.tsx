'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Combobox,
  EmptyState,
  NumberInput,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_TD,
  TABLE_TH,
  type ComboboxOption,
} from '@/components/ui'
import { Trash } from '@/components/ui/icons'
import type { RecipeLine } from '@/lib/site/productComposition'
import type { ProductPick } from '@/lib/site/products'
import { searchProductsAction } from '@/app/(app)/products/pickerActions'

/**
 * What a recipe product is made of.
 *
 * Each line is one ingredient and how much of it ONE of the made item takes —
 * per one, never per batch, because a batch size would have to be stored
 * alongside and the first person to change it would silently rescale every
 * quantity already captured.
 *
 * Lines submit as recipeComponent/recipeQty/recipeWastage triples of hidden
 * inputs. Parallel arrays rather than indexed names because rows are deleted
 * from the middle, and re-indexing on every delete is how the gaps appear.
 */

/** A row being edited. `key` is local — new rows have no database id yet. */
type Row = {
  key: string
  componentId: number
  code: string
  description: string
  qty: number
  wastagePct: number
  unitCostExcl: number
  stockOnHand: number
}

function toRow(line: RecipeLine): Row {
  return {
    key: `saved-${line.id}`,
    componentId: line.componentId,
    code: line.componentCode,
    description: line.componentDescription,
    qty: line.qty,
    wastagePct: line.wastagePct,
    unitCostExcl: line.unitCostExcl,
    stockOnHand: line.stockOnHand,
  }
}

const money = (n: number) =>
  n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function RecipePanel({
  lines,
  productId,
  isNew,
}: {
  /** What this recipe holds today. Empty for a product with none yet. */
  lines: RecipeLine[]
  /** Excluded from the picker so a recipe cannot list itself. */
  productId: number | null
  isNew: boolean
}) {
  const [rows, setRows] = useState<Row[]>(() => lines.map(toRow))
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ProductPick[]>([])
  const [searching, startSearch] = useTransition()

  function search(next: string) {
    setQuery(next)
    startSearch(async () => {
      setResults(await searchProductsAction(next, productId ?? undefined))
    })
  }

  function add(pick: ProductPick) {
    setRows((prev) =>
      // Silently ignoring a duplicate would look like the click missed. The row
      // is already there, so scrolling to it is the honest response — but the
      // list is short, so simply refusing to double it is enough.
      prev.some((r) => r.componentId === pick.id)
        ? prev
        : [
            ...prev,
            {
              key: `new-${pick.id}`,
              componentId: pick.id,
              code: pick.code,
              description: pick.description,
              qty: 1,
              wastagePct: 0,
              unitCostExcl: pick.averageCost,
              stockOnHand: pick.stockOnHand,
            },
          ],
    )
    setQuery('')
    setResults([])
  }

  const update = (key: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  const remove = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key))

  // Cost of one made item: what each ingredient contributes, wastage included.
  const totalCost = rows.reduce(
    (sum, r) => sum + r.qty * (1 + r.wastagePct / 100) * r.unitCostExcl,
    0,
  )

  // The binding ingredient decides how many can be made — two buns and ten
  // patties makes two burgers. Shown live so the setup screen answers the
  // question the stock screen would otherwise be asked.
  const buildable = rows.reduce((least, r) => {
    const per = r.qty * (1 + r.wastagePct / 100)
    if (per <= 0) return least
    return Math.min(least, r.stockOnHand / per)
  }, Infinity)

  const options: ComboboxOption<ProductPick>[] = results.map((p) => ({
    value: String(p.id),
    label: p.description,
    hint: p.code,
    trailing: `${p.stockOnHand.toLocaleString('en-ZA')} on hand`,
    disabled: rows.some((r) => r.componentId === p.id),
    data: p,
  }))

  return (
    <div className="flex flex-col gap-4 p-6">
      <p className="text-sm text-muted">
        What one of this product is made from. Selling one deducts these ingredients from stock —
        the made item itself never carries stock of its own.
      </p>

      {isNew && (
        <p className="text-sm text-muted">
          Ingredients are saved together with the product.
        </p>
      )}

      <div className="max-w-md">
        <Combobox
          options={options}
          query={query}
          onQueryChange={search}
          onSelect={(option) => option.data && add(option.data)}
          loading={searching}
          placeholder="Search a product to add as an ingredient…"
          emptyText="No products match"
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No ingredients yet"
          hint="Search above to add the products this one is made from. A recipe with no ingredients cannot be sold."
        />
      ) : (
        <>
          {/* Hand-built because the cells hold live inputs, which DataTable
              cannot express — wearing the kit's shared table skin so it still
              matches every other table in the app. */}
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Ingredient</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Quantity</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Wastage %</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Unit cost</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Line cost</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>On hand</th>
                  <th className={TABLE_TH}>
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const effective = row.qty * (1 + row.wastagePct / 100)
                  return (
                    <tr key={row.key}>
                      <td className={TABLE_TD}>
                        <span className="block text-sm text-ink">{row.description}</span>
                        <span className="block text-xs text-muted">{row.code}</span>
                        {/* Parallel arrays: the action zips them back together,
                            so deleting a middle row leaves no index gap. */}
                        <input type="hidden" name="recipeComponent" value={row.componentId} />
                        <input type="hidden" name="recipeQty" value={row.qty} />
                        <input type="hidden" name="recipeWastage" value={row.wastagePct} />
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        <NumberInput
                          aria-label={`Quantity of ${row.description}`}
                          value={row.qty}
                          onChange={(e) => update(row.key, { qty: Number(e.target.value) })}
                          className="w-24"
                        />
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        <NumberInput
                          aria-label={`Wastage on ${row.description}`}
                          value={row.wastagePct}
                          onChange={(e) => update(row.key, { wastagePct: Number(e.target.value) })}
                          className="w-24"
                        />
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{money(row.unitCostExcl)}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        {money(effective * row.unitCostExcl)}
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        {row.stockOnHand < effective ? (
                          <Badge tone="danger">{row.stockOnHand.toLocaleString('en-ZA')}</Badge>
                        ) : (
                          row.stockOnHand.toLocaleString('en-ZA')
                        )}
                      </td>
                      <td className={TABLE_TD}>
                        <Button
                          type="button"
                          variant="danger-ghost"
                          size="sm"
                          iconOnly
                          aria-label={`Remove ${row.description}`}
                          onClick={() => remove(row.key)}
                        >
                          <Trash size={15} />
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-6 border-t border-border pt-4">
            <div>
              <span className="block text-xs text-muted">Cost to make one</span>
              <span className="numeric text-lg font-semibold text-ink">{money(totalCost)}</span>
            </div>
            <div>
              <span className="block text-xs text-muted">Can be made from stock</span>
              <span className="numeric text-lg font-semibold text-ink">
                {Number.isFinite(buildable) ? Math.floor(buildable).toLocaleString('en-ZA') : '—'}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
