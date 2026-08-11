import { requireCapability } from '@/lib/auth'
import { PageHeader, PageBody } from '@/components/ui'
import { tipsOwed, tipsEarned, listPayouts } from '@/lib/site/tips'
import { listUsers } from '@/lib/site/users'
import TipsPayoutClient from './TipsPayoutClient'

export const dynamic = 'force-dynamic'

/**
 * Paying tips out.
 *
 * Setup → Tips configures what a bill is charged. This is where the money leaves: what each
 * person is still owed, and the record of what has already been handed over.
 *
 * ── OWED IS NOT EARNED ────────────────────────────────────────────────────
 *
 * The screen shows both, deliberately and separately. `tipsOwed` filters on
 * `payout_id IS NULL`, so it falls to nothing as people are paid — which is what makes it
 * safe to pay from. `tipsEarned` ignores payouts entirely and answers the other question a
 * shop asks of the same rows ("what did Nomsa make this week?"). One figure serving both is
 * the figure that gets paid out twice.
 */
export default async function TipsPayoutPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('sales.cashup')

  /*
   * Opens on TODAY, not on the month.
   *
   * Tips are settled at the end of a shift, so today is the answer nine times in ten — and a
   * default range wide enough to sweep up last week's unpaid tips would offer to pay them
   * again in the same envelope, without the manager having asked for that.
   */
  const today = new Date().toISOString().slice(0, 10)
  const range = { from: today, to: today }

  const [owed, earned, payouts, users] = await Promise.all([
    tipsOwed(siteId, range),
    tipsEarned(siteId, range),
    listPayouts(siteId, range),
    listUsers(siteId),
  ])

  return (
    <>
      <PageHeader title="Tips" subtitle="What each person is owed, and what has been paid out" />
      <PageBody>
        <TipsPayoutClient
          from={today}
          to={today}
          initial={{
            owed,
            earned,
            payouts,
            staff: users.filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name })),
          }}
        />
      </PageBody>
    </>
  )
}
