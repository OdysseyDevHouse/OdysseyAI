import { requireModuleCapability } from '@/lib/auth'
import { listSlaPolicies, untargetedJobCount } from '@/lib/site/jobSla'
import { listUsers } from '@/lib/site/users'
import { customerOptions } from '@/lib/site/customers'
import { getSettings } from '@/lib/site/settings'
import { PageHeader, PageBody } from '@/components/ui'
import SlaPanel from './SlaPanel'

export const dynamic = 'force-dynamic'

/**
 * What this business promises a customer.
 *
 * The four trading-hours settings live with the promises rather than on a
 * settings screen of their own, because a response time means nothing without
 * the hours it is counted in — "four hours" on a Friday afternoon is a different
 * promise depending on whether Saturday counts.
 *
 * /jobs/sla is the screen that REPORTS on these. This one sets them.
 */
export default async function ServiceLevelsPage() {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.setup')

  const [policies, settings, untargeted, siteUsers, slaCustomers] = await Promise.all([
    listSlaPolicies(siteId, true),
    getSettings(siteId, [
      'job_sla_trading_days',
      'job_sla_opens_at',
      'job_sla_closes_at',
      'job_sla_skip_holidays',
    ]),
    /*
     * Tolerant: a nicety on a setup screen. A site mid-migration must still be
     * able to configure its promises.
     */
    untargetedJobCount(siteId).catch(() => 0),
    listUsers(siteId).catch(() => []),
    // Customers who can be given a promise of their own (164). See
    // customerOptions for why it is not the paged list helper.
    customerOptions(siteId).catch(() => []),
  ])

  // Who an escalation can name: back-office and active only — a POS-only account
  // has no bell to read it in.
  const backOfficeUsers = siteUsers
    .filter((u) => u.isActive && u.userType === 'back_office')
    .map((u) => ({ id: u.id, name: u.name }))

  return (
    <>
      <PageHeader
        title="Service levels"
        subtitle="What you promise a customer — response and completion times."
      />
      <PageBody>
        <SlaPanel
          policies={policies}
          customers={slaCustomers}
          users={backOfficeUsers}
          tradingDays={settings.job_sla_trading_days}
          opensAt={settings.job_sla_opens_at}
          closesAt={settings.job_sla_closes_at}
          skipHolidays={settings.job_sla_skip_holidays === '1'}
          untargetedCount={untargeted}
        />
      </PageBody>
    </>
  )
}
