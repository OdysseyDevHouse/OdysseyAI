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
      /* The tick belongs beside the title rather than above the amount: it
         answers "did that go through?", which is a different question from
         "what do I hand back?" and should not compete with the change. */
      titleMedia={
        <span className="flex size-8 items-center justify-center rounded-pill bg-success text-white">
          <Icons.Check size={18} strokeWidth={3} />
        </span>
      }
      /* Sized by the FOOTER, not the body. Five touch-size keys measure ~535px
         of buttons plus gaps and the panel's own padding; at `sm` (448px) they
         overflowed and "Open" was clipped by the panel edge, and at `md` (576px)
         they fit only by wrapping "Next sale" onto a line of its own. `lg`
         (768px) is the first width that holds the row a cashier actually uses
         on ONE line. Every Button is `shrink-0 whitespace-nowrap`, so this row
         genuinely cannot be made narrower — the panel has to give. */
      size="lg"
      footer={
        <>
          {/* Print IS print now — the 80mm slip route (or the ESC/POS bridge).
              Open keeps its old job: the back-office document, the void/credit
              surface. Both hidden for a sale rung up offline — no document
              exists yet, and a button that reliably 404s is worse than none.

              Each wears its glyph so the row is scannable at arm's length —
              a cashier finds "the gift one" by shape long before reading it. */}
          {posted && (
            <>
              <Button variant="ghost" size="touch" onClick={onOpen}>
                <Icons.FolderOpen size={18} />
                Open
              </Button>
              {onEmail && (
                <Button variant="ghost" size="touch" onClick={onEmail}>
                  <Icons.Mail size={18} />
                  Email
                </Button>
              )}
              <Button variant="ghost" size="touch" onClick={onGiftReceipt}>
                <Icons.Gift size={18} />
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
          {/* The arrow points OUT of the dialog — this key does not confirm
              anything, it clears the screen for the next customer.

              `touch` and not `touch-lg`, and no `flex-1`: at touch-lg it could
              not share a line with the other four and wrapped to a row of its
              own, which puts the key a cashier taps all day in a different place
              depending on whether the sale can be voided. It stays the primary
              by COLOUR and by extra width, both of which survive at any size. */}
          <Button variant="success" size="touch" className="grow px-6" onClick={onClose}>
            Next sale
            <Icons.ArrowRight size={18} />
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {change > 0 && (
          /* The one thing on this screen with a job to do RIGHT NOW. It gets the
             size, the colour and the only decoration in the dialog, because the
             cashier is reading it with a customer's hand already out. */
          <div className="relative overflow-hidden rounded-card border border-success/30 bg-success-soft px-4 py-7 text-center">
            {/* Confetti — purely decorative, so it is hidden from screen readers
                and sits behind the figure it celebrates. Tokened opacities of
                `success`, never a raw colour. */}
            <Sparkle className="left-[12%] top-[42%] size-2.5 opacity-70" />
            <Sparkle className="left-[18%] top-[26%] size-4 opacity-50" />
            <Sparkle className="left-[8%] top-[62%] size-2 opacity-40" />
            <Sparkle className="right-[13%] top-[30%] size-2 opacity-50" />
            <Sparkle className="right-[9%] top-[46%] size-3.5 opacity-70" />
            <Sparkle className="right-[16%] top-[64%] size-2 opacity-40" />

            <span className="relative block text-sm font-bold uppercase tracking-[0.12em] text-success-ink">
              Change
            </span>
            <span className="numeric relative block text-7xl font-extrabold leading-tight text-success-ink">
              {formatMoney(change)}
            </span>
          </div>
        )}

        {/* A row rather than a centred block: this is a reference someone reads
            off or copies later, not a number anybody acts on now. Left-aligned
            behind its own glyph, it reads as filing — which is what it is. */}
        <div className="flex items-center gap-4 rounded-card border border-border bg-surface-2 px-4 py-4">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-pill border border-border bg-surface text-muted">
            <Icons.TaxInvoice size={20} />
          </span>
          <div className="min-w-0">
            <span className="block text-sm text-muted">Invoice number</span>
            {/* selectable because .till-surface blocks selection everywhere else,
                and this is exactly the string somebody legitimately copies. */}
            <span className="selectable numeric block truncate text-xl font-bold text-ink">
              {documentNumber}
            </span>
          </div>
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

        {/* Void sits here, in the body and well away from "Next sale".
            It reverses real money, so it must be findable without being anywhere
            near the key a cashier taps a hundred times a day.

            Offline it is hidden: voidDocument needs the document, which does not
            exist yet. Cancelling an unsynced sale is the outbox screen's job and has
            different rules — the number is BURNT rather than reused. */}
        {canVoid && posted && (
          /* Outlined rather than bare text: at till distance a text-only control
             on a white panel is easy to miss entirely, and this is the one
             escape hatch from a sale that just took money. Still `danger-ghost`
             — findable, never as loud as the key beside it in the footer. */
          <Button
            variant="danger-ghost"
            className="self-center border-danger/40"
            onClick={onVoid}
          >
            <Icons.Trash size={16} />
            Something wrong? Void this sale
          </Button>
        )}
      </div>
    </Modal>
  )
}

/**
 * One four-pointed glint on the change card.
 *
 * A drawn shape rather than an icon: `Icons.Sparkles` is three stars in a fixed
 * arrangement, and scattering it reads as a repeated logo. This is a single
 * point, so position and size can vary per instance and the group looks strewn.
 *
 * Local to this file on purpose — it is decoration for ONE card, not a kit
 * component. If a second screen ever wants it, that is the moment it moves to
 * `components/ui/` and onto the Style Guide, not before.
 *
 * Caller passes position/size/opacity; `currentColor` inherits `text-success`
 * so the colour stays a token.
 */
function Sparkle({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`pointer-events-none absolute text-success ${className ?? ''}`}
      fill="currentColor"
    >
      {/* Four cubic arcs pinched toward the centre — a star whose waist is thin
          enough to glint rather than read as a plus sign. */}
      <path d="M12 0c.6 6.4 5 10.8 12 12-7 1.2-11.4 5.6-12 12-.6-6.4-5-10.8-12-12C7 10.8 11.4 6.4 12 0Z" />
    </svg>
  )
}
