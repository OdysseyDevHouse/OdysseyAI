'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { Button, CategoryTile, Icons, TouchRow, type CategoryTone } from '@/components/ui'

/**
 * The four screens this window holds, in the order a counter reaches for them.
 *
 * Invoicing leads because it is what the window is FOR — the other three are
 * things you go and do. Same ordering principle as the till's module menu, and
 * the same four tones, so somebody who works both screens sees one product.
 */
const SCREENS: {
  href: string
  label: string
  hint: string
  icon: keyof typeof Icons
  tone: CategoryTone
}[] = [
  {
    href: '/invoicing',
    label: 'Invoicing',
    hint: 'Invoices and credit notes',
    icon: 'FileText',
    tone: 'emerald',
  },
  {
    href: '/invoicing/quotes',
    label: 'Quotes',
    hint: 'A price to think about',
    icon: 'FileText',
    tone: 'indigo',
  },
  {
    href: '/invoicing/orders',
    label: 'Sales orders',
    hint: 'Promised now, delivered later',
    icon: 'ListOrdered',
    tone: 'sky',
  },
  {
    href: '/invoicing/laybys',
    label: 'Lay-bys',
    /* Shorter than the till's wording for the same row: TouchRow truncates on
       one line, and "Take a payment or hand goods over" came back as "hand
       goods o…" here, where the panel is the same width but the label above it
       is longer. A hint that stops before the useful half is worse than a
       brief one. */
    hint: 'Paid off over time',
    icon: 'Package',
    tone: 'amber',
  },
]

/**
 * The invoicing window's own chrome.
 *
 * ── WHAT REPLACES THE SIDEBAR ─────────────────────────────────────────────
 *
 * A slim bar and a slide-in menu holding the four screens — deliberately the
 * same shape as the till's `ModuleMenu`, because the counter staff who work
 * this window are the people who work that one. A second navigation idiom in
 * the same product would be two things to learn for no reason.
 *
 * Not the same COMPONENT, though. The till's menu switches what the basket IS,
 * keyed on doc type, and never navigates — that is the whole point of it, since
 * unmounting a half-rung basket would lose the sale. This one navigates by URL,
 * because these are separate screens with separate data. Same shape, different
 * mechanism; sharing the component would mean one of them pretending.
 *
 * ── AND WHAT IS DELIBERATELY ABSENT ───────────────────────────────────────
 *
 * Everything else. No site switcher, no notification bell, no search, no rail
 * of Customers/Suppliers/Reports. The reason is in the layout's docblock: this
 * window has to keep working when the shop's server does not, and every control
 * that CANNOT survive that is a way for an operator to find themselves on a
 * dead page mid-document.
 *
 * The one way out is Back to the back office, and it says so plainly rather
 * than being an icon somebody has to guess at.
 */
export default function InvoicingChrome({
  siteName,
  capabilities,
  children,
}: {
  siteName: string
  /** Reserved: per-screen gating lands here when the screens grow it. */
  capabilities: string[]
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)

  /* Escape closes it, as everywhere else in the product. A panel whose only exit
     is a precise tap on the backdrop is one somebody gets stuck in. */
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  /* Navigating closes it. Without this the panel stays open over the screen it
     just opened, which reads as the tap not having worked. */
  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  /*
   * WHICH SCREEN IS SHOWING — longest match wins.
   *
   * `/invoicing` is a prefix of all three others, so a plain `startsWith` marks
   * Invoicing as current on every screen in the window. Sorting by length and
   * taking the first match is what makes /invoicing/quotes read as Quotes
   * rather than as both.
   */
  const current =
    [...SCREENS]
      .sort((a, b) => b.href.length - a.href.length)
      .find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`))?.href ?? '/invoicing'

  return (
    <>
      {/* THE BAR. `shrink-0` because the content below it scrolls — without it
          a long invoice squashes the chrome instead of overflowing, which is
          the flex-column trap this codebase has hit before. */}
      <header className="flex shrink-0 items-center gap-2.5 border-b border-border px-4 py-3">
        <button
          type="button"
          data-kit-ok
          onClick={() => setMenuOpen(true)}
          aria-label="Go to another part of invoicing"
          title="Go to"
          className="flex h-control w-control items-center justify-center rounded-control border border-border bg-surface text-ink-2 transition hover:border-brand/40 hover:bg-brand-soft hover:text-brand"
        >
          <Icons.Menu size={20} />
        </button>

        <span className="flex items-center gap-2.5">
          {/* Decorative beside the wordmark, so no alt of its own. */}
          <Image
            src="/logo-icon.png"
            alt=""
            aria-hidden
            width={318}
            height={278}
            unoptimized
            className="h-7 w-auto object-contain"
          />
          {/* Set like the till's lockup and the back office's rail — the same
              product name in the same face, so this reads as a room in the
              app rather than a different application. */}
          <span className="wordmark-lockup text-lg leading-none text-ink">
            Odyssey <span className="font-bold text-brand">Invoicing</span>
          </span>
        </span>

        <span className="ml-auto flex items-center gap-2.5">
          <span className="hidden text-[13px] text-muted sm:inline">{siteName}</span>
          {/* The one way out, named rather than drawn. An operator who opened
              this window from the back office still has that window; this is
              for the one who did not, or who has lost it behind this one. */}
          <Link
            href="/dashboard"
            className="flex h-control items-center gap-2 rounded-control border border-border bg-surface px-3 text-[13px] font-medium text-ink-2 transition hover:border-brand/40 hover:bg-brand-soft hover:text-brand"
            data-kit-ok
          >
            <Icons.ArrowLeft size={16} />
            Back office
          </Link>
        </span>
      </header>

      {/* `min-h-0` is what lets this scroll inside a flex column instead of
          pushing the header off screen. */}
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>

      {menuOpen && (
        <>
          {/* A plain div rather than a Button: a full-screen dismiss target with
              no label has no business in the tab order, and Escape plus the
              panel's own Close button are what make this reachable. */}
          <div
            data-kit-ok
            aria-hidden
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-40 bg-ink/50"
          />
          <aside
            /* LEFT, like the till's — it is a way back to somewhere, and every
               other back-affordance in this app lives on that edge. */
            className="fixed inset-y-0 left-0 z-50 flex w-[340px] max-w-[85vw] flex-col border-r border-border bg-surface shadow-pop"
            aria-label="Invoicing screens"
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <span className="text-[15px] font-semibold text-ink">Go to</span>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Close"
                onClick={() => setMenuOpen(false)}
              >
                <Icons.Close size={20} />
              </Button>
            </div>

            <nav className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
              {SCREENS.map((s) => {
                const Icon = Icons[s.icon]
                const isCurrent = s.href === current
                return (
                  <Link key={s.href} href={s.href} className="contents">
                    <TouchRow
                      icon={<CategoryTile icon={<Icon size={20} />} tone={s.tone} />}
                      title={s.label}
                      subtitle={s.hint}
                      tone={isCurrent ? 'active' : 'default'}
                      /* No chevron on the screen already showing — it would
                         promise somewhere the tap cannot take you. */
                      showChevron={!isCurrent}
                      trailing={
                        isCurrent ? (
                          <Icons.StatusSuccess size={18} className="text-brand" />
                        ) : undefined
                      }
                    />
                  </Link>
                )
              })}
            </nav>
          </aside>
        </>
      )}
    </>
  )
}
