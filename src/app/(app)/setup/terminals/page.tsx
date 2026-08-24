import { requireCapability } from '@/lib/auth'
import { listTerminals } from '@/lib/site/terminals'
import { listLocations } from '@/lib/site/stockLocations'
import { listLicences, paidSlots } from '@/lib/control/devices'
import { PageHeader, PageBody } from '@/components/ui'
import { getNumericSetting, getSetting } from '@/lib/site/settings'
import { suggestedMasterCode } from '@/lib/site/masterCodes'

import TerminalsClient from './TerminalsClient'
import LicencesPanel from './LicencesPanel'
import UndoLimitPanel from './UndoLimitPanel'
import StockWarningPanel from './StockWarningPanel'
import ForceClockInPanel from './ForceClockInPanel'
import OfflineAccountPanel from './OfflineAccountPanel'

import UnlockPanel from './UnlockPanel'
import { siteHasLocalBackend } from '@/lib/licence/grantUnlock'

export const dynamic = 'force-dynamic'

export default async function TerminalsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')
  const terminals = await listTerminals(siteId, true)
  /* The rooms a till may be pointed at. Active only, and no transit pile — a
     register cannot sell out of a truck, and setTerminalStockLocation refuses
     both, so offering them would be a choice whose only outcome is a toast
     saying no. (excludeTransit = true, includeInactive = false.) */
  const locations = await listLocations(siteId, false, true)
  /* The code the "add a till" dialog opens with, or null when auto-numbering is
     off. Claims nothing — two managers opening the dialog together see the same
     suggestion, and the second one saves under the next code up. */
  const suggestedCode = await suggestedMasterCode(siteId, 'terminal')
  /* Licences come from the CONTROL database, not this shop's own. Read here
     rather than in the client so a manager sees them on first paint — this is
     the screen somebody opens when a till will not start. */
  const licences = await listLicences(siteId)
  /* How many of those the shop actually PAYS for, which the list alone cannot
     say: a trial row and a paid row look alike in it, and the question a manager
     arrives with is "why can this machine not start" — whose answer is usually
     that every paid licence is spoken for. */
  const slots = await paidSlots(siteId)
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
  /* Absent means OFF. Turning it on can stop a cashier trading, which is not a
     rule anybody should inherit by upgrade — see pos_force_clock_in. */
  const forceClockIn = (await getSetting(siteId, 'pos_force_clock_in')) === '1'
  /* NO SHOP-WIDE MODE READ HERE ANY MORE. Which screen a till runs is a
     property of that till, carried on its own row — see TerminalsClient and
     sql/site/180_terminal_pos_mode.sql. */
  /* The telephone unlock only means anything where a machine holds its own
     database and can therefore be cut off from us. Hidden entirely for a cloud
     site rather than shown and refused: a panel that can never do anything is a
     panel somebody will one day ring up about. */
  const hasLocalBackend = await siteHasLocalBackend(siteId)

  return (
    <>
      <PageHeader
        title="Tills"
        subtitle="Which register rang up a sale, and which machine is which."
      />
      <PageBody>
        <div className="flex flex-col gap-4">
          <TerminalsClient
            terminals={terminals}
            locations={locations.map((l) => ({ id: l.id, name: l.name, isMain: l.isMain }))}
            suggestedCode={suggestedCode}
          />
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
          {/* Beside the till-behaviour panels rather than under Staff: the rule
              is about what the TILL does when somebody signs in, and this is the
              screen a manager is on when they set up how the tills behave. */}
          <ForceClockInPanel forceClockIn={forceClockIn} />
          {/* BELOW the tills, because a manager comes here to add a till far
              more often than to release a licence — and the licence list is the
              one they need when something is already wrong. */}
          <LicencesPanel licences={licences} slots={slots} terminals={terminals} />
          {/* Last, and only where it applies: this is the panel somebody opens
              with a customer already on the phone, not one they browse. */}
          {hasLocalBackend && <UnlockPanel />}
        </div>
      </PageBody>
    </>
  )
}
