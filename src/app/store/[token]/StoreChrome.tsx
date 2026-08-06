'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { Badge, Icons, ToastProvider } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { StorefrontDepartment } from '@/lib/site/storefront'
import type { StorefrontTheme } from '@/lib/storefrontModel'
import { useCart } from './CartContext'

/**
 * The shop's frame: header with a basket, department nav, and a footer.
 *
 * Uses the same design tokens as the back office — a storefront that looked
 * like a different product would be the one screen nobody could restyle from
 * globals.css. The layout is its own, though: this is read on a phone in a
 * queue, so it goes single-column early and the basket is always reachable.
 */
export default function StoreChrome({
  token,
  storeName,
  blurb,
  departments,
  theme,
  children,
}: {
  token: string
  storeName: string
  blurb: string
  departments: StorefrontDepartment[]
  theme: StorefrontTheme
  children: ReactNode
}) {
  const cart = useCart()
  const base = `/store/${token}`

  return (
    // The storefront sits outside the (app) layout, so it brings its own
    // toaster — "added to basket" is the only feedback a tap on a phone gets.
    <ToastProvider>
    {/* The shop's own colour, applied by overriding the brand token for this
        subtree only. Every `text-brand` and `bg-brand` inside then follows it,
        so a store re-colours its whole shop without a single component knowing
        the theme exists. The value is hex-validated before it is stored. */}
    <div
      className="flex min-h-screen flex-col bg-canvas"
      style={{ '--color-brand': theme.brandColour } as React.CSSProperties}
    >
      <header className="sticky top-0 z-20 border-b border-border bg-surface">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-4 px-4 py-3">
          <Link href={base} className="min-w-0 flex-1">
            <span className="block truncate text-base font-semibold text-ink">{storeName}</span>
            {blurb && <span className="block truncate text-sm text-muted">{blurb}</span>}
          </Link>

          <Link
            href={`${base}/checkout`}
            className="flex shrink-0 items-center gap-2 rounded-control border border-border px-3 py-2 text-sm font-medium text-ink transition hover:bg-surface-2"
          >
            <Icons.Package size={16} />
            {/* Suppressed until the basket has been read from storage, so the
                server's "0" and the client's real count never disagree. */}
            {cart.ready && cart.count > 0 ? (
              <>
                <Badge tone="brand">{cart.count}</Badge>
                <span className="numeric hidden sm:inline">{formatMoney(cart.subtotal)}</span>
              </>
            ) : (
              <span>Basket</span>
            )}
          </Link>
        </div>

        {departments.length > 0 && (
          <nav
            aria-label="Departments"
            className="mx-auto flex w-full max-w-5xl gap-1 overflow-x-auto px-4 pb-2"
          >
            <Link
              href={base}
              className="shrink-0 rounded-pill px-3 py-1.5 text-sm text-ink-2 transition hover:bg-surface-2"
            >
              Everything
            </Link>
            {departments.map((d) => (
              <Link
                key={d.id}
                href={`${base}?department=${d.id}`}
                className="shrink-0 rounded-pill px-3 py-1.5 text-sm text-ink-2 transition hover:bg-surface-2"
              >
                {d.name}
              </Link>
            ))}
          </nav>
        )}
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>

      <footer className="border-t border-border bg-surface">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 text-sm text-muted sm:flex-row sm:justify-between">
          <div className="min-w-0">
            <p className="font-medium text-ink">{storeName}</p>
            {theme.footerAbout && <p className="mt-1 max-w-md">{theme.footerAbout}</p>}
            <p className="mt-1">
              Orders placed here are confirmed by the shop before they are prepared.
            </p>
          </div>

          <div className="shrink-0">
            {theme.footerHours && (
              <>
                <p className="font-medium text-ink">Opening hours</p>
                <p className="mt-0.5 whitespace-pre-line">{theme.footerHours}</p>
              </>
            )}

            {(theme.socialFacebook || theme.socialInstagram || theme.socialWhatsapp) && (
              <div className="mt-3 flex items-center gap-3">
                {/* rel="noreferrer" on every outbound link: the shop's own
                    URL carries its store token, and leaking it in a Referer
                    header hands anyone the shop's private link. */}
                {theme.socialFacebook && (
                  <a
                    href={theme.socialFacebook}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-brand hover:underline"
                  >
                    Facebook
                  </a>
                )}
                {theme.socialInstagram && (
                  <a
                    href={theme.socialInstagram}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-brand hover:underline"
                  >
                    Instagram
                  </a>
                )}
                {theme.socialWhatsapp && (
                  <a
                    href={`https://wa.me/${theme.socialWhatsapp.replace(/\D/g, '')}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-brand hover:underline"
                  >
                    WhatsApp
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      </footer>
    </div>
    </ToastProvider>
  )
}
