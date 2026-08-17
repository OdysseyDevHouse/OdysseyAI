import { notFound } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
import { getJobCard } from '@/lib/site/jobCards'
import { PageHeader, PageBody } from '@/components/ui'
import { isJobPriority, isJobSource, type JobPriority, type JobSource } from '@/lib/jobStatusModel'
import JobForm from '../../JobForm'

export const dynamic = 'force-dynamic'

/**
 * Changing a job's details.
 *
 * A separate route rather than an inline edit mode, matching how contracts and
 * customers do it: the detail screen is a record of the work, and turning it into
 * a form every time somebody opens it would bury the thing they came to read.
 *
 * Only the details live here. Status, assignment, lines and billing are actions on
 * the detail screen, each with its own capability and its own audit entry — a form
 * that could change all of them at once would make "who moved this to On Hold"
 * unanswerable.
 */
export default async function EditJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.edit')
  const { id } = await params

  const jobId = Number(id)
  if (!Number.isFinite(jobId) || jobId <= 0) notFound()

  const job = await getJobCard(siteId, jobId)
  if (!job) notFound()

  const priority: JobPriority = isJobPriority(job.priority) ? job.priority : 'normal'
  const source: JobSource = isJobSource(job.source) ? job.source : 'manual'

  return (
    <>
      <PageHeader
        title={`Edit ${job.documentNumber ?? `job #${job.id}`}`}
        subtitle="The job number and everything already recorded against it stay as they are."
      />
      <PageBody>
        <JobForm
          defaultPriority={priority}
          job={{
            id: job.id,
            customerId: job.customerId,
            customerName: job.customerName,
            customerPhone: job.customerPhone,
            customerEmail: job.customerEmail,
            serviceAddressId: job.serviceAddressId,
            priority,
            title: job.title,
            description: job.description,
            dueAt: job.dueAt,
            source,
            reference: job.reference,
            internalNote: job.internalNote,
          }}
        />
      </PageBody>
    </>
  )
}
