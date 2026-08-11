'use client'

import { useState, useTransition } from 'react'
import {
  Button,
  Combobox,
  EmptyState,
  Field,
  NumberInput,
  Select,
  type ComboboxOption,
} from '@/components/ui'
import { Trash, ArrowRight } from '@/components/ui/icons'
import type { ReferLink, ReferMethod } from '@/lib/site/productComposition'
import type { ProductPick } from '@/lib/site/products'
import { searchProductsAction } from '@/app/(app)/products/pickerActions'

/**
 * The product a refer product is linked to, and what that link does to stock.
 *
 * The factor is always "how many of the target one of these is" — a six-pack
 * linked to a single has a factor of 6. What differs is where the stock sits,
 * and that is the METHOD (see 103_refer_methods.sql):
 *
 *   subtract  one pile, counted in singles. Selling a six-pack takes six off
 *             it and the six-pack itself never carries stock.
 *   normal    every pack size has its own pile. Selling a single when there
 *             are none breaks a six-pack open to make six.
 *
 * 1:1, so this submits three plain fields rather than a row set. Clearing the
 * link submits an empty referTarget, which the action reads as "unlink".
 *
 * For building a whole range at once — single, six-pack and case together —
 * see ReferWizard.tsx.
 */

const METHOD_HINT: Record<ReferMethod, string> = {
  subtract:
    'Only the linked product holds stock. Receiving 10 of these adds the factor × 10 to it, and selling one takes the factor off it.',
  normal:
    'This pack holds its own stock. Receiving 10 gives you 10 of these, and selling the linked product when it runs out breaks one of these open.',
}

const money = (n: number) =>
  n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function ReferPanel({
  link,
  productId,
  isNew,
}: {
  /** The link as saved, or null if this product has none yet. */
  link: ReferLink | null
  /** Excluded from the picker: a refer product cannot point at itself. */
  productId: number | null
  isNew: boolean
}) {
  const [target, setTarget] = useState<{
    id: number
    code: string
    description: string
    unitCostExcl: number
    stockOnHand: number
  } | null>(
    link
      ? {
          id: link.targetId,
          code: link.targetCode,
          description: link.targetDescription,
          unitCostExcl: link.unitCostExcl,
          stockOnHand: link.targetStockOnHand,
        }
      : null,
  )
  const [factor, setFactor] = useState(link?.factor ?? 1)
  const [method, setMethod] = useState<ReferMethod>(link?.method ?? 'subtract')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ProductPick[]>([])
  const [searching, startSearch] = useTransition()

  function search(next: string) {
    setQuery(next)
    startSearch(async () => {
      setResults(await searchProductsAction(next, productId ?? undefined))
    })
  }

  const options: ComboboxOption<ProductPick>[] = results.map((p) => ({
    value: String(p.id),
    label: p.description,
    hint: p.code,
    trailing: `${p.stockOnHand.toLocaleString('en-ZA')} on hand`,
    data: p,
  }))

  return (
    <div className="flex flex-col gap-4 p-6">
      <p className="text-sm text-muted">
        The product this one draws its stock from. Selling one of these deducts the factor below
        from the linked product — this one never carries stock of its own.
      </p>

      {isNew && <p className="text-sm text-muted">The link is saved together with the product.</p>}

      {/* Always submitted, empty when unlinked. An absent field would be
          indistinguishable from "this tab was never rendered", and the action
          would leave a link the user deliberately removed in place. */}
      <input type="hidden" name="referTarget" value={target?.id ?? ''} />
      <input type="hidden" name="referFactor" value={factor} />
      <input type="hidden" name="referMethod" value={method} />

      {!target ? (
        <>
          <div className="max-w-md">
            <Combobox
              options={options}
              query={query}
              onQueryChange={search}
              onSelect={(option) => {
                if (!option.data) return
                setTarget({
                  id: option.data.id,
                  code: option.data.code,
                  description: option.data.description,
                  unitCostExcl: option.data.averageCost,
                  stockOnHand: option.data.stockOnHand,
                })
                setQuery('')
                setResults([])
              }}
              loading={searching}
              placeholder="Search the product this one refers to…"
              emptyText="No products match"
            />
          </div>
          <EmptyState
            title="Not linked yet"
            hint="Search above for the product that carries the stock — for example the single that this case is made up of. A refer product cannot be sold until it is linked."
          />
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-4 rounded-card border border-border p-4">
            <Field label="Factor" hint="How many of the linked product one of these is" className="w-40">
              <NumberInput
                value={factor}
                onChange={(e) => setFactor(Number(e.target.value))}
                aria-label="Refer factor"
              />
            </Field>

            <div className="flex items-center gap-3 pb-2 text-muted">
              <ArrowRight size={16} />
            </div>

            <div className="min-w-0 flex-1 pb-2">
              <span className="block text-sm font-medium text-ink">{target.description}</span>
              <span className="block text-xs text-muted">
                {target.code} · {target.stockOnHand.toLocaleString('en-ZA')} on hand ·{' '}
                {money(target.unitCostExcl)} each
              </span>
            </div>

            <Button
              type="button"
              variant="danger-ghost"
              size="sm"
              onClick={() => setTarget(null)}
              className="mb-2"
            >
              <Trash size={15} />
              Unlink
            </Button>
          </div>

          <div className="max-w-md">
            <Field label="Refer method" hint={METHOD_HINT[method]}>
              <Select
                value={method}
                onChange={(e) => setMethod(e.target.value as ReferMethod)}
                aria-label="Refer method"
              >
                <option value="subtract">Subtract pack — the linked product holds the stock</option>
                <option value="normal">Normal refers — this pack holds its own stock</option>
              </Select>
            </Field>
          </div>

          {method === 'subtract' ? (
            <p className="text-sm text-muted">
              Selling one deducts{' '}
              <span className="numeric font-medium text-ink">
                {factor.toLocaleString('en-ZA')}
              </span>{' '}
              of {target.description}, at a cost of{' '}
              <span className="numeric font-medium text-ink">
                {money(factor * target.unitCostExcl)}
              </span>
              .
            </p>
          ) : (
            <p className="text-sm text-muted">
              Selling one takes one of these off the shelf. When {target.description} runs out,
              one of these is broken open to make{' '}
              <span className="numeric font-medium text-ink">
                {factor.toLocaleString('en-ZA')}
              </span>{' '}
              of it.
            </p>
          )}
        </>
      )}
    </div>
  )
}
