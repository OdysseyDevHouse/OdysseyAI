'use client'

import { Button, Icons, Modal } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'

/**
 * What happened, immediately after the sale posts.
 *
 * Shows two things and nothing else: the CHANGE to hand back, and the number the
 * customer's slip carries. Everything else a cashier might want — a reprint, the
 * document itself — is a tap away rather than on screen, because this dialog is
 * open for about three seconds while money changes hands.
 *
 * Change is the larger of the two on purpose. The invoice number matters later,
 * to whoever files it; the change matters now, to the person waiting for it.
 */
export function ReceiptModal({
  open,
  documentNumber,
  change,
  canVoid,
  posted,
  canPrint,
  onClose,
  onPrint,
  onOpen,
  onGiftReceipt,
  onEmail,
  onVoid,
}: {
  open: boolean
  documentNumber: string
  change: number
  /**
   * Whether to offer Void at all.
   *
   * This is the honest place for it: the sale is same-day by definition, the
   * cashier is looking at it, and `voidDocument` refuses anything older anyway.
   * A cashier without `sales.void` simply does not see it — and the action
   * re-checks, because a hidden button is not a boundary.
   */
  canVoid: boolean
  /**
   * Whether the sale is ON THE SERVER.
   *
   * False for one rung up offline: the number is real and the customer may leave
   * with the slip, but no document exists yet, so Open and Void have nothing to
   * act on.
   */
  posted: boolean
  /**
   * Whether Print can do anything. True for a posted sale (the slip route
   * exists) and for an OFFLINE sale on a till with a print bridge — the slip
   * was built from the basket and the bridge is local, so paper still comes
   * out with the server gone.
   */
  canPrint: boolean
  onClose: () => void
  /** Prints the 80mm slip. */
  onPrint: () => void
  /** Opens the document in the back office — the void/credit surface. */
  onOpen: () => void
  /** The price-suppressed variant, for a present. */
  onGiftReceipt: () => void
  /** Emails the invoice. Undefined offline — there is no document to attach. */
  onEmail?: () => void
  onVoid: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sale complete"
      size="sm"
      footer={
        <>
          {/* Print IS print now — the 80mm slip route (or the ESC/POS bridge).
              Open keeps its old job: the back-office document, the void/credit
              surface. Both hidden for a sale rung up offline — no document
              exists yet, and a button that reliably 404s is worse than none. */}
          {posted && (
            <>
              <Button variant="ghost" size="touch" onClick={onOpen}>
                Open
              </Button>
              {onEmail && (
                <Button variant="ghost" size="touch" onClick={onEmail}>
                  Email
                </Button>
              )}
              <Button variant="ghost" size="touch" onClick={onGiftReceipt}>
                Gift
              </Button>
            </>
          )}
          {canPrint && (
            <Button variant="secondary" size="touch" onClick={onPrint}>
              <Icons.Printer size={18} />
              Print
            </Button>
          )}
          <Button variant="success" size="touch-lg" className="flex-1 justify-center" onClick={onClose}>
            Next sale
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {change > 0 && (
          <div className="rounded-card border border-success/40 bg-success-soft px-4 py-4 text-center">
            <span className="block text-xs font-semibold uppercase tracking-wide text-success-ink">
              Change
            </span>
            <span className="numeric block text-5xl font-extrabold text-success-ink">
              {formatMoney(change)}
            </span>
          </div>
        )}

        <div className="rounded-card border border-border bg-surface-2 px-4 py-3 text-center">
          <span className="block text-xs text-muted">Invoice number</span>
          {/* selectable because .till-surface blocks selection everywhere else,
              and this is exactly the string somebody legitimately copies. */}
          <span className="selectable numeric block text-lg font-bold text-ink">
            {documentNumber}
          </span>
        </div>

        {/*
         * Rung up offline: say so, on the one screen the cashier is definitely
         * looking at.
         *
         * This is a REAL tax invoice with a real number — the customer can leave
         * with it — and the only difference is that the shop's own books have not
         * caught up yet. Stated plainly, because a cashier who thinks it did not go
         * through will ring it up a second time.
         */}
        {!posted && (
          <div className="rounded-card border border-brand/40 bg-brand-soft px-4 py-3 text-center">
            <span className="block text-sm font-medium text-brand">
              Saved on this till
            </span>
            <span className="mt-0.5 block text-xs text-muted">
              A valid tax invoice. It will send itself when the connection is back —
              don&apos;t ring it up again.
            </span>
          </div>
        )}

        {/* Void sits here, small and text-only, well away from "Next sale".
            It reverses real money, so it must be findable without being anywhere
            near the key a cashier taps a hundred times a day.

            Offline it is hidden: voidDocument needs the document, which does not
            exist yet. Cancelling an unsynced sale is the outbox screen's job and has
            different rules — the number is BURNT rather than reused. */}
        {canVoid && posted && (
          <Button variant="danger-ghost" size="sm" className="self-center" onClick={onVoid}>
            <Icons.Trash size={14} />
            Something wrong? Void this sale
          </Button>
        )}
      </div>
    </Modal>
  )
}
