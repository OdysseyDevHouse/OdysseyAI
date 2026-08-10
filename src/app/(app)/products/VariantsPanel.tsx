'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Icons,
  Input,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_TD,
  TABLE_TH,
  useToast,
} from '@/components/ui'
import type { VariantGroup } from '@/lib/site/productVariants'
import type { ProductPick } from '@/lib/site/products'
import {
  attachChildAction,
  detachChildAction,
  loadGroupAction,
  makeParentAction,
  searchAttachableAction,
  unmakeParentAction,
} from './variantActions'

/**
 * Variants, on the product that owns them.
 *
 * ── THE PANEL HAS TWO COMPLETELY DIFFERENT JOBS ──────────────────────────
 *
 * Before: this product is ordinary, and the panel offers to turn it into a
 * group by naming what tells the variants apart.
 *
 * After: this product is a parent, and the panel is a list of its variants.
 *
 * They are drawn as one panel rather than two because they are the same
 * question at different stages, and a screen that grows a second card once you
 * press a button is a screen that moves under the user.
 *
 * ── WHY A PARENT SHOWS A WARNING, NOT A STOCK FIGURE ─────────────────────
 *
 * A parent holds no stock and cannot be sold — recordMovement refuses it. The
 * rest of this screen still shows price and stock fields, because they are the
 * same form for every product, so the panel says plainly that those figures
 * live on the variants now. Without that, the zero in the stock box reads as a
 * shop that has run out.
 *
 * The variant table is deliberately NOT a DataTable: its rows carry live axis
 * inputs, which DataTable cannot express. It wears the shared skin instead, so
 * it cannot drift from the tables that do use it.
 */

