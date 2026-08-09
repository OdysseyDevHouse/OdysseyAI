import { ToastProvider } from '@/components/ui'

/**
 * The till's shell — deliberately NOT (app)/layout.tsx.
 *
 * That one is back-office chrome: a sidebar, a topbar, a site switcher, and a
 * scrolling <main>. All three are wrong here. A cashier reaching past the basket
 * for a navigation rail is a cashier looking away from a customer; on a 1024-wide
 * counter screen the rail costs a whole column of basket; and a scrolling page
 * fights a screen whose whole point is that every control is always in the same
 * place.
 *
 * A route GROUP rather than a second route: `(pos)` contributes nothing to the
 * URL, so /pos gets its own layout with no duplicate path. The reference POS this
 * is modelled on has both /pos and /pos-full, and only because it ALSO embeds the
 * till inside the back office. We do not — one till, one shell.
 *
 * No auth gate here on purpose. `pos/page.tsx` gates itself, which leaves this
 * layout able to serve the public PIN-unlock screen a till needs when its browser
 * session has lapsed overnight.
 */

/* The till is installable, and its manifest is scoped to /pos so installing it
   does not put the whole back office behind a cache. */
export const metadata = {
  manifest: '/pos-manifest.json',
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  // A pinch-zoom on a till is always an accident — a stray second thumb while
  // reaching for a key — and it leaves the cashier on a screen they cannot
  // straighten out mid-sale with a customer waiting.
  maximumScale: 1,
  userScalable: false,
  // Draw under the notch/rounded corners on a tablet rather than letterboxing.
  viewportFit: 'cover' as const,
}

export default function PosLayout({ children }: { children: React.ReactNode }) {
  return (
    // `fixed inset-0` rather than h-screen: in Electron kiosk and on Windows
    // tablets the 100vh discrepancy shows up as a scrollbar on a screen that must
    // never scroll, and the fix is to take the viewport rather than measure it.
    //
    // The safe-area padding is what `viewportFit: 'cover'` above makes necessary.
    // Cover draws the page UNDER a tablet's notch and rounded corners, which is
    // what stops the till being letterboxed by black bars — but it also means the
    // top-right chips and the Exit button would sit under the notch on the
    // hardware this is built for. env() is 0 on a desktop monitor, so this costs
    // nothing there.
    <div
      className="till-surface fixed inset-0 flex flex-col overflow-hidden bg-canvas"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
    >
      <ToastProvider>{children}</ToastProvider>
    </div>
  )
}
