import 'server-only'
import { siteQuery, siteExecute } from '../siteDb'
import { verifierSalt, deriveVerifier, VERIFIER_ITERATIONS } from '../offlinePin'
import { capabilitiesForRole, can, type CapabilitySet } from './permissions'
import { listUsers } from './users'

/**
 * Who may sign in at a till that has no database.
 *
 * The verifier itself is `lib/offlinePin.ts` — pure WebCrypto, and deliberately
 * testable without a database. This module is the half that needs one: minting a
 * verifier when a PIN is set, and shipping the set of them for one machine in the
 * offline catalog.
 *
 * ── THE SECRET ────────────────────────────────────────────────────────────
 *
 * `OFFLINE_PIN_KEY` is read here and nowhere near the browser. It is what makes a
 * dumped IndexedDB useless: without it an attacker cannot even construct the salt,
 * so cannot test a guess at all. Treat it like SESSION_SECRET.
 */

function secret(): string {
  const value = process.env.OFFLINE_PIN_KEY
  if (!value) throw new Error('OFFLINE_PIN_KEY is not set.')
  return value
}

/** Whether offline sign-in is configured at all. */
export function offlinePinConfigured(): boolean {
  return Boolean(process.env.OFFLINE_PIN_KEY)
}

/**
 * Mints (or replaces) one operator's verifier for one device.
 *
 * Needs the PLAINTEXT pin, which is why this is called from the moment a PIN is
 * saved rather than at any later point — bcrypt does not give it back.
 */
export async function mintVerifier(
  siteId: number,
  userId: number,
  pin: string,
  deviceId: string,
): Promise<void> {
  const salt = await verifierSalt(secret(), siteId, userId, deviceId)
  const verifier = await deriveVerifier(pin, salt, VERIFIER_ITERATIONS)

  await siteExecute(
    siteId,
    `INSERT INTO user_offline_verifiers (user_id, device_id, verifier, iterations)
     VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE verifier = VALUES(verifier), iterations = VALUES(iterations)`,
    [userId, deviceId, verifier, VERIFIER_ITERATIONS],
  )
}

/**
 * Mints a verifier for every machine that has claimed a till at this site.
 *
 * Called when a PIN is set or changed. Every registered device rather than one,
 * because a cashier whose PIN was reset should be able to sign in at whichever
 * till they walk up to — minting lazily would mean their first offline shift on
 * till 3 failed for a reason nobody could diagnose.
 *
 * FAIL-SOFT, deliberately. A verifier that cannot be minted — no secret
 * configured, the table missing on an unmigrated site — must never stop a user
 * being saved. The consequence of failing is that the operator cannot sign in
 * OFFLINE, which is a smaller problem than an admin screen that refuses to save.
 */
export async function mintVerifiersForAllDevices(
  siteId: number,
  userId: number,
  pin: string,
): Promise<void> {
  if (!offlinePinConfigured()) return
  try {
    const devices = await siteQuery<{ device_id: string }>(
      siteId,
      'SELECT device_id FROM terminals WHERE device_id IS NOT NULL AND is_active = 1',
    )

    /* In PARALLEL, and measured: one derivation is ~250ms at 2.4M iterations, so a
       serial loop costs a quarter-second PER TILL. Measured at one till that is
       376ms and invisible; projected across a twenty-till franchise it is five
       seconds of an admin screen looking hung while somebody saves a cashier's PIN.
       The derivations share nothing, so there is no reason to queue them. */
    await Promise.all(devices.map(({ device_id }) => mintVerifier(siteId, userId, pin, device_id)))
  } catch {
    // Swallowed on purpose — see the note above.
  }
}

/**
 * A CapabilitySet flattened into the plain list the till can carry.
 *
 * ⚠ An OWNER's set is `{ isOwner: true, granted: <empty> }` — `can()` short-circuits
 * on the flag and never reads the set. Shipping `granted` alone would therefore
 * strip an owner of every permission the moment they went offline, which is the
 * opposite of what the flag means. The sentinel below is what carries it across,
 * and `operatorCan` in lib/offlineCapability.ts is the only thing that reads it.
 *
 * A Set cannot cross a server-action boundary as a Set anyway, so the flattening
 * has to happen somewhere; doing it here keeps the owner rule next to the reason
 * for it.
 */
export const OWNER_CAPABILITY = '*'

export function flattenCapabilities(capabilities: CapabilitySet): string[] {
  return capabilities.isOwner ? [OWNER_CAPABILITY] : [...capabilities.granted]
}

/** An operator as the offline till sees them. */
export type OfflineOperator = {
  userId: number
  name: string
  /** Resolved server-side. The till reads these; it never decides them. */
  capabilities: string[]
  saltB64: string
  verifier: string
  iterations: number
  /**
   * False when this operator has no verifier for this device.
   *
   * Shipped as a FLAG rather than omitting them, so the till can say "Nomsa has
   * not signed in on this machine yet — she needs to once, online" instead of
   * silently refusing a PIN that the person knows is correct.
   */
  offlineReady: boolean
}

/**
 * Every operator who could sign in at this machine, for the offline catalog.
 *
 * The SALT is shipped, not just the verifier. That is safe and necessary: the salt
 * is an HMAC output, so it reveals nothing about the secret that produced it, and
 * without it the till could not derive anything to compare. What is never shipped
 * is `OFFLINE_PIN_KEY` itself.
 *
 * Capabilities come from the operator's ROLE, resolved here. A till that decided
 * its own permissions would be a till an attacker could grant themselves a void
 * on; these are re-derived server-side again at sync, and the ones shipped here
 * only decide what the screen offers.
 */
export async function operatorsForDevice(
  siteId: number,
  deviceId: string,
): Promise<OfflineOperator[]> {
  if (!offlinePinConfigured() || !deviceId) return []

  const rows = await siteQuery<{ user_id: number; verifier: string; iterations: number }>(
    siteId,
    'SELECT user_id, verifier, iterations FROM user_offline_verifiers WHERE device_id = ?',
    [deviceId],
  )
  const byUser = new Map(rows.map((r) => [Number(r.user_id), r]))

  // Only users who can actually work a till. A back-office user with no PIN has
  // no business in this list, and shipping them would put names on the till's
  // lock screen that can never unlock it.
  const users = (await listUsers(siteId)).filter((u) => u.isActive && u.hasPin)

  /* Serial is fine HERE, unlike minting: `verifierSalt` is a single HMAC —
     microseconds — not a 2.4M-iteration derivation. The expensive one is
     `deriveVerifier`, and that happens on the till, once, when a PIN is typed. */
  const operators: OfflineOperator[] = []
  for (const user of users) {
    const capabilities = await capabilitiesForRole(siteId, user.roleId)
    if (!can(capabilities, 'sales.till')) continue

    const row = byUser.get(user.id)
    operators.push({
      userId: user.id,
      name: user.name,
      capabilities: flattenCapabilities(capabilities),
      saltB64: await verifierSalt(secret(), siteId, user.id, deviceId),
      verifier: row?.verifier ?? '',
      iterations: Number(row?.iterations ?? VERIFIER_ITERATIONS),
      offlineReady: Boolean(row?.verifier),
    })
  }
  return operators
}
