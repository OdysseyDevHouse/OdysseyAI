import { requireCapability } from '@/lib/auth'
import { listFieldDefs } from '@/lib/site/customFields'
import { PageHeader, PageBody, Callout } from '@/components/ui'
import FieldsClient from './FieldsClient'

export const dynamic = 'force-dynamic'

/**
 * Fields a business defines for itself.
 *
 * ── WHY THIS IS ITS OWN SCREEN AND NOT A PANEL ON JOB WORKFLOW ─────────────
 *
 * Because it is not a job feature. The same mechanism serves jobs, customers and
 * equipment, and a panel under Setup > Job workflow would say the opposite —
 * which is precisely how a general mechanism ends up job-shaped and wrong for the
 * other two.
 *
 * ── ONE SCREEN, THREE TABS, NOT THREE SCREENS ──────────────────────────────
 *
 * The three sets share every rule and every editor. Three routes would be three
 * copies of one dialog, and somebody adding a sixth field type would have to find
 * all of them.
 */
export default async function CustomFieldsPage() {
  const { siteId } = await requireCapability('setup.edit')

  // Inactive included: a retired field still holds values, and the screen that
  // retired it is the only place to bring it back.
  const fields = await listFieldDefs(siteId, null, true)

  return (
    <>
      <PageHeader
        title="Custom fields"
        subtitle="Extra fields of your own, on jobs, customers and equipment."
      />
      <PageBody>
        {/*
         * Said once, at the top, rather than in every dialog: these two rules are
         * what somebody needs to know BEFORE they start, and finding out at the
         * point of refusal is finding out too late.
         */}
        <Callout tone="brand" title="Two things worth knowing first">
          A field&apos;s <strong>type</strong> is fixed once anybody has filled it in — a date
          that becomes a number would make every existing answer unreadable. And a field
          holding answers cannot be deleted, only retired, because deleting it would destroy
          them.
        </Callout>

        <FieldsClient fields={fields} />
      </PageBody>
    </>
  )
}
