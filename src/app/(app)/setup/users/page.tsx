import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can, listRoles } from '@/lib/site/permissions'
import { listUsers } from '@/lib/site/users'
import { listSalesReps } from '@/lib/site/lookups'
import { siteGrantsFor } from '@/lib/controlUsers'
import { PageHeader, PageBody } from '@/components/ui'
import UsersScreen from './UsersScreen'

export const dynamic = 'force-dynamic'

export default async function UsersPage() {
  const { site, user, capabilities } = await requireSiteUser()
  // A hidden menu entry is not a boundary — this URL is typeable.
  if (!can(capabilities, 'setup.users')) redirect('/not-allowed')

  const [users, roles, reps, sites] = await Promise.all([
    listUsers(site.id),
    listRoles(site.id),
    listSalesReps(site.id),
    // Stores this administrator can hand out, for the multi-store tick list.
    siteGrantsFor(user.controlUserId ?? 0, null),
  ])

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Who may sign in, at the till and in the back office"
      />
      <PageBody>
        <UsersScreen
          users={users}
          roles={roles.map((r) => ({ id: r.id, name: r.name, isOwner: r.isOwner }))}
          reps={reps.map((r) => ({ id: r.id, name: r.name }))}
          sites={sites.map((s) => ({ id: s.siteId, name: s.displayName, code: s.siteCode }))}
          currentSiteId={site.id}
          currentUserId={user.id}
        />
      </PageBody>
    </>
  )
}
