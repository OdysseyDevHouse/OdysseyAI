import { requireSite, requireCapability } from '@/lib/auth'
import { getSettings } from '@/lib/site/settings'
import { canTakePayments } from '@/lib/site/payments'
import { createPortalToken } from '@/lib/publicPortalToken'
import { PageHeader, PageBody } from '@/components/ui'
import PortalSettingsForm from './PortalSettingsForm'

export const dynamic = 'force-dynamic'

/**
 * What customers may see of their own accounts.
 *
 * ── SEPARATE FROM THE JOBS PORTAL, ON PURPOSE ──────────────────────────────
 *
 * The same /portal/ URL serves both, but they are configured apart because they
 * are bought apart: a workshop wants customers following their repairs, a
 * wholesaler wants them fetching their own statements, and plenty want one and
 * not the other. The jobs half stays under Job cards → Workflow, where somebody
 * setting up job cards will find it.
 */
export default async function CustomerPortalSetupPage() {
  // A hidden hub tile is not a boundary — this URL is typeable.
  await requireCapability('setup.edit')
  const site = await requireSite()

  const [settings, gateway, portalToken] = await Promise.all([
    getSettings(site.id, [
      'portal_accounts_enabled',
      'portal_show_transactions',
      'portal_show_statement',
      'portal_allow_pay',
    ]),
    // Tolerant: the switch is a nicety, and a shop must still be able to
    // configure the portal if the gateway read fails.
    canTakePayments(site.id).catch(() => false),
    // Deterministic, so what somebody put on their website keeps working; null
    // if SESSION_SECRET is missing.
    createPortalToken(site.id).catch(() => null),
  ])

  return (
    <>
      <PageHeader
        title="Customer portal"
        subtitle="What your customers can see of their own account"
        backHref="/setup"
        backLabel="Setup"
      />
      <PageBody>
        <PortalSettingsForm
          initial={{
            accountsEnabled: settings.portal_accounts_enabled === '1',
            showTransactions: settings.portal_show_transactions === '1',
            showStatement: settings.portal_show_statement === '1',
            allowPay: settings.portal_allow_pay === '1',
          }}
          portalUrl={portalToken ? `${process.env.APP_URL ?? ''}/portal/${portalToken}` : null}
          canTakePayments={gateway}
        />
      </PageBody>
    </>
  )
}
