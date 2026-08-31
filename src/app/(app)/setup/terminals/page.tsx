import { requireCapability } from '@/lib/auth'
import { listTerminals } from '@/lib/site/terminals'
import { listLocations } from '@/lib/site/stockLocations'
import { listLicences, paidSlots } from '@/lib/control/devices'
import { PageHeader, PageBody } from '@/components/ui'
import { suggestedMasterCode } from '@/lib/site/masterCodes'

import TerminalsClient from './TerminalsClient'
import LicencesPanel from './LicencesPanel'

import UnlockPanel from './UnlockPanel'
import { siteHasLocalBackend } from '@/lib/licence/grantUnlock'

export const dynamic = 'force-dynamic'

/**
 * The registers themselves — what a till IS, and what it may run on.
 *
 * ── WHAT LEFT THIS SCREEN ─────────────────────────────────────────────────
 *
 * Seven panels of till BEHAVIOUR — the undo limit, stock warnings, offline
 * account sales, force clock-in, the sign-out rules, scan sounds and the
 * sign-in backdrop — moved to /settings → "Till". Every one of them was a
 * SHOP-WIDE flag that happened to be rendered on the screen listing machines,
 * so a manager adding a register scrolled through seven policy decisions to
 * reach the licence list.
 *
 * What stays is per-machine: which registers exist, which physical device is
 * standing at each, which stock location one sells from, the licences they
 * consume, and the telephone unlock. Those all belong beside the list; the
 * policies did not.
 */
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
