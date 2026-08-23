import { requireModuleCapability } from '@/lib/auth'
import { listForms } from '@/lib/site/jobForms'
import { PageHeader, PageBody } from '@/components/ui'
import FormsClient from './FormsClient'

export const dynamic = 'force-dynamic'

/**
 * The forms a business asks its technicians to fill in (§24).
 *
 * ── WHY ITS OWN ROUTE AND NOT A SIXTH PANEL ────────────────────────────────
 *
 * /jobs/setup/workflow already stacks five panels, and its own header explains
 * why: they are one thought — how does this business run a job — and splitting
 * them would make five cards nobody can hold in their head.
 *
 * A form builder is not one of those cards. It has a list, a per-form editor, a
 * field editor inside that, and a version history; it is a screen with screens
 * in it. Stacking it there would bury the five settings that belong together
 * under a builder somebody opens once a quarter.
 *
 * The precedent is /setup/custom-fields, which is the same shape of thing —
 * defining what gets asked, rather than deciding how work flows.
 */
export default async function JobFormsPage() {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.setup')

  // Retired forms included: this screen is where somebody brings one back, and
  // a retired form that vanished from the only screen listing forms would be
  // unrecoverable from the interface.
  const forms = await listForms(siteId, true)

  return (
    <>
      <PageHeader
        title="Forms"
        subtitle="What a technician is asked to record, and which jobs ask for it."
      />
      <PageBody>
        <FormsClient forms={forms} />
      </PageBody>
    </>
  )
}
