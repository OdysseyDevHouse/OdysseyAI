import Link from 'next/link'
import type { ReactNode } from 'react'
import { Settings, ChevronRight } from './icons'
import { SUBPAGE_LABELS, hubFor, type SubpageHref } from '@/lib/nav'

/**
 * SettingsHint — "the rule behind this number is set over there".
 *
 * Configuration is spread across ~40 screens, and most of it is nowhere near
 * the screen whose figures it decides: lay-by terms are set in Setup but felt
 * on a lay-by, overtime multipliers in Setup but felt on a timesheet. Somebody
 * looking at a number they disagree with has no way to know which screen owns
 * the rule that produced it. The setup hub answers "where is everything"; this
 * answers the harder question, "where is THIS", at the moment it is asked.
 *
 * Deliberately NOT a <Callout>. A Callout is a condition — something is wrong,
 * or blocked, or needs attention before the screen can be used. A hint is none
 * of those: nothing has gone wrong, the screen works, and the pointer is an
 * aside. Given Callout's weight it would read as a warning on every screen that
 * carried one, and a warning that is always present stops being read at all.
 *
 * The label is NOT passed in — it is read from `SUBPAGE_LABELS`, the same map
 * the breadcrumb and the hub tiles use. So a hint can never call a screen
 * something the screen does not call itself, and renaming it stays one edit in
 * nav.ts. The `href` type makes pointing at an unnamed screen a compile error.
 */
export function SettingsHint({
  href,
  children,
  className = '',
}: {
  /** The settings screen that owns the rule. Must be a screen a hub lists. */
  href: SubpageHref
  /**
   * What that screen decides, from the point of view of THIS one — "Deposit and
   * cancellation terms are set here". Say what the rule is, not that a link
   * exists; "click here to review" tells somebody nothing they cannot see.
   */
  children: ReactNode
  className?: string
}) {
  const label = (SUBPAGE_LABELS as Record<string, string>)[href]
  const hub = hubFor(href)
  /* "Setup → Lay-bys", so the sentence names the trail rather than a bare
     screen name somebody then has to go hunting for. Hub-less screens (none
     today) degrade to the label alone rather than rendering a stray arrow. */
  const trail = hub === '/setup' ? `Setup → ${label}` : label

  return (
    <Link
      href={href}
      className={`group flex items-start gap-2.5 rounded-card border border-border bg-surface-2 px-3.5 py-2.5 text-sm outline-none transition-colors hover:border-border-strong hover:bg-surface ${className}`}
    >
      <Settings size={15} className="mt-0.5 shrink-0 text-muted" />
      <span className="min-w-0 flex-1 text-muted">
        {children}{' '}
        <span className="font-medium text-brand group-hover:underline">{trail}</span>
      </span>
      <ChevronRight
        size={15}
        className="mt-0.5 shrink-0 text-faint transition-transform group-hover:translate-x-0.5"
      />
    </Link>
  )
}
