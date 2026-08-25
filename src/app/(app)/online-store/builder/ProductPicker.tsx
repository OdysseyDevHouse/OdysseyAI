'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Field, Icons, Input, Modal, Select, TextLink } from '@/components/ui'
import { MAX_SECTION_ITEMS } from '@/lib/storefrontModel'
import type { StorefrontDepartment, StorefrontProduct } from '@/lib/site/storefront'
import { browseProductsAction, searchProductsAction } from './actions'

/**
 * Choosing the exact products in a hand-picked row.
 *
 * ── WHY ORDER IS PART OF THE VALUE ───────────────────────────────────────
 *
 * The list is stored as an ordered array, not a set. An owner building a
 * "This week's specials" row is merchandising: the thing they most want sold
 * goes first. Sorting these by name on the way out would throw away the only
 * decision the owner actually made here.
 *
 * ── WHY A DIALOG RATHER THAN A SEARCH BOX ────────────────────────────────
 *
 * This used to be search-as-you-type in the inspector. That only worked for an
 * owner who already knew what they wanted to type, and it cost one round trip
 * per product added. Building a "Specials" row is browsing, not recall — so
 * the button opens the catalogue, filters it by department, and adds the whole
 * selection in one go.
 *
 * ── WHY IT SEARCHES THE SHOP, NOT THE PRODUCT TABLE ──────────────────────
 *
 * Both actions run the storefront's own query, so the picker can only offer
 * what a shopper could buy. Offering the whole product table would let an
 * owner pick a discontinued line and discover it was missing only by looking
 * at the live shop.
 */

/** What one dialog page asks for. `publishedProducts` clamps at 120. */
const PAGE_SIZE = 100

