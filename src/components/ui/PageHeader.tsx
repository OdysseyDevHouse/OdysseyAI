import Link from 'next/link'
import type { ReactNode } from 'react'
import { ArrowLeft } from './icons'
import { buttonClass } from './styles'

/** Title block at the top of a screen. One per page, above everything else. */
export function PageHeader({
  title,
  subtitle,
  action,
  backHref,
  backLabel = 'Back',
}: {
  title: string
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
          {subtitle && <p className="truncate text-sm text-muted">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  )
}

/** Standard page padding and max width, so every screen gutters the same. */
export function PageBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-col gap-5 px-6 pb-10 ${className}`}>{children}</div>
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
