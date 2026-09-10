import { requireModuleCapability } from '@/lib/auth'
import { listForms } from '@/lib/site/jobForms'
import { PageHeader, PageBody } from '@/components/ui'
import FormsClient from './FormsClient'

export const dynamic = 'force-dynamic'

/**
 * The forms a business asks its technicians to fill in (§24).
 *
 * ── WHY ITS OWN ROUTE ──────────────────────────────────────────────────────
 *
 * This screen was carved out back when the rest of job setup shared one route
 * called Workflow, and the argument then was that a form builder is not a
 * settings panel: it has a list, a per-form editor, a field editor inside that,
 * and a version history — a screen with screens in it — and stacking it there
 * would bury the settings under a builder somebody opens once a quarter.
 *
 * That route has since been split into eighteen, so the argument no longer has to
 * be made against anything: this is simply one of them. It is kept because it
 * records why a builder is not a panel, which is still the rule.
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
