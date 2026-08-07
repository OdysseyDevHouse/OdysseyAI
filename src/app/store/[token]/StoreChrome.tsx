'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { Icons, Input, ToastProvider } from '@/components/ui'
import type { StorefrontDepartment } from '@/lib/site/storefront'
import type { StorefrontTheme } from '@/lib/storefrontModel'
import { useCart } from './CartContext'
import { useWishlist } from './WishlistContext'
import CartBar from './CartBar'

/**
 * The shop's frame: masthead, department rail, footer.
 *
 * ── TWO BANDS, BOTH STICKY ───────────────────────────────────────────────
 *
 * Identity and search on top, departments beneath. Both stay put, because the
 * two things a shopper does most are search and change department, and a
 * catalogue is long enough that either would otherwise mean scrolling back to
 * the top first.
 *
 * ── SEARCH SUBMITS, IT DOES NOT FILTER AS YOU TYPE ───────────────────────
 *
 * The browser does not hold the catalogue — the server does the matching — so
 * a keystroke filter would be a request per character. Submitting also puts
 * the term in the URL, which makes the back button and a shared link both
 * behave the way a shopper expects.
 */
export default function StoreChrome({
  token,
  storeName,
  blurb,
  departments,
  theme,
  allowAccount,
  customerName,

  children,
}: {
  token: string
  storeName: string
  blurb: string
  departments: StorefrontDepartment[]
  theme: StorefrontTheme
  /** Whether this shop offers account ordering at all. */
  allowAccount: boolean
  /** The signed-in customer, or null. Name only — never the account itself. */
  customerName: string | null

  children: ReactNode
}) {
  const base = `/store/${token}`

  return (
    // The storefront sits outside the (app) layout, so it brings its own
    // toaster — feedback on a phone has nowhere else to go.
    <ToastProvider>
      {/* The shop's own colour, applied by overriding the brand token for this
          subtree only. Every `text-brand` and `bg-brand` inside then follows
          it, so a store re-colours its whole shop without a single component
          knowing the theme exists. The value is hex-validated before storage. */}
      <div
        className="flex min-h-screen flex-col bg-canvas"
        style={{ '--color-brand': theme.brandColour } as React.CSSProperties}
      >
        <header className="sticky top-0 z-20 bg-surface">
          <div className="border-b border-border">
            <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 py-4">
              <Link href={base} className="min-w-0 shrink-0" aria-label={storeName}>
                {theme.logoImageId ? (
                  /*
                    The logo REPLACES the name, it does not sit beside it: a
                    logo almost always contains the shop's name already, and
                    printing it twice is the commonest way a masthead ends up
                    looking wrong.

                    The name still travels — as the alt text and as the link's
                    aria-label above — so a shopper who cannot see the image,
                    or whose connection drops it, still gets the shop's name.

                    A capped height with w-auto, so a wide logo and a square
                    one both sit on the same line without one of them
                    stretching the header.
                  */
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/store-images/${token}/shop/${theme.logoImageId}`}
                    alt={storeName}
                    className="h-9 w-auto max-w-48 object-contain"
                  />
                ) : (
                  <>
                    <span className="block truncate text-base font-semibold leading-tight text-ink">
                      {storeName}
                    </span>
                    {blurb && <span className="block truncate text-sm text-muted">{blurb}</span>}
                  </>
                )}
              </Link>

              <SearchForm token={token} className="hidden min-w-0 flex-1 md:flex" />

              <div className="ml-auto flex shrink-0 items-center">
                {/* Only when the shop offers accounts. A shop that does not
                    should never show a sign-in for something it has not got. */}
                {allowAccount && (
                  <Link
                    href={`${base}/account`}
                    className="flex w-16 flex-col items-center px-1 py-1 text-ink transition hover:opacity-75"
                    aria-label={
                      customerName ? `Your account, signed in as ${customerName}` : 'Sign in'
                    }
                  >
                    <span className="flex h-6 w-6 items-center justify-center">
                      <Icons.Contact size={20} />
                    </span>
                    {/* The first name only. The full account name is often a
                        company and would not fit — and the point is only to
                        show that they ARE signed in. */}
                    <span className="mt-1 hidden max-w-full truncate text-xs font-medium leading-none sm:block">
                      {customerName ? customerName.split(/\s+/)[0] : 'Sign in'}
                    </span>
                  </Link>
                )}
                <WishlistAction token={token} />
                <BasketAction token={token} />
              </div>
            </div>

            {/* The phone's search sits on its own line: sharing a row with the
                shop name leaves neither enough width to be usable. */}
            <div className="px-4 pb-3 md:hidden">
              <SearchForm token={token} className="flex" />
            </div>
          </div>

          {departments.length > 0 && (
            <nav
              aria-label="Departments"
              className="mx-auto flex w-full max-w-6xl gap-1 overflow-x-auto border-b border-border px-4 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <Link
                href={base}
                className="shrink-0 whitespace-nowrap rounded-pill px-3 py-1.5 text-sm text-ink-2 transition hover:bg-surface-2"
              >
                Everything
              </Link>
              {departments.map((d) => (
                <Link
                  key={d.id}
                  href={`${base}/c/${d.id}`}
                  className="shrink-0 whitespace-nowrap rounded-pill px-3 py-1.5 text-sm text-ink-2 transition hover:bg-surface-2"
                >
                  {d.name}
                </Link>
              ))}
            </nav>
          )}
        </header>

        {/* pb-28 clears the phone cart bar, which is fixed to the bottom and
            would otherwise sit on top of the last row of the page. */}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 pb-28 md:pb-5">{children}</main>

        <Footer storeName={storeName} theme={theme} />
        <CartBar token={token} />
      </div>
    </ToastProvider>
  )
}

function SearchForm({ token, className = '' }: { token: string; className?: string }) {
  const router = useRouter()
  /*
   * Seeded from the URL so the term survives the navigation it caused — a
   * search box that empties itself the moment it returns results looks like it
   * lost the search. Read here rather than passed down from the layout,
   * because a layout cannot see searchParams.
   */
  const params = useSearchParams()
  const [term, setTerm] = useState(params.get('q') ?? '')

  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault()
        const q = term.trim()
        router.push(`/store/${token}${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      }}
    >
      <Input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search for products"
        aria-label="Search products"
        icon={<Icons.Search size={16} />}
        className="w-full"
      />
    </form>
  )
}

/** Saved for later. The count stays hidden until storage has been read. */
function WishlistAction({ token }: { token: string }) {
  const wishlist = useWishlist()
  const showCount = wishlist.ready && wishlist.count > 0

  return (
    <Link
      href={`/store/${token}/wishlist`}
      className="relative flex w-16 flex-col items-center px-1 py-1 text-ink transition hover:opacity-75"
      aria-label={showCount ? `Wishlist, ${wishlist.count} saved` : 'Wishlist'}
    >
      <span className="relative flex h-6 w-6 items-center justify-center">
        <Icons.Heart size={20} />
        {showCount && (
          <span className="absolute -right-2.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-pill bg-brand px-1 text-[11px] font-semibold leading-none text-white">
            {wishlist.count > 99 ? '99+' : wishlist.count}
          </span>
        )}
      </span>
      <span className="mt-1 hidden truncate text-xs font-medium leading-none sm:block">Saved</span>
    </Link>
  )
}

/** The basket, always reachable. Counts stay hidden until storage has been read. */
function BasketAction({ token }: { token: string }) {
  const cart = useCart()

  return (
    <Link
      href={`/store/${token}/checkout`}
      className="relative flex w-16 flex-col items-center px-1 py-1 text-ink transition hover:opacity-75"
      aria-label={cart.ready && cart.count > 0 ? `Basket, ${cart.count} items` : 'Basket'}
    >
      <span className="relative flex h-6 w-6 items-center justify-center">
        <Icons.ShoppingCart size={22} />
        {/* Only the badge is brand-coloured, so the thing that CHANGES is the
            thing that draws the eye. */}
        {cart.ready && cart.count > 0 && (
          <span className="absolute -right-2.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-pill bg-brand px-1 text-[11px] font-semibold leading-none text-white">
            {cart.count > 99 ? '99+' : cart.count}
          </span>
        )}
      </span>
      <span className="mt-1 hidden truncate text-xs font-medium leading-none sm:block">
        Basket
      </span>
    </Link>
  )
}

function Footer({ storeName, theme }: { storeName: string; theme: StorefrontTheme }) {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 text-sm text-muted sm:flex-row sm:justify-between">
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
              {/* rel="noreferrer" on every outbound link: the shop's own URL
                  carries its store token, and leaking it in a Referer header
                  hands anyone the shop's private link. */}
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
  )
}
