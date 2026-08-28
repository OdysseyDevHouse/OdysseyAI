import type { ReactNode } from 'react'
import { TextLink } from '@/components/ui'
import type { PortalSettings } from '@/lib/site/portalAuth'

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

export type PortalTab = 'jobs' | 'account' | 'transactions' | 'statement' | 'invoices'

/**
 * The tab strip on the signed-in pages.
 *
 * ── THE TABS ARE WHAT THE SHOP OFFERS, NOT A FIXED LIST ────────────────────
 *
 * It used to name two pages outright. Now that a shop can run the jobs portal,
 * the account portal, or both, a fixed strip would show a customer tabs that
 * redirect the moment they are clicked — the section guard would bounce them
 * back, which reads as a broken page rather than a feature that is switched off.
 *
 * So it is built from the same `PortalSettings` the guards read. A tab is shown
 * when the section behind it would let the customer in, and never otherwise.
 */
export function PortalNav({
  token,
  active,
  settings,
  onSignOut,
}: {
  token: string
  active: PortalTab
  settings: PortalSettings
  onSignOut: ReactNode
}) {
  const tab = (href: string, label: string, isActive: boolean) => (
    <TextLink
      key={href}
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

  const tabs = [
    settings.isEnabled && tab(`/portal/${token}/jobs`, 'Your jobs', active === 'jobs'),
    settings.accountsEnabled &&
      tab(`/portal/${token}/account`, 'Your details', active === 'account'),
    settings.showTransactions &&
      tab(`/portal/${token}/transactions`, 'Transactions', active === 'transactions'),
    settings.showStatement &&
      tab(`/portal/${token}/statement`, 'Statement', active === 'statement'),
    settings.accountsEnabled &&
      tab(`/portal/${token}/invoices`, 'Invoices', active === 'invoices'),
  ].filter(Boolean)

  return (
    <div className="mb-4 flex items-end justify-between gap-4 border-b border-border">
      {/* Scrolls rather than wraps: five tabs on a phone would otherwise stack
          into two rows and push the content down the page. */}
      <nav className="flex gap-5 overflow-x-auto" aria-label="Your account">
        {tabs}
      </nav>
      <div className="shrink-0 pb-1">{onSignOut}</div>
    </div>
  )
}
