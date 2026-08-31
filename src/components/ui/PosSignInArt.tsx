'use client'

import { useEffect, useState } from 'react'
import { Gift } from './icons'
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
 * brand gradient, the Odyssey wordmark, a greeting, and no specials card at
 * all. It looks finished rather than looking like a screen waiting to be filled
 * in. Each piece the shop adds — a backdrop photograph, a logo, a promotion —
 * replaces a part of that rather than filling a hole.
 *
 * That ordering matters more here than on an ordinary screen. An `EmptyState`
 * saying "no specials yet — add one in Setup" is right in the back office and
 * wrong here: the audience is a customer waiting to be served, who can do
 * nothing about it and should not be shown our scaffolding.
 *
 * ── THE PANEL HAS TWO LAYOUTS, AND THE BOARD DECIDES WHICH ───────────────
 *
 * WITH a specials card: identity at the top — logo, greeting, date — and the
 * offer at the foot, with the photograph left to breathe between them. The two
 * blocks are the two things a person in the queue reads, and they are read in
 * that order; stacking them together in the middle made the panel a caption on
 * a picture rather than a composed half of a screen.
 *
 * WITHOUT one — which is most shops, most of the time — that reasoning stops
 * applying. There is no second block for the identity to be read before, so
 * top-aligning it left a small logo and a heading tucked into one corner with
 * five hundred pixels of empty photograph beneath them. So the identity centres
 * in the pane and wears a bigger logo and a bigger greeting: the same block,
 * given the room it is actually standing in.
 */
