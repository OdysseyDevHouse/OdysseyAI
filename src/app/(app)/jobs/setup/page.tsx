import { redirect } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { PageHeader, PageBody } from '@/components/ui'
import HubView from '@/components/HubView'
import { jobsSetupGroupsFor } from './catalogue'

export const dynamic = 'force-dynamic'

/**
 * Job cards — Setup.
 *
 * Eighteen screens in three groups, where there were four in two. The catalogue
 * carries the argument for the split; what matters here is that this is the ONE
 * front door, so a shop without the module never sees any of it — the gate below
 * turns them away before the catalogue is read.
 *
 * Tabs are on, which they were not at four tiles: past about a dozen entries a
 * single scrolling grid stops being a list somebody reads and becomes one they
 * scan past. Search still reads the whole catalogue regardless of the tab, which
 * is the point — somebody typing "signature" does not know it lives under Flow.
 */
export default async function JobsSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { capabilities } = await requireModuleCapability('job_cards', 'jobs.setup')

  const groups = jobsSetupGroupsFor((c) => can(capabilities, c as Parameters<typeof can>[1]))
  if (groups.length === 0) redirect('/not-allowed')

  const { q } = await searchParams

  return (
    <>
      <PageHeader
        title="Job card setup"
        subtitle="What a job is made of, how it moves, and what gets recorded against it"
      />
      <PageBody>
        <HubView
          groups={groups}
          noun="job card settings"
          emptyHint="Your role does not include configuring job cards. An owner can grant this under Roles & permissions."
          initialSearch={q ?? ''}
          tabs
        />
      </PageBody>
    </>
  )
}
