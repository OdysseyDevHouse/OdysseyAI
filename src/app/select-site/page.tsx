import { redirect } from 'next/navigation'
import { Building2, ChevronRight, StatusError as AlertCircle } from '@/components/ui/icons'
import { requireSession } from '@/lib/auth'
import { listSitesForUser } from '@/lib/sites'
import LoginScreen from '@/components/LoginScreen'
import { selectSiteAction } from './actions'

export const dynamic = 'force-dynamic'

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  staff: 'Staff',
}

export default async function SelectSitePage() {
  const session = await requireSession()

  // This page is outside the (app) layout, so it carries the same guard —
  // otherwise picking a site would be a way around the forced change.
  if (session.mustChangePassword) redirect('/change-password')

  const sites = await listSitesForUser(session.userId)

  return (
    <LoginScreen>
      <div className="flex flex-col gap-4">
        <div className="text-center">
          <h2 className="text-sm font-semibold text-ink">Choose a store</h2>
          <p className="mt-0.5 text-xs text-muted">Signed in as {session.email}</p>
        </div>

        {sites.length === 0 ? (
          <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2.5 text-sm text-warning">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span>
              This account isn&apos;t linked to any store yet. Add a row to
              <code className="mx-1 rounded bg-surface-2 px-1 py-0.5 text-xs">cp2_user_sites</code>
              to grant access.
            </span>
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {sites.map((site) => (
              <li key={site.id}>
                <form action={selectSiteAction}>
                  <input type="hidden" name="siteId" value={site.id} />
                  {/* Not <Button>: a two-line site row with a trailing chevron,
                      closer to a list item than a labelled action. */}
                  <button
                    data-kit-ok
                    type="submit"
                    className="flex w-full items-center justify-between gap-3 rounded-control border border-border px-3 py-2.5 text-left transition hover:border-brand hover:bg-surface-2"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <Building2 size={14} className="shrink-0 text-muted" />
                        <span className="truncate text-sm text-ink">{site.displayName}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted">
                        {site.code} · {ROLE_LABEL[site.role] ?? site.role}
                        {site.isDefault && ' · default'}
                        {site.status === 'suspended' && ' · suspended'}
                      </span>
                    </span>
                    <ChevronRight size={16} className="shrink-0 text-muted" />
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <form action="/api/auth/signout" method="post" className="text-center">
          {/* A quiet text affordance, not a button — it must not compete with
              the site rows above, which are the actual choice on this screen. */}
          <button data-kit-ok type="submit" className="text-xs text-muted hover:text-ink">
            Sign out
          </button>
        </form>
      </div>
    </LoginScreen>
  )
}
