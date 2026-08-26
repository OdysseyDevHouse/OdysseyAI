'use client'

import { useEffect, useState } from 'react'
import { Tag } from './icons'
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
  /* Three at a time: the mockup's proportion, and the most that stay legible at
     room distance on the narrowest screen this panel appears on. */
  const perPage = 3
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
    /* `w-full` and `flex-1`: this panel FILLS the half it is given rather
       than sizing to its content. Every child of it is either absolutely
       positioned (the backdrop, the scrim) or optional (the board), so its
       intrinsic width is close to nothing — without this it rendered as a
       narrow strip with a dead gap beside it whenever the shop had no
       specials to widen it. */
    <div className="relative isolate hidden w-full flex-1 overflow-hidden rounded-card bg-brand lg:flex lg:flex-col">
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
      <div className="relative z-[2] flex min-h-0 flex-1 items-center justify-center p-8">
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
          <div className="logo-disc flex h-40 max-h-full w-40 items-center justify-center rounded-full p-6 shadow-pop">
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
          <div className="rounded-card bg-ink/45 p-4 backdrop-blur-sm">
            <div className="flex items-center gap-2 pb-3">
              <Tag size={16} className="text-white/80" />
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

            <div className="flex flex-col gap-2">
              {shown.map((s) => (
                <SpecialRow key={s.productId} special={s} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** One item on the board. */
function SpecialRow({ special }: { special: PosSignInSpecial }) {
  return (
    /* A light card on the dark scrim rather than more translucency: the price
       is the thing being read from a distance, and dark-on-light at this size
       beats white-on-photograph every time. */
    <div className="flex items-center gap-3 rounded-control bg-surface p-2.5">
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
 * One item on the sign-in board.
 *
 * Declared here rather than imported from lib/site so the kit component stays
 * server-free — the Style Guide renders this with literals, and a type reaching
 * back into a `server-only` module would drag that module into the client
 * bundle.
 */
export type PosSignInSpecial = {
  productId: number
  description: string
  blurb: string
  priceIncl: number
  wasIncl?: number | null
  /** Already a URL — the panel does no id-to-route mapping of its own. */
  imageUrl?: string
}
