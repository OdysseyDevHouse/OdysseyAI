'use client'

import { useMemo, useState } from 'react'
import { Button, Modal } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { TillProduct } from '@/lib/site/tillSearch'
import type { VariantAxis } from '@/lib/site/productVariants'

/**
 * Which one — the size/colour picker behind a variant group tile (070).
 *
 * The LotModal pattern, and for the same reason every prompt in this folder
 * follows it: a product that cannot be sold as it stands opens a dialog on the
 * way into `add()` rather than being refused at the tender pad with the
 * customer's card already out.
 *
 * What makes this one different is that it does not decorate a line, it CHOOSES
 * one. A parent holds no stock and `recordMovement` refuses it outright, so the
 * thing this modal hands back is a different product from the one that opened
 * it — the child — and that child then runs the whole of `add()` itself. A
 * variant that is also a batch item gets its lot prompt straight afterwards,
 * for free, because the chain is re-entered rather than short-circuited.
 *
 * ── WHY OUT-OF-STOCK CHILDREN ARE STILL SELLABLE ─────────────────────────
 *
 * The same call LotModal makes about expired lots, and for the same reason: the
 * shop's figure is a claim about the stockroom, and the customer is holding the
 * garment. A till that refused the sale would be arguing with the person at the
 * counter about a number only the shop can be wrong about. So a sold-out size
 * is shown, marked, and sells — the mark is there to prompt a word with the
 * customer, not to block one.
 *
 * ── WHY IMPOSSIBLE COMBINATIONS ARE SHOWN, DISABLED ──────────────────────
 *
 * With two axes the grid is rarely full: a shop stocks 3XL in black but not in
 * red. Hiding those buttons would make the second row change length as the
 * first row is tapped, so a cashier reaching for a button would find something
 * else under their finger. Disabled and visible, the shape of the range stays
 * still and the answer to "do you have this in red" is on screen rather than
 * inferred from an absence.
 */
export function VariantModal({
  parent,
  childrenProducts: children,
  axes,
  priceFor,
  onConfirm,
  onCancel,
}: {
  /** The group that was tapped. Never sold itself — only its members are. */
  parent: TillProduct
  /**
   * The members, already filtered to what this till may sell and in the shop's
   * own `variant_sort` order. Sizes are not alphabetical, which is the whole
   * reason that column exists — so this list is never re-sorted here.
   */
  childrenProducts: TillProduct[]
  /** What the axes are called: 'Size', 'Colour'. Empty falls back to generic. */
  axes: VariantAxis[]
  /** Live price including any schedule due — the same figure the tile shows. */
  priceFor: (product: TillProduct) => number
  onConfirm: (child: TillProduct) => void
  onCancel: () => void
}) {
  /*
   * The two axes' distinct values, in the order the children arrive — which is
   * the shop's `variant_sort`. A Set preserves insertion order, so S/M/L/XL
   * stays S/M/L/XL rather than sorting to L/M/S/XL.
   */
  const [values1, values2] = useMemo(() => {
    const a = new Set<string>()
    const b = new Set<string>()
    for (const c of children) {
      if (c.axis1Value) a.add(c.axis1Value)
      if (c.axis2Value) b.add(c.axis2Value)
    }
    return [[...a], [...b]]
  }, [children])

  const twoAxes = values2.length > 0

  /*
   * Preselected when there is only one thing it could be.
   *
   * A single-axis group with one value left in stock, or a range that has been
   * whittled down to one, should not make somebody tap a button that has no
   * alternative. Anything with a real choice starts blank: preselecting the
   * first size would let a distracted tap sell a medium to someone who asked
   * for a large, and there is no cheaper mistake to make than that one.
   */
  const [pick1, setPick1] = useState(values1.length === 1 ? values1[0] : '')
  const [pick2, setPick2] = useState(values2.length === 1 ? values2[0] : '')

  /** The child at this intersection, if the shop stocks that combination. */
  function childAt(v1: string, v2: string): TillProduct | undefined {
    return children.find(
      (c) => c.axis1Value === v1 && (!twoAxes || c.axis2Value === v2),
    )
  }

  /*
   * Whether a button leads anywhere.
   *
   * Read against the OTHER axis's current pick, so tapping 'Red' greys the
   * sizes that do not come in red. With nothing picked on the other axis every
   * value that exists at all is live — otherwise the grid would open entirely
   * disabled and look broken.
   */
  function enabled1(v1: string): boolean {
    if (!twoAxes || !pick2) return true
    return children.some((c) => c.axis1Value === v1 && c.axis2Value === pick2)
  }
  function enabled2(v2: string): boolean {
    if (!pick1) return true
    return children.some((c) => c.axis2Value === v2 && c.axis1Value === pick1)
  }

  const chosen = pick1 && (!twoAxes || pick2) ? childAt(pick1, pick2) : undefined

  const label1 = axes.find((a) => a.position === 1)?.label || 'Option'
  const label2 = axes.find((a) => a.position === 2)?.label || 'Option'

  return (
    <Modal
      open
      onClose={onCancel}
      title={parent.description}
      /* The chosen row is what the cashier is about to commit, so it sits with
         the button that commits it rather than scrolling away above a long
         range. The kit's body caps at 60vh and a 40-size range scrolls. */
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted">
            {chosen ? (
              <>
                <span className="font-medium text-ink">{chosen.code}</span>
                {' · '}
                <span className="numeric">{formatMoney(priceFor(chosen))}</span>
              </>
            ) : (
              `Choose a ${twoAxes ? `${label1.toLowerCase()} and ${label2.toLowerCase()}` : label1.toLowerCase()}.`
            )}
          </span>
          <span className="flex gap-2">
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="success" disabled={!chosen} onClick={() => chosen && onConfirm(chosen)}>
              Add to sale
            </Button>
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <AxisRow
          label={label1}
          values={values1}
          picked={pick1}
          isEnabled={enabled1}
          noteFor={(v) => (twoAxes ? '' : soldOutNote(childAt(v, '')))}
          onPick={setPick1}
        />
        {twoAxes && (
          <AxisRow
            label={label2}
            values={values2}
            picked={pick2}
            isEnabled={enabled2}
            noteFor={(v) => (pick1 ? soldOutNote(childAt(pick1, v)) : '')}
            onPick={setPick2}
          />
        )}

        {/* Said once, under the grid, rather than on each sold-out button: a
            badge repeated down a column of sizes is decoration, but the fact
            that the shop's count says none is worth one line of prose. */}
        {chosen && chosen.availableQty <= 0 && (
          <p className="text-sm text-warning-ink">
            The count says none of this one is on the shelf. It will still sell.
          </p>
        )}
      </div>
    </Modal>
  )
}

