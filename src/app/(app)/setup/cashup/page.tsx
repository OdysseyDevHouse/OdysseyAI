import { requireCapability } from '@/lib/auth'
import { getSettings } from '@/lib/site/settings'
import { cashupMode, openShifts } from '@/lib/site/shifts'
import { currencyState } from '@/lib/site/cashDenominations'
import { listDenominations } from '@/lib/site/cashupDeclaration'
import { CURRENCIES } from '@/lib/currencies'
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

  const [settings, mode, open, currency, denominations] = await Promise.all([
    getSettings(siteId, ['cashup_variance_tolerance', 'pos_require_shift']),
    cashupMode(siteId),
    // Only the COUNT is used: the mode cannot change while a shift is open, and
    // the screen says so rather than letting somebody click into a refusal.
    openShifts(siteId),
    currencyState(siteId),
    /* Inactive included: the whole point of showing the grid here is turning a
       row back on — a shop that finds old 5c coins in a safe should tick a box
       rather than ring support. See 168. */
    listDenominations(siteId, true),
  ])

  return (
    <>
      <PageHeader
        title="Cash-up"
        subtitle="Whether this shop counts a drawer at all, what it is counted against, and how far out it may be before somebody explains it."
      />
      <PageBody>
        <CashupSettingsClient
          settings={{
            varianceTolerance: settings.cashup_variance_tolerance,
            requireShift: settings.pos_require_shift,
          }}
          mode={mode}
          openShiftCount={open.length}
          currency={currency}
          denominations={denominations}
          currencies={CURRENCIES.map((c) => ({ code: c.code, name: c.name, symbol: c.symbol }))}
        />
      </PageBody>
    </>
  )
}
