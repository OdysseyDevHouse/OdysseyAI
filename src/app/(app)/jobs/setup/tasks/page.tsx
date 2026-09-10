import { requireModuleCapability } from '@/lib/auth'
import { PageHeader, PageBody, TextLink } from '@/components/ui'
import NotBuiltYet from '../NotBuiltYet'

export const dynamic = 'force-dynamic'

/**
 * The checklist a technician works down.
 *
 * ── THIS ONE IS NOT MERELY UNBUILT. IT WAS DELIBERATELY REMOVED ────────────
 *
 * There WAS a checklist: job_headline_items held the template and job_card_items
 * held the answers, both added by 114. Migration 224 dropped them, and its header
 * gives the reason — a checklist versions by copy-on-attach, so a copied row
 * cannot say which version of the template it came from, and §24 requires exactly
 * that. Forms can, so forms carry the questions now.
 *
 * The decisive sentence in that migration is the one this screen has to respect:
 * "Two systems answering the same question — what must be recorded before this
 * job is done — is worse than either alone." A tasks screen that grew its own
 * item list would recreate the second system, and the close gate would be back to
 * reading both.
 *
 * So this stays a stub pointing at forms rather than becoming a checklist, and
 * anything built here later should be a VIEW of a form's fields — the things a
 * technician ticks — not a parallel list of its own.
 */
export default async function JobTasksPage() {
  await requireModuleCapability('job_cards', 'jobs.setup')

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle="The checklist a technician works down while on a job."
      />
      <PageBody>
        <NotBuiltYet
          what="There is no separate task list. A job's checklist is a form — that way a signed-off job keeps the exact version of the questions it was asked, which a copied checklist could not do."
          today={
            <>
              Build the checks a technician works down as fields on a form, under{' '}
              <TextLink href="/jobs/setup/forms">Forms</TextLink>. Whether outstanding ones stop a
              job closing is set under{' '}
              <TextLink href="/jobs/setup/signoff">Job signoff</TextLink>.
            </>
          }
        />
      </PageBody>
    </>
  )
}