/** 'Sold out' where the shop's count has run dry, and nothing where it has not. */
function soldOutNote(child: TillProduct | undefined): string {
  if (!child) return ''
  return child.availableQty <= 0 ? 'Sold out' : ''
}

/**
 * One axis — its caption and its buttons.
 *
 * Buttons rather than a `Select`: a till is a touch screen, the values are
 * short, and a dropdown puts the choice behind an extra tap and a list that
 * covers what is beneath it. That is the same argument `CatalogPane` makes for
 * feeding the pane instead of a combobox.
 */
function AxisRow({
  label,
  values,
  picked,
  isEnabled,
  noteFor,
  onPick,
}: {
  label: string
  values: string[]
  picked: string
  isEnabled: (value: string) => boolean
  /** A short note under the value — 'Sold out', or nothing at all. */
  noteFor: (value: string) => string
  onPick: (value: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <div className="flex flex-wrap gap-2">
        {values.map((v) => {
          const on = picked === v
          const live = isEnabled(v)
          const note = noteFor(v)
          return (
            <button
              key={v}
              type="button"
              disabled={!live}
              onClick={() => onPick(v)}
              /* Not a kit Button: this is a two-line SELECTABLE cell — a value
                 with a stock note under it, holding a pressed state — which
                 Button's variants express as meaning ("this commits", "this
                 destroys") rather than as selection. Wearing the kit's control
                 height, radius and tokens so it sits in the same system. */
              data-kit-ok
              className={`flex min-w-[4.5rem] min-h-control flex-col items-center justify-center rounded-control border px-4 py-2 text-sm transition ${
                on
                  ? 'border-brand bg-brand-soft font-medium text-ink'
                  : live
                    ? 'border-border bg-surface text-ink hover:bg-surface-2'
                    : 'cursor-not-allowed border-border bg-surface-2 text-faint'
              }`}
            >
              <span>{v}</span>
              {note && <span className="text-xs font-normal text-warning-ink">{note}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
