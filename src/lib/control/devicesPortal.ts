import 'server-only'
import { portalConfig, send } from './portalApi'
import type {
  ClaimResult,
  DeviceLicence,
  DeviceOffer,
  LicenceSpot,
  PaidSlots,
  SelfRegisterResult,
} from './devices'

/**
 * Till licensing, asked over HTTPS instead of a MySQL socket.
 *
 * ── HOW THIS RELATES TO devices.ts ──────────────────────────────────────────
 *
 * devices.ts keeps the SQL and keeps the exported API. Each of its functions
 * asks here first and falls through to its own query when this returns null.
 * So a caller — the till gate, the sale path, the setup screen — is unchanged
 * and unaware, which is the point: the transport moved, the rules did not.
 *
 * The portal runs the SAME logic against the SAME tables; its licence.ts is a
 * faithful port of devices.ts, comments included. There is no second set of
 * rules to keep in step, only a second way to reach the first.
 *
 * ── WHEN THIS RETURNS null, AND WHY THAT IS NOT AN ERROR ────────────────────
 *
 * Three cases, and all three mean "ask the database yourself":
 *
 *   · No portal key. A cloud install, the web build, a developer checkout, or a
 *     machine provisioned before the portal issued site keys. The ordinary
 *     answer for most of the estate today.
 *   · Unreachable. No line, DNS gone, or four seconds elapsed. The control
 *     database may still answer — it is a different host — and on a cloud
 *     install it certainly will.
 *   · A malformed answer. A proxy error page dressed as JSON.
 *
 * A REFUSAL is none of those and is NOT null. If the portal says "that licence
 * is not active" or "your signature did not verify", that is an answer, and
 * quietly re-asking MySQL would mean a broken key silently reverting the whole
 * estate to the direct connection this exists to stop needing. Refusals are
 * returned, logged, and acted on.
 */

/** Shared shape of everything /licence/spots answers in one call. */
type SpotsPayload = {
  licences: RawSpot[]
  free: RawSpot[]
  slots: PaidSlots
  billableDeviceCount: number
  trialDays: number
}

type RawSpot = Omit<LicenceSpot, 'lastSeenAt'> & { lastSeenAt: string | null }

/** Is there anything to ask? Cheap, and read per call so a test can flip it. */
export function portalAvailable(): boolean {
  return portalConfig() !== null
}

/**
 * Report a refusal once, where somebody will see it.
 *
 * Not thrown. Every caller of this module is on a path that must not stop a
 * shop trading, so the refusal degrades to the SQL fallback and leaves a line
 * behind rather than a stack trace on a shop floor.
 */
function refused(what: string, error: string, code: string): null {
  console.error(`[portal] ${what} refused (${code}): ${error}`)
  return null
}

/** `lastSeenAt` crosses the wire as a string; the app's type wants a Date. */
function toSpot(r: RawSpot): LicenceSpot {
  return { ...r, lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt) : null }
}

/**
 * The whole tills screen in one round trip.
 *
 * Four separate reads in devices.ts — listLicences, freeSpots, paidSlots,
 * billableDeviceCount — because each was a cheap local query. Over a shop's ADSL
 * line four round trips is four times the wait for a screen that cannot draw
 * until it has all of them, so the portal answers them together and the four
 * callers below share one result.
 */
async function spots(siteId: number): Promise<SpotsPayload | null> {
  if (!portalAvailable()) return null
  const res = await send<SpotsPayload>('GET', '/licence/spots')
  if (res.ok) return res.data
  if (res.reason === 'refused') return refused(`licence/spots for site ${siteId}`, res.error, res.code)
  return null
}

export async function licenceForSerial(serial: string): Promise<DeviceLicence | null> {
  if (!portalAvailable()) return null
  const res = await send<DeviceLicence>('POST', '/licence/check', { serial }, serial)
  if (res.ok) return res.data
  /* A refusal here is about the REQUEST, not the licence — an unverifiable
     signature or a suspended store. The licence's own "no" arrives as a 200
     carrying { ok: false, reason }. Falling back keeps the till trading while
     somebody looks at the key. */
  if (res.reason === 'refused') return refused(`licence/check for ${serial}`, res.error, res.code)
  return null
}

