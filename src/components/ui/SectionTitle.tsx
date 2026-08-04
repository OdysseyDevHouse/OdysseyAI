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
 */
export function SectionTitle({
  icon,
  children,
  action,
}: {
  /** A 16px glyph from @/components/ui/icons. */
  icon?: ReactNode
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
      <h2 className="flex items-center gap-2.5 text-sm font-semibold text-ink">
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
