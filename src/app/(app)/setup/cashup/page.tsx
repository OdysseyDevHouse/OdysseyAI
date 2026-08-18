import { requireCapability } from '@/lib/auth'
import { getSetting } from '@/lib/site/settings'
import { cashupMode, openShifts } from '@/lib/site/shifts'
import { PageHeader, PageBody } from '@/components/ui'
import CashupSettingsClient from './CashupSettingsClient'

export const dynamic = 'force-dynamic'

/**
 * Cash-up — what a drawer is counted against, and how far out it may be.
 *
 * Guarded on `setup.edit`, not a till capability: the tolerance decides when a
 * short drawer must be explained, and the people it is applied to are the last
 * ones who should be able to raise it.
 */
export default async function CashupSetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  const [varianceTolerance, mode, open] = await Promise.all([
    getSetting(siteId, 'cashup_variance_tolerance'),
    cashupMode(siteId),
    // Only the COUNT is used: the mode cannot change while a shift is open, and
    // the screen says so rather than letting somebody click into a refusal.
    openShifts(siteId),
  ])

  return (
    <>
      <PageHeader
        title="Cash-up"
        subtitle="What a drawer is counted against, and how far out it may be before somebody explains it."
      />
      <PageBody>
        <CashupSettingsClient
          settings={{ varianceTolerance }}
          mode={mode}
          openShiftCount={open.length}
        />
      </PageBody>
    </>
  )
}
