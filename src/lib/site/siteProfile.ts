import 'server-only'
import type { RowDataPacket } from 'mysql2'
import { siteQueryOne, siteExecute } from '@/lib/siteDb'
import type { ConnectionType, Site } from '@/lib/sites'

/**
 * The local copy of the shop's own profile.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 *
 * `getSite()` reads cp2_sites, in the CONTROL database, and every authenticated
 * page reaches it through requireSite(). On an adopted local install that is a
 * query over the wire to answer "what is this shop called" — so a shop with no
 * line can sign in against its own users table, with all of its own data on the
 * machine, and then fail to open a screen.
 *
 * This is the memory that closes that. Written whenever the control panel
 * answers, read when it cannot. Exactly the shape licence_lease already uses
 * for module entitlements — see sql/site/178, and sql/site/238 for why the two
 * are separate tables rather than one.
 *
 * ── cp2_sites REMAINS THE AUTHORITY ─────────────────────────────────────────
 *
 * Nothing here is a second place where the truth might live. Support changes an
 * address in the control panel and that must keep working without visiting the
 * shop, so the mirror is refreshed on every successful read rather than at
 * sign-in — on a machine with a line it is never more than one page load old.
 * `mirroredAt` says when it was last confirmed, so a stale copy is legible
 * rather than silent.
 */

type Row = RowDataPacket & Record<string, unknown>

/** A mirrored profile, plus when it was last confirmed. */
export type MirroredSite = { site: Site; mirroredAt: Date }

/**
 * Does this installation keep a mirror?
 *
 * Desktop only, and for the same reason lockState.keepsLease() is: a cloud
 * install reaches the control database over the same network as everything else
 * it needs, so a mirror there would be written on every request and read on
 * none. A web build must also never be able to answer from a stale copy — see
 * the note on readSiteProfile about what the fallback deliberately skips.
 */
export function keepsProfile(): boolean {
  return process.env.APP_MODE === 'desktop'
}

/**
 * Record what the control panel just said.
 *
 * Fire-and-forget by contract. This runs off the back of a read that has
 * already succeeded, and a request that got its answer must never be failed by
 * a failure to write the answer down. A missed write costs a copy that is one
 * page load older than it might have been.
 *
 * `REPLACE` rather than an upsert of named columns: the row is a singleton and
 * a whole snapshot, so a partial update has no meaning — a field cleared
 * upstream must be cleared here too, and an UPDATE listing columns is how a
 * later-added field quietly never gets mirrored.
 */
export async function writeSiteProfile(site: Site): Promise<void> {
  if (!keepsProfile()) return
  try {
    await siteExecute(
      site.id,
      `REPLACE INTO site_profile
         (id, site_id, site_code, company_name, trading_name, registration_number, vat_number,
          address1, address2, address3, postal_code, phone, email, contact_name,
          connection_type, site_type_id, is_paid, status, mirrored_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        site.id,
        site.code,
        site.companyName,
        site.tradingName,
        site.registrationNumber,
        site.vatNumber,
        site.address1,
        site.address2,
        site.address3,
        site.postalCode,
        site.phone,
        site.email,
        site.contactName,
        site.connectionType,
        site.siteTypeId,
        site.isPaid ? 1 : 0,
        site.status,
      ],
    )
  } catch {
    /* No table yet (a site that has not run 238), or the database went away
       between the read and this write. Neither is worth failing a page over. */
  }
}

/**
 * Turn a mirrored row into a Site, or refuse it.
 *
 * Pure, and exported separately from the read so it can be tested without a
 * database — the two things it decides are a wrong-machine refusal and a set of
 * type coercions, and both are exactly the kind of boundary a round trip is a
 * poor way to exercise.
 *
 * ── VERIFIED BEFORE IT IS TRUSTED ───────────────────────────────────────────
 *
 * The caller asks for a specific siteId and the row must agree. A database
 * restored onto the wrong machine — a backup taken at one shop and put back at
 * another — therefore cannot present itself as the shop it came from. The same
 * check resolveOfflineSite() makes against the lease, for the same reason.
 *
 * ── THE MEMBERSHIP HALF IS NOT MIRRORED, AND THAT IS THE POINT ──────────────
 *
 * `role` comes back null and `isDefault` true, matching what getSite() itself
 * returns for a local install. This copy answers "which shop is this machine",
 * never "which shops may this person open" — so it cannot stand in for an
 * access check. That is why the fallback is wired into getSite() alone and not
 * into getSiteForUser().
 */
export function profileRowToSite(row: Record<string, unknown>, siteId: number): Site | null {
  if (!row) return null
  if (Number(row.site_id) !== siteId) return null

  const companyName = String(row.company_name ?? '')
  const tradingName = (row.trading_name as string | null) ?? null

  return {
    id: siteId,
    code: String(row.site_code ?? ''),
    companyName,
    tradingName,
    displayName: tradingName?.trim() || companyName,
    registrationNumber: (row.registration_number as string | null) ?? null,
    vatNumber: (row.vat_number as string | null) ?? null,
    address1: (row.address1 as string | null) ?? null,
    address2: (row.address2 as string | null) ?? null,
    address3: (row.address3 as string | null) ?? null,
    postalCode: (row.postal_code as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    contactName: (row.contact_name as string | null) ?? null,
    connectionType: String(row.connection_type ?? 'cloud') as ConnectionType,
    /* Coerced the same way mapSite does: a nullable int comes back as a string
       in some driver configurations, and `siteTypeId === 5` being quietly false
       is a shop showing the default picture on its till. */
    siteTypeId: row.site_type_id === null || row.site_type_id === undefined
      ? null
      : Number(row.site_type_id) || null,
    isPaid: Number(row.is_paid) === 1,
    status: String(row.status ?? 'active') as Site['status'],
    role: null as unknown as Site['role'],
    isDefault: true,
  }
}

/**
 * The last thing the control panel told us about this shop.
 *
 * Returns null when there is nothing to trust — which is the safe answer
 * everywhere it is used, because the caller then reports the original database
 * failure rather than guessing at a shop.
 */
export async function readSiteProfile(siteId: number): Promise<MirroredSite | null> {
  if (!keepsProfile()) return null
  try {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT site_id, site_code, company_name, trading_name, registration_number, vat_number,
              address1, address2, address3, postal_code, phone, email, contact_name,
              connection_type, site_type_id, is_paid, status, mirrored_at
         FROM site_profile WHERE id = 1 LIMIT 1`,
    )
    if (!row) return null

    const site = profileRowToSite(row, siteId)
    if (!site) return null

    return { site, mirroredAt: new Date(row.mirrored_at as string) }
  } catch {
    /* No table, or the site database is unreachable too. The second case is not
       a profile problem and must not be reported as one — the app fails on its
       own terms a moment later, with an error about the database. Same posture
       as lockState. */
    return null
  }
}
