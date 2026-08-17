import { requireModuleCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { requestQueue, REQUEST_STATUSES, type RequestStatus } from '@/lib/site/jobPartRequests'
import { PageHeader, PageBody, LinkSegmentedControl } from '@/components/ui'
import RequestQueue from './RequestQueue'

export const dynamic = 'force-dynamic'

/**
 * The buying queue for parts a job needs (§28).
 *
 * ── WHY IT LIVES UNDER JOBS, NOT PURCHASING ────────────────────────────────
 *
 * The rows are questions from technicians about jobs, and their whole context —
 * which job, which customer, who is waiting — is job context. A buyer coming
 * here to decide is answering "does this job get its part", and the answer is
 * carried out in Purchasing afterwards.
 *
 * ── GATED ON READING JOBS, NOT ON BUYING ───────────────────────────────────
 *
 * `jobs.view` opens the screen so a technician can see what happened to what
 * they asked for — the queue with nothing to act on is still the answer to
 * "where is my part". Deciding needs `purchasing.edit`, checked in the action
 * as well as here, because approving is agreeing to spend money.
 */
export default async function PartRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>
}) {
  const { siteId, capabilities } = await requireModuleCapability('job_cards', 'jobs.view')
  const { show } = await searchParams

  /*
   * Defaults to what still needs doing. A queue that opened on every request
   * ever made is a list nobody opens twice — and the settled ones are still one
   * click away rather than hidden.
   */
  const chosen = REQUEST_STATUSES.includes(show as RequestStatus) ? (show as RequestStatus) : null
  const statuses: RequestStatus[] = chosen
    ? [chosen]
    : ['requested', 'approved', 'ordered']

  const requests = await requestQueue(siteId, { statuses })

  return (
    <>
      <PageHeader
        title="Parts asked for"
        subtitle="What technicians need that is not on the shelf."
      />
      <PageBody>
        <div className="mb-4">
          {/* The LINK variant, because this page is server-rendered and a
              Server Component cannot pass a callback across the boundary. */}
          <LinkSegmentedControl
            value={chosen ?? 'open'}
            aria-label="Which requests to show"
            options={[
              { value: 'open', label: 'Outstanding', href: '/jobs/part-requests' },
              {
                value: 'requested',
                label: 'Undecided',
                href: '/jobs/part-requests?show=requested',
              },
              { value: 'ordered', label: 'On order', href: '/jobs/part-requests?show=ordered' },
              { value: 'received', label: 'Arrived', href: '/jobs/part-requests?show=received' },
              {
                value: 'cancelled',
                label: 'Declined',
                href: '/jobs/part-requests?show=cancelled',
              },
            ]}
          />
        </div>

        <RequestQueue
          requests={requests}
          canDecide={can(capabilities, 'purchasing.edit')}
        />
      </PageBody>
    </>
  )
}
