import type { Metadata, Viewport } from 'next'
import './globals.css'

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
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
