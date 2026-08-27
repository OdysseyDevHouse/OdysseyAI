'use client'

import { useEffect, useState } from 'react'
import { Tag, Gift } from './icons'
import { formatMoney } from '@/lib/decimals'

/**
 * The showcase half of the till's sign-in screen.
 *
 * ── WHY THIS IS A KIT COMPONENT AND NOT PART OF PosGate ──────────────────
 *
 * It is the one screen in the product that faces the CUSTOMER rather than the
 * operator, and it is read from across a room. That makes it a distinct visual
 * problem from every other screen the kit dresses, and one the Style Guide has
 * to be able to show — otherwise the next person to touch it has no way to see
 * what it looks like without standing at a till and signing out.
 *
 * ── WHAT IT SHOWS WHEN THE SHOP HAS SET UP NOTHING ───────────────────────
 *
 * Almost every shop, on day one. So the empty state is the DESIGNED state: a
 * brand gradient, the Odyssey wordmark, and no specials section at all. It
 * looks finished rather than looking like a screen waiting to be filled in.
 * Each piece the shop adds — a backdrop photograph, a logo, a promotion —
 * replaces a part of that rather than filling a hole.
 *
 * That ordering matters more here than on an ordinary screen. An `EmptyState`
 * saying "no specials yet — add one in Setup" is right in the back office and
 * wrong here: the audience is a customer waiting to be served, who can do
 * nothing about it and should not be shown our scaffolding.
 */
