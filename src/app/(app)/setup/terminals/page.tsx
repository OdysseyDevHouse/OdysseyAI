import { requireCapability } from '@/lib/auth'
import { listTerminals } from '@/lib/site/terminals'
import { listLicences } from '@/lib/control/devices'
import { PageHeader, PageBody } from '@/components/ui'
import { getNumericSetting, getSetting } from '@/lib/site/settings'
import { toPosMode } from '@/lib/posMode'
import TerminalsClient from './TerminalsClient'
import LicencesPanel from './LicencesPanel'
import UndoLimitPanel from './UndoLimitPanel'
import StockWarningPanel from './StockWarningPanel'
import OfflineAccountPanel from './OfflineAccountPanel'
import PosModePanel from './PosModePanel'

export const dynamic = 'force-dynamic'

export default async function TerminalsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')
  const terminals = await listTerminals(siteId, true)
  /* Licences come from the CONTROL database, not this shop's own. Read here
     rather than in the client so a manager sees them on first paint — this is
     the screen somebody opens when a till will not start. */
  const licences = await listLicences(siteId)
  /* A shop-wide till rule rather than a per-register one — see setUndoLimitAction.
     Absent or unreadable means no limit, matching what the POS itself does with a
     setting it cannot read: fail open rather than start refusing corrections. */
  const undoLimit = await getNumericSetting(siteId, 'pos_undo_limit')
  /* Absent means OFF — the opposite default to most flags here, because a shop
     that does not maintain its counts would be questioned about them all day.
     See pos_warn_out_of_stock in settings.ts. */
  const warnOutOfStock = (await getSetting(siteId, 'pos_warn_out_of_stock')) === '1'
  /* Absent means OFF, and that default is load-bearing: turning this on means a
     till may extend credit against a limit it cannot check, which nobody should
     inherit by upgrade. See pos_offline_account_sales. */
  const offlineAccountSales = (await getSetting(siteId, 'pos_offline_account_sales')) === '1'
  /* Which of the three tills this shop runs. Anything unreadable resolves to
     retail, which is the answer that trades — see lib/posMode. */
  const posMode = toPosMode(await getSetting(siteId, 'pos_mode'))

  return (
    <>
      <PageHeader
        title="Tills"
        subtitle="Which register rang up a sale, and which machine is which."
      />
      <PageBody>
        <div className="flex flex-col gap-4">
          <TerminalsClient terminals={terminals} />
          {/* WHAT KIND of till, above how they behave: the mode decides which
              screen the other settings even apply to. */}
          <PosModePanel mode={posMode} />
          {/* How the tills BEHAVE, under the list of which tills there are. One
              field, so it sits between the registers and the licences rather than
              earning a screen of its own. */}
          <UndoLimitPanel
            limit={
              Number.isFinite(undoLimit) && (undoLimit ?? 0) > 0 ? Number(undoLimit) : 0
            }
          />
          <StockWarningPanel warnOutOfStock={warnOutOfStock} />
          {/* Beside the stock warning because both answer "what does the till do
              when it cannot be sure" — one about counts, one about credit. */}
          <OfflineAccountPanel offlineAccountSales={offlineAccountSales} />
          {/* BELOW the tills, because a manager comes here to add a till far
              more often than to release a licence — and the licence list is the
              one they need when something is already wrong. */}
          <LicencesPanel licences={licences} terminals={terminals} />
        </div>
      </PageBody>
    </>
  )
}
