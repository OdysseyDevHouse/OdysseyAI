import { redirect } from 'next/navigation'
import { requireSession, requireSiteUser } from '@/lib/auth'
import { isSiteDataUnavailable } from '@/lib/sites'
import ControlUnreachable from '../(app)/ControlUnreachable'
import { getUser } from '@/lib/site/users'
import { can, capabilitiesForRole } from '@/lib/site/permissions'
import { getTillSession } from '@/lib/tillSession'
import { ToastProvider } from '@/components/ui'
import WindowSessionMarker from '@/components/WindowSessionMarker'
import InvoicingChrome from './InvoicingChrome'
import InvoicingGate from './InvoicingGate'
import InvoicingLicenceGate from './InvoicingLicenceGate'

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

  /* Same gate as (app)/layout.tsx, and for the same reason: this resolves the
     site through the control database, so a machine with no line throws a raw
     socket error at a user who can only read it as "the product is broken".
     Narrow on purpose — redirect() is also a throw and must pass through. */
  let resolved
  try {
    resolved = await requireSiteUser()
  } catch (err) {
    if (!isSiteDataUnavailable(err)) throw err
    return <ControlUnreachable err={err} />
  }
  const { site, capabilities } = resolved
  if (!can(capabilities, 'sales.view')) redirect('/not-allowed')

  /*
   * ── WHO IS STANDING AT THE COUNTER ──────────────────────────────────────
   *
   * The browser session above says which SHOP is open. This says which PERSON
   * is typing the invoice, and they are not the same fact: the session lasts
   * twelve hours while a trade counter changes hands several times a day.
   * Without this every document typed here would be attributed to whoever
   * opened the browser that morning.
   *
   * The same `odyssey_till` cookie the POS mints, deliberately — see
   * pinActions.ts. A clerk who signed in at the till is already signed in
   * here, and `withTillOperator` in the shared sales actions already reads it,
   * so attribution starts working the moment this gate does.
   */
  const till = await getTillSession(site.id)

  /* Rendered ABOVE the chrome, not inside it. A gate wrapped in a menu bar
     invites somebody to try the four doors behind it, all of which want the
     operator this screen is asking for. The till does the same thing for the
     same reason (see (app)/layout.tsx on the lease lock). */
  if (!till) {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-canvas">
        {/* On the GATE too, not only past it: the cookie has to be in place on
            the request that follows the PIN, and this is the render before it. */}
        <WindowSessionMarker />
        <ToastProvider>
          <InvoicingGate siteName={site.displayName} />
        </ToastProvider>
      </div>
    )
  }

  /* The OPERATOR's rights, read from their role rather than the browser
     session's — a manager who signed the browser in must not leave their own
     rights on the counter for the next clerk. */
  const operator = await getUser(site.id, till.userId)
  const operatorCapabilities = operator
    ? await capabilitiesForRole(site.id, operator.roleId)
    : capabilities

  return (
    /* SCROLLS, unlike the till.
       The POS is a fixed board where every key must stay where the cashier's
       hand expects it. These are documents — a long invoice has more lines than
       a screen, and a counter typing one needs to reach the bottom of it. So
       this takes the viewport and lets the content inside scroll, rather than
       forbidding scroll outright the way (pos)/layout.tsx does. */
    <div className="flex h-screen flex-col overflow-hidden bg-canvas">
      {/* Keeps the tab's id and its cookie in step for as long as this window
          lives — a browser restart can drop the cookie while restoring the tab. */}
      <WindowSessionMarker />
      <ToastProvider>
        {/* IS THIS MACHINE LICENSED?
            After the PIN gate above, not before — a clerk who cannot sign in
            learns nothing useful from a licensing message, which is the order
            the till uses too. Client-side because the device id is not a server
            fact; see InvoicingLicenceGate. */}
        <InvoicingLicenceGate>
          <InvoicingChrome
            /* The BROWSER session's rights still decide which of the four
               screens the menu offers — they are the same reads the back office
               allows. */
            capabilities={[...capabilities.granted]}
            /* The counter clerk, for the status strip and the shift. */
            operatorName={till.name}
            canCashup={can(operatorCapabilities, 'sales.cashup')}
          >
            {children}
          </InvoicingChrome>
        </InvoicingLicenceGate>
      </ToastProvider>
    </div>
  )
}
