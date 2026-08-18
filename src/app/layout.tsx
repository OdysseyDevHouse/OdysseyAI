import type { Metadata, Viewport } from 'next'
import './globals.css'
import { brandFont } from './brandFont'
import InlineScript from '@/components/InlineScript'

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /* The wordmark face is declared on <html> so every route group — the back
       office AND the till, which has its own layout — can reach it through the
       `.wordmark` class without each one remembering to add it. */
    <html lang="en" className={brandFont.variable} suppressHydrationWarning>
      <head>
        {/* Extracted to a CLIENT component, which is the shape Next documents
            for this (preventing-flash-before-hydration.md). The type switch
            inside it can only tell the two renders apart when it actually runs
            in the browser; in a server component the `text/plain` branch is
            dead code and the tag is always `text/javascript`. */}
        <InlineScript html={THEME_SCRIPT} />
      </head>
      <body>{children}</body>
    </html>
  )
}
