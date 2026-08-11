import type { ReactNode } from 'react'

/**
 * The heading bar at the top of a card that holds one section of a form.
 *
 * The icon sits in a tinted brand tile so a long form reads as a stack of
 * distinct blocks rather than a wall of text — on the product screen there are
 * six of these, and finding the one you want should not mean reading every
 * heading.
 *
 * Distinct from <CardHeader>, which carries a description and an action and is
 * used for cards that are a screen in their own right.
 *
 * tone="brand" adds a brand-rule line across the top of the card and colours
 * the heading to match, so a long stack of sections reads as a set of tabs down
 * the page. Currently worn by the product screen only — it is being tried there
 * before the rest of the app follows.
 */
export function SectionTitle({
  icon,
  children,
  action,
  tone = 'default',
}: {
  /** A 16px glyph from @/components/ui/icons. */
  icon?: ReactNode
  children: ReactNode
  action?: ReactNode
  tone?: 'default' | 'brand'
}) {
  const brand = tone === 'brand'
  return (
    <div
      className={[
        'flex items-center justify-between gap-3 border-b border-border px-5 py-3',
        // -mt/-mx pull the rule onto the card's own top edge, so it sits inside
        // the rounded corners instead of leaving a square cap above them.
        brand ? '-mx-px -mt-px rounded-t-card border-t-2 border-t-brand-rule' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <h2
        className={`flex items-center gap-2.5 text-sm font-semibold ${
          brand ? 'text-brand' : 'text-ink'
        }`}
      >
        {icon && (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-control border border-brand/25 bg-brand-soft text-brand">
            {icon}
          </span>
        )}
        {children}
      </h2>
      {action}
    </div>
  )
}
