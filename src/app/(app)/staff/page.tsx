import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listEmployment } from '@/lib/site/employment'
import { listUsers } from '@/lib/site/users'
import { PageHeader, PageBody, Callout } from '@/components/ui'
import StaffScreen from './StaffScreen'

export const dynamic = 'force-dynamic'

/**
 * The staff list — who works here, on what terms.
 *
 * Separate from Setup → Users, which answers "who may sign in and what may
 * they do". A person can be one without the other: the owner's accountant has
 * a login and is not staff; a casual packer is staff and may never sign in at
 * all. Keeping them apart also keeps the pay rate off a screen that people who
 * only manage permissions have to open.
 */
export default async function StaffPage() {
  const { site, capabilities } = await requireSiteUser()

  const seesEveryone = can(capabilities, 'staff.view_all')
  if (!seesEveryone && !can(capabilities, 'staff.cost')) redirect('/not-allowed')

  const showCost = can(capabilities, 'staff.cost')

  const [employment, users] = await Promise.all([
    // The flag decides whether rates leave the server at all — see
    // employment.ts. Not a display concern.
    listEmployment(site.id, showCost),
    listUsers(site.id),
  ])

  // Anybody with a user row but no employment terms yet. They are the ones an
  // owner has to notice, so they lead rather than hide at the bottom.
  const onFile = new Set(employment.map((e) => e.userId))
  const unrecorded = users
    .filter((u) => u.isActive && !onFile.has(u.id))
    .map((u) => ({ id: u.id, name: u.name }))

  return (
    <>
      <PageHeader
        title="Staff"
        subtitle="Who works here, and on what terms"
      />

      <PageBody>
        {!showCost && (
          <Callout tone="neutral" title="Pay is hidden.">
            You can see who works here and when they started, but not what
            anybody is paid. An owner can grant that in Setup → Roles.
          </Callout>
        )}

        <StaffScreen
          employment={employment}
          unrecorded={unrecorded}
          canEdit={showCost}
        />
      </PageBody>
    </>
  )
}
