'use client'

import { Button, Badge, Icons, ExpandingCard } from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/decimals'
import { describeSelection } from '@/lib/instructionRules'
import { isPriceOverridden, type BasketLine } from '@/lib/basket'

/**
 * One line of the sale, as a CARD rather than a table row.
 *
 * ── WHY THIS INVERTS THE 36px TABLE DENSITY ───────────────────────────────
 *
 * The odyssey-craft rule is that rows are tight, because a 1,284-product list is
 * SCANNED and every pixel of padding is a product somebody has to scroll to
 * reach. A basket is the opposite instrument: eight to fifteen lines that get
 * TOUCHED, by a finger, by someone standing up and looking at a customer rather
 * than at the screen. Here the cost of a mis-tap is higher than the cost of a
 * scroll, so the same reasoning that produces 36px there produces ~64px here.
 *
 * Do not "fix" this to match the tables. It is the documented exception.
 *
 * A DataTable cannot express it either: the selected line GROWS to reveal its
 * actions, and a table row cannot hold a second row inside itself.
 */
export function SaleLineCard({
  line,
  lineTotal,
  effectiveDiscountPct,
  specialName,
  selected,
  onSelect,
  onStep,
  onEdit,
  onRemove,
}: {
  line: BasketLine
  lineTotal: number
  /** After the special-versus-manual comparison — what is actually charged. */
  effectiveDiscountPct: number
  /** Named when a promotion is what discounted this line. */
  specialName: string | null
  selected: boolean
  onSelect: () => void
  onStep: (delta: number) => void
  onEdit: () => void
  onRemove: () => void
}) {
  const refund = line.qty < 0
  const discounted = effectiveDiscountPct > 0

  return (
    <li>
      <ExpandingCard
        className="mx-2.5 my-2"
        open={selected}
        onToggle={onSelect}
        header={
          <>
            <span className="flex items-start gap-2">
              <span className="min-w-0 flex-1 text-[15px] font-semibold leading-tight text-ink">
                {line.description}
              </span>
              <span className="numeric shrink-0 text-[15px] font-bold text-ink">
                {formatMoney(lineTotal)}
              </span>
            </span>

            <span className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
              <span className="numeric">
                {formatQty(line.qty)} × {formatMoney(line.unitPriceIncl)}
              </span>

              {/* Badges only where they SAY something. A chip on every line is
                  decoration, and decoration is what hides the one line that is
                  actually unusual — see odyssey-craft on colour as meaning. */}
              {refund && <Badge tone="danger">Refund</Badge>}
              {discounted && (
                <Badge tone="warning">
                  {specialName ?? `${formatQty(effectiveDiscountPct)}% off`}
                </Badge>
              )}
              {isPriceOverridden(line) && <Badge tone="brand">Price changed</Badge>}
            </span>

            {/* What was chosen, and anything typed.
                This is the ONLY place a cashier sees the answers again before
                paying — the modal is gone by then — so a wrong tap has to be
                visible here or it reaches the kitchen unnoticed. The 'receipt'
                filter is deliberately not used: the cashier should see
                everything on the line, including the answers that will only
                print for the cook. */}
            {(line.instructions.length > 0 || line.note) && (
              <span className="flex flex-col gap-0.5 text-[13px] text-muted">
                {describeSelection(line.instructions).map((text, i) => (
                  <span key={i}>· {text}</span>
                ))}
                {line.note && <span className="italic">“{line.note}”</span>}
              </span>
            )}
          </>
        }
        /* Four buttons on every line would put sixty targets on screen and make
           the basket unreadable; one line's worth is a decision the cashier has
           just made. */
        actions={
          <>
            <Button
              variant="success"
              size="touch"
              className="flex-1"
              onClick={() => onStep(1)}
              aria-label="One more"
            >
              <Icons.Plus size={20} />
            </Button>
            <Button
              variant="ghost"
              size="touch"
              className="flex-1"
              onClick={() => onStep(-1)}
              aria-label="One fewer"
            >
              <Icons.Minus size={20} />
            </Button>
            <Button variant="ghost" size="touch" className="flex-[1.4]" onClick={onEdit}>
              <Icons.Pencil size={18} />
              Edit
            </Button>
            <Button
              variant="danger"
              size="touch"
              className="flex-[1.2]"
              onClick={onRemove}
              aria-label="Remove line"
            >
              <Icons.Trash size={18} />
            </Button>
          </>
        }
      />
    </li>
  )
}
