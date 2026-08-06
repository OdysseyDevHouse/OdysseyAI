import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listRuns } from '@/lib/site/commissionRuns'
import { PageHeader, PageBody, ButtonLink } from '@/components/ui'
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
      <PageHeader
        title="Commission"
        subtitle="One period at a time — calculate, check, then lock"
        action={
          can(capabilities, 'commission.edit') ? (
            <ButtonLink href="/commission/rules" variant="secondary">
              Rules
            </ButtonLink>
          ) : undefined
        }
      />

      <PageBody>
        <RunsScreen runs={runs} canRun={can(capabilities, 'commission.run')} />
      </PageBody>
    </>
  )
}
