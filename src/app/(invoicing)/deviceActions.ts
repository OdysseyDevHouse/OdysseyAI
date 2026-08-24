'use server'

import { actorFor } from '@/lib/auth'
import { deviceOffer, licenceForSerial, touchDevice } from '@/lib/control/devices'
import {
  deviceLabelFor,
  type DeviceState,
  type SelfRegisterActionResult,
} from '@/lib/control/deviceMessages'
import { registerThisMachine } from '@/lib/licence/selfRegister'

/**
 * Is this machine allowed to be an invoicing counter?
 *
 * ── THE SAME QUESTION THE TILL ASKS, AND THE SAME LICENCE ──────────────────
 *
 * A counter and a till both spend one row in `cp2_devices`, claimed by one
 * machine, and both resolve it through `licenceForSerial` — so the RULE is
 * shared and there is exactly one copy of it. What is not shared is the door:
 * this window admits somebody on `sales.view` (see the layout), the till on
 * `sales.till`, and an action guarded on the other one would refuse a person
 * the window has already let in.
 *
 * That is why this is a second action rather than an import of
 * `(pos)/pos/deviceActions.ts`. Two doors, one rule, one answer shape — the
 * shape being `DeviceState`, which lives beside the sentences in
 * `deviceMessages.ts` precisely so both can return it.
 *
 * ── THE DEVICE ID ARRIVES FROM THE CLIENT ──────────────────────────────────
 *
 * It has to: the identifier lives in the Electron shell's userData file or in
 * the browser's localStorage, and the server can read neither. That makes it an
 * IDENTIFIER, never a credential — anyone can send any string. What stops that
 * mattering is that the licence is resolved server-side from the signed-in
 * session's site, and the write path re-checks it independently through
 * `requireLicensedDevice`. Sending somebody else's serial gets you their
 * licence, which they are already using; inventing one gets you nothing,
 * because no row carries it.
 *
 * ── AND THE SAME OFFER AT THE DOOR ─────────────────────────────────────────
 *
 * A counter that has never been registered can put itself into service on a free
 * paid licence, or take a thirty-day trial, exactly as a till can — because it
 * is the same licence, and a shop evaluating Odyssey from the invoicing window
 * is evaluating the same thing. Both go through `registerThisMachine`, so the
 * caps, the once-per-machine trial record and the till binding are one
 * implementation rather than two that could disagree.
 */
export async function checkCounterDeviceAction(serial: string): Promise<DeviceState> {
  const ctx = await actorFor('sales.view')
  if ('ok' in ctx) {
    return {
      status: 'blocked',
      reason: 'unregistered',
      message: 'This counter is not signed in.',
    }
  }

  const licence = await licenceForSerial(ctx.siteId, serial)
  if (licence.ok) {
    // Best-effort heartbeat; a failed write must never block the counter.
    void touchDevice(licence.deviceRowId)
    return {
      status: 'licensed',
      terminalId: licence.terminalId,
      name: licence.name,
      trialEndsOn: licence.trialEndsOn,
    }
  }

  /* Only once the answer is "no" — see the note on the till's copy. */
  const offer = await deviceOffer(ctx.siteId, serial)

  return {
    status: 'blocked',
    reason: licence.reason,
    message: deviceLabelFor(licence.reason, offer),
    offer,
  }
}

/**
 * Take the offer, from the counter's door.
 *
 * Guarded on `sales.view`, which is what this window already admits on. The
 * safety is the entitlement rather than the permission: `registerThisMachine`
 * can only ever hand out a licence the shop is already billed for, or the one
 * trial this machine has never taken.
 */
export async function startCounterAction(
  serial: string,
  label: string,
): Promise<SelfRegisterActionResult> {
  const ctx = await actorFor('sales.view')
  if ('ok' in ctx) return { ok: false, error: 'This counter is not signed in.' }

  const result = await registerThisMachine(ctx.siteId, serial, label, ctx.actor.userName)
  return result.ok ? { ok: true, trialEndsOn: result.trialEndsOn } : result
}
