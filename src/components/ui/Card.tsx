import type { ReactNode } from 'react'

/**
 * Card — the panel every block of content sits in.
 *
 * Compose it as Card > CardHeader + CardBody. CardHeader draws its own bottom
 * rule, so a card with a header and a table needs no extra dividers.
 *
 * `data-card` is not decoration: it is how the brand rule finds this element.
 * A brand-toned heading marks itself and the card turns its own left border
 * into the rule — see the note in globals.css.
 */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-card
      className={`rounded-card border border-border bg-surface shadow-card ${className}`}
    >
      {children}
    </div>
  )
}

export function CardHeader({
  icon,
  title,
  description,
  action,
  className = '',
  tone = 'brand',
}: {
  /**
   * A glyph in a tinted tile, left of the title.
   *
   * Same 36px disc `SettingRow` draws, so a card whose header carries one sits
   * in the same column as the rows beneath it rather than half a tile off. Use
   * an icon from '@/components/ui/icons'; omit it and the header is unchanged.
   */
  icon?: ReactNode
  title: ReactNode
  /** One line saying what this block is for — muted, sentence case. */
  description?: ReactNode
  action?: ReactNode
  className?: string
  /**
   * The brand rule is the default, matching <SectionTitle>, so a screen that
   * mixes the two headings reads as one stack rather than two. 'default' opts
   * out — use it for a card nested inside another card, where a second rule
   * would compete with the outer one.
   */
  tone?: 'default' | 'brand'
}) {
  const brand = tone === 'brand'
  return (
    <div
      /* The marker the card's left border keys off — the rule itself is drawn
         by the card, because a border here could only be as tall as the
         header. See globals.css. */
      data-brand-rule={brand ? '' : undefined}
      className={[
        'flex items-start justify-between gap-4 border-b border-border px-5 py-4',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          {/* Ink, not brand. The rule down the card's edge is what marks the
              heading; colouring the words as well said the same thing twice, and
              a blue title reads as a link. */}
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
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
