'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'
import { AdvancedFilter, type FilterCondition, type FilterField } from '@/components/ui'
import { encodeFilters, FILTER_PARAM } from '@/lib/listFilters'
import { rememberListFiltersAction } from '@/app/(app)/listFilterActions'
import type { ListKey } from '@/lib/site/listColumns'

/**
 * The Filter button on a master list — products, customers or suppliers.
 *
 * The panel itself is the kit component; this is the thin piece that knows
 * where the filter LIVES (the URL) and how "remember" gets persisted. One
 * component for all three lists rather than one each: the only thing that
 * differs between them is which ListKey they remember under, and three copies
 * of a navigation rule is how the three screens quietly stop behaving alike.
 *
 * Applying NAVIGATES rather than setting state, because every filter on these
 * screens is a URL parameter: that is what makes a filtered list linkable,
 * reloadable and server-rendered, and it is what lets the trip out to a record
 * and back come home to the same list (see lib/returnTo.ts).
 */
export default function ListFilterButton({
  listKey,
  fields,
  value,
  remembered,
  builderHref,
}: {
  /** Which list — also the key the remembered filter is stored under. */
  listKey: ListKey
  fields: FilterField[]
  value: FilterCondition[]
  remembered: boolean
  builderHref?: string
}) {
  const router = useRouter()
  const params = useSearchParams()
  /* The list's own path, rather than one passed in: this component is rendered
     BY that page, so asking the router is both shorter and impossible to get
     wrong when a route moves. */
  const pathname = usePathname()
  const [, startTransition] = useTransition()

  function apply(conditions: FilterCondition[], remember: boolean) {
    const next = new URLSearchParams(params)
    const encoded = encodeFilters(conditions)

    /* ALWAYS set the parameter, even to empty.
     *
     * An empty `?f=` is how "no filter" is written, and it is deliberately
     * different from the parameter being absent: absent means "nobody has
     * said", which is when a remembered filter rehydrates. Deleting the key
     * here would make a remembered filter impossible to clear — the next
     * render would put it straight back. See the pages' `cleared` flag. */
    next.set(FILTER_PARAM, encoded)

    // Back to page 1: page 7 of the old result set is rarely a page of the new
    // one, and landing on an empty page reads as "no matches".
    next.delete('page')

    startTransition(() => {
      router.push(`${pathname}?${next.toString()}`)
      // Fire-and-forget: whether the filter is remembered has no bearing on
      // what this navigation shows, and awaiting it would stall the apply.
      void rememberListFiltersAction(listKey, remember ? encoded : '')
    })
  }

  return (
    <AdvancedFilter
      fields={fields}
      value={value}
      remembered={remembered}
      onApply={apply}
      builderHref={builderHref}
    />
  )
}
