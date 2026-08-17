import { requireSiteUser } from '@/lib/auth'
import { can, type Capability } from '@/lib/site/permissions'
import { holder } from '@/lib/control/modules'
import { PageHeader, PageBody, Badge, Card, Icons } from '@/components/ui'
import { SalesDashboard } from './SalesDashboard'
import { WIDGETS } from './widgets'

/**
 * The landing screen: how the shop is trading.
 *
 * The site's connection details used to live here. They moved to
 * /setup/databases — a page that answers "is anything broken" belongs in
 * setup, not in the first thing someone sees every morning.
 */

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const { site, user, capabilities, modules } = await requireSiteUser()

  // NOT a redirect to /not-allowed, unlike every other guarded page.
  //
  // This is where the app lands after sign-in, so a cashier without
  // `dashboard.view` — or anyone who has not been given a role yet — would be
  // bounced the instant they logged in, and from a screen that itself links
  // back here. Showing an explanation is the only version that does not trap
  // them. The trading figures are still withheld.
  const allowed = can(capabilities, 'dashboard.view')

  /*
   * Which widgets to OFFER, not which data to send.
   *
   * A UI affordance only — the two dashboard endpoints do the real gating, and
   * they do it by not querying the data at all. This exists so the widget panel
   * does not list switches that would turn on a box reading "not available".
   * A Set cannot cross the server/client boundary, so it goes as a plain array.
   */
  const bought = holder(modules)
  const visibleWidgets = WIDGETS.filter(
    (w) =>
      (!w.capability || can(capabilities, w.capability as Capability)) &&
      /* The module half is NOT merely an affordance: a shop that never bought
         Job Cards has no job data to read, so those panels would sit on the
         dashboard for ever showing zero. */
      (!w.module || bought(w.module)),
  ).map((w) => w.id)

  return (
    <>
      <PageHeader
        title={site.displayName}
        subtitle={allowed ? 'How the shop is trading' : 'Welcome'}
        action={
          site.status !== 'active' ? <Badge tone="warning">{site.status}</Badge> : undefined
        }
      />
      <PageBody>
        {allowed ? (
          <SalesDashboard visibleWidgets={visibleWidgets} />
        ) : (
          <Card>
            <div className="flex items-start gap-3 px-6 py-5">
              <Icons.Info size={20} className="mt-0.5 shrink-0 text-muted" />
              <div>
                <p className="font-medium text-ink">
                  {user.roleName
                    ? `Your role (${user.roleName}) does not include the trading figures.`
                    : 'You have not been given a role yet.'}
                </p>
                <p className="text-sm text-muted">
                  {user.roleName
                    ? 'Use the menu on the left for the screens you do have.'
                    : 'An owner can give you one in Setup → Users. Until then there is nothing here for you.'}
                </p>
              </div>
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
