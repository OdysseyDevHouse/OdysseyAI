import type { ReactNode } from 'react'
import { Quote } from './icons'

/**
 * DeepPanel — a plaque, not a card.
 *
 * Everything else in the app is a pale surface on a paler canvas. This is the
 * opposite: a dark block that pulls the eye to ONE thing on a screen that has
 * exactly one thing worth reading. It was built for the till's opening float,
 * which is read from three feet away by somebody standing at a counter — at
 * that distance a large figure in `ink` on `surface-2` is just more page.
 *
 * Use it sparingly — as a rule, once in a viewport. Two plaques is no plaque:
 * the whole effect is that it is the darkest thing on the screen.
 *
 * The ONE standing exception is a number pad: `NumPadDisplay` and `PinPad`'s
 * entry box wear this same plaque, and a screen carrying a pad carries exactly
 * one of them — the figure being typed. That is the same rule, not a breach of
 * it. Do not add a second plaque beside a pad for something else.
 *
 * The gradient is a token pair rather than a hardcoded pair of hexes, so a
 * future decision to flatten it is one edit in globals.css.
 */
export function DeepPanel({
  label,
  hint,
  value,
  className = '',
}: {
  /** The small caps line — what the figure IS ("Opening float"). */
  label: ReactNode
  /** One line under the label, in the panel's own muted step. Optional. */
  hint?: ReactNode
  /** The figure. Rendered large, tabular and hard right. */
  value: ReactNode
  className?: string
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 rounded-card bg-gradient-to-br from-deep to-deep-2 px-5 py-4 ${className}`}
    >
      <div className="min-w-0">
        <span className="block text-xs font-bold uppercase tracking-wider text-deep-ink">
          {label}
        </span>
        {hint && <span className="mt-0.5 block text-xs text-deep-muted">{hint}</span>}
      </div>
      {/* The figure, and nothing competing with it. `numeric` so a float typed
          digit by digit does not shuffle sideways as the glyph widths change —
          on a pad that is the difference between a number growing and a number
          jittering. */}
      <span className="numeric shrink-0 text-4xl font-extrabold leading-none text-deep-ink">
        {value}
      </span>
    </div>
  )
}

/**
 * QuoteCard — a line of encouragement in brand, with the mark behind it.
 *
 * A card rather than a loose italic line because it is the one piece of the
 * screen that is NOT about the task, and an unframed sentence beside a set of
 * instructions reads as another instruction. The frame says "this is an aside",
 * which is what lets it be warm without being confusing.
 *
 * The glyph is decorative and sits at low opacity behind the text — it is the
 * mark that tells you what kind of sentence this is before you read a word.
 */
export function QuoteCard({
  eyebrow,
  children,
  footnote,
  className = '',
}: {
  /** The small caps line above the quote — "Quote of the day". */
  eyebrow?: ReactNode
  children: ReactNode
  /** A quiet line under it. Optional. */
  footnote?: ReactNode
  className?: string
}) {
  return (
    <div
      /* `quote`, not `brand` to `brand-ink`. The -ink step is the HOVER step and
         moves the opposite way between themes — darker in light, lighter in
         dark — so a card built from it came out deep blue in one theme and a
         pale wash carrying white text in the other. See globals.css. */
      className={`relative overflow-hidden rounded-card bg-gradient-to-br from-quote to-quote-2 px-6 py-5 text-white ${className}`}
    >
      {/* Behind the text, and unhittable. `aria-hidden` because a screen reader
          announcing "quote" before the quote is read is the same word twice. */}
      <Quote
        size={104}
        className="pointer-events-none absolute -right-4 -top-4 text-white/15"
        aria-hidden
        strokeWidth={1.5}
      />
      <div className="relative">
        {eyebrow && (
          <span className="block text-xs font-bold uppercase tracking-wider text-white/75">
            {eyebrow}
          </span>
        )}
        <p className="mt-2 text-xl font-bold leading-snug">{children}</p>
        {footnote && <p className="mt-4 text-xs text-white/70">{footnote}</p>}
      </div>
    </div>
  )
}