export async function listLicences(siteId: number): Promise<LicenceSpot[] | null> {
  const payload = await spots(siteId)
  return payload ? payload.licences.map(toSpot) : null
}

export async function freeSpots(siteId: number): Promise<LicenceSpot[] | null> {
  const payload = await spots(siteId)
  return payload ? payload.free.map(toSpot) : null
}

export async function paidSlots(siteId: number): Promise<PaidSlots | null> {
  const payload = await spots(siteId)
  return payload ? payload.slots : null
}

export async function billableDeviceCount(siteId: number): Promise<number | null> {
  const payload = await spots(siteId)
  return payload ? payload.billableDeviceCount : null
}

export async function deviceOffer(serial: string | null): Promise<DeviceOffer | null> {
  if (!portalAvailable()) return null
  const res = await send<DeviceOffer>('POST', '/licence/offer', { serial }, serial)
  if (res.ok) return res.data
  if (res.reason === 'refused') return refused('licence/offer', res.error, res.code)
  return null
}

export async function claimSpot(
  deviceRowId: number,
  serial: string,
  label: string,
  terminalId?: number | null,
): Promise<ClaimResult | null> {
  if (!portalAvailable()) return null
  /* `terminalId` carries three meanings — absent leaves it alone, null clears
     it, a number sets it — and JSON expresses all three. The key is omitted
     rather than sent as undefined, because JSON.stringify would drop it either
     way and being explicit about that is cheaper than rediscovering it. */
  const body: Record<string, unknown> = { deviceRowId, serial, label }
  if (terminalId !== undefined) body.terminalId = terminalId

  const res = await send<ClaimResult>('POST', '/licence/claim', body, serial)
  if (res.ok) return res.data
  if (res.reason === 'refused') return refused('licence/claim', res.error, res.code)
  return null
}

export async function releaseSpot(deviceRowId: number): Promise<boolean> {
  if (!portalAvailable()) return false
  const res = await send<{ ok: boolean }>('POST', '/licence/release', { deviceRowId })
  if (res.ok) return true
  if (res.reason === 'refused') refused('licence/release', res.error, res.code)
  return false
}

/**
 * The heartbeat.
 *
 * Returns nothing and reports nothing. Its caller does not await it, so a
 * rejected promise here would surface as an unhandled rejection in a shop
 * rather than as information anybody acts on — and the column it writes is a
 * convenience for a manager choosing which spot to release, never worth a sale.
 */
export async function touchDevice(deviceRowId: number): Promise<boolean> {
  if (!portalAvailable()) return false
  const res = await send<{ ok: boolean; stored: boolean }>('POST', '/licence/heartbeat', { deviceRowId })
  return res.ok
}

export async function selfRegister(
  kind: 'paid' | 'trial',
  serial: string,
  label: string,
  terminalId: number | null,
  startedBy?: string | null,
): Promise<SelfRegisterResult | null> {
  if (!portalAvailable()) return null
  const res = await send<SelfRegisterResult>(
    'POST',
    '/licence/register',
    { kind, serial, label, terminalId, startedBy: startedBy ?? null },
    serial,
  )
  if (res.ok) return res.data
  /* ── A REFUSED WRITE IS NOT RETRIED AGAINST MySQL ────────────────────────
   *
   * The read paths above fall through on a refusal because re-asking costs
   * nothing and answers the same question. This one creates a cp2_devices row.
   * Doing it twice — once refused, once by the fallback — is how a shop ends up
   * with a licence nobody ordered, so a refusal here is final and the caller is
   * told. */
  if (res.reason === 'refused') {
    return { ok: false, error: res.error }
  }
  return null
}
