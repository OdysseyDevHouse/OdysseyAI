'use client'

import { useState } from 'react'
import { Button, Drawer } from '@/components/ui'
import {
  Barcode,
  Boxes,
  Calculator,
  Factory,
  Gift,
  Link2,
  Package,
  Reverse,
  ShoppingCart,
  Wrench,
} from '@/components/ui/icons'
import {
  PRODUCT_TYPES,
  PRODUCT_TYPE_GROUPS,
  type ProductTypeId,
} from '@/lib/productTypes'

/**
 * A glyph per type, so the picker can be scanned by shape rather than read.
 *
 * Kept here rather than on the type itself: `productTypes.ts` is imported by
 * server code that has no business pulling in an icon set, and a lucide element
 * is not something a plain data module should hold.
 */
const TYPE_ICON: Record<ProductTypeId, typeof Package> = {
  normal: Package,
  returnable: Reverse,
  recipe: Factory,
  refer: Link2,
  batch: Boxes,
  serial: Barcode,
  buyout: ShoppingCart,
  calcqty: Calculator,
  gift_card: Gift,
  service: Wrench,
}

/**
 * Which kind of product this is.
 *
 * The panel shows the ONE type in force, not all ten: a product has a type the
 * overwhelming majority of the time it is opened, and a grid of ten tiles asked
 * that settled question again on every visit while crowding out the rest of the
 * form. Changing it is a deliberate act, so it opens a drawer of the full list
 * — where each type gets room for its glyph, its name and a line saying what it
 * does, grouped by whether it carries stock.
 *
 * The value reaches the form through a hidden input rather than the radios in
 * the drawer, because a <dialog> in the top layer is NOT inside the <form> that
 * opened it and its inputs would never be submitted.
 */
export default function ProductTypePanel({
  defaultValue,
  onChange,
  onSetupClick,
}: {
  defaultValue: ProductTypeId
  /**
   * Told to the form so the Recipe, Refer and Serials tabs can appear with the
   * type they belong to. Kept as a callback rather than lifting the state out
   * entirely: this panel still owns its own selection.
   */
  onChange?: (next: ProductTypeId) => void
  /** Jumps to the tab that configures the selected type. */
  onSetupClick?: (type: ProductTypeId) => void
}) {
  const [selected, setSelected] = useState<ProductTypeId>(defaultValue)
  const [picking, setPicking] = useState(false)

  const current = PRODUCT_TYPES.find((t) => t.id === selected) ?? PRODUCT_TYPES[0]
  const CurrentIcon = TYPE_ICON[current.id]

  function choose(next: ProductTypeId) {
    setSelected(next)
    onChange?.(next)
    // Picking IS the commit — there is nothing else to say in the drawer, so
    // leaving it open would only make the user close it themselves.
    setPicking(false)
  }

  return (
    /* No padding of its own. It carried p-6 from when it filled a Card of its
       own; it now sits under a field label inside one, where that inset only
       pushed it out of line with the fields either side of it. */
    <div>
      <input type="hidden" name="productType" value={selected} />

      {/* The type in force. A plain readout on a hairline, not a brand-tinted
          selection: by the time this card is on screen the choice is settled,
          and colouring a settled fact spends the accent that marks the live
          selection inside the picker. */}
      <div className="flex flex-wrap items-center gap-4 rounded-card border border-border bg-surface p-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full border border-brand/25 bg-brand-soft text-brand">
          <CurrentIcon size={20} />
        </span>
        {/* basis-48 rather than min-w-0: the buttons beside it are shrink-0, so
            a zero minimum let the text give up ALL its width to keep them on
            one line — in a half-width column the name broke to "Serial /
            product" over a ~90px ribbon. With a floor, the row wraps the whole
            action group onto its own line instead, which is what a narrow
            column wants. */}
        <div className="flex-1 basis-48">
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
            {current.name}
          </div>
          <p className="mt-0.5 text-xs text-muted">{current.summary}</p>
        </div>
        {/* ml-auto so the group still sits hard right once it has wrapped onto
            a line of its own. */}
        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
          {current.setupLabel && onSetupClick && (
            <Button variant="ghost" size="sm" onClick={() => onSetupClick(current.id)}>
              {current.setupLabel}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setPicking(true)}>
            Change product type
          </Button>
        </div>
      </div>

      <Drawer
        open={picking}
        onClose={() => setPicking(false)}
        title="Choose product type"
        description="Decides how a sale moves this product's stock."
        footer={
          <Button variant="ghost" onClick={() => setPicking(false)}>
            Cancel
          </Button>
        }
      >
        <div className="flex flex-col gap-5">
          {PRODUCT_TYPE_GROUPS.map((group) => {
            const types = PRODUCT_TYPES.filter((t) => t.group === group.id)
            if (types.length === 0) return null

            return (
              <div key={group.id}>
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted">
                  {group.name}
                </h3>
                {/* One rounded block of rows, hairline-separated: ten separate
                    cards would put nine gaps into a list that is read top to
                    bottom in one go. */}
                <div className="divide-y divide-border overflow-hidden rounded-card border border-border">
                  {types.map((type) => {
                    const Icon = TYPE_ICON[type.id]
                    const isSelected = selected === type.id

                    return (
                      /* Not a kit control: a full-width row carrying a radio, a
                         glyph, a name, a badge and a line of explanation.
                         SelectableCard is a tile and cannot lay that out. It
                         behaves as a radio because it IS one. */
                      <label
                        key={type.id}
                        data-kit-ok
                        className={`flex cursor-pointer items-center gap-3 px-3 py-3 transition ${
                          isSelected ? 'bg-brand-soft' : 'bg-surface hover:bg-surface-2'
                        }`}
                      >
                        <input
                          type="radio"
                          name="productTypeChoice"
                          value={type.id}
                          checked={isSelected}
                          onChange={(e) => e.target.checked && choose(type.id)}
                          className="size-4 shrink-0 accent-brand"
                        />
                        <span
                          className={`flex size-9 shrink-0 items-center justify-center rounded-control border ${
                            isSelected
                              ? 'border-brand/25 bg-surface text-brand'
                              : 'border-border bg-surface-2 text-muted'
                          }`}
                        >
                          <Icon size={17} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
                            {type.name}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted">
                            {type.summary}
                          </span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </Drawer>
    </div>
  )
}
