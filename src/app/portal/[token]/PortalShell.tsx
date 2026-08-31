import type { ReactNode } from 'react'
import { LinkTabs } from '@/components/ui'
import type { PortalSettings } from '@/lib/site/portalAuth'

/**
 * The letterhead: the shop's logo where it has one, its name either way.
 *
 * A plain <img> rather than next/image: the source is a route that streams
 * bytes from disk with no known dimensions, and the optimiser would want a
 * width and a height this cannot supply. `alt=""` because the name is already
 * beside it in text — a screen reader announcing both would say it twice.
 */
function Letterhead({ token, name, hasLogo }: { token: string; name?: string; hasLogo: boolean }) {
  if (!name && !hasLogo) return null
  return (
    <div className="flex items-center gap-2.5">
      {hasLogo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/portal/${token}/logo`}
          alt=""
          className="h-8 w-auto max-w-[160px] object-contain"
        />
      )}
      {name ? <span className="truncate text-base font-semibold text-ink">{name}</span> : null}
    </div>
  )
}

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
  /** The page's own heading and its one action, laid out like PageHeader. */
  title,
  subtitle,
  action,
  /**
   * Wrap the children in a card.
   *
   * ── THE SHELL USED TO DO THIS UNCONDITIONALLY, AND IT WAS THE BUG ────────
   *
   * Every page came pre-wrapped in one big bordered panel, so a page that
   * wanted two Cards — details and addresses, say — could not have them
   * without nesting a card inside a card. The result was pages hand-rolling
   * `rounded-card border border-border` on a <dl> and a <ul> to fake what the
   * kit already draws, which is exactly the drift the design system exists to
   * stop.
   *
   * So the frame is now opt-in. Signed-in pages compose their own Cards and
   * pass `false`; the sign-in, closed and expired pages are a single block of
   * prose and keep the panel.
   */
  card = true,
  /** The site token, for the logo route. Omitted on pages with no letterhead. */
  token,
  hasLogo = false,
  /** Sign out, rendered in the letterhead row rather than beside the tabs. */
  onSignOut,
  children,
}: {
  name?: string
  /** Signed-in pages pass their tabs; the sign-in page has none. */
  nav?: ReactNode
  title?: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
  card?: boolean
  token?: string
  hasLogo?: boolean
  onSignOut?: ReactNode
  children: ReactNode
}) {
  return (
    <main className="min-h-screen bg-canvas px-4 py-8">
      {/*
       * Wider than the old max-w-3xl. A statement row carries a document
       * number, two dates, a badge, an amount, a PDF link and a Pay button —
       * at 48rem those wrap onto a second line on a laptop, which is what made
       * the list look untidy rather than dense.
       */}
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
        {/*
         * ── THE LETTERHEAD IS A ROW, NOT A LINE OF SMALL PRINT ─────────────
         *
         * The business name used to be a muted 14px line above the tabs, which
         * read as a caption rather than as whose page this is. It now carries
         * the shop's logo and its name at full weight, with Sign out opposite —
         * the arrangement every letter, invoice and statement from this
         * business already uses.
         *
         * Sign out moved here from beside the tabs for the same reason: it is
         * an action on the SESSION, not on the section being viewed, and
         * sitting in the tab strip it read as a fifth tab.
         */}
        {(name || hasLogo || onSignOut) && (
          <div className="flex items-center justify-between gap-4">
            <Letterhead token={token ?? ''} name={name} hasLogo={hasLogo && Boolean(token)} />
            {onSignOut ? <div className="shrink-0">{onSignOut}</div> : null}
          </div>
        )}

        {nav}

        {title ? (
          /* The same shape as PageHeader in the back office — title, subtitle
             under it, one action hard right — without importing it, since that
             component carries breadcrumbs and a back link that mean nothing to
             a customer. */
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-ink">{title}</h1>
              {subtitle ? <div className="mt-0.5 text-sm text-muted">{subtitle}</div> : null}
            </div>
            {action ? <div className="shrink-0">{action}</div> : null}
          </div>
        ) : null}

        {card ? (
          <div className="rounded-card border border-border bg-surface p-6 shadow-card">
            {children}
          </div>
        ) : (
          children
        )}
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
}: {
  token: string
  active: PortalTab
  settings: PortalSettings
}) {
  /*
   * LinkTabs, not a hand-rolled strip.
   *
   * This drew its own <a>s with its own border-b-2 active treatment — a second
   * spelling of the tab bar the whole back office already uses, which would
   * drift the first time either was restyled. The kit's version is href-driven,
   * which is what a server-rendered page needs.
   */
  const items = [
    settings.isEnabled && { value: 'jobs' as const, label: 'Your jobs', href: `/portal/${token}/jobs` },
    settings.accountsEnabled && {
      value: 'account' as const,
      label: 'Your details',
      href: `/portal/${token}/account`,
    },
    settings.showTransactions && {
      value: 'transactions' as const,
      label: 'Transactions',
      href: `/portal/${token}/transactions`,
    },
    settings.showStatement && {
      value: 'statement' as const,
      label: 'Statement',
      href: `/portal/${token}/statement`,
    },
    settings.accountsEnabled && {
      value: 'invoices' as const,
      label: 'Invoices',
      href: `/portal/${token}/invoices`,
    },
  ].filter(Boolean) as { value: PortalTab; label: string; href: string }[]

  return <LinkTabs items={items} value={active} aria-label="Your account" />
}