export function PosSignInArt({
  backdropUrl,
  logoUrl,
  specials = [],
  cycleMs = 7000,
}: {
  /** The shop's own photograph, or '' for the brand gradient. */
  backdropUrl?: string
  /** The shop's logo, or '' to fall back to the Odyssey wordmark. */
  logoUrl?: string
  /** The board. Empty omits the whole panel — see the docblock. */
  specials?: PosSignInSpecial[]
  /**
   * How long each page of the board holds before the next.
   *
   * Seven seconds is long enough to read three items at a glance and short
   * enough that somebody waiting to be served sees more than one page. Faster
   * than about five reads as a slideshow demanding attention, which is the
   * wrong register for a screen behind a counter.
   */
  cycleMs?: number
}) {
  /* Four at a time, which is what the 706px pane holds without squeezing the
     logo above it: four 76px rows plus the board's own chrome is 444px, leaving
     262px for the logo block — enough for the h-32 disc it shrinks to whenever
     there is a board. A fifth would have to come out of the logo. */
  const perPage = 4
  const pages = Math.max(1, Math.ceil(specials.length / perPage))
  const [page, setPage] = useState(0)

  /*
   * The cycle.
   *
   * Skipped entirely at one page — an interval that fires forever to set state
   * to the value it already holds is a wakeup every seven seconds on a machine
   * that sits on this screen all night.
   */
  useEffect(() => {
    if (pages <= 1) return
    const timer = setInterval(() => setPage((p) => (p + 1) % pages), cycleMs)
    return () => clearInterval(timer)
  }, [pages, cycleMs])

  /* Clamped rather than reset: a promotion ending mid-cycle shortens the board,
     and a page index past the end would render an empty panel until the next
     tick. */
  const current = page % pages
  const shown = specials.slice(current * perPage, current * perPage + perPage)

  return (
    /*
     * A FIXED 574×706 pane, matching the sign-in card beside it.
     *
     * Those are not arbitrary: 574 is the PIN pad's 510 plus the card's padding,
     * and 706 is that card's height with the offline notice showing. Two panes
     * of one size read as a pair; one pane stretched to whatever the screen left
     * over read as a photograph with the pad parked next to it.
     *
     * It also replaces an explicit `w-full flex-1`, which was there because every
     * child here is either absolutely positioned (the backdrop, the scrim) or
     * optional (the board) — so the pane's intrinsic width is close to nothing,
     * and without a stated width it collapsed to a narrow strip whenever the shop
     * had no specials to widen it. A fixed width answers that just as well.
     *
     * ── max-h-full IS NOT OPTIONAL ────────────────────────────────────────────
     *
     * 706 plus the screen's padding is 770, and a very common counter display is
     * 1366×768. Without this the pane would hang 2px off the bottom of the
     * commonest till in the field. It shrinks instead, which the inside of this
     * pane already handles: the logo block is `min-h-0 flex-1` precisely so that
     * it yields and the specials board does not get clipped.
     */
    <div className="relative isolate hidden h-[706px] max-h-full w-[574px] shrink-0 overflow-hidden rounded-card bg-brand lg:flex lg:flex-col">
      {/* ── The backdrop ────────────────────────────────────────────────── */}
      {/* A gradient ALWAYS, with the photograph over it. Two reasons: a picture
          that is still loading shows brand colour rather than a white flash on
          a screen in a dim room, and a picture whose bytes have gone missing
          leaves the panel looking deliberate instead of broken. */}
      <div aria-hidden className="absolute inset-0 z-0 bg-gradient-to-br from-brand to-brand-ink" />
      {backdropUrl && (
        <img
          src={backdropUrl}
          alt=""
          aria-hidden
          className="absolute inset-0 z-0 h-full w-full object-cover"
        />
      )}
      {/* The scrim, OVER both — z-0 on the two layers above and z-[1] here, so
          it darkens the brand gradient as well as a photograph.

          It has to cover both. White text over an unknown photograph is a
          contrast accident waiting to happen — the shop chooses the picture and
          we cannot know how light it is — but `brand` is itself a LIGHT blue,
          so a scrim that skipped the fallback would leave the wordmark white on
          pale blue on the screen almost every shop actually sees.

          `.signin-scrim` rather than `from-ink/55`: `ink` is the THEME's text
          colour, near-white in dark mode, so the token version painted a white
          veil the moment a cashier switched theme — measured, not guessed. See
          the class in globals.css, and .logo-disc beside it for the same trap.

          Content after this sits above it via z-[2] on each block, rather than
          relying on document order — an absolutely positioned sibling does not
          establish one for the flex children that follow. */}
      <div aria-hidden className="signin-scrim absolute inset-0 z-[1]" />

      {/* ── The logo ────────────────────────────────────────────────────── */}
      {/* Centred in the space ABOVE the board rather than pinned to the top:
          with no specials it lands in the middle of the panel, which is where a
          logo belongs on a screen that is otherwise a photograph. */}
      {/* `min-h-0` so this yields rather than the board below it. Both are
         flex children; without it the logo keeps its content height and the
         specials card is the one that gets clipped — which is what happened,
         cutting the third item in half on a short panel. */}
      {/* Centred with no board, but pushed UP the moment there is one: four
          specials is a tall card, and a logo still sitting on the vertical
          centre of what is left ends up crowding the board's top edge. `pt-10`
          with `items-start` parks it in the upper third instead, which is where
          a mark belongs on a panel whose lower half is a list. */}
      <div
        className={`relative z-[2] flex min-h-0 flex-1 justify-center p-8 ${
          specials.length > 0 ? 'items-start pt-10' : 'items-center'
        }`}
      >
        {logoUrl ? (
          /* On its own light disc, because a shop's logo is drawn for white
             paper and most have dark ink. Dropping it straight onto a
             photograph would lose half of them entirely — the same problem
             `.logo-plate` solves for our own wordmark in dark mode.

             `.logo-disc` rather than `bg-surface`: surface follows the
             OPERATOR's theme, and this disc is on the half a CUSTOMER reads.
             A cashier preferring dark mode must not turn a shop's dark logo
             invisible on the screen facing the queue. */
          /* Capped by the room available as well as by a fixed size, so a
             short panel shrinks the disc instead of squeezing the board. */
          /* Two sizes rather than one. With no board the disc has the whole
             pane and reads small at h-40, so it takes h-52; with a board it
             steps back to h-32, because the shop's offers are what the person
             in the queue is there to read and the mark only has to be
             recognised. Both keep `max-h-full` for the 768px-tall counter
             screen. */
          <div
            className={`logo-disc flex max-h-full items-center justify-center rounded-full shadow-pop ${
              specials.length > 0 ? 'h-32 w-32 p-5' : 'h-52 w-52 p-7'
            }`}
          >
            <img src={logoUrl} alt="" className="max-h-full max-w-full object-contain" />
          </div>
        ) : (
          /* No logo uploaded: our own wordmark, which is what the till showed
             before this panel existed. Never a "your logo here" placeholder —
             the customer side of a counter is not where we advertise our own
             setup screens. */
          <p className="wordmark text-center text-3xl text-white">
            ODYSSEY
            <span className="wordmark-sub mt-1 block text-xs text-white/80">POINT OF SALE</span>
          </p>
        )}
      </div>

      {/* ── The board ───────────────────────────────────────────────────── */}
      {/* Omitted entirely when the shop runs no price-shaped promotions, rather
          than rendered as an empty card. See the docblock: there is no useful
          empty state for this audience. */}
      {specials.length > 0 && (
        <div className="relative z-[2] shrink-0 p-6">
          {/* `.signin-board` rather than a token fill — see the class in
              globals.css. Same trap as the scrim: `ink` inverts with the
              operator's theme and this card faces the queue. */}
          <div className="signin-board rounded-card p-4 backdrop-blur-sm">
            <div className="flex items-center gap-2.5 pb-3">
              {/* The glyph on its own disc rather than loose beside the words.
                  The heading is small caps at 13px and the tag on its own sat
                  as a speck against a photograph; the disc gives it a ground to
                  be legible on from across the room, and matches the lock disc
                  the operator half wears over its own heading. */}
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/25 bg-white/10 text-white">
                <Tag size={15} />
              </span>
              <h2 className="text-[13px] font-bold uppercase tracking-wide text-white/90">
                Specials of the day
              </h2>
              {/* Which page, where there is more than one. Dots rather than
                  "1 of 3": it is a progress hint for somebody who is not
                  reading closely, not a control anybody operates. */}
              {pages > 1 && (
                <span className="ml-auto flex items-center gap-1.5">
                  {Array.from({ length: pages }).map((_, i) => (
                    <span
                      key={i}
                      className={`h-1.5 w-1.5 rounded-pill transition ${
                        i === current ? 'bg-white' : 'bg-white/35'
                      }`}
                    />
                  ))}
                </span>
              )}
            </div>

            {/* ONE card holding every item, not a card each.
                Three separately-bordered tiles stacked two millimetres apart
                read as three unrelated offers; the board is a single thing a
                customer scans top to bottom. The rows carry their own padding
                and need no rule between them — the product pictures already
                mark where each one starts. */}
            <div className="flex flex-col rounded-card bg-surface p-2">
              {shown.map((s) =>
                s.kind === 'price' ? (
                  <SpecialRow key={`p${s.productId}`} special={s} />
                ) : (
                  <OfferRow key={`o${s.specialId}`} offer={s} />
                ),
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** One item on the board, at a price a customer can act on. */
function SpecialRow({ special }: { special: PosSignInPriceRow }) {
  return (
    /* No fill of its own: the light card is the BOARD's, above. The light-on-dark
       reasoning still holds — the price is read from a distance and dark-on-light
       beats white-on-photograph every time — it is just carried one level up so
       three items read as one list. */
    <div className="flex items-center gap-3 p-2.5">
      {special.imageUrl ? (
        <img
          src={special.imageUrl}
          alt=""
          className="h-14 w-14 shrink-0 rounded-control border border-border object-cover"
        />
      ) : (
        /* No photograph is ordinary — most products have none. A tinted glyph
           rather than a grey box, so a board of un-photographed items still
           reads as a designed list. */
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand">
          <Tag size={20} />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-bold text-ink">{special.description}</p>
        {special.blurb && (
          /* Two lines, then clipped. A shop's marketing copy has no length
             limit and a long one would push the price off the card. */
          <p className="line-clamp-2 text-[12.5px] leading-snug text-muted">{special.blurb}</p>
        )}
      </div>

      <div className="shrink-0 text-right">
        <p className="numeric text-[17px] font-bold text-brand">
          {formatMoney(special.priceIncl)}
        </p>
        {special.wasIncl !== null && special.wasIncl !== undefined && (
          /* The saving, struck through. Only where it is genuinely higher — the
             resolver returns null otherwise, because a struck-through number
             that is not bigger reads as our mistake rather than the shop's. */
          <p className="numeric text-[12px] text-faint line-through">
            {formatMoney(special.wasIncl)}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * A promotion with no single price to show — a combo, a spend-and-get, a
 * multibuy — said in words instead.
 *
 * ── WHY IT LOOKS DELIBERATELY UNLIKE THE ROW ABOVE ───────────────────────
 *
 * The priced row is a menu line: photograph, name, number. This one cannot be,
 * and dressing it to match would be the lie. A customer scanning the board has
 * to be able to tell at a glance which rows they can act on without asking
 * anybody and which need a word at the counter — so this carries a tinted glyph
 * where the photograph goes, and the space the price occupied is simply left to
 * the words.
 *
 * No price, ever, including a computed one. See posSignInSpecials: "Chicken
 * Wings — R0.00" because the promotion was really a buy-two-get-one is the
 * failure this whole row type exists to avoid.
 */
function OfferRow({ offer }: { offer: PosSignInOfferRow }) {
  return (
    <div className="flex items-center gap-3 p-2.5">
      {/* A tinted disc rather than a product photograph. The deal covers several
          things, so any one picture would be a claim about which item it is
          really about — and that is the one the customer would come to the
          counter holding. */}
      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand">
        <Gift size={22} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-bold text-ink">{offer.description}</p>
        {/* The DEAL, at the size the price wears on the row above — it is the
            same fact for this row, and the thing being read from a distance. */}
        <p className="text-[13.5px] font-semibold leading-snug text-brand">{offer.blurb}</p>
        {offer.appliesTo && (
          <p className="truncate text-[12px] leading-snug text-muted">{offer.appliesTo}</p>
        )}
      </div>
    </div>
  )
}

/**
 * One row on the sign-in board.
 *
 * Declared here rather than imported from lib/site so the kit component stays
 * server-free — the Style Guide renders this with literals, and a type reaching
 * back into a `server-only` module would drag that module into the client
 * bundle.
 *
 * A UNION rather than one shape with optional fields, so a row can never be
 * half of each: an offer with a stray price on it is exactly the invented
 * number the board must not show, and the compiler is a better guard against
 * that than a comment.
 */
export type PosSignInPriceRow = {
  kind: 'price'
  productId: number
  description: string
  blurb: string
  priceIncl: number
  wasIncl?: number | null
  /** Already a URL — the panel does no id-to-route mapping of its own. */
  imageUrl?: string
}

export type PosSignInOfferRow = {
  kind: 'offer'
  specialId: number
  /** The shop's own name for the promotion. */
  description: string
  /** What it gives, in words. */
  blurb: string
  /** "On Beverages, Snacks", or '' where that cannot be said briefly. */
  appliesTo: string
}

export type PosSignInSpecial = PosSignInPriceRow | PosSignInOfferRow
