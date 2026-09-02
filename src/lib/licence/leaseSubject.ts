import 'server-only'
import { cookies } from 'next/headers'
import { licenceForSerial } from '@/lib/control/devices'

/**
 * Who the lease is ABOUT.
 *
 * A lease is per machine, not per site: one paid till does not license the
 * shop's other four. So writing one needs the serial of the machine making the
 * request, and the licence verdict for that serial.
 *
 * ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
 *
 * modules.ts writes the lease as a side effect of reading entitlements, and it
 * must not grow a dependency on the device layer to do it — devices.ts already
 * imports nothing from modules.ts, and keeping that one-way is what stops the
 * two files becoming a cycle the bundler resolves differently from the server.
 *
 * ── THE SERIAL IS A CLAIM, NOT A CREDENTIAL ─────────────────────────────────
 *
 * It comes from the machine itself — Electron's device-id file, or localStorage
 * in a browser — so it is a claim about identity that the server re-checks
 * against cp2_devices every time. That is the same posture the till takes on
 * the sale path. The lease inherits it: a machine can only ever lease the
 * licence its own serial actually resolves to, so lying about the serial gets
 * you somebody else's refusal rather than their entitlement.
 */

/**
 * The device id this request came from.
 *
 * Read from the cookie the client mirrors it into, because a server action has
 * no other way to see it: the canonical copy lives in Electron's userData file
 * and in localStorage, both of which are renderer-side. A machine that has not
 * mirrored it yet simply leases nothing, which is the safe outcome.
 */
export async function deviceSerialForLease(_siteId: number): Promise<string | null> {
  try {
    const jar = await cookies()
    const raw = jar.get(DEVICE_COOKIE)?.value?.trim()
    return raw ? raw.slice(0, 190) : null
  } catch {
    /* Called outside a request scope — a script, or a background task. There is
       no machine to speak of, so there is nothing to lease. */
    return null
  }
}

/**
 * The cookie the client mirrors its device id into.
 *
 * Deliberately not httpOnly: the renderer writes it, from the same value it
 * already holds. It is not a secret and it grants nothing on its own — see the
 * note above about claims.
 */
export const DEVICE_COOKIE = 'odyssey.device'

/**
 * What the control panel says about this machine's licence right now.
 *
 * 'licensed', or the refusal. Recorded on the lease so a locked screen can say
 * WHICH problem it was: "your subscription lapsed" and "this machine is not
 * registered" send the reader to two different conversations, and a screen that
 * cannot tell them apart sends every customer to the wrong one.
 *
 * A machine with no serial is recorded as 'licensed' rather than 'unregistered'
 * — it has not been refused, it simply has not identified itself, and the
 * device gate is what deals with that. Writing a refusal here would put a
 * machine into a locked state it was never actually refused into.
 */
export async function licenceStatusForLease(
  siteId: number,
): Promise<'licensed' | 'unregistered' | 'inactive' | 'unpaid' | 'expired'> {
  const serial = await deviceSerialForLease(siteId)
  if (!serial) return 'licensed'

  const licence = await licenceForSerial(siteId, serial)
  return licence.ok ? 'licensed' : licence.reason
}

/**
 * The device's own licence facts, for the lease to hold.
 *
 * ── WHY THIS IS SEPARATE FROM licenceStatusForLease ─────────────────────────
 *
 * That one records what the control panel CONCLUDED; this records what it
 * concluded FROM. Both go onto the same row and neither replaces the other: the
 * verdict is what a locked screen reads to say which refusal this was, and the
 * facts are what deviceLicenceState re-judges against today's date when there
 * is no line to ask down.
 *
 * Null on a machine that has not identified itself, or whose serial resolves to
 * no row. writeLease COALESCEs, so null LEAVES WHAT WAS ALREADY KNOWN rather
 * than clearing it — a machine that could not resolve its device this minute
 * must not thereby forget the expiry date it was told yesterday.
 */
export async function deviceFactsForLease(siteId: number): Promise<{
  deviceStatus: string | null
  deviceIsPaid: boolean | null
  deviceExpiryDate: string | null
}> {
  const none = { deviceStatus: null, deviceIsPaid: null, deviceExpiryDate: null }

  const serial = await deviceSerialForLease(siteId)
  if (!serial) return none

  const { deviceFactsForSerial } = await import('@/lib/control/devices')
  const facts = await deviceFactsForSerial(siteId, serial)
  if (!facts) return none

  return {
    deviceStatus: facts.status,
    deviceIsPaid: facts.isPaid,
    deviceExpiryDate: facts.expiryDate,
  }
}
