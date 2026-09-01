import 'server-only'
import { portalConfig, send } from './portalApi'
import type { ModuleEntitlements, ModuleKey, AccountStatus } from './modules'

/**
 * What this shop may open, asked over HTTPS instead of a MySQL socket.
 *
 * ── WHY THIS IS THE MOST IMPORTANT OF THE PORTAL CLIENTS ────────────────────
 *
 * Every other control-database read on a desktop install DEGRADES when the line
 * is down: the billing screen falls back, the licence check fails open, the
 * session registry allows the request. This one EXPIRES.
 *
 * A desktop machine trades on a lease — the entitlements it was last told, good
 * for LEASE_DAYS — and the lease is renewed by exactly one thing: a successful
 * read of the control database. On a shop whose firewall does not permit an
 * outbound connection to port 3306 that read has never once succeeded, so the
 * lease counts down from the day of installation and the machine eventually
 * shows the lock screen with nothing whatsoever wrong with it.
 *
 * This is the same question over the transport a shop's line actually allows.
 *
 * ── THE PORTAL DECIDES, THIS ONLY RESHAPES ─────────────────────────────────
 *
 * The endpoint answers held modules, not cp2_site_modules rows. That is
 * deliberate: the entitlement RULES — latest-start wins, a suspended account
 * keeps only the base, the base is always granted — must live in one place, or
 * the copy that drifts is the one deciding whether a shop may open its own back
 * office. Everything below is Set and Map construction.
 *
 * ── null MEANS "ASK THE DATABASE YOURSELF" ─────────────────────────────────
 *
 * As in devicesPortal: no key, unreachable, or a malformed answer. The caller
 * then runs the query it always ran, which on a cloud install is the ordinary
 * path and the right one.
 */

/** The wire shape of GET /entitlements. */
type Payload = {
  held: string[]
  endingOn: Record<string, string>
  deviceCount: number
  accountId: number | null
  accountStatus: AccountStatus | null
}

/** Is there anything to ask? Read per call so a test can flip the env. */
export function portalAvailable(): boolean {
  return portalConfig() !== null
}

/**
 * The entitlements for this site, or null to fall back to SQL.
 *
 * ── WHY A REFUSAL IS ALSO null ──────────────────────────────────────────────
 *
 * Everywhere else a refusal is kept apart from an outage, because the two read
 * differently to a person. Here they lead to the same place: the caller's next
 * step is the direct query either way, and the alternative — treating a refusal
 * as "no modules" — would take a shop's whole back office away on a bad
 * signature. It is logged so somebody can see it; it is never acted on.
 */
export async function entitlementsForSite(
  siteId: number,
): Promise<Omit<ModuleEntitlements, 'degraded' | 'leased'> | null> {
  if (!portalAvailable()) return null

  const res = await send<Payload>('GET', '/entitlements')
  if (!res.ok) {
    if (res.reason === 'refused') {
      console.error(`[portal] entitlements for site ${siteId} refused (${res.code}): ${res.error}`)
    }
    return null
  }

  const data = res.data

  /* An answer with no `held` array is not an answer. A proxy error page that
     happens to parse as JSON would otherwise arrive here as a shop entitled to
     nothing, which is the one failure this must never produce. */
  if (!Array.isArray(data.held)) {
    console.error('[portal] entitlements answered without a held array; ignoring')
    return null
  }

  const held = new Set<ModuleKey>(data.held as ModuleKey[])
  const endingOn = new Map<ModuleKey, string>(
    Object.entries(data.endingOn ?? {}) as [ModuleKey, string][],
  )

  return {
    held,
    endingOn,
    deviceCount: Number(data.deviceCount ?? 0),
    accountId: data.accountId ?? null,
    accountStatus: data.accountStatus ?? null,
  }
}