export default function ProductPicker({
  value,
  onChange,
  onResolve,
  departments = [],
}: {
  value: number[]
  onChange: (ids: number[]) => void
  /**
   * The picked products, in order, whenever we can name them all.
   *
   * Lets the canvas draw the row immediately instead of waiting for the
   * autosave and a server revalidate — the products are already here.
   */
  onResolve?: (products: StorefrontProduct[]) => void
  /** Departments with something published in them, for the dialog's filter. */
  departments?: StorefrontDepartment[]
}) {
  const [browsing, setBrowsing] = useState(false)
  /**
   * Names for the picked ids.
   *
   * The layout stores ids only, so on first open we know WHAT is picked but
   * not what any of it is called. Kept as a map that only ever grows, so a
   * picked product's name survives the dialog's results changing underneath it.
   */
  const [names, setNames] = useState<Map<number, StorefrontProduct>>(new Map())

  const learn = (products: StorefrontProduct[]) =>
    setNames((prev) => {
      const next = new Map(prev)
      for (const p of products) next.set(p.id, p)
      return next
    })

  /*
   * Resolve names for anything picked we cannot name yet.
   *
   * Runs on `value` rather than once on mount because selecting a different
   * section swaps the whole list out under us.
   */
  useEffect(() => {
    const unknown = value.filter((id) => !names.has(id))
    if (unknown.length === 0) return
    let live = true
    searchProductsAction('', unknown).then((products) => {
      if (live) learn(products)
    })
    return () => {
      live = false
    }
    // `names` is deliberately not a dependency: learn() writes to it, so
    // including it would re-run this effect with every resolution.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  /*
   * Hand the resolved products up, in the owner's order.
   *
   * Only when EVERY pick is named. A partial list would flash a half-empty row
   * while the names for the rest were still in flight — the canvas already has
   * the server's copy to show until then, which is better than a flicker.
   */
  useEffect(() => {
    if (!onResolve) return
    const resolved = value.map((id) => names.get(id)).filter(Boolean) as StorefrontProduct[]
    if (resolved.length === value.length) onResolve(resolved)
  }, [value, names, onResolve])

  const full = value.length >= MAX_SECTION_ITEMS

  function addMany(products: StorefrontProduct[]) {
    learn(products)
    // Filter against the CURRENT value rather than trusting the dialog: it
    // already hides what is picked, but the room left is the invariant that
    // actually matters and it is cheap to enforce here as well.
    const room = MAX_SECTION_ITEMS - value.length
    const fresh = products.map((p) => p.id).filter((id) => !value.includes(id))
    if (fresh.length === 0) return
    onChange([...value, ...fresh.slice(0, room)])
  }

  function removeAt(index: number) {
    onChange(value.filter((_, i) => i !== index))
  }

  /** Move a pick one place. A splice, so the neighbour takes its old slot. */
  function move(index: number, direction: -1 | 1) {
    const to = index + direction
    if (to < 0 || to >= value.length) return
    const next = [...value]
    const [moved] = next.splice(index, 1)
    next.splice(to, 0, moved)
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-3" data-product-picker>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">Products in this row</p>
          <p className="text-xs text-muted">
            {full
              ? `That is the most a row can hold (${MAX_SECTION_ITEMS}).`
              : `${value.length} of ${MAX_SECTION_ITEMS} picked — shown in this order.`}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setBrowsing(true)} disabled={full}>
          <Icons.Plus size={15} />
          Add products
        </Button>
      </div>

      {value.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing picked yet — this row will not show on your page until you add something.
        </p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {value.map((id, index) => {
            const product = names.get(id)
            return (
              <li
                key={id}
                className="flex items-center gap-2 rounded-control border border-border bg-surface px-2.5 py-1.5"
              >
                <span className="numeric w-5 shrink-0 text-xs text-muted">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {/* A pick whose product we cannot resolve is one that has
                      stopped being published. Say so — it is silently absent
                      from the shop, and this is the only place that shows it. */}
                  {product ? product.description : <span className="text-muted">No longer published</span>}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Move up"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <Icons.ChevronUp size={15} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Move down"
                  disabled={index === value.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <Icons.ChevronDown size={15} />
                </Button>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Remove ${product?.description ?? 'product'}`}
                  onClick={() => removeAt(index)}
                >
                  <Icons.Close size={15} />
                </Button>
              </li>
            )
          })}
        </ol>
      )}

      <AddProductsDialog
        open={browsing}
        onClose={() => setBrowsing(false)}
        departments={departments}
        alreadyPicked={value}
        room={MAX_SECTION_ITEMS - value.length}
        onAdd={(products) => {
          addMany(products)
          setBrowsing(false)
        }}
      />
    </div>
  )
}

/**
 * The catalogue browser.
 *
 * Its selection lives here rather than in the parent, and <Modal> remounts its
 * children on every open — so a cancelled selection is genuinely discarded
 * instead of waiting inside for the next person to open the dialog.
 */
function AddProductsDialog({
  open,
  onClose,
  departments,
  alreadyPicked,
  room,
  onAdd,
}: {
  open: boolean
  onClose: () => void
  departments: StorefrontDepartment[]
  alreadyPicked: number[]
  /** How many more this row can hold. Selection is capped at it. */
  room: number
  onAdd: (products: StorefrontProduct[]) => void
}) {
  const [departmentId, setDepartmentId] = useState<number | null>(null)
  const [term, setTerm] = useState('')
  const [rows, setRows] = useState<StorefrontProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Map<number, StorefrontProduct>>(new Map())
  /** The store publishes nothing at all, so no search here can ever match. */
  const [publishesNothing, setPublishesNothing] = useState(false)

  /*
   * Load a page whenever the filters change.
   *
   * Debounced on the search term and guarded by `live`, because the department
   * <Select> and the search box can both settle out of order — a slow "co"
   * landing after a fast "coffee" would replace the right list with a stale one.
   */
  useEffect(() => {
    if (!open) return
    let live = true
    setLoading(true)
    const timer = setTimeout(
      () => {
        browseProductsAction({
          search: term.trim(),
          departmentId,
          limit: PAGE_SIZE,
        }).then((result) => {
          if (!live) return
          setRows(result.products)
          setPublishesNothing(result.publishesNothing)
          setLoading(false)
        })
      },
      // No wait on the first load or a department change — only typing needs
      // the debounce, and paying 250ms to open the dialog would be felt.
      term.trim() ? 250 : 0,
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, term, departmentId])

  /** What the list can offer: this page, minus what the row already holds. */
  const offered = useMemo(
    () => rows.filter((p) => !alreadyPicked.includes(p.id)),
    [rows, alreadyPicked],
  )

  const atCap = selected.size >= room

  function toggle(product: StorefrontProduct) {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(product.id)) next.delete(product.id)
      else if (next.size < room) next.set(product.id, product)
      return next
    })
  }

  /* Selecting the page is the common case for a small catalogue, so it gets a
     control rather than 40 clicks. Stops at `room` for the same reason the
     checkboxes do. */
  function selectAllOffered() {
    setSelected((prev) => {
      const next = new Map(prev)
      for (const p of offered) {
        if (next.size >= room) break
        if (!next.has(p.id)) next.set(p.id, p)
      }
      return next
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add products"
      description={`Pick as many as you like — up to ${room} more in this row.`}
      size="lg"
      /* The body grows and the RESULTS LIST scrolls inside it, so the search
         and department filters above stay put while products scroll past. */
      bodyPins
      /* Holds a half-made selection; a stray click on the backdrop must not
         throw it away. */
      closeOnBackdrop={false}
      footer={
        <>
          <span className="mr-auto text-sm text-muted">
            {selected.size === 0
              ? 'Nothing selected'
              : `${selected.size} selected${atCap ? ' — that is the row’s limit' : ''}`}
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={selected.size === 0}
            onClick={() => onAdd([...selected.values()])}
          >
            Add {selected.size > 0 ? selected.size : ''}
          </Button>
        </>
      }
    >
      {/* `min-h-0` so the results list below can shrink rather than pushing
          this column past the panel. */}
      <div className="flex min-h-0 flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <Field label="Search">
              <Input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Name or code…"
                icon={<Icons.Search size={15} />}
              />
            </Field>
          </div>
          <div className="min-w-48">
            <Field label="Department">
              <Select
                value={departmentId ?? ''}
                onChange={(e) => setDepartmentId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">All departments</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.productCount})
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button
            variant="ghost"
            onClick={selectAllOffered}
            disabled={loading || offered.length === 0 || atCap}
          >
            Select all
          </Button>
        </div>

        <div className="rounded-card border border-border overflow-hidden">
          {loading ? (
            <p className="px-3 py-6 text-center text-sm text-muted">Loading products…</p>
          ) : offered.length === 0 ? (
            /* Three different empty states, because they have three different
               fixes. "Nothing matches those filters" is actively misleading for
               a store that publishes nothing at all — the owner would retype a
               search that could never have worked. */
            <div className="px-3 py-6 text-center text-sm text-muted">
              {rows.length > 0 ? (
                'Everything here is already in this row.'
              ) : publishesNothing ? (
                <>
                  <p className="text-ink">Your shop is not publishing any products yet.</p>
                  <p className="mt-1">
                    Tick “Show in online store” on a department under{' '}
                    <TextLink href="/online-store/departments">Departments</TextLink>, or change
                    what you publish under <TextLink href="/online-store/setup">Setup</TextLink>.
                  </p>
                </>
              ) : (
                'Nothing published matches those filters.'
              )}
            </div>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto divide-y divide-border">
              {offered.map((product) => {
                const checked = selected.has(product.id)
                return (
                  <li key={product.id}>
                    {/* Not a kit Button: a full-width selection row with a
                        checkbox, two stacked lines and a right-aligned price,
                        which no button variant expresses. The whole row is the
                        hit target — a 16px checkbox is a mean thing to aim at
                        forty times. The Checkbox inside is presentation only
                        (it renders its own <label>, so it must not be nested
                        in another control); the row carries the aria state. */}
                    <button
                      type="button"
                      data-kit-ok
                      role="checkbox"
                      aria-checked={checked}
                      disabled={!checked && atCap}
                      onClick={() => toggle(product)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                    >
                      <Checkbox
                        checked={checked}
                        readOnly
                        tabIndex={-1}
                        aria-hidden="true"
                        className="pointer-events-none"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">
                          {product.description}
                        </span>
                        <span className="block truncate text-xs text-muted">{product.code}</span>
                      </span>
                      <span className="numeric text-sm text-ink-2">
                        {product.priceIncl.toFixed(2)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Say when the list is a page rather than the whole catalogue —
            otherwise an owner filters, sees 100, and assumes that is all of it. */}
        {!loading && rows.length >= PAGE_SIZE && (
          <p className="text-xs text-muted">
            Showing the first {PAGE_SIZE}. Search or pick a department to narrow it down.
          </p>
        )}
      </div>
    </Modal>
  )
}
