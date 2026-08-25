'use client'

import { Modal, Button, Badge, Icons } from '@/components/ui'
import type { PriceStructure } from '@/lib/site/lookups'

/**
 * Which price type this sale is being rung at.
 *
 * ── THIS IS NOT A PRICE OVERRIDE ──────────────────────────────────────────
 *
 * The key that opens this used to edit the selected LINE's price, which is a
 * different act with a different meaning: an override says "this one item, this
 * once, at this figure", and it is a departure from the price list that a manager
 * should see. This says "everything from here is trade", and it is not a departure
 * from anything — wholesale IS a price the shop set. One is an exception, the
 * other is a mode.
 *
 * Line overrides did not go anywhere. Tapping a line still opens the editor with
 * its price field, which is where a one-item exception belongs and where the
 * override rights and the product's discount ceiling are already enforced.
 *
 * ── WHY IT DOES NOT REPRICE WHAT IS ALREADY IN THE BASKET ─────────────────
 *
 * Switching changes what is added NEXT. Lines already rung up keep the price they
 * were rung at, which is the same discipline attaching an account mid-sale
 * follows — and it is the honest one: the cashier watched those lines go on at
 * those prices, and a screen that silently rewrote figures a customer has already
 * been shown is a screen nobody can trust. Retotalling half a basket under a
 * customer's nose is also how a dispute starts.
 *
 * The dialog says so rather than leaving it to be discovered, which is the whole
 * reason the note is on screen and not in this comment alone.
 */
export function PriceTypeModal({
  open,
  structures,
  /** What the sale is priced at right now — the resolved answer, not the override. */
  activeId,
  /** What it would fall back to with no override: the account's, else the site's. */
  defaultId,
  /** Whether an account is imposing that default. Changes what "Default" means. */
  fromCustomer,
  hasLines,
  onPick,
  onClose,
}: {
  open: boolean
  structures: PriceStructure[]
  activeId: number | null
  defaultId: number | null
  fromCustomer: boolean
  hasLines: boolean
  onPick: (structureId: number | null) => void
  onClose: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Price type"
      description="What the rest of this sale rings up at. It goes back to normal when the sale is done."
      size="sm"
      /* One touch-sized block per pricing structure, so a wholesaler with six
         price types outgrew the cap. Still a MAX — a shop with two stays small. */
      bodyGrows
      footer={
        <Button variant="secondary" size="touch" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-2">
        {structures.map((structure) => {
          const active = structure.id === activeId
          return (
            <button
              key={structure.id}
              type="button"
              onClick={() => onPick(structure.id === defaultId ? null : structure.id)}
              /* Not a kit Button: this is a full-width selection row carrying a name,
                 a state badge and a tick — three pieces of content a Button has no
                 slot for. The kit's row components are all table-shaped, and a table
                 of one column for four options would be heavier than what it holds. */
              data-kit-ok
              className={`flex w-full items-center justify-between gap-3 rounded-control border px-4 py-3 text-left transition ${
                active
                  ? 'border-brand bg-brand-soft text-brand-ink'
                  : 'border-border bg-surface text-ink hover:bg-surface-2'
              }`}
            >
              <span className="flex items-center gap-3">
                <span className="text-base font-medium">{structure.name}</span>
                {structure.id === defaultId && (
                  <Badge tone={fromCustomer ? 'brand' : 'neutral'}>
                    {/* Named for WHY it is the default. A cashier who switches away
                        from a customer's own price list should know that is what they
                        are doing — it is the account's list, not just the shop's. */}
                    {fromCustomer ? 'This account' : 'Normal'}
                  </Badge>
                )}
              </span>
              {active && <Icons.Check size={20} />}
            </button>
          )
        })}

        {hasLines && (
          <p className="pt-1 text-sm text-muted">
            What is already on the sale keeps the price it was rung up at. This changes what
            you add next.
          </p>
        )}
      </div>
    </Modal>
  )
}
