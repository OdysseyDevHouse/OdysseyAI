import { redirect } from 'next/navigation'
import { requireSession, requireSiteUser } from '@/lib/auth'
import { listSitesForUser } from '@/lib/sites'
import { opensHere } from '@/lib/desktopBackOffice'
import { unreadCount } from '@/lib/site/notifications'
import Sidebar from '@/components/Sidebar'
import TopBar from '@/components/TopBar'
import { MobileTopBar } from '@/components/MobileTopBar'
import { isMobileShell } from '@/lib/mobileShell'
import { ToastProvider } from '@/components/ui'
import DesktopLicenceGate from './DesktopLicenceGate'
import LeaseLockScreen from './LeaseLockScreen'
import { lockState } from '@/lib/licence/lockState'

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
  const { site, user, capabilities, modules } = await requireSiteUser()

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
      : /* Filtered for the same reason /select-site is: on the back office EXE a
           cloud store is not openable, and a switcher row that selectSiteAction
           refuses is a door drawn on a wall. An account holding one store of
           each kind is exactly the case that reaches this line — it signs in
           against the control panel, opens its local store, and would otherwise
           be offered the cloud one in the header. */
        (await listSitesForUser(session.userId)).filter((s) => opensHere(s.connectionType))

  // The bell's starting figure. One indexed COUNT; the client keeps itself
  // fresh from there, and a failure here must not take down every page.
  const unread = await unreadCount(site.id, user.id, capabilities).catch(() => 0)

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
        <MobileTopBar
          granted={[...capabilities.granted]}
          isOwner={capabilities.isOwner}
          modules={[...modules.held]}
          userName={user.name}
          siteName={site.displayName}
          unreadNotifications={unread}
        />
        {/* min-h-0 so the pane scrolls instead of the children being crushed —
            a flex column hands its children infinite height otherwise. */}
        <main className="min-h-0 flex-1 overflow-y-auto bg-canvas">
          <ToastProvider>
            {isDesktop ? <DesktopLicenceGate>{children}</DesktopLicenceGate> : children}
          </ToastProvider>
        </main>
      </div>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        granted={[...capabilities.granted]}
        isOwner={capabilities.isOwner}
        modules={[...modules.held]}
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
        <main className="flex-1 overflow-y-auto bg-canvas">
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
            {isDesktop ? <DesktopLicenceGate>{children}</DesktopLicenceGate> : children}
          </ToastProvider>
        </main>
      </div>
    </div>
  )
}
