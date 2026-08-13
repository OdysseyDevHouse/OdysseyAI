'use client'

import { useMemo, useState, type MouseEvent } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { Badge, Button, Card, Icons, ToolbarSearch } from '@/components/ui'
import { ProductTile } from './tiles'
import type { DropData, MenuProduct } from './types'

/** Render cap — a real catalogue can hold thousands of unfiled SKUs. */
const PAGE = 40

/**
 * The "not on the menu" tray: every product with no department.
 *
 * These are not browsable at the till — a cashier can still scan or search for
 * them, but they have no tile. The tray is where they wait, and dragging one
 * out is how a product joins the menu. Dropping a menu product back in is how
 * it leaves.
 *
 * ── WHY IT IS A DROP TARGET AND ITS TILES ARE NOT ──────────────────────────
 *
 * The tray body takes drops; the tiles inside it decline them (see
 * ProductTile's `disabled` droppable). The tray has no order to land in, so a
 * tile absorbing a drop would swallow a drag meant for the tray underneath and
 * the gesture would fail for no visible reason.
 */
export function UnassignedTray({
  products,
  selection,
  activeIds,
  receiving,
  canEdit,
  onProductClick,
  onEdit,
  onToggleVisible,
}: {
  products: MenuProduct[]
  selection: Set<number>
  /** Ids in the live drag — drawn as the ghosts they left behind. */
  activeIds: Set<number>
  /** A drag from the canvas is over the tray body. */
  receiving: boolean
  canEdit: boolean
  onProductClick: (e: MouseEvent, id: number, visual: number[]) => void
  onEdit: (id: number) => void
  onToggleVisible: (id: number, on: boolean) => void
}) {
  const [open, setOpen] = useState(true)
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(PAGE)

  const { setNodeRef } = useDroppable({
    id: 'tray',
    data: { drop: { kind: 'tray' } satisfies DropData },
  })

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return products
    return products.filter(
      (p) =>
        p.description.toLowerCase().includes(term) ||
        p.code.toLowerCase().includes(term) ||
        (p.barcode ?? '').toLowerCase().includes(term),
    )
  }, [products, search])

  const shown = filtered.slice(0, limit)
  const visual = useMemo(() => shown.map((p) => p.id), [shown])

  return (
    <div ref={setNodeRef}>
      <Card className={receiving ? 'ring-2 ring-brand' : ''}>
        {/* data-kit-ok: the whole header is the disclosure control, and it
            holds a badge and a hint — not a shape any Button variant is. */}
        <button
          data-kit-ok
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-center gap-2.5 px-4 py-3.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          <span className="text-sm font-semibold text-ink">Not on the menu</span>
          <Badge tone={products.length ? 'warning' : 'success'}>{products.length}</Badge>
          <span className="text-sm text-muted">
            {receiving
              ? 'Drop here to take it off the menu'
              : 'Products with no department — drag them onto the menu above'}
          </span>
          <span aria-hidden className="ml-auto text-muted">
            {open ? <Icons.ChevronDown size={16} /> : <Icons.ChevronRight size={16} />}
          </span>
        </button>

        {open && (
          <div className="border-t border-border px-4 py-3.5">
            {products.length === 0 ? (
              <p className="py-2 text-sm text-muted">
                Nothing here — every product has a place on the menu.
              </p>
            ) : (
              <>
                <div className="mb-3 max-w-xs">
                  <ToolbarSearch
                    value={search}
                    onChange={(value) => {
                      setSearch(value)
                      setLimit(PAGE)
                    }}
                    placeholder="Search unfiled products…"
                  />
                </div>

                {filtered.length === 0 ? (
                  <p className="py-2 text-sm text-muted">
                    Nothing here matches “{search.trim()}”.
                  </p>
                ) : (
                  <div className="flex gap-4 overflow-x-auto pb-2">
                    {shown.map((p) => (
                      <div key={p.id} className="w-[168px] flex-none">
                        <ProductTile
                          product={p}
                          dragId={`tray-${p.id}`}
                          fromTray
                          selected={selection.has(p.id)}
                          dimmed={activeIds.has(p.id)}
                          zone={null}
                          canEdit={canEdit}
                          onClick={(e) => onProductClick(e, p.id, visual)}
                          onEdit={() => onEdit(p.id)}
                          onToggleVisible={(on) => onToggleVisible(p.id, on)}
                        />
                      </div>
                    ))}

                    {filtered.length > limit && (
                      <div className="flex w-[168px] flex-none items-center justify-center">
                        <Button variant="ghost" onClick={() => setLimit((l) => l + PAGE)}>
                          Show {Math.min(PAGE, filtered.length - limit)} more
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}
