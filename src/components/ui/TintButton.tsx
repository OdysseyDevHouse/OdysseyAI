'use client'

import type { ComponentProps, ReactNode } from 'react'
import { buttonShape, type ButtonSize } from './styles'
import type { CategoryTone } from './CategoryTile'

/**
 * A button that wears a SUBJECT's colour rather than a meaning's.
 *
 * ── WHY THE KIT NEEDED A SECOND KIND OF BUTTON ────────────────────────────
 *
 * Every `Button` variant answers "what does pressing this DO to me" — primary
 * commits, danger destroys, warning is consequential. That vocabulary is the
 * reason a red button is frightening anywhere in the app, and it must not be
 * spent on anything else.
 *
 * This answers a different question: "what is this button ABOUT". The till's
 * module menu is the case that forced it — four cards, each a different kind of
 * document, each carrying two buttons of its own. Rendering all eight as
 * `secondary` made one brand-blue wall in which no card owned its own pair, and
 * reaching for `success`/`warning` to break it up would have painted "start a
 * quote" as a positive act and "find an order" as a cautious one, which is a lie
 * the rest of the app then has to live with.
 *
 * So: the same tones as `CategoryTile`, which already means "which kind of
 * thing", and the same ramp — the disc at the top of a card and the buttons
 * under it become one identifier instead of two decorations.
 *
 * ── WHEN NOT TO REACH FOR IT ──────────────────────────────────────────────
 *
 * Only where a SUBJECT colour is already established beside it. A tinted button
 * on its own is a coloured button with nothing to be the colour of, and a screen
 * of them is the wall this exists to prevent. If the button confirms, saves,
 * deletes or refuses, it is a `Button` — no exceptions.
 */

/* Full class strings per tone: Tailwind scans source text, so a built-up
   `bg-cat-${tone}-bg` is never emitted. Same reason CategoryTile writes its map
   out longhand, and the two maps are deliberately the same shape so a tone added
   there has an obvious partner here.

   The RESTING state is the soft tint at half strength with the tone's own ink on
   it, and hover fills to the full tint — the card behind these already carries
   the pale surface, so a button at full strength on it reads as a block of
   colour rather than as something raised out of the card. */
const TONE: Record<CategoryTone, string> = {
  indigo: 'border-cat-indigo/25 bg-cat-indigo-bg/60 text-cat-indigo hover:bg-cat-indigo-bg hover:border-cat-indigo/45',
  violet: 'border-cat-violet/25 bg-cat-violet-bg/60 text-cat-violet hover:bg-cat-violet-bg hover:border-cat-violet/45',
  emerald: 'border-cat-emerald/25 bg-cat-emerald-bg/60 text-cat-emerald hover:bg-cat-emerald-bg hover:border-cat-emerald/45',
  amber: 'border-cat-amber/25 bg-cat-amber-bg/60 text-cat-amber hover:bg-cat-amber-bg hover:border-cat-amber/45',
  sky: 'border-cat-sky/25 bg-cat-sky-bg/60 text-cat-sky hover:bg-cat-sky-bg hover:border-cat-sky/45',
  rose: 'border-cat-rose/25 bg-cat-rose-bg/60 text-cat-rose hover:bg-cat-rose-bg hover:border-cat-rose/45',
  teal: 'border-cat-teal/25 bg-cat-teal-bg/60 text-cat-teal hover:bg-cat-teal-bg hover:border-cat-teal/45',
  orange: 'border-cat-orange/25 bg-cat-orange-bg/60 text-cat-orange hover:bg-cat-orange-bg hover:border-cat-orange/45',
  cyan: 'border-cat-cyan/25 bg-cat-cyan-bg/60 text-cat-cyan hover:bg-cat-cyan-bg hover:border-cat-cyan/45',
  slate: 'border-cat-slate/25 bg-cat-slate-bg/60 text-cat-slate hover:bg-cat-slate-bg hover:border-cat-slate/45',
}

export function TintButton({
  tone = 'slate',
  size = 'md',
  className = '',
  type = 'button',
  children,
  ...rest
}: Omit<ComponentProps<'button'>, 'className'> & {
  /** The SUBJECT's tone — pass the same one its `CategoryTile` carries. */
  tone?: CategoryTone
  size?: ButtonSize
  className?: string
  children?: ReactNode
}) {
  /* Geometry, type scale and motion come from `buttonShape` so a tinted button
     and a plain one at the same size are the same box — only the colour differs.
     `buttonShape` rather than `buttonClass` because that one always emits SOME
     variant's colours, and two colour classes in one attribute are resolved by
     stylesheet order rather than by which was written last. See the note there. */
  return (
    <button
      type={type}
      className={`${buttonShape({ size })} ${TONE[tone]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
