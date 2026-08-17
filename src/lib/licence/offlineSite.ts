import 'server-only'
import type { RowDataPacket } from 'mysql2'
import { siteQueryOne } from '@/lib/siteDb'

/**
 * Which site this machine IS, without asking the control database.
 *
 * ── THE CHICKEN AND EGG ─────────────────────────────────────────────────────
 *
 * Everywhere else in the app, the site comes from the session, and the session
 * comes from a sign-in that read cp2_users. Offline there is no session yet —
 * that is what is being created — and no control database to ask.
 *
 * On a local backend there is exactly one answer available, and it is reliable:
 * this machine hosts one shop's database, so whatever site that database says
 * it belongs to is the site. The licence lease already records it, written on
 * the last successful check, and it is verified against the site id it was
 * issued to — so a database restored onto the wrong machine cannot present
 * itself as a different shop.
 *
 * ── WHY THE SITE ID IS TAKEN FROM CONFIGURATION, NOT DISCOVERED ─────────────
 *
 * sitePool() resolves a connection by looking the site up in cp2_site_databases
 * — the control database again. So a machine that cannot reach control cannot
 * discover which site databases exist either.
 *
 * The desktop shell therefore records its own site id in the environment when
 * it provisions, and this reads it back. That is a fact about the installation,
 * fixed at setup time, not something the app should be rediscovering on every
 * sign-in.
 */

type Row = RowDataPacket & Record<string, unknown>

export type OfflineSite = { siteId: number }

/**
 * The site this installation serves, or null if that cannot be established.
 *
 * Null is the safe answer everywhere it is used: the caller falls back to
 * reporting the original database failure, rather than guessing at a shop.
 */
export async function resolveOfflineSite(): Promise<OfflineSite | null> {
  if (process.env.APP_MODE !== 'desktop') return null

  const raw = process.env.ODYSSEY_SITE_ID
  const siteId = Number(raw)
  if (!raw || !Number.isFinite(siteId) || siteId <= 0) return null

  /* Confirmed against the database itself before it is trusted. An environment
     variable is a claim; a lease row carrying the same site id is that claim
     agreeing with what the shop's own database was last told. Without this a
     mistyped variable would point a machine at another shop's data. */
  try {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT site_id FROM licence_lease WHERE id = 1 LIMIT 1`,
    )
    if (!row) return null
    if (Number(row.site_id) !== siteId) return null
    return { siteId }
  } catch {
    return null
  }
}
