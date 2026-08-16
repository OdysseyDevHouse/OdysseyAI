import type { ReactNode } from 'react'

/**
 * Badge — status and count pills.
 *
 * Colour carries meaning, so pick the tone for what the value *means*, not for
 * how it looks: success = good/in stock, danger = blocked/out of stock,
 * warning = needs attention, brand = new/informational, neutral = a count.
 */
export type BadgeTone =
  | 'neutral'
  | 'brand'
  | 'success'
  | 'warning'
  | 'danger'
  /* Aliases kept so older screens keep rendering. Prefer the names above. */
  | 'default'
  | 'positive'

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-muted',
  brand: 'bg-brand-soft text-brand',
  success: 'bg-success-soft text-success-ink',
  warning: 'bg-warning-soft text-warning-ink',
  danger: 'bg-danger-soft text-danger-ink',
  default: 'bg-surface-2 text-muted',
  positive: 'bg-success-soft text-success-ink',
}

/**
 * The same tones at full saturation, for the TILL.
 *
 * The soft fills above are right for a back-office table, where a column of
 * pale pills sits quietly beside the data. A basket is read at arm's length by
 * someone standing up and looking at a customer, and at that distance a pale
 * pill on a white card is a smudge. Filled reads; soft does not.
 *
 * This is a size-of-room decision, not a prettier palette — do not reach for it
 * to make a back-office badge "pop", or the rule that colour marks exceptions
 * stops meaning anything.
 */
const TONE_SOLID: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-ink-2',
  brand: 'bg-brand text-white',
  success: 'bg-success text-white',
  warning: 'bg-warning text-white',
  danger: 'bg-danger text-white',
  default: 'bg-surface-2 text-ink-2',
  positive: 'bg-success text-white',
}

/**
 * The dot's fill per tone. `currentColor` would inherit the pill's TEXT colour,
 * which is the darkened `-ink` step and reads as a bruise on a pale fill — each
 * tone names the saturated base instead, so the dot stays the brightest thing
 * in the pill.
 */
const DOT: Record<BadgeTone, string> = {
  neutral: 'bg-faint',
  brand: 'bg-brand',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  default: 'bg-faint',
  positive: 'bg-success',
}

export function Badge({
  children,
  tone = 'neutral',
  dot = false,
  solid = false,
  className = '',
}: {
  children: ReactNode
  tone?: BadgeTone
  /**
   * A leading status dot. For a pill naming the STATE of a record — Draft,
   * Finalised, Cancelled — where the dot gives the row a mark the eye catches
   * before it reads the word. Leave it off for a plain count or a label, which
   * have no state to signal.
   */
  dot?: boolean
  /**
   * Full-saturation fill instead of the pale tint. For the TILL, which is read
   * at arm's length — see the note on TONE_SOLID. Not for back-office tables.
   */
  solid?: boolean
  className?: string
}) {
  return (
    <span
      className={`inline-flex items-center rounded-pill px-2 py-0.5 text-xs font-medium ${
        solid ? TONE_SOLID[tone] : TONE[tone]
      } ${dot ? 'gap-1.5 pl-1.5' : ''} ${className}`}
    >
      {/* On a solid fill the tone-coloured dot vanishes into its own
          background; currentColor is the only thing guaranteed to show. */}
      {dot && (
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-pill ${solid ? 'bg-current' : DOT[tone]}`}
        />
      )}
      {children}
    </span>
  )
}
