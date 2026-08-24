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
 * ── THE TILL MAY NOW PUT ITSELF INTO SERVICE, WITHIN THE SHOP'S ENTITLEMENT ─
 *
 * It could not, for a long time, and the reason was good: a cashier should not
 * be able to spend a licence the shop pays for by tapping a button. What that
 * reasoning missed is the shop with NOTHING to spend — a new customer, or one
 * who bought back-office modules and no POS. For them the refusal screen sent a
 * supervisor to a panel with no rows in it, and the product could not be started
 * at all without a phone call.
 *
 * So the door offers what the shop is already entitled to, and nothing more:
 *
 *   · a paid licence that is FREE, which the shop is billed for either way, so
 *     claiming it cannot raise the bill; or
 *   · a thirty-day trial, once per machine per store.
 *
 * Raising the count, marking a row paid, extending an expiry — all still
 * impossible from here. The cap is re-checked under a lock inside
 * `takePaidSlot`, so the answer this action returned a moment ago cannot be
 * replayed into a second licence.
 */

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

  /* Only asked once the answer is "no". A licensed till is the common path and
     it must not pay for two extra queries on every load to find out what it
     would have been offered had it been refused. */
  const offer = await deviceOffer(ctx.siteId, serial)

  return {
    status: 'blocked',
    reason: licence.reason,
    message: deviceLabelFor(licence.reason, offer),
    offer,
  }
}

/**
 * Take the offer.
 *
 * Guarded on `sales.till` — the same right the window itself needs, and
 * deliberately not `setup.edit`. Whoever is standing here has already been let
 * in to sell; making them fetch somebody with a back-office right to accept a
 * free trial is the friction this whole change exists to remove. What keeps that
 * safe is not the permission, it is the entitlement: nothing this action can do
 * costs the shop money it has not already agreed to.
 *
 * `label` is what the machine calls itself — "Desktop (win32)". Cosmetic, and
 * treated as such: it names the licence and the till in the setup list, and is
 * truncated rather than validated.
 */
export async function startTillAction(
  serial: string,
  label: string,
): Promise<SelfRegisterActionResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return { ok: false, error: 'This till is not signed in.' }

  const result = await registerThisMachine(ctx.siteId, serial, label, ctx.actor.userName)
  return result.ok ? { ok: true, trialEndsOn: result.trialEndsOn } : result
}
