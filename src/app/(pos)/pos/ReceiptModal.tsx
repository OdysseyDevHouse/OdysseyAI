'use client'

import { Button, Icons, Modal } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { SuccessBurst } from './SuccessBurst'

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
  tip,
  posted,
  canPrint,
  onClose,
  onPrint,
  onOpen,
  onGiftReceipt,
  onEmail,
}: {
  open: boolean
  documentNumber: string
  /**
   * What to hand back. Always shown, zero included — see the panel below.
   */
  change: number
  /**
   * What was kept as a tip out of the same over-tender, if any.
   *
   * Undefined on every path where a tip cannot arise (a refund, an exchange),
   * which is not the same claim as 0 — but both render nothing, because a
   * "Tip R0.00" line on a retail sale is noise on a screen that has three
   * seconds of a cashier's attention.
   */
  tip?: number
  /**
   * Whether the sale is ON THE SERVER.
   *
   * False for one rung up offline: the number is real and the customer may leave
   * with the slip, but no document exists yet, so Open has nothing to act on.
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
  /** Prints this till's paper — the 80mm slip, or A4 on a trade counter. */
  onPrint: () => void
  /** Opens the document in the back office — the void/credit surface. */
  onOpen: () => void
  /**
   * The price-suppressed variant, for a present. Undefined on a trade counter:
   * a gift receipt is an 80mm slip with the prices struck out and has no A4
   * counterpart, and nobody gift-wraps an account invoice.
   */
  onGiftReceipt?: () => void
  /** Emails the invoice. Undefined offline — there is no document to attach. */
  onEmail?: () => void
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
              {onGiftReceipt && (
                <Button variant="ghost" size="touch" onClick={onGiftReceipt}>
                  <Icons.Gift size={18} />
                  Gift
                </Button>
              )}
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
        {/*
          ── THE TICK, DRAWN ───────────────────────────────────────────────
          The header's static tick answers "did that go through?" the moment
          the panel paints. This one answers it a beat later and LOUDER, in
          the place the cashier's eye is already heading — dead centre, above
          the change.

          It runs once and stops (see SuccessBurst): a loop would still be
          celebrating while the next customer is being served. Purely
          decorative, so it is hidden from screen readers — the dialog's own
          title already says "Sale complete", and this repeats nothing.

          A SQUARE box, matching the artwork's square viewBox. An SVG letterboxes
          to preserve its aspect ratio, so the first attempt — full width, `h-32`
          — fit a wide canvas into a short row and drew the disc at 51px, SMALLER
          than the static tick already in the header. Square in, square out: at
          `size-28` the disc gets its full 112px.

          `size-28` and not larger because the panel above the fold also has to
          hold the change and the invoice number on a 768-high till.
          `overflow-visible` so the burst, which is drawn outside the viewBox,
          flies across the padding instead of being clipped at this box's edge —
          which is why the negative margins are safe: nothing here needs the
          room the particles pass through. */}
        <div className="-mb-2 -mt-1 flex shrink-0 justify-center">
          <SuccessBurst className="size-28 overflow-visible" />
        </div>

        {/*
          ── ALWAYS SHOWN, EVEN AT ZERO ────────────────────────────────────
          This used to render only when `change > 0`, which meant the panel a
          cashier reads for the answer was ABSENT in the commonest case — a
          card payment or exact cash. In a queue that is indistinguishable from
          a slow render, so the honest answer is a stated zero: "nothing to hand
          back" is information, and its absence is not.

          Zero is drawn quieter than a real amount — same size and position, so
          the eye lands in one place either way, but in the neutral tokens
          rather than the celebratory ones. A till that shouts at every sale
          stops being read. */}
        {(() => {
          const owing = change > 0
          return (
            <div
              className={`relative overflow-hidden rounded-card border px-4 py-7 text-center ${
                owing ? 'border-success/30 bg-success-soft' : 'border-border bg-surface-2'
              }`}
            >
              {/* Confetti — purely decorative, so it is hidden from screen readers
                  and sits behind the figure it celebrates. Tokened opacities of
                  `success`, never a raw colour. Only for money actually going
                  back: nothing is being celebrated at zero. */}
              {owing && (
                <>
                  <Sparkle className="left-[12%] top-[42%] size-2.5 opacity-70" />
                  <Sparkle className="left-[18%] top-[26%] size-4 opacity-50" />
                  <Sparkle className="left-[8%] top-[62%] size-2 opacity-40" />
                  <Sparkle className="right-[13%] top-[30%] size-2 opacity-50" />
                  <Sparkle className="right-[9%] top-[46%] size-3.5 opacity-70" />
                  <Sparkle className="right-[16%] top-[64%] size-2 opacity-40" />
                </>
              )}

              <span
                className={`relative block text-sm font-bold uppercase tracking-[0.12em] ${
                  owing ? 'text-success-ink' : 'text-muted'
                }`}
              >
                Change
              </span>
              <span
                className={`numeric relative block text-7xl font-extrabold leading-tight ${
                  owing ? 'text-success-ink' : 'text-ink'
                }`}
              >
                {formatMoney(change)}
              </span>

              {/*
                ── THE TIP, BESIDE THE CHANGE THAT IT SPLIT ──────────────────
                A tip and change divide ONE over-tender. Without this line a
                cashier handed R500 on a R430 bill with R20 left as a tip sees
                only "R50" and has no way to tell it from the R70 they would
                owe if there were no tip — so the figure they are checking
                against the drawer cannot be checked at all.

                Inside the same panel rather than below it: it is an explanation
                OF this number, not a second fact competing with it. */}
              {tip !== undefined && tip > 0 && (
                /* `text-lg` — two steps up the scale from the `text-sm` this
                   started at. The padding and the glyph go up with it: a pill
                   whose text grows while its box does not stops reading as a
                   pill, and at till distance the shape is what is recognised
                   before the words are. */
                <span className="relative mt-3 inline-flex items-center gap-2 rounded-pill border border-border bg-surface px-4 py-1.5 text-lg font-medium text-muted">
                  <Icons.HandCoins size={18} />
                  <span>
                    Tip <span className="numeric font-bold text-ink">{formatMoney(tip)}</span> kept
                    back
                  </span>
                </span>
              )}
            </div>
          )
        })()}

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

        {/* ── NO VOID HERE, DELIBERATELY ───────────────────────────────────
            Voiding a finalised sale reverses real money, puts stock back and
            can reverse a debtor's ledger entry. It belongs to the back office,
            where a manager is already looking at the sale in its register —
            not to a clerk standing at the till with a queue behind them.

            The capability still exists and the action still enforces it; what
            changed is that the till no longer OFFERS it. A mistake taken at the
            counter is escalated, which is the point: someone other than the
            person who rang it up decides to reverse it.

            Open (above) still reaches the document in the back office, so the
            route to a void is a walk to a workstation rather than a dead end. */}
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
