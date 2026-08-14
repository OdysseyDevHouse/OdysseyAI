'use server'

import { actorFor } from '@/lib/auth'
import { licenceForSerial, touchDevice, type LicenceRefusal } from '@/lib/control/devices'
import { deviceLabelFor } from '@/lib/control/deviceMessages'

/**
 * Is this machine allowed to be a till?
 *
 * ── WHY THE DEVICE ID ARRIVES FROM THE CLIENT ──────────────────────────────
 *
 * It has to: the identifier lives in the Electron shell's userData file or in
 * the browser's localStorage, and the server has no way to read either. That
 * makes it an IDENTIFIER, never a credential — anyone can send any string.
 *
 * What stops that mattering is that the licence is resolved server-side from the
 * signed-in session's site, and the sale path re-checks it independently (see
 * `requireLicensedDevice`). Sending somebody else's serial gets you their
 * licence, which they are already using; inventing one gets you nothing, because
 * no row carries it.
 *
 * ── THE TILL NEVER REGISTERS ITSELF ────────────────────────────────────────
 *
 * There are exactly two answers here — licensed, or blocked. An earlier version
 * let a browser claim a free licence from the till screen, and it was the wrong
 * shape twice over: it meant a cashier could spend a licence the shop pays for
 * by tapping a button, and it meant desktop and browser tills behaved
 * differently at the one moment somebody is trying to understand the system.
 *
 * Linking a machine is now a supervisor's act, in Setup → Tills, behind
 * `setup.edit`. This screen only reports.
 */

export type DeviceState =
  | {
      /** Registered and entitled — the till may open. */
      status: 'licensed'
      terminalId: number | null
      name: string
      /** Set while an unpaid device is inside its evaluation period. */
      trialEndsOn: string | null
    }
  | {
      /** Anything else. The till does not open, and says why. */
      status: 'blocked'
      reason: LicenceRefusal
      message: string
    }

export async function checkDeviceAction(serial: string): Promise<DeviceState> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) {
    return { status: 'blocked', reason: 'unregistered', message: 'This till is not signed in.' }
  }

  const licence = await licenceForSerial(ctx.siteId, serial)
  if (licence.ok) {
    // Best-effort heartbeat; a failed write must never block the till.
    void touchDevice(licence.deviceRowId)
    return {
      status: 'licensed',
      terminalId: licence.terminalId,
      name: licence.name,
      trialEndsOn: licence.trialEndsOn,
    }
  }

  return {
    status: 'blocked',
    reason: licence.reason,
    message: deviceLabelFor(licence.reason),
  }
}
