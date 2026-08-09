'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  CardHeader,
  EmptyState,
  Icons,
  RowTile,
  Switch,
  useToast,
} from '@/components/ui'
import type {
  ProductVisibility,
  ProductVisibilityOptions,
  PublishCounts,
  PublishMode,
} from '@/lib/site/onlineStore'
import { setProductVisibilityAction, setVisibilityForFilterAction } from './actions'

/**
 * The product file, one switch each.
 *
 * Deliberately a list rather than a DataTable: the rows carry live Switches,
 * which DataTable cannot express, and the density is set by TABLE_TD's own
 * px-4 py-1.5 so it still sits at the same rhythm as every other list. This is
 * the same choice the department tree next door made, for the same reason.
 */
export default function ProductVisibilityList({
  items,
  total,
  counts,
  publishMode,
  departmentPaths,
  filter,
  empty,
}: {
  items: ProductVisibility[]
  /** Everything the filter matches, not just this page — what bulk acts on. */
  total: number
  counts: PublishCounts
  publishMode: PublishMode
  departmentPaths: Record<number, string>
  filter: ProductVisibilityOptions
  empty: { title: string; hint: string; action?: React.ReactNode }
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, startAction] = useTransition()

  /*
   * Flipped switches, held locally until the next server render.
   *
   * router.refresh() re-runs the page, but a Switch that snaps back to its old
   * position for the length of a round trip reads as "that did not work". This
   * keeps the row showing what the user just chose.
   */
  const [pending, setPending] = useState<Record<number, boolean>>({})
  const visibleState = (p: ProductVisibility) => pending[p.id] ?? p.showOnline

  function toggle(product: ProductVisibility, next: boolean) {
    setPending((prev) => ({ ...prev, [product.id]: next }))
    startAction(async () => {
      const result = await setProductVisibilityAction(product.id, product.description, next)
      if (!result.ok) {
        toast.error(result.error)
        // Put it back: the row must not claim a change the server refused.
        setPending((prev) => {
          const copy = { ...prev }
          delete copy[product.id]
          return copy
        })
        return
      }
      router.refresh()
    })
  }

  function bulk(next: boolean) {
    startAction(async () => {
      const result = await setVisibilityForFilterAction(filter, next)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setPending({})
      toast.success(
        `${result.changed.toLocaleString('en-ZA')} product${result.changed === 1 ? '' : 's'} ${
          next ? 'shown in' : 'hidden from'
        } the online store.`,
      )
      router.refresh()
    })
  }

  return (
    <>
      <CardHeader
        title="Shown in the online store"
        description={
          publishMode === 'flagged'
            ? 'Only the products ticked here appear in your shop.'
            : 'Ticks are saved, but another publish mode is deciding your catalogue.'
        }
        action={
          <div className="flex items-center gap-2">
            {/* A count is a count — neutral. Colour is saved for the one state
                that needs attention: a store publishing nothing. */}
            <Badge tone={counts.flagged === 0 ? 'danger' : 'neutral'}>
              {counts.flagged.toLocaleString('en-ZA')} of{' '}
              {counts.total.toLocaleString('en-ZA')} ticked
            </Badge>

            {/* Bulk acts on the whole FILTER, not the page — see the note in
                actions.ts. Hidden when there is nothing to act on. */}
            {total > 0 && (
              <>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => bulk(true)}>
                  Show all {total.toLocaleString('en-ZA')}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => bulk(false)}>
                  Hide all
                </Button>
              </>
            )}
          </div>
        }
      />

      {items.length === 0 ? (
        <EmptyState
          icon={<Icons.Package size={22} />}
          title={empty.title}
          hint={empty.hint}
          action={empty.action}
        />
      ) : (
        <ul className="divide-y divide-border">
          {items.map((product) => {
            const ticked = visibleState(product)
            return (
              // px-4 py-1.5 — the shared table rhythm, as the department tree.
              <li key={product.id} className="flex items-center gap-3 px-4 py-1.5">
                <RowTile label={product.description} token={product.imageColor} />

                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">
                    {product.description}
                  </span>
                  <span className="truncate text-xs text-muted">
                    {product.code}
                    {product.departmentId !== null && departmentPaths[product.departmentId]
                      ? ` · ${departmentPaths[product.departmentId]}`
                      : ' · No department'}
                  </span>
                </div>

                {/* Under 'departments' mode the department's tick is what
                    publishes this, so say so rather than showing a switch
                    whose position does not match the shop. */}
                {publishMode === 'departments' && product.publishedByDepartment && (
                  <Badge tone="success">Shown via its department</Badge>
                )}

                {/* ariaLabel, not label: the row already names the product, so
                    a visible label would repeat it on every line. */}
                <Switch
                  checked={ticked}
                  disabled={busy}
                  onChange={(next) => toggle(product, next)}
                  ariaLabel={`Show ${product.description} in the online store`}
                />
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
