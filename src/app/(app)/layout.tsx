import { redirect } from 'next/navigation'
import { requireSession, requireSiteUser } from '@/lib/auth'
import { listSitesForUser } from '@/lib/sites'
import { unreadCount } from '@/lib/site/notifications'
import Sidebar from '@/components/Sidebar'
import TopBar from '@/components/TopBar'
import { ToastProvider } from '@/components/ui'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession()

  // Enforced here rather than only at login, so typing a URL can't skip it.
  if (session.mustChangePassword) redirect('/change-password')
  if (session.siteId === null) redirect('/select-site')

  // Site access, the local user record and their permissions, all re-read per
  // request rather than trusted from the token — so access revoked upstream or
  // a role changed on the permissions screen takes effect on the next load.
  const { site, user, capabilities } = await requireSiteUser()

  const sites = await listSitesForUser(session.userId)

  // The bell's starting figure. One indexed COUNT; the client keeps itself
  // fresh from there, and a failure here must not take down every page.
  const unread = await unreadCount(site.id, user.id, capabilities).catch(() => 0)

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar granted={[...capabilities.granted]} isOwner={capabilities.isOwner} />
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
          <ToastProvider>{children}</ToastProvider>
        </main>
      </div>
    </div>
  )
}
