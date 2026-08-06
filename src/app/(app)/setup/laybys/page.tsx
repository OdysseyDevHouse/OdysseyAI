import { requireSite, requireCapability } from '@/lib/auth'
import { getSettings } from '@/lib/site/settings'
import { PENALTY_GRACE_BUSINESS_DAYS } from '@/lib/laybyRules'
import { PageHeader, PageBody, Card, Icons } from '@/components/ui'
import LaybySettingsForm from './LaybySettingsForm'

export const dynamic = 'force-dynamic'

export default async function LaybySetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  await requireCapability('setup.edit')
  const site = await requireSite()
  const settings = await getSettings(site.id, [
    'layby_cancellation_fee_pct',
    'layby_default_days',
    'layby_terms_text',
    'layby_max_fee_pct',
  ])

  const maxPct = Number(settings.layby_max_fee_pct) || 0

  return (
    <>
      <PageHeader
        title="Lay-bys"
        subtitle="What a customer agrees to when they put something aside"
      />

      <PageBody>
        <Card>
          <div className="flex items-start gap-3 px-6 py-4">
            <Icons.Info size={18} className="mt-0.5 shrink-0 text-muted" />
            <div className="text-sm">
              <p className="font-medium text-ink">
                Section 62 of the Consumer Protection Act decides most of this.
              </p>
              <p className="text-muted">
                Money a customer pays on a lay-by stays theirs until they take the goods, and the
                goods stay at the store&apos;s risk. A cancellation fee may only be charged once
                they are {PENALTY_GRACE_BUSINESS_DAYS} business days past the due date, never where
                the customer died or was hospitalised, and never unless it was disclosed to them
                before they signed. Those three are enforced whatever is set here.
              </p>
              <p className="mt-1 text-muted">
                The Act does not itself set a maximum — section 62(6) leaves that to regulation.
                The {maxPct}% ceiling below is this store&apos;s own policy.
              </p>
            </div>
          </div>
        </Card>

        <LaybySettingsForm
          feePct={settings.layby_cancellation_fee_pct ?? '0'}
          defaultDays={settings.layby_default_days ?? '90'}
          termsText={settings.layby_terms_text ?? ''}
          maxPct={maxPct}
          canEdit={site.role === 'owner'}
        />
      </PageBody>
    </>
  )
}
