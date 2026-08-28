'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'
import { AdvancedFilter, type FilterCondition, type FilterField } from '@/components/ui'
import { encodeFilters, FILTER_PARAM } from '@/lib/listFilters'
import { rememberProductFiltersAction } from './filterActions'

/**
 * The Filter button on the products list.
 *
 * The panel itself is the kit component; this is the thin piece that knows
 * where the filter LIVES — the URL — and how "remember" gets persisted.
 *
 * Applying navigates rather than setting state, because every filter on this
 * screen is a URL parameter: that is what makes a filtered list linkable,
 * reloadable and server-rendered, and it is what lets the trip out to a product
 * and back come home to the same list (see lib/returnTo.ts).
 */
export default function ProductFilterButton({
  fields,
  value,
  remembered,
}: {
  fields: FilterField[]
  value: FilterCondition[]
  remembered: boolean
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [, startTransition] = useTransition()

  function apply(conditions: FilterCondition[], remember: boolean) {
    const next = new URLSearchParams(params)
    const encoded = encodeFilters(conditions)

    /* ALWAYS set the parameter, even to empty.
     *
     * An empty `?f=` is how "no filter" is written, and it is deliberately
     * different from the parameter being absent: absent means "nobody has said",
     * which is when a remembered filter rehydrates. Deleting the key here would
     * make a remembered filter impossible to clear — the next render would put
     * it straight back. See the page's `cleared` flag. */
    next.set(FILTER_PARAM, encoded)

    // Back to page 1: page 7 of the old result set is rarely a page of the new
    // one, and landing on an empty page reads as "no matches".
    next.delete('page')

    startTransition(() => {
      router.push(`/products?${next.toString()}`)
      // Fire-and-forget: whether the filter is remembered has no bearing on
      // what this navigation shows, and awaiting it would stall the apply.
      void rememberProductFiltersAction(remember ? encoded : '')
    })
  }

  return (
    <AdvancedFilter
      fields={fields}
      value={value}
      remembered={remembered}
      onApply={apply}
      builderHref="/reports/builder?source=products"
    />
  )
}
