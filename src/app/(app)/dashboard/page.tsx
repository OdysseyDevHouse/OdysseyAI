import { redirect } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import { getSiteForUser } from '@/lib/sites'
import { PageHeader, PageBody, Badge } from '@/components/ui'
import { SalesDashboard } from './SalesDashboard'

/**
 * The landing screen: how the shop is trading.
 *
 * The site's connection details used to live here. They moved to
 * /setup/databases — a page that answers "is anything broken" belongs in
 * setup, not in the first thing someone sees every morning.
 */

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const session = await requireSession()
  if (session.siteId === null) redirect('/select-site')

  const site = await getSiteForUser(session.userId, session.siteId)
  if (!site) redirect('/select-site')

  return (
    <>
      <PageHeader
        title={site.displayName}
        subtitle="How the shop is trading"
        action={
          site.status !== 'active' ? <Badge tone="warning">{site.status}</Badge> : undefined
        }
      />
      <PageBody>
        <SalesDashboard />
      </PageBody>
    </>
  )
}
