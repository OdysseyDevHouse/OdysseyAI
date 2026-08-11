import type { ReactNode } from 'react'

/**
 * Card — the panel every block of content sits in.
 *
 * Compose it as Card > CardHeader + CardBody. CardHeader draws its own bottom
 * rule, so a card with a header and a table needs no extra dividers.
 */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-card border border-border bg-surface shadow-card ${className}`}>
      {children}
    </div>
  )
}

export function CardHeader({
  title,
  description,
  action,
  className = '',
  tone = 'default',
}: {
  title: ReactNode
  /** One line saying what this block is for — muted, sentence case. */
  description?: ReactNode
  action?: ReactNode
  className?: string
  /**
   * 'brand' draws a brand-rule line across the card's top edge and colours the
   * title, matching <SectionTitle tone="brand">. Both exist so a screen that
   * mixes the two headings reads as one stack rather than two. Worn by the
   * product screen only for now.
   */
  tone?: 'default' | 'brand'
}) {
  const brand = tone === 'brand'
  return (
    <div
      className={[
        'flex items-start justify-between gap-4 border-b border-border px-5 py-4',
        // See the note in SectionTitle: the negative insets put the rule on the
        // card's own edge so it follows the rounded corners.
        brand ? '-mx-px -mt-px rounded-t-card border-t-2 border-t-brand-rule' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="min-w-0">
        <h2 className={`text-sm font-semibold ${brand ? 'text-brand' : 'text-ink'}`}>{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export function CardBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`p-5 ${className}`}>{children}</div>
}

export function CardFooter({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`flex items-center justify-end gap-2 border-t border-border px-5 py-3.5 ${className}`}>
      {children}
    </div>
  )
}