export default function VariantsPanel({
  productId,
  productDescription,
  initialGroup,
  isChildOf,
}: {
  productId: number
  productDescription: string
  /** The group when this product is already a parent, otherwise null. */
  initialGroup: VariantGroup | null
  /** Set when this product is itself somebody's variant. */
  isChildOf: { id: number; description: string } | null
}) {
  const toast = useToast()
  const [busy, startAction] = useTransition()
  const [group, setGroup] = useState<VariantGroup | null>(initialGroup)

  // Naming the axes, before the group exists.
  const [axis1, setAxis1] = useState('Size')
  const [axis2, setAxis2] = useState('')

  // Attaching a variant.
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<ProductPick[] | null>(null)
  const [picked, setPicked] = useState<ProductPick | null>(null)
  const [value1, setValue1] = useState('')
  const [value2, setValue2] = useState('')

  /** Re-read from the server rather than patching state, so the panel and the
      database cannot disagree after a partial failure. */
  function refresh() {
    startAction(async () => {
      setGroup(await loadGroupAction(productId))
    })
  }

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) {
    startAction(async () => {
      const result = await fn()
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(done)
      setGroup(await loadGroupAction(productId))
    })
  }

  /* ── This product is somebody else's variant ─────────────────────────── */

  if (isChildOf) {
    return (
      <Card>
        <CardHeader
          title="Variants"
          description={`This product is one of the variants of ${isChildOf.description}.`}
        />
        <CardBody>
          <p className="text-sm text-muted">
            Its price and stock belong to it alone. To change which variant it is, or to
            detach it, open{' '}
            <Link
              href={`/products/${isChildOf.id}`}
              className="font-medium text-brand underline-offset-2 hover:underline"
            >
              {isChildOf.description}
            </Link>
            .
          </p>
        </CardBody>
      </Card>
    )
  }

  /* ── Not a group yet ─────────────────────────────────────────────────── */

  if (!group) {
    return (
      <Card>
        <CardHeader
          title="Variants"
          description="Sell one product in several sizes, colours or packs."
        />
        <CardBody>
          <p className="mb-4 max-w-prose text-sm text-muted">
            Shoppers see one product with a picker instead of several competing ones. Each
            variant keeps its own code, barcode, price and stock, so the till and the
            stockroom carry on exactly as they do now — but this product itself stops being
            sellable, and its stock moves onto the variants.
          </p>

          {/* Labels kept short and equal so the two fields sit on one line at
              the same height. "And a second thing? (optional)" wrapped to two
              lines and pushed its input below its neighbour's. */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-44">
              <Field label="Varies by" hint="e.g. Size">
                <Input
                  value={axis1}
                  onChange={(e) => setAxis1(e.target.value)}
                  placeholder="Size"
                />
              </Field>
            </div>
            <div className="w-44">
              <Field label="And by (optional)" hint="e.g. Colour">
                <Input
                  value={axis2}
                  onChange={(e) => setAxis2(e.target.value)}
                  placeholder="Colour"
                />
              </Field>
            </div>
            {/* Nudged up so it aligns with the inputs rather than the hints
                sitting under them. */}
            <div className="mb-6">
              <Button
                variant="secondary"
                disabled={busy || !axis1.trim()}
                onClick={() =>
                  run(
                    () => makeParentAction(productId, [axis1, axis2].filter((a) => a.trim())),
                    'This product now has variants.',
                  )
                }
              >
                Set up variants
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
    )
  }

  /* ── A group, with its variants ──────────────────────────────────────── */

  const axisOne = group.axes.find((a) => a.position === 1)?.label ?? 'Variant'
  const axisTwo = group.axes.find((a) => a.position === 2)?.label ?? null

  return (
    <Card>
      <CardHeader
        title="Variants"
        description={`${productDescription} is sold as ${group.children.length} ${
          group.children.length === 1 ? 'variant' : 'variants'
        }.`}
        action={
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || group.children.length > 0}
            onClick={() =>
              run(() => unmakeParentAction(productId), 'This product no longer has variants.')
            }
          >
            Turn off variants
          </Button>
        }
      />
      <CardBody>
        {/* The exception this screen exists to explain — see the note above. */}
        <div className="mb-4 flex items-start gap-2.5 rounded-control bg-warning-soft px-3 py-2.5">
          <span className="shrink-0 text-warning">
            <Icons.StatusWarning size={18} />
          </span>
          <p className="text-sm text-ink-2">
            The price and stock boxes on this screen no longer apply — this product cannot be
            sold or counted on its own. Each variant below carries its own.
          </p>
        </div>

        {group.children.length === 0 ? (
          <EmptyState
            icon={<Icons.Package size={22} />}
            title="No variants yet"
            hint={`Add the first one below — give it the ${axisOne.toLowerCase()} it represents.`}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse">
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Code</th>
                  <th className={TABLE_TH}>{axisOne}</th>
                  {axisTwo && <th className={TABLE_TH}>{axisTwo}</th>}
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>In stock</th>
                  <th className={TABLE_TH} />
                </tr>
              </thead>
              <tbody>
                {group.children.map((child) => (
                  <tr key={child.id} className="border-b border-border last:border-0">
                    <td className={TABLE_TD}>
                      <Link
                        href={`/products/${child.id}`}
                        className="font-medium text-brand underline-offset-2 hover:underline"
                      >
                        {child.code}
                      </Link>
                      {child.isArchived && (
                        <Badge tone="neutral" className="ml-2">
                          Archived
                        </Badge>
                      )}
                    </td>
                    <td className={TABLE_TD}>{child.axis1 || '—'}</td>
                    {axisTwo && <td className={TABLE_TD}>{child.axis2 || '—'}</td>}
                    {/* State takes a form, not only a value: a plain 0 and a
                        plain 142 read identically at scanning speed.

                        The badge is inline-flex, so it needs the cell to push
                        it right — TABLE_NUMERIC's text-right moves text, not a
                        flow-root child. */}
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      <span className="flex justify-end">
                        {child.stockOnHand <= 0 ? (
                          <Badge tone="danger">Out</Badge>
                        ) : (
                          <span className="numeric text-ink-2">{child.stockOnHand}</span>
                        )}
                      </span>
                    </td>
                    <td className={`${TABLE_TD} text-right`}>
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () => detachChildAction(productId, child.id),
                            `${child.code} is no longer a variant.`,
                          )
                        }
                      >
                        Detach
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Attach an existing product ────────────────────────────────── */}
        <div className="mt-5 border-t border-border pt-4">
          <h3 className="mb-1 text-sm font-semibold text-ink">Add a variant</h3>
          <p className="mb-3 text-sm text-muted">
            Pick a product that already exists. It keeps its own code, price and stock — it
            just starts being shown as part of this one.
          </p>

          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[16rem] flex-1">
              <Field label="Find a product">
                <Input
                  value={search}
                  placeholder="Code or description"
                  onChange={(e) => {
                    setSearch(e.target.value)
                    setPicked(null)
                  }}
                />
              </Field>
            </div>
            <Button
              variant="secondary"
              disabled={busy || search.trim().length < 2}
              onClick={() =>
                startAction(async () => {
                  setResults(await searchAttachableAction(productId, search.trim()))
                })
              }
            >
              Search
            </Button>
          </div>

          {results !== null && !picked && (
            <div className="mt-3">
              {results.length === 0 ? (
                <p className="text-sm text-muted">
                  Nothing matched “{search.trim()}”. Products that already have variants of
                  their own are not offered.
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {results.map((row) => (
                    <li key={row.id}>
                      {/* Not a kit Button: this is a full-width multi-line
                          selection row, and every Button variant would centre
                          its contents and impose its own padding. */}
                      <button
                        type="button"
                        data-kit-ok
                        onClick={() => setPicked(row)}
                        className="flex w-full items-center justify-between gap-3 rounded-control border border-border bg-surface px-3 py-2 text-left transition hover:bg-surface-2"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-ink">
                            {row.description}
                          </span>
                          <span className="block text-xs text-muted">{row.code}</span>
                        </span>
                        <span className="numeric shrink-0 text-sm text-ink-2">
                          {row.stockOnHand}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {picked && (
            <div className="mt-3 rounded-card border border-border bg-surface-2 p-3">
              <p className="mb-3 text-sm text-ink">
                Adding <span className="font-semibold">{picked.description}</span>{' '}
                <span className="text-muted">({picked.code})</span>
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-40">
                  <Field label={axisOne}>
                    <Input
                      value={value1}
                      autoFocus
                      onChange={(e) => setValue1(e.target.value)}
                      placeholder="Medium"
                    />
                  </Field>
                </div>
                {axisTwo && (
                  <div className="w-40">
                    <Field label={axisTwo}>
                      <Input
                        value={value2}
                        onChange={(e) => setValue2(e.target.value)}
                        placeholder="Red"
                      />
                    </Field>
                  </div>
                )}
                <Button
                  variant="primary"
                  disabled={busy || (!value1.trim() && !value2.trim())}
                  onClick={() =>
                    run(async () => {
                      const result = await attachChildAction(
                        productId,
                        picked.id,
                        value1,
                        value2,
                      )
                      if (result.ok) {
                        setPicked(null)
                        setResults(null)
                        setSearch('')
                        setValue1('')
                        setValue2('')
                      }
                      return result
                    }, `${picked.code} is now a variant.`)
                  }
                >
                  Add variant
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setPicked(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
