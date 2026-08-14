import type { ReactNode } from 'react'
import { TextLink } from '@/components/ui'

/**
 * The frame every portal page sits in.
 *
 * ── IT IS NOT THE APP SHELL ────────────────────────────────────────────────
 *
 * No sidebar, no store picker, no search, no notification bell. A customer is
 * not a user of this system and must never be shown the furniture of one — half
 * of it would 403 and the other half would be a menu of things that are none of
 * their business.
 *
 * The same reasoning as the reservation and feedback pages, and the same markup:
 * one column, the business name at the top, the content under it.
 */
export default function PortalShell({
  name,
  nav,
  children,
}: {
  name?: string
  /** Signed-in pages pass their tabs; the sign-in page has none. */
  nav?: ReactNode
  children: ReactNode
}) {
  return (
    <main className="min-h-screen bg-canvas px-4 py-8">
      <div className="mx-auto w-full max-w-3xl">
        {name ? (
          <p className="mb-3 text-sm text-muted">{name}</p>
        ) : null}
        {nav}
        <div className="rounded-card border border-border bg-surface p-6 shadow-card">
          {children}
        </div>
        {/*
         * Deliberately no "powered by" and no link back to the app. This page
         * belongs to the business the customer deals with, not to the software
         * behind it.
         */}
      </div>
    </main>
  )
}

/** The tab strip on the signed-in pages. */
export function PortalNav({
  token,
  active,
  onSignOut,
}: {
  token: string
  active: 'jobs' | 'invoices'
  onSignOut: ReactNode
}) {
  const tab = (href: string, label: string, isActive: boolean) => (
    <TextLink
      href={href}
      className={
        isActive
          ? 'border-b-2 border-brand pb-2 text-sm font-medium text-ink no-underline'
          : 'border-b-2 border-transparent pb-2 text-sm text-muted no-underline'
      }
    >
      {label}
    </TextLink>
  )

  return (
    <div className="mb-4 flex items-end justify-between gap-4 border-b border-border">
      <nav className="flex gap-5" aria-label="Your account">
        {tab(`/portal/${token}/jobs`, 'Your jobs', active === 'jobs')}
        {tab(`/portal/${token}/invoices`, 'Invoices', active === 'invoices')}
      </nav>
      <div className="pb-1">{onSignOut}</div>
    </div>
  )
}
