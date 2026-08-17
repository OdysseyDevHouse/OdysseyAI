import { requireModuleCapability } from '@/lib/auth'
import { getSetting } from '@/lib/site/settings'
import { missingRoles } from '@/lib/site/jobStatuses'
import { PageHeader, PageBody, Callout } from '@/components/ui'
import { ROLE_LABEL, isJobPriority, type JobPriority } from '@/lib/jobStatusModel'
import JobForm from '../JobForm'

export const dynamic = 'force-dynamic'

/**
 * Taking a new job down.
 *
 * The one thing this page does beyond rendering the form is check that the
 * workflow can actually receive a job. A site whose `new` role is held by no
 * active status cannot have one created, and finding that out by pressing Save is
 * worse than being told before typing anything.
 */
export default async function NewJobPage() {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.edit')

  const [defaultPriority, missing] = await Promise.all([
    getSetting(siteId, 'job_default_priority'),
    missingRoles(siteId),
  ])

  const priority: JobPriority = isJobPriority(defaultPriority) ? defaultPriority : 'normal'
  const blocking = missing.includes('new')

  return (
    <>
      <PageHeader
        title="New job"
        subtitle="Take the job down while they are on the phone. The rest can wait."
      />
      <PageBody>
        {missing.length > 0 && (
          <Callout tone={blocking ? 'danger' : 'warning'}>
            {blocking
              ? 'No active status is marked as where new jobs start, so a job cannot be created yet. Set one under Setup first.'
              : `The workflow is missing a status for: ${missing.map((role) => ROLE_LABEL[role].toLowerCase()).join(', ')}. Jobs can still be taken, but parts of the lifecycle will refuse to run.`}
          </Callout>
        )}
        {!blocking && <JobForm defaultPriority={priority} />}
      </PageBody>
    </>
  )
}
