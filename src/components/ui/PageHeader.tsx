import Link from 'next/link'
import type { ReactNode } from 'react'
import { ArrowLeft } from './icons'
import { buttonClass } from './styles'

/** Title block at the top of a screen. One per page, above everything else. */
export function PageHeader({
  title,
  icon,
  status,
  subtitle,
  action,
  backHref,
  backLabel = 'Back',
}: {
  title: string
  /**
   * A glyph in a soft tile to the left of the title, naming the section the
   * way the sidebar row does. For the LANDING screen of a section — the
   * invoice register, the product catalogue — where it gives the page an
   * identity you recognise before reading.
   *
   * Leave it off on detail screens: those get `backHref`, and an arrow plus a
   * tile is two competing things in the same corner.
   */
  icon?: ReactNode
  /**
   * A status chip sitting between the title and the subtitle — usually a
   * <Badge>. For the state of the record being edited ("Draft", "Issued"),
   * which the subtitle can only describe in prose and easily gets skimmed past.
   */
  status?: ReactNode
  subtitle?: string
  action?: ReactNode
  /**
   * Shows a back arrow to the left of the title. Use on detail screens, where
   * it replaces a Cancel button — leaving is the same act either way, and one
   * obvious way out beats two.
   */
  backHref?: string
  /** Announced to screen readers; the arrow itself carries no text. */
  backLabel?: string
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
      <div className="flex min-w-0 items-center gap-3">
        {backHref && (
          <Link
            href={backHref}
            aria-label={backLabel}
            className="flex size-8 shrink-0 items-center justify-center rounded-control text-muted transition hover:bg-surface-2 hover:text-ink"
          >
            <ArrowLeft size={18} />
          </Link>
        )}
        {/* Never shown next to a back arrow — see the prop's note. */}
        {icon && !backHref && (
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-card bg-brand-soft text-brand"
          >
            {icon}
          </span>
        )}
        {/* Title and subtitle on one line: a detail screen's subtitle names the
            record, so it reads as "Edit product — 2-Hole Punch 22" rather than
            as a second, competing heading. */}
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 className="shrink-0 text-lg font-semibold text-ink">{title}</h1>
          {/* `self-center` so a pill sits on the title's optical centre rather
              than on its baseline, where its own padding would hang it low. */}
          {status && <span className="shrink-0 self-center">{status}</span>}
          {subtitle && <p className="truncate text-sm text-muted">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  )
}

/**
 * Standard page padding and max width, so every screen gutters the same.
 *
 * `pt-5` matches the `gap-5` between the sections below it, so the space under
 * the header reads as part of the same rhythm rather than as a seam. Without
 * it the first element — usually a toolbar or a New button — sits flush against
 * the header's bottom border and looks wedged there.
 */
export function PageBody({
  children,
  className = '',
  flush = false,
}: {
  children: ReactNode
  className?: string
  /**
   * Drop the bottom padding, for a body that is NOT the end of the page.
   *
   * `pb-10` exists so the last card does not sit flush against the window,
   * which is right whenever this is the final thing on the screen — nearly
   * always. The invoicing editor is the exception: it renders its own
   * PageBody and the screen then adds a deposit panel, an outcome panel or
   * proof of delivery below it, so that trailing 40px landed on top of the
   * next section's own spacing and made one seam three times every other gap.
   *
   * A PROP rather than `className="pb-0"` at the call site: Tailwind resolves
   * conflicting utilities by stylesheet order, not by the order they appear in
   * a class string, so an appended `pb-0` loses to the `pb-10` in here and
   * silently does nothing. The class has to not be emitted at all.
   */
  flush?: boolean
}) {
  return (
    <div className={`flex flex-col gap-5 px-6 pt-5 ${flush ? '' : 'pb-10'} ${className}`}>
      {children}
    </div>
  )
}

/**
 * The primary "New ..." link in a page header.
 *
 * Server components can't hand an onClick to <Button>, so navigation actions
 * use this — it borrows the exact same button skin.
 *
 * `target`/`rel` pass through for the one link that needs them: the till opens
 * beside the back office rather than replacing it (see lib/openTill.ts). They
 * are declared rather than spread from `...rest` so that this stays a link and
 * not a place to re-style a button at the call site.
 */
export function PrimaryLink({
  href,
  target,
  rel,
  children,
}: {
  href: string
  target?: string
  rel?: string
  children: ReactNode
}) {
  return (
    <Link href={href} target={target} rel={rel} className={buttonClass({ variant: 'primary' })}>
      {children}
    </Link>
  )
}
