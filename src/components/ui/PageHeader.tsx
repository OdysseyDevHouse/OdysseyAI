import Link from 'next/link'
import type { ReactNode } from 'react'
import { ArrowLeft } from './icons'
import { buttonClass } from './styles'

/** Title block at the top of a screen. One per page, above everything else. */
export function PageHeader({
  title,
  status,
  subtitle,
  action,
  backHref,
  backLabel = 'Back',
}: {
  title: string
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
export function PageBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-col gap-5 px-6 pt-5 pb-10 ${className}`}>{children}</div>
}

/**
 * The primary "New ..." link in a page header.
 *
 * Server components can't hand an onClick to <Button>, so navigation actions
 * use this — it borrows the exact same button skin.
 */
export function PrimaryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={buttonClass({ variant: 'primary' })}>
      {children}
    </Link>
  )
}
