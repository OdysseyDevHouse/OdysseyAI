import type { Metadata, Viewport } from 'next'
import './globals.css'
import { brandFont } from './brandFont'

export const metadata: Metadata = {
  title: 'OdysseyAI Back Office',
  description: 'Multi-store point of sale back office',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

/**
 * Replays a saved light/dark choice onto <html> BEFORE the first paint.
 *
 * This has to be a blocking inline script rather than an effect: React runs
 * effects after the browser has already painted, so a user on dark would see a
 * white flash on every navigation. Absent or unreadable storage leaves the
 * attribute off, which is what makes the app follow the OS by default.
 */
const THEME_SCRIPT = `
try {
  var t = localStorage.getItem('odyssey.theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
`

/**
 * The theme script, in the one shape React will render without complaining.
 *
 * A bare `<script>` in a rendered tree makes React throw "Encountered a script
 * tag while rendering React component" — scripts inserted through a DOM update
 * never execute, so it refuses rather than silently doing nothing. That error
 * broke hydration for the whole app, which meant no form on any page became
 * interactive.
 *
 * The fix is the one Next documents for exactly this case
 * (docs/01-app/02-guides/preventing-flash-before-hydration.md): serve it as
 * real JavaScript, and mark it `text/plain` on the client so React has nothing
 * to execute when it hydrates. `suppressHydrationWarning` covers the type
 * attribute differing between the two.
 */
function ThemeScript() {
  return (
    <script
      type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}
    />
  )
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /* The wordmark face is declared on <html> so every route group — the back
       office AND the till, which has its own layout — can reach it through the
       `.wordmark` class without each one remembering to add it. */
    <html lang="en" className={brandFont.variable} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>{children}</body>
    </html>
  )
}
