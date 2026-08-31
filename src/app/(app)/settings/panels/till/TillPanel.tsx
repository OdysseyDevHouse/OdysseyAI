'use client'

import { PanelState, usePanelData } from '../usePanelData'
import { loadTillSettingsAction, type TillPanelState } from './actions'
import UndoLimitPanel from './UndoLimitPanel'
import StockWarningPanel from './StockWarningPanel'
import OfflineAccountPanel from './OfflineAccountPanel'
import ForceClockInPanel from './ForceClockInPanel'
import SignOutPanel from './SignOutPanel'
import ScanSoundPanel from './ScanSoundPanel'
import SignInArtPanel from './SignInArtPanel'

/**
 * How the tills behave. Seven panels moved from /setup/terminals.
 *
 * That screen keeps the register LIST — which machines exist, which device is
 * standing at each, the licences they consume. Everything here is a shop-wide
 * rule about what a till DOES once somebody is signed in, which is why it was
 * always odd company for a list of hardware.
 *
 * The order is the one the old screen argued for, and the arguments still hold:
 * what the till ALLOWS, then who may start and stop trading, then what it does
 * out loud, then what it looks like before anybody signs in.
 */
export default function TillPanel() {
  const { data, error } =
    usePanelData<Omit<Extract<TillPanelState, { ok: true }>, 'ok'>>(loadTillSettingsAction)

  if (!data) return <PanelState error={error} rows={7} />

  return (
    <div className="flex flex-col gap-4">
      <UndoLimitPanel limit={data.undoLimit} />
      <StockWarningPanel warnOutOfStock={data.warnOutOfStock} />
      {/* Beside the stock warning because both answer "what does the till do
          when it cannot be sure" — one about counts, one about credit. */}
      <OfflineAccountPanel offlineAccountSales={data.offlineAccountSales} />
      {/* The rule is about what the TILL does when somebody signs in, which is
          why it sits here rather than under Staff. */}
      <ForceClockInPanel forceClockIn={data.forceClockIn} />
      {/* Directly after it, because the two are the same subject read from
          opposite ends: that one decides who may START trading, this one
          decides when they STOP. */}
      <SignOutPanel
        returnToLogin={data.returnToLogin}
        idleLogoutSeconds={data.idleLogoutSeconds}
      />
      {/* Last of the behaviour run, because it is the only one here that
          changes what the till DOES rather than what it allows — and the only
          one a manager can judge by pressing a button rather than by reading a
          paragraph. */}
      <ScanSoundPanel scanSounds={data.scanSounds} />
      {/* What the tills LOOK like before anybody signs in, under what they DO
          once somebody has. */}
      <SignInArtPanel backdropUrl={data.signInBackdrop} stockUrl={data.signInStock} />
    </div>
  )
}
