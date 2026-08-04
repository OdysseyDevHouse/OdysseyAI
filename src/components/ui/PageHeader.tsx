import Link from 'next/link'
import type { ReactNode } from 'react'
import { buttonClass } from './styles'

/** Title block at the top of a screen. One per page, above everything else. */
export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-6 py-5">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
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
