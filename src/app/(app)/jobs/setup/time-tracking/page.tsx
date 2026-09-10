import { requireModuleCapability } from '@/lib/auth'
import { PageHeader, PageBody, TextLink } from '@/components/ui'
import NotBuiltYet from '../NotBuiltYet'

export const dynamic = 'force-dynamic'

/**
 * When the clock runs on a job.
 *
 * The FEATURE works: `jobTime.ts` clocks a technician onto a job through
 * `staff_time_entries.job_card_id`, and a labour line follows from it. What has
 * no screen is the policy around it.
 *
 * ── ONE SETTING THAT SHOULD NOT APPEAR HERE LATER ──────────────────────────
 *
 * The PRD asks for a permissioned bypass of the one-open-timer rule, and jobTime
 * declines it on purpose: `uq_open_entry` enforces it in the DATABASE, and
 * relaxing that index cannot be undone — once two overlapping rows exist, no
 * migration can restore the constraint without choosing which of somebody's hours
 * to delete. The failure it prevents is an hour paid twice or billed to two
 * customers.
 *
 * Recorded here because this is the screen where somebody would think to add the
 * switch.
 */
export default async function JobTimeTrackingPage() {
  await requireModuleCapability('job_cards', 'jobs.setup')

  return (
    <>
      <PageHeader
        title="Time tracking"
        subtitle="When the clock runs, and what counts as billable."
      />
      <PageBody>
        <NotBuiltYet
          what="Technicians can already clock on and off a job — there is just nothing to set. No rounding, no default labour rate per kind of work, and no rule for what is billable."
          today={
            <>
              Hours a technician records land on their timesheet, and what an hour costs comes
              from their employment record under{' '}
              <TextLink href="/staff">Staff</TextLink>. Whether a closed job raises a draft
              invoice from its billable lines is under{' '}
              <TextLink href="/jobs/setup/notifications">Notifications</TextLink>.
            </>
          }
        />
      </PageBody>
    </>
  )
}
