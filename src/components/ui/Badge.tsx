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

export function Badge({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode
  tone?: BadgeTone
  className?: string
}) {
  return (
    <span
      className={`inline-flex items-center rounded-pill px-2 py-0.5 text-xs font-medium ${TONE[tone]} ${className}`}
    >
      {children}
    </span>
  )
}
