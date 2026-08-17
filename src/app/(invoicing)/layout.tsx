import { redirect } from 'next/navigation'
import { requireSession, requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { ToastProvider } from '@/components/ui'
import InvoicingChrome from './InvoicingChrome'

/**
 * The invoicing window — deliberately NOT (app)/layout.tsx.
 *
 * ── WHY THESE SCREENS LEFT THE BACK OFFICE ────────────────────────────────
 *
 * Invoicing, quotes, orders and lay-bys are what a TRADE COUNTER does all day.
 * The person running them is not a manager dipping into a screen; they are
 * standing at a counter with somebody in front of them, the same way a cashier
 * is at the till.
 *
 * The back-office chrome is wrong for that in the same three ways it is wrong
 * for the POS — a navigation rail is a place to look away from a customer, it
 * costs a column on a 1024-wide counter screen, and it invites wandering off
 * mid-document.
 *
 * ── AND THE REASON THAT MATTERS MOST: THE SERVER CAN DIE ──────────────────
 *
 * A hardware shop's local server goes down and the counter has to keep
 * invoicing. The till already survives that. What breaks the illusion is a
 * sidebar full of screens that CANNOT survive it — Customers, Suppliers,
 * Reports, Accounting — one absent-minded click and the operator is looking at
 * a dead page wondering whether the whole system is gone.
 *
 * Removing the rail is therefore not cosmetic. It is what makes "this window
 * keeps working" a promise the app can actually keep: everything reachable from
 * here is invoicing, and invoicing is what the offline layer covers.
 *
 * ── WHY A ROUTE GROUP ─────────────────────────────────────────────────────
 *
 * `(invoicing)` contributes nothing to the URL, so the screens live at
 * /invoicing/* with their own layout and no duplicate path — the same trick
 * `(pos)` uses. The SALES ENGINE stays where it is: `sales/actions.ts` is
 * shared with the POS, the print routes and contracts, and dragging it in here
 * would put a module three consumers depend on inside one of them.
 */

export const dynamic = 'force-dynamic'

export default async function InvoicingLayout({ children }: { children: React.ReactNode }) {
  /* The same gate the back office applies, because this is the same data. A
     route group with no auth would be a second front door to every invoice in
     the shop. */
  const session = await requireSession()
  if (session.mustChangePassword) redirect('/change-password')
  if (session.siteId === null) redirect('/select-site')

  const { site, capabilities } = await requireSiteUser()
  if (!can(capabilities, 'sales.view')) redirect('/not-allowed')

  return (
    /* SCROLLS, unlike the till.
       The POS is a fixed board where every key must stay where the cashier's
       hand expects it. These are documents — a long invoice has more lines than
       a screen, and a counter typing one needs to reach the bottom of it. So
       this takes the viewport and lets the content inside scroll, rather than
       forbidding scroll outright the way (pos)/layout.tsx does. */
    <div className="flex h-screen flex-col overflow-hidden bg-canvas">
      <ToastProvider>
        <InvoicingChrome siteName={site.displayName} capabilities={[...capabilities.granted]}>
          {children}
        </InvoicingChrome>
      </ToastProvider>
    </div>
  )
}
