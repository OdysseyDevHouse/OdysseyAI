import { requireModuleCapability } from '@/lib/auth'
import { listJobTeams } from '@/lib/site/jobTeams'
import { listUsers } from '@/lib/site/users'
import { PageHeader, PageBody } from '@/components/ui'
import TeamsPanel from './TeamsPanel'

export const dynamic = 'force-dynamic'

/**
 * Who works together.
 *
 * ── WHY THE PICKER IS BACK-OFFICE AND ACTIVE ONLY ──────────────────────────
 *
 * A crew is a shortcut into the people picker on a job, and a job is handed to
 * somebody who can act on it. A POS-only account has no back office to read the
 * handover in, so offering one here would build a crew whose members never hear
 * they were given anything.
 */
export default async function JobCrewsPage() {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.setup')

  const [teams, siteUsers] = await Promise.all([
    // Tolerant: a site without migration 126 still gets the screen.
    listJobTeams(siteId, true).catch(() => []),
    listUsers(siteId).catch(() => []),
  ])

  const backOfficeUsers = siteUsers
    .filter((u) => u.isActive && u.userType === 'back_office')
    .map((u) => ({ id: u.id, name: u.name }))

  return (
    <>
      <PageHeader title="Crews" subtitle="Who works together, and what work they can be sent to." />
      <PageBody>
        <TeamsPanel teams={teams} users={backOfficeUsers} />
      </PageBody>
    </>
  )
}