export function PosSignInArt({
  backdropUrl,
  logoUrl,
  siteName = '',
  specials = [],
  cycleMs = 7000,
}: {
  /** The shop's own photograph, or '' for the brand gradient. */
  backdropUrl?: string
  /** The shop's logo, or '' to fall back to the Odyssey wordmark. */
  logoUrl?: string
  /**
   * The shop's name, for the greeting. '' greets without naming anybody rather
   * than rendering "Welcome back, ." — a site with no display name is a control
   * panel record somebody has not finished, not a reason to break the heading.
   */
  siteName?: string
  /** The board. Empty omits the whole card — see the docblock. */
  specials?: PosSignInSpecial[]
  /**
   * How long each page of the supporting rows holds before the next.
   *
   * Seven seconds is long enough to read two items at a glance and short enough
   * that somebody waiting to be served sees more than one page. Faster than
   * about five reads as a slideshow demanding attention, which is the wrong
   * register for a screen behind a counter.
   */
  cycleMs?: number
}) {
  /*
   * ONE headline, then the others.
   *
   * The card is titled "Today's special" in the singular, and that is a promise
   * about what the biggest thing on it is: the first promotion the resolver
   * returned, held still. The rest cycle underneath it.
   *
   * Cycling the headline as well was the obvious alternative and is worse — the
   * one line a customer reads from across the room would change under them
   * mid-sentence, and the card's own title would stop being true.
   */
  const headline = specials[0]
  const rest = specials.slice(1)

  /*
   * Is the identity block the ONLY thing in this pane?
   *
   * Derived from the headline rather than from `specials.length`, so it can
   * never disagree with the card's own render condition below — the two are the
   * same question asked once, and a pane that centred its greeting while a
   * board was still painted at the foot would be the worst of both layouts.
   */
  const solo = !headline

  /* Two supporting rows at a time. The card sits in the bottom third of a 706px
     pane and a headline plus two rows is what fits there without the greeting
     above having to give up room. */
  const perPage = 2
  const pages = Math.max(1, Math.ceil(rest.length / perPage))
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

  /* Clamped rather than reset: a promotion ending mid-cycle shortens the list,
     and a page index past the end would render an empty strip until the next
     tick. */
  const current = page % pages
  const shown = rest.slice(current * perPage, current * perPage + perPage)

  /*
   * Today's date, resolved on the CLIENT and kept current.
   *
   * Not passed down from the server page, for two reasons. A till renders this
   * screen once and then sits on it all night, so a date baked in at render
   * time says "Wednesday" to the cashier opening up on Thursday — this screen
   * is precisely the one that is left up for sixteen hours. And a server that
   * formats a date in its own locale and timezone hands the browser a string it
   * would have written differently, which is a hydration mismatch on the one
   * screen that must not flicker in a dim room.
   *
   * Empty on the first paint rather than a guess, so nothing has to be
   * corrected a frame later; the line simply arrives.
   */
  const [today, setToday] = useState('')
  useEffect(() => {
    /* 'en-ZA' rather than the browser's own locale, which is what every other
       formatted date and number in the product uses — see lib/reservations,
       lib/invoices/pdf and the rest. A till's browser is frequently left on
       en-US out of the box, and that renders "August 26" on a screen facing a
       South African queue while the prices beside it are in rand. */
    const label = () =>
      new Date().toLocaleDateString('en-ZA', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      })
    setToday(label())
    /* Once a minute, which is enough to turn the date over shortly after
       midnight and is a fraction of the work the specials cycle already does.
       React bails out when the string has not changed, so all but one of these
       ticks costs a comparison and nothing else. */
    const timer = setInterval(() => setToday(label()), 60_000)
    return () => clearInterval(timer)
  }, [])

  return (
    /*
     * A FIXED-WIDTH, full-height pane forming the LEFT half of the sign-in card.
     *
     * No rounding and no shadow of its own any more: the two halves are now one
     * card, and PosGate's container does the rounding and clips this to it. A
     * radius here as well would have drawn a second, smaller corner inside the
     * first down the seam between the halves.
     *
     * 574px — the SAME width as the pad beside it, so the seam falls down the
     * middle of the card and neither half reads as the leftover space around the
     * other. The pad's 574 is fixed (it is sized by the finger, not by the
     * display), so matching it is the only way the two stay equal.
     *
     * But 574 + 574 is 1148, and at exactly 1024px (a real counter display) that
     * does not fit between the screen's own padding. So this panel is NOT
     * `shrink-0` the way the pad is: 574 is what it ASKS for, and on a display
     * too narrow to grant it the PICTURE gives way rather than the pad — a
     * photograph 150px narrower still reads, and a pad narrower than its own keys
     * does not. Everything inside takes that squeeze without breaking: a scrim, an
     * `object-cover` image, and text that wraps.
     *
     * ── max-h-full IS NOT OPTIONAL ────────────────────────────────────────────
     *
     * 706 plus the screen's padding is 754, and a very common counter display is
     * 1366×768. Without this the pane would hang off the bottom of a till in the
     * field. It shrinks instead, which the inside of this pane already handles:
     * the identity block is `min-h-0 flex-1` precisely so that it yields and the
     * specials card does not get clipped.
     */
    <div className="relative isolate hidden h-[706px] max-h-full min-w-0 overflow-hidden bg-brand lg:flex lg:w-[574px] lg:flex-col">
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
          so a scrim that skipped the fallback would leave the greeting white on
          pale blue on the screen almost every shop actually sees.

          `.signin-scrim` rather than `from-ink/55`: `ink` is the THEME's text
          colour, near-white in dark mode, so the token version painted a white
          veil the moment a cashier switched theme — measured, not guessed. See
          the class in globals.css, and .logo-disc beside it for the same trap.

          Content after this sits above it via z-[2] on each block, rather than
          relying on document order — an absolutely positioned sibling does not
          establish one for the flex children that follow. */}
      <div aria-hidden className="signin-scrim absolute inset-0 z-[1]" />

      {/* ── Who this shop is ────────────────────────────────────────────── */}
      {/* `min-h-0 flex-1` so this yields rather than the card below it. Both are
          flex children; without it this block keeps its content height and the
          specials card is the one that gets clipped on a 768px-tall counter
          screen — which is what happened before, cutting the last row in half.

          Centred on both axes when it is alone in the pane, top-left when a
          board sits beneath it. Whole class strings on each branch rather than
          a base string with conditional fragments appended: it is longer to
          read but it is the pair of layouts written out, which is what somebody
          changing one of them needs to see. */}
      <div
        className={
          solo
            ? 'relative z-[2] flex min-h-0 flex-1 flex-col items-center justify-center p-10 text-center'
            : 'relative z-[2] flex min-h-0 flex-1 flex-col p-8'
        }
      >
        {logoUrl ? (
          /* On its own light disc, because a shop's logo is drawn for white
             paper and most have dark ink. Dropping it straight onto a
             photograph would lose half of them entirely — the same problem
             `.logo-plate` solves for our own wordmark in dark mode.

             `.logo-disc` rather than `bg-surface`: surface follows the
             OPERATOR's theme, and this disc is on the half a CUSTOMER reads.
             A cashier preferring dark mode must not turn a shop's dark logo
             invisible on the screen facing the queue.

             TWO sizes, and the board decides. Beside a specials card the mark
             only has to be recognised — the greeting under it carries the
             shop's identity in words, and a large disc there would crowd the
             offer. Alone in the pane it is the largest thing on the customer's
             half of the screen and should be readable from the back of the
             queue, so it takes 160px: the panel is 400 wide at `lg`, and that
             plus the 40px padding either side still leaves it clear of the
             edges. */
          <div
            className={
              solo
                ? 'logo-disc flex h-40 w-40 shrink-0 items-center justify-center rounded-full p-6 shadow-pop'
                : 'logo-disc flex h-16 w-16 shrink-0 items-center justify-center rounded-full p-2.5 shadow-pop'
            }
          >
            <img src={logoUrl} alt="" className="max-h-full max-w-full object-contain" />
          </div>
        ) : (
          /* No logo uploaded: our own wordmark, which is what the till showed
             before this panel existed. Never a "your logo here" placeholder —
             the customer side of a counter is not where we advertise our own
             setup screens.

             It grows with the disc for the same reason, but by less. A shop's
             own logo standing alone is the point of the panel; ours standing
             alone means the shop has not uploaded one yet, and blowing our
             wordmark up to fill their screen is not the way to say that. */
          <p
            className={
              solo
                ? 'wordmark shrink-0 text-4xl text-white'
                : 'wordmark shrink-0 text-xl text-white'
            }
          >
            ODYSSEY
            <span
              className={
                solo
                  ? 'wordmark-sub mt-1.5 block text-[15px] text-white/80'
                  : 'wordmark-sub mt-1 block text-[10px] text-white/80'
              }
            >
              POINT OF SALE
            </span>
          </p>
        )}

        {/* The greeting, at the size a heading wears on a screen read from
            across a room rather than at arm's length. `text-balance` so a long
            trading name breaks into even lines instead of leaving one word
            stranded on the second — which matters more centred than left, where
            a ragged last line is visible from both ends. */}
        <h2
          className={
            solo
              ? 'mt-8 text-balance text-[36px] font-extrabold leading-[1.15] tracking-tight text-white'
              : 'mt-7 text-balance text-[30px] font-extrabold leading-[1.15] tracking-tight text-white'
          }
        >
          {siteName ? `Welcome back, ${siteName}.` : 'Welcome back.'}
        </h2>

        {/* The date. Rendered only once it has resolved on the client — see the
            state above — so the line never appears and then corrects itself. */}
        {today && (
          <p
            className={
              solo
                ? 'mt-4 text-[15px] font-semibold text-white/70'
                : 'mt-3 text-[13px] font-semibold text-white/70'
            }
          >
            {today}
          </p>
        )}
      </div>

      {/* ── Today's special ─────────────────────────────────────────────── */}
      {/* Omitted entirely when the shop runs no price-shaped promotions, rather
          than rendered as an empty card. See the docblock: there is no useful
          empty state for this audience. */}
      {headline && (
        <div className="relative z-[2] shrink-0 p-6">
          {/* `.signin-board` rather than a token fill — see the class in
              globals.css. Same trap as the scrim: `ink` inverts with the
              operator's theme and this card faces the queue. */}
          <div className="signin-board rounded-card p-5 backdrop-blur-sm">
            <div className="flex items-center gap-2">
              <Gift size={14} className="shrink-0 text-white/70" />
              <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/70">
                Today&rsquo;s special
              </h3>
              {/* Which page of the SUPPORTING rows, where there is more than
                  one. Dots rather than "1 of 3": it is a progress hint for
                  somebody who is not reading closely, not a control anybody
                  operates. */}
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

            <HeadlineSpecial special={headline} />

            {/* The others, under a hairline. Quieter than the headline by a
                long way and deliberately so: the card makes ONE offer, and
                these are there for the customer who has read it and is still
                waiting. */}
            {shown.length > 0 && (
              <div className="mt-3.5 flex flex-col gap-2 border-t border-white/10 pt-3">
                {shown.map((s) =>
                  s.kind === 'price' ? (
                    <SupportingRow
                      key={`p${s.productId}`}
                      name={s.description}
                      value={formatMoney(s.priceIncl)}
                    />
                  ) : (
                    <SupportingRow key={`o${s.specialId}`} name={s.description} value={s.blurb} />
                  ),
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The one offer the card is built around, said in two sizes on one line.
 *
 * The big half is the thing that makes somebody look up — a price, or the words
 * of a deal — and the smaller half is what it applies to. That split is the
 * whole design: "R89.00 ribeye 300g" and "25% off wood-fired pizza" are the
 * same sentence shape, so a card of either kind reads consistently from the
 * back of a queue.
 */
function HeadlineSpecial({ special }: { special: PosSignInSpecial }) {
  /* A price row leads with the PRICE, an offer row with the words of the deal.
     Never a computed price for an offer — see posSignInSpecials: "Chicken Wings
     — R0.00" because the promotion was really a buy-two-get-one is the failure
     this distinction exists to avoid. */
  const lead = special.kind === 'price' ? formatMoney(special.priceIncl) : special.blurb

  /* The supporting line under it. A price row has the shop's own blurb and, if
     the item was genuinely dearer before, the old price; an offer row has what
     the promotion applies to. All three are optional and the line is dropped
     rather than padded when there is nothing to say. */
  const note =
    special.kind === 'price'
      ? special.blurb ||
        (special.wasIncl !== null && special.wasIncl !== undefined
          ? `Was ${formatMoney(special.wasIncl)}`
          : '')
      : special.appliesTo

  return (
    <div className="mt-3">
      {/* Baseline-aligned rather than centred, so the small half sits on the
          same line the big half stands on — centring left it floating against
          the cap height of a 24px number. */}
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="numeric text-[24px] font-extrabold leading-tight text-white">{lead}</span>
        <span className="text-[15px] font-semibold leading-snug text-white/90">
          {special.description}
        </span>
      </p>
      {note && (
        /* Two lines, then clipped. A shop's marketing copy has no length limit
           and a long one would push the supporting rows off the card. */
        <p className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-white/55">{note}</p>
      )}
    </div>
  )
}

/**
 * One of the other promotions running today — a name and its number.
 *
 * No photograph and no second line, unlike the headline above it. Three
 * fully-dressed rows competing with the headline is what the old board did, and
 * it left a customer with no idea which of four things the shop actually wanted
 * them to notice.
 */
function SupportingRow({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-white/75">{name}</span>
      <span className="numeric shrink-0 text-[12.5px] font-bold text-white">{value}</span>
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
