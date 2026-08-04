import { redirect } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import { getSiteForUser, listSitesForUser } from '@/lib/sites'
import Sidebar from '@/components/Sidebar'
import TopBar from '@/components/TopBar'
import { ToastProvider } from '@/components/ui'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession()

  // Enforced here rather than only at login, so typing a URL can't skip it.
  if (session.mustChangePassword) redirect('/change-password')
  if (session.siteId === null) redirect('/select-site')

  // Re-checked here rather than trusted from the token, so access revoked in
  // the control panel takes effect on the next page load.
  const site = await getSiteForUser(session.userId, session.siteId)
  if (!site) redirect('/select-site')

  const sites = await listSitesForUser(session.userId)

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
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
          userName={session.name}
          userEmail={session.email}
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
