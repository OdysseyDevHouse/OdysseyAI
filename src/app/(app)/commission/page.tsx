import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listRuns } from '@/lib/site/commissionRuns'
import { PageHeader, PageBody } from '@/components/ui'
import RunsScreen from './RunsScreen'

export const dynamic = 'force-dynamic'

export default async function CommissionPage() {
  const { site, capabilities } = await requireSiteUser()
  if (!can(capabilities, 'commission.view_all') && !can(capabilities, 'commission.run')) {
    redirect('/not-allowed')
  }

  const runs = await listRuns(site.id)

  return (
    <>
      {/* Rules used to sit in the header's action slot. It lives in the
          toolbar beside "Open a period" instead, so the two things anyone
          comes to this screen to do are found in one place rather than at
          opposite corners. */}
      <PageHeader
        title="Commission"
        subtitle="One period at a time — calculate, check, then lock"
      />

      <PageBody>
        <RunsScreen
          runs={runs}
          canRun={can(capabilities, 'commission.run')}
          canEdit={can(capabilities, 'commission.edit')}
        />
      </PageBody>
    </>
  )
}
