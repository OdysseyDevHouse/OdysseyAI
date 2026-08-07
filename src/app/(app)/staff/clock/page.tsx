import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { whoIsOnTheClock } from '@/lib/site/staffTime'
import { listTerminals } from '@/lib/site/terminals'
import { PageHeader, PageBody } from '@/components/ui'
import ClockScreen from './ClockScreen'

export const dynamic = 'force-dynamic'

/**
 * The clock.
 *
 * Reachable by anyone who may clock or who may see the team — a cashier taps
 * their PIN here at 07:00, and a supervisor watches the same screen to see who
 * is in. Neither needs `staff.cost`: this screen carries times, never money.
 */
export default async function ClockPage() {
  const { site, capabilities } = await requireSiteUser()

  const canSeeAll = can(capabilities, 'staff.view_all')
  if (!canSeeAll && !can(capabilities, 'staff.clock')) redirect('/not-allowed')

  const [onTheClock, terminals] = await Promise.all([
    whoIsOnTheClock(site.id),
    listTerminals(site.id, false),
  ])

  return (
    <>
      <PageHeader title="Clock in and out" subtitle={site.displayName} />

      <PageBody>
        <ClockScreen
          onTheClock={onTheClock}
          terminals={terminals.map((t) => ({ id: t.id, code: t.code, deviceId: t.deviceId }))}
          canSeeAll={canSeeAll}
          canEdit={can(capabilities, 'staff.edit')}
        />
      </PageBody>
    </>
  )
}
