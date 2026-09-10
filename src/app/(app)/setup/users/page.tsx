import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can, listRoles } from '@/lib/site/permissions'
import { listUsers } from '@/lib/site/users'
import { syncControlGrants } from '@/lib/site/userSync'
import { listSalesReps } from '@/lib/site/lookups'
import { siteGrantsFor, accessForControlUsers } from '@/lib/controlUsers'
import { PageHeader, PageBody } from '@/components/ui'
import UsersScreen from './UsersScreen'

export const dynamic = 'force-dynamic'

export default async function UsersPage() {
  const { site, user, capabilities } = await requireSiteUser()
  // A hidden menu entry is not a boundary — this URL is typeable.
  if (!can(capabilities, 'setup.users')) redirect('/not-allowed')

  /* Before the list is read, not after: a login added in the control panel has
     no row here until somebody reconciles the two databases, and this screen
     claims to show everyone who may sign in. See site/userSync.ts. */
  await syncControlGrants(site.id)

  const [users, roles, reps, sites] = await Promise.all([
    listUsers(site.id),
    listRoles(site.id),
    listSalesReps(site.id),
    // Stores this administrator can hand out, for the multi-store tick list.
    siteGrantsFor(user.controlUserId ?? 0, null),
  ])

  /* What each back-office user may ALREADY open. The edit form overwrites this
     on save, so showing it a guess meant every save rewrote somebody's access
     to something nobody chose — see accessForControlUsers. */
  const access = await accessForControlUsers(
    user.controlUserId ?? 0,
    users.map((u) => u.controlUserId).filter((id): id is number => id !== null),
  )

  return (
    <>
      {/* Named for both halves, matching its tile: the roles screen is reached
          from the toolbar here rather than from a tile of its own. */}
      <PageHeader
        title="Staff and permissions"
        subtitle="Who may sign in, at the till and in the back office"
      />
      <PageBody>
        <UsersScreen
          users={users}
          roles={roles.map((r) => ({ id: r.id, name: r.name, isOwner: r.isOwner }))}
          reps={reps.map((r) => ({ id: r.id, name: r.name }))}
          sites={sites.map((s) => ({ id: s.siteId, name: s.displayName, code: s.siteCode }))}
          access={access}
          currentSiteId={site.id}
          currentUserId={user.id}
        />
      </PageBody>
    </>
  )
}
