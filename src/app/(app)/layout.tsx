import { redirect } from 'next/navigation'
import { requireSession, requireSiteUser } from '@/lib/auth'
import { listSitesForUser } from '@/lib/sites'
import { unreadCount } from '@/lib/site/notifications'
import Sidebar from '@/components/Sidebar'
import TopBar from '@/components/TopBar'
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

  const sites = await listSitesForUser(session.userId)

  // The bell's starting figure. One indexed COUNT; the client keeps itself
  // fresh from there, and a failure here must not take down every page.
  const unread = await unreadCount(site.id, user.id, capabilities).catch(() => 0)

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
