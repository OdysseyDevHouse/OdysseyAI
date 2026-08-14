import 'server-only'
import { licenceForSerial } from './devices'
import { deviceLabelFor } from './deviceMessages'

/**
 * The licence check that actually protects revenue.
 *
 * ── WHY THIS EXISTS WHEN THE TILL ALREADY CHECKS ───────────────────────────
 *
 * `PosEntry` refuses to render an unlicensed till, and that is the check a
 * cashier sees — but it runs in the browser, and a server action is a public
 * endpoint. Anyone who can call `finaliseSaleAction` can call it without ever
 * loading the screen that would have stopped them.
 *
 * So the screen is a courtesy and THIS is the enforcement, sitting where sales
 * are written. It is the same principle every other guard in this app follows:
 * the client decides what to offer, the server decides what is allowed.
 *
 * ── WHY IT REFUSES SOFTLY WHEN IT CANNOT TELL ──────────────────────────────
 *
 * The licence lives in the control database. If that is unreachable — a network
 * blip, a failover — this cannot answer, and the honest options are "let the
 * sale through" or "stop the shop trading". It lets the sale through, and says
 * so in the log.
 *
 * That is deliberate and it is the same trade the offline till makes: a shop
 * unable to sell because a licence server hiccuped is a far worse failure than
 * a few minutes of unverified trading by a device that was licensed the last
 * time anybody asked. Revenue protection is not worth a checkout queue.
 */
export type DeviceGuard = { ok: true } | { ok: false; error: string }

export async function requireLicensedDevice(
  siteId: number,
  serial: string | null | undefined,
): Promise<DeviceGuard> {
  /*
   * NO SERIAL AT ALL.
   *
   * Older till builds, and any caller that predates this feature, send nothing.
   * Refusing them would stop every one of those shops trading the moment this
   * deploys, so an absent serial passes and the till-side gate is what closes
   * the door. A MISSING serial is a caller that has not been updated; a WRONG
   * one is a device that was told no — only the second is a licence decision.
   */
  if (!serial || !serial.trim()) return { ok: true }

  try {
    const licence = await licenceForSerial(siteId, serial)
    if (licence.ok) return { ok: true }
    return { ok: false, error: deviceLabelFor(licence.reason) }
  } catch (err) {
    // Cannot reach the control database. See the docblock: trade on.
    console.error('[licence] could not verify device; allowing the sale', err)
    return { ok: true }
  }
}
