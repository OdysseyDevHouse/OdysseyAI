import { redirect } from 'next/navigation'
import { requireSession, requireSiteUser } from '@/lib/auth'
import { listSitesForUser, isSiteDataUnavailable } from '@/lib/sites'
import { opensHere } from '@/lib/siteOpensHere'
import { unreadCount } from '@/lib/site/notifications'
import Sidebar from '@/components/Sidebar'
import TopBar from '@/components/TopBar'
import { MobileTopBar } from '@/components/MobileTopBar'
import { isMobileShell } from '@/lib/mobileShell'
import { ToastProvider } from '@/components/ui'
import DesktopLicenceGate from './DesktopLicenceGate'
import LeaseLockScreen from './LeaseLockScreen'
import ControlUnreachable from './ControlUnreachable'
import { lockState } from '@/lib/licence/lockState'
import PrecisionProvider from '@/components/PrecisionProvider'
import DeviceHeartbeat from '@/components/DeviceHeartbeat'
import { getSettings } from '@/lib/site/settings'
import { setDisplayPrecision } from '@/lib/decimals'
import { hiddenAreas } from '@/lib/site/menuVisibility'
import type { MenuArea } from '@/lib/menuAreas'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  /* Read once, on the server. `APP_MODE` is baked in by `build:desktop`, so this
     is a fact about which build is running rather than a claim from the client
     — which is the difference between a check and a suggestion. */
  const isDesktop = process.env.APP_MODE === 'desktop'

  const session = await requireSession()

  // Enforced here rather than only at login, so typing a URL can't skip it.
  if (session.mustChangePassword) redirect('/change-password')
  if (session.siteId === null) redirect('/select-site')

  // Site access, the local user record and their permissions, all re-read per
  // request rather than trusted from the token — so access revoked upstream or
  // a role changed on the permissions screen takes effect on the next load.
  /*
   * ── THE LINE IS DOWN: ONE SCREEN, NOT A STACK TRACE ─────────────────────
   *
   * Everything below needs the control panel at least indirectly, and on a
   * machine with no internet these reads throw a raw socket error — `connect
   * ENETUNREACH 105.30.57.88:3306`. That lands on global-error.tsx, which is a
   * DIAGNOSTIC screen by design: it shows the real error because for a genuine
   * fault the only reader is the person who can act on it.
   *
   * A shop with no internet is not a genuine fault, and the reader is the owner.
   * So the one condition that has a plain-English remedy is caught here and
   * given the same treatment as an expired lease — a screen that says what
   * happened and what to do.
   *
   * The same goes for a database that ANSWERS and refuses — a wrong password
   * or a schema that is not there. Nothing about "Access denied for user
   * 'ody10003'@'127.0.0.1'" needs a stack trace to be understood, and the
   * reader can fix it in the row it came from, so it gets the screen too. What
   * it does NOT get is the same wording; see ControlUnreachable.
   *
   * ── WHY THE CATCH IS NARROW ──────────────────────────────────────────────
   *
   * `redirect()` works by throwing, and requireSession()/requireSiteUser() both
   * use it — for a password change, a missing site, a superseded session.
   * Swallowing that would strand the user on this screen instead of sending
   * them where they were meant to go. So only a recognised failure to open the
   * site's data is caught; everything else, redirects included, is re-thrown
   * untouched.
   */
  let resolved
  try {
    resolved = await requireSiteUser()
  } catch (err) {
    if (!isSiteDataUnavailable(err)) throw err
    /* Which screen that becomes depends on the build — see ControlUnreachable.
       A till gets the plain-English remedy; the web build gets the error, because
       there the reader is an operator and the cause is a setting. */
    return (
      <ToastProvider>
        <ControlUnreachable err={err} />
      </ToastProvider>
    )
  }
  const { site, user, capabilities, modules } = resolved

  /*
   * ── HOW MANY DECIMALS THIS SHOP SHOWS ───────────────────────────────────
   *
   * Set on the module before anything below renders, because `formatQty` and
   * `formatCost` are called from server components deep in the tree and cannot
   * each be handed a preference — see lib/decimals.ts for why it is a set
   * value rather than a parameter at 248 call sites.
   *
   * PER REQUEST, and that is the load-bearing part: one Node process serves
   * many shops, so a value read once at boot would be whichever site rendered
   * first and every other shop would silently inherit it. A request is handled
   * to completion before the next layout runs, so setting it here is safe.
   *
   * A failed read leaves the defaults in place, which are exactly what these
   * functions printed before the setting existed. `PrecisionProvider` below
   * carries the same two numbers into the client half of the tree.
   *
   * `getting_started_hidden` rides along on this read rather than taking one of
   * its own: it is wanted on every page load, because the sidebar is drawn on
   * all of them, and it comes out of the same settings row these two do.
   */
  const decimals = await getSettings(site.id, [
    'qty_decimals',
    'cost_decimals',
    'getting_started_hidden',
  ]).catch(() => null)
  const precision = {
    qty: Number(decimals?.qty_decimals ?? 2),
    cost: Number(decimals?.cost_decimals ?? 2),
  }
  setDisplayPrecision(precision)

  /* Defaults to SHOWN when the read failed. The row is how a new shop finds the
     screen written for it, so a settings blip must not be what takes it away. */
  const gettingStartedHidden = decimals?.getting_started_hidden === '1'

  /*
   * ── OUT OF LEASE: NOTHING ELSE RENDERS ──────────────────────────────────
   *
   * A local-backend machine may trade offline for a week; past that it stops.
   * Decided on the SERVER, deliberately: DesktopLicenceGate fails open in three
   * places by design, so an offline machine sails through it — and an offline
   * machine is precisely the one this rule exists for.
   *
   * Returned above the chrome rather than inside it. A locked machine showing a
   * sidebar and a store picker invites the cashier to try twelve doors that are
   * all shut; one screen that explains itself and offers the unlock is kinder
   * and shorter. On a cloud install lockState() is a no-op that returns `open`
   * without reading anything.
   */
  const lock = await lockState(site.id)
  if (lock.locked) {
    return (
      <ToastProvider>
        <LeaseLockScreen
          daysSilent={lock.daysSilent}
          licenceStatus={lock.licenceStatus}
          challenge={lock.challenge}
          deviceSerial={lock.deviceSerial}
          /* Which of the two locks this is. A device whose licence lapsed and a
             machine that has merely been out of contact need opposite remedies
             — renew the till, or plug the network back in — and the screen can
             only say the right one if it is told which happened. */
          reason={lock.reason}
          deviceReason={lock.deviceReason}
        />
      </ToastProvider>
    )
  }

  /* ── A LOCAL INSTALL HAS ONE STORE, AND IT IS NOT IN cp2_user_sites ───────
   *
   * On a local build `session.userId` is a row in the SHOP'S OWN users table,
   * not a control account — see SessionPayload.scope and the same reasoning in
   * requireSite(). Asking listSitesForUser for it compares that id against
   * cp2_user_sites.user_id, two unrelated id spaces that are both small
   * integers, so it matches nothing: the switcher was handed an empty list,
   * found no row for the site the page is actually showing, and rendered
   * "No store" above a back office that was working perfectly.
   *
   * The site is already resolved, and already resolved more strictly than this
   * query could — the machine was provisioned for it. So it IS the list. One
   * entry also renders as a plain label rather than a dropdown, which is the
   * truth on a machine that has nothing to switch to.
   */
  const sites =
    session.scope === 'site'
      ? [site]
      : /* Filtered for the same reason /select-site is: each back office opens
           one kind of store — the EXE local, the browser cloud — and a switcher
           row that selectSiteAction refuses is a door drawn on a wall. An
           account holding one store of each kind is exactly the case that
           reaches this line: it signs in against the control panel, opens the
           store this door serves, and would otherwise be offered the other one
           in the header. */
        (await listSitesForUser(session.userId)).filter((s) => opensHere(s.connectionType))

  // The bell's starting figure. One indexed COUNT; the client keeps itself
  // fresh from there, and a failure here must not take down every page.
  const unread = await unreadCount(site.id, user.id, capabilities).catch(() => 0)

  /*
   * ── WHAT THIS SHOP WANTS IN ITS MENU, NOT MERELY WHAT IT BOUGHT ──────────
   *
   * A third filter on top of capabilities and modules: a shop that holds Job
   * Cards but never takes a booking can switch the section off under Setup →
   * Menu & modules, and this is where that choice reaches the chrome. It only
   * ever subtracts from `modules.held` — see lib/site/menuVisibility.ts for
   * why hiding and owning are kept as two separate facts.
   *
   * Handed to BOTH shells below, because the phone and the browser draw
   * different chrome from the same answer; computing it once here is what stops
   * the two menus from disagreeing.
   *
   * Read ONCE and derived twice: both answers come from the same settings row,
   * and this runs on every authenticated page load.
   *
   * The hide list goes down as well as the merged answer, because a section
   * marked `menuArea` — Tickets, which travels with Job Cards, and Staff, which
   * is nobody's module — has to tell "switched off" apart from "never bought",
   * and the merged list cannot: both read as absent. Sets do not cross the
   * server/client boundary, so both go as arrays.
   */
  const switchedOff = await hiddenAreas(site.id)
  const hiddenAreaKeys = [...switchedOff]
  const menuModules = [...modules.held].filter((key) => !switchedOff.has(key as MenuArea))

  /*
   * ── THE PHONE GETS DIFFERENT CHROME, NOT DIFFERENT RULES ─────────────────
   *
   * Read AFTER every guard above, deliberately. The session check, the
   * must-change-password redirect, the site-access re-read and the lease lock
   * all run first and all run identically, so the mobile app cannot reach a
   * screen the browser could not — this branch only decides what is drawn
   * AROUND the page.
   *
   * Why a branch here rather than a second route group: everything above this
   * line is the expensive, security-carrying half — three database reads and
   * four redirects. A parallel `(mobile)` layout would have to repeat all of
   * it, and the copy that drifts is the one that forgets a guard.
   */
  if (await isMobileShell()) {
    return (
      <div className="flex h-screen flex-col overflow-hidden">
        {/* Registers this machine with the shop, once per load. A back-office PC
            never opens the till, so nothing else would ever tell Setup →
            Printing that it exists — and it is exactly the machine that needs
            its own answer for where an A4 invoice goes. Renders nothing and
            swallows every failure. */}
        <DeviceHeartbeat />
        <MobileTopBar
          granted={[...capabilities.granted]}
          isOwner={capabilities.isOwner}
          modules={menuModules}
          hiddenAreas={hiddenAreaKeys}
          gettingStartedHidden={gettingStartedHidden}
          userName={user.name}
          siteName={site.displayName}
          unreadNotifications={unread}
        />
        {/* min-h-0 so the pane scrolls instead of the children being crushed —
            a flex column hands its children infinite height otherwise. */}
        {/* `relative` for the same reason as the desktop shell below — a static
            scroll pane does not contain absolutely positioned descendants, and
            they stretch the document into a second scrollbar. */}
        <main className="relative min-h-0 flex-1 overflow-y-auto bg-canvas">
          <ToastProvider>
            <PrecisionProvider qty={precision.qty} cost={precision.cost}>
              {isDesktop ? <DesktopLicenceGate>{children}</DesktopLicenceGate> : children}
            </PrecisionProvider>
          </ToastProvider>
        </main>
      </div>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Registers this machine with the shop, once per load. A back-office PC
          never opens the till, so nothing else would ever tell Setup →
          Printing that it exists — and it is exactly the machine that needs
          its own answer for where an A4 invoice goes. Renders nothing and
          swallows every failure. */}
      <DeviceHeartbeat />
      <Sidebar
        granted={[...capabilities.granted]}
        isOwner={capabilities.isOwner}
        modules={menuModules}
        hiddenAreas={hiddenAreaKeys}
        gettingStartedHidden={gettingStartedHidden}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          sites={sites.map((s) => ({
            id: s.id,
            displayName: s.displayName,
            code: s.code,
            role: s.role,
            status: s.status,
          }))}
          currentSiteId={site.id}
          userName={user.name}
          userEmail={session.email}
          roleName={user.roleName}
          unreadNotifications={unread}
        />
        {/* `relative` is what makes `overflow-y-auto` above actually CONTAIN the
            page. Without it this pane is `position: static`, so any absolutely
            positioned descendant resolves against the VIEWPORT rather than this
            box — it escapes the clip and stretches the document behind it. The
            symptom is two scrollbars: the pane's own, plus a second on the
            window scrolling tens of thousands of pixels of blank space. The
            style guide showed it worst (27212px of nothing) because its preview
            frames hold whole absolutely-positioned screens, but the leak was in
            the shell and every long page could feed it. */}
        <main className="relative flex-1 overflow-y-auto bg-canvas">
          {/* Toasts are the standard outcome message for any action, so the
              provider sits above every page rather than per-screen. */}
          <ToastProvider>
            {/*
              ── THE DESKTOP APP IS LICENSED AS A WHOLE ─────────────────────
              On the packaged build, an unlicensed installation gets no back
              office either — the machine IS the thing that was sold. On the web
              build this wrapper is not rendered at all, so a browser reaches the
              back office exactly as before and only /pos is licensed.

              `APP_MODE` is read on the SERVER, from the environment the build
              was made with (see `build:desktop`). That matters: a client
              claiming to be desktop would be claiming its way into a check, and
              one claiming to be a browser could otherwise skip it.
            */}
            <PrecisionProvider qty={precision.qty} cost={precision.cost}>
              {isDesktop ? <DesktopLicenceGate>{children}</DesktopLicenceGate> : children}
            </PrecisionProvider>
          </ToastProvider>
        </main>
      </div>
    </div>
  )
}
