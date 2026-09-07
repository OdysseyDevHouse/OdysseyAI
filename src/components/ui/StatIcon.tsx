import type { ReactNode } from 'react'

/**
 * StatIcon — the tinted medallion that opens a figure.
 *
 * ONE spelling of it, for the whole app. StatTile drew its own inline, and the
 * dashboard bands needed the same thing at a smaller size; two copies of a
 * medallion is how a kit ends up with two medallions that no longer match.
 * StatTile now calls this, so a change to the tint or the radius reaches every
 * figure in the product on the same paint.
 *
 * `-soft` fills rather than the saturated base: it sits UNDER a glyph and has
 * to stay a background. At full strength it competes with the number it
 * labels, which is the one thing it must not do.
 */

export type StatIconTone = 'default' | 'positive' | 'success' | 'warning' | 'danger'

const TONE: Record<StatIconTone, string> = {
  default: 'bg-brand-soft text-brand',
  positive: 'bg-success-soft text-success-ink',
  success: 'bg-success-soft text-success-ink',
  warning: 'bg-warning-soft text-warning-ink',
  danger: 'bg-danger-soft text-danger-ink',
}

/**
 * `md`/`lg` are StatTile's two densities — a page strip and an in-dialog one.
 * `sm` is for a figure inside other chrome, where 36px of medallion would be a
 * third of the cell: the dashboard's headline and rates bands, whose cells are
 * 100px tall and hold three lines of text beside it.
 */
const SIZE: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'size-8',
  md: 'size-9',
  lg: 'size-11',
}

export function StatIcon({
  children,
  tone = 'default',
  size = 'sm',
  round = false,
}: {
  children: ReactNode
  /**
   * Colours the medallion only, never the figure beside it. For a tile whose
   * SUBJECT has a natural colour — takings are money, so the glyph is green.
   * Leave it default unless the subject genuinely has one: a strip where every
   * medallion is coloured is a strip with no signal in it.
   */
  tone?: StatIconTone
  size?: 'sm' | 'md' | 'lg'
  /**
   * A circle rather than a rounded square.
   *
   * StatTile's medallions have always been circular and stay that way; the
   * dashboard bands are square. The two shapes are a live inconsistency rather
   * than a considered pair — worth settling one way in a future pass — but they
   * are at least now one component, so settling it is one edit here instead of
   * a hunt through two files.
   */
  round?: boolean
}) {
  return (
    <span
      /* aria-hidden: decoration beside a caption that already names the figure,
         so a screen reader announcing "wallet" would only interrupt. */
      aria-hidden
      className={`flex ${SIZE[size]} shrink-0 items-center justify-center ${
        round ? 'rounded-pill' : 'rounded-control'
      } ${TONE[tone]}`}
    >
      {children}
    </span>
  )
}
