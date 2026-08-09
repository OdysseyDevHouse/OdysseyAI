import type { ReactNode } from 'react'

/**
 * The small coloured tile that identifies a SUBJECT — a report category, a
 * dataset, a section of the catalogue.
 *
 * Colour here means "which kind of thing", never "how is it doing". That is
 * why it reads from the `cat-*` accent ramp rather than the semantic tones: a
 * rose tile on Suppliers must not be mistaken for a danger state, and reusing
 * `danger` for identity is what makes colour stop carrying meaning everywhere
 * else. Set `tone` by subject and leave it stable — a category that changes
 * colour between screens is worse than one with no colour at all.
 *
 * The classes are written out in full because Tailwind scans source text: a
 * built-up `bg-cat-${tone}-bg` is never emitted.
 */

export type CategoryTone =
  | 'indigo'
  | 'violet'
  | 'emerald'
  | 'amber'
  | 'sky'
  | 'rose'
  | 'teal'
  | 'orange'
  | 'slate'

const TONE: Record<CategoryTone, string> = {
  indigo: 'text-cat-indigo bg-cat-indigo-bg',
  violet: 'text-cat-violet bg-cat-violet-bg',
  emerald: 'text-cat-emerald bg-cat-emerald-bg',
  amber: 'text-cat-amber bg-cat-amber-bg',
  sky: 'text-cat-sky bg-cat-sky-bg',
  rose: 'text-cat-rose bg-cat-rose-bg',
  teal: 'text-cat-teal bg-cat-teal-bg',
  orange: 'text-cat-orange bg-cat-orange-bg',
  slate: 'text-cat-slate bg-cat-slate-bg',
}

const SIZE = {
  sm: 'h-8 w-8 rounded-control',
  md: 'h-10 w-10 rounded-[10px]',
  /* Round, and larger, for a touch tile — the till's department and quick-key
     tiles carry this at 44px so the glyph still reads at arm's length. */
  lg: 'h-11 w-11 rounded-pill',
}

/** Every tone, in the order toneForId walks them. */
export const CATEGORY_TONES: readonly CategoryTone[] = [
  'indigo',
  'teal',
  'amber',
  'violet',
  'rose',
  'sky',
  'emerald',
  'orange',
  'slate',
]

/**
 * A stable tone for a record that has no colour of its own — a department, a
 * quick-key group.
 *
 * Derived from the id rather than stored, so a catalogue of 40 departments is
 * colour-coded with no migration and no colour picker. Derived rather than
 * random because the same department must be the same colour on every screen and
 * every reload: a tile that changes hue between visits is worse than a grid of
 * grey ones, since the colour stops being a thing you can learn.
 *
 * The order above is not the declaration order: adjacent ids get well-separated
 * hues, so two departments listed next to each other never land on neighbouring
 * colours.
 */
export function toneForId(id: number): CategoryTone {
  return CATEGORY_TONES[Math.abs(Math.trunc(id)) % CATEGORY_TONES.length]
}

export function CategoryTile({
  icon,
  tone = 'slate',
  size = 'md',
}: {
  icon: ReactNode
  tone?: CategoryTone
  size?: 'sm' | 'md' | 'lg'
}) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center ${SIZE[size]} ${TONE[tone]}`}
    >
      {icon}
    </span>
  )
}
