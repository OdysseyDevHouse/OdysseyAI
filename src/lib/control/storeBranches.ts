import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { query, queryOne, execute } from '../db'
import { siteQueryOne } from '../siteDb'

/**
 * Branch pins — where each store in a group is, for the public branch picker.
 *
 * A chain running one storefront has to offer a shopper the branch nearest
 * them, and then draw a list of the rest. Both answers live in the stores' own
 * databases (coordinates on the main stock_locations row, is_enabled on
 * online_store_settings), and reading them there would mean opening one database
 * connection per branch before the first byte of the page.
 *
 * So cp2_store_branches holds a published copy, and this module owns it. See the
 * header of sql/tickets/009_store_branches.sql for why that trade is the right
 * way round.
 *
 * WHAT THIS IS NOT: nothing here decides a price, a stock figure, or whether an
 * order may be placed. Those questions are always asked of the branch's own
 * database at the moment they matter. This exists to draw a list and sort it.
 */

export type BranchPin = {
  siteId: number
  /** Null when nobody has pinned this branch yet. A normal state, not a fault. */
  latitude: number | null
  longitude: number | null
  acceptsOnline: boolean
  displayName: string
  addressLine: string
  phone: string
  sortOrder: number
  /** Null when the copy has never been refreshed. */
  syncedAt: Date | null
}

type PinRow = RowDataPacket & {
  site_id: number
  latitude: string | null
  longitude: string | null
  accepts_online: number
  display_name: string
  address_line: string
  phone: string
  sort_order: number
  synced_at: Date | null
}

/**
 * DECIMAL comes back from the driver as a string, and Number('') is 0 — which
 * would silently drop a branch onto Null Island off the coast of Ghana rather
 * than reporting it as unpinned. Anything that is not a finite number becomes
 * null, which every caller already has to handle.
 */
function coord(raw: string | null): number | null {
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function mapPin(r: PinRow): BranchPin {
  return {
    siteId: Number(r.site_id),
    latitude: coord(r.latitude),
    longitude: coord(r.longitude),
    acceptsOnline: Boolean(r.accepts_online),
    displayName: String(r.display_name ?? ''),
    addressLine: String(r.address_line ?? ''),
    phone: String(r.phone ?? ''),
    sortOrder: Number(r.sort_order ?? 0),
    syncedAt: r.synced_at ?? null,
  }
}

/**
 * The pins for a set of sites, in the owner's running order.
 *
 * One query for the whole group — that is the entire point of this table. An
 * empty list in means an empty list out, with no query at all: a caller resolving
 * a group with no members must not send `IN ()` to MySQL.
 */
export async function branchPinsFor(siteIds: readonly number[]): Promise<BranchPin[]> {
  const ids = [...new Set(siteIds.filter((id) => Number.isInteger(id) && id > 0))]
  if (ids.length === 0) return []

  const placeholders = ids.map(() => '?').join(',')
  return (
    await query<PinRow>(
      `SELECT site_id, latitude, longitude, accepts_online, display_name,
              address_line, phone, sort_order, synced_at
         FROM cp2_store_branches
        WHERE site_id IN (${placeholders})
        ORDER BY sort_order ASC, display_name ASC`,
      ids,
    )
  ).map(mapPin)
}

export async function branchPin(siteId: number): Promise<BranchPin | null> {
  const row = await queryOne<PinRow>(
    `SELECT site_id, latitude, longitude, accepts_online, display_name,
            address_line, phone, sort_order, synced_at
       FROM cp2_store_branches WHERE site_id = ?`,
    [siteId],
  )
  return row ? mapPin(row) : null
}

/**
 * Writes a branch's coordinates.
 *
 * Passing null for either clears the pin, which is how a branch pinned in the
 * wrong place is un-pinned rather than left somewhere plausible but wrong. A
 * cleared pin drops the branch out of distance sorting and it is chosen by name
 * instead — degraded, but never misleading.
 *
 * Out-of-range values are refused rather than clamped: latitude 200 is somebody
 * having typed a longitude into the wrong box, and clamping it to 90 would put
 * the shop at the North Pole and look deliberate.
 */
export async function setBranchPin(
  siteId: number,
  latitude: number | null,
  longitude: number | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const bothNull = latitude === null && longitude === null
  if (!bothNull) {
    if (latitude === null || longitude === null) {
      return { ok: false, error: 'A pin needs both a latitude and a longitude.' }
    }
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      return { ok: false, error: 'Latitude must be between -90 and 90.' }
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return { ok: false, error: 'Longitude must be between -180 and 180.' }
    }
  }

  await execute(
    `INSERT INTO cp2_store_branches (site_id, latitude, longitude)
          VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE latitude = VALUES(latitude), longitude = VALUES(longitude)`,
    [siteId, latitude, longitude],
  )
  return { ok: true }
}

type SiteRow = RowDataPacket & {
  company_name: string
  trading_name: string | null
}

type LocationRow = RowDataPacket & {
  latitude: string | null
  longitude: string | null
  address: string | null
}

type EnabledRow = RowDataPacket & { is_enabled: number }

/**
 * Refreshes one branch's published copy from the store's own database.
 *
 * Called when a shop saves its online-store settings, and by hand from the setup
 * screen. Everything it copies is already the truth somewhere else; this only
 * moves it somewhere a public page can read in one query.
 *
 * ── WHY IT NEVER THROWS ─────────────────────────────────────────────────────
 *
 * This runs as a side effect of saving a screen that has already succeeded. A
 * branch whose database is unreachable, or which has never been migrated, must
 * not turn "your settings were saved" into a stack trace — the settings WERE
 * saved. The copy simply stays as it was, the setup screen shows the stale
 * synced_at, and somebody presses refresh. Reported, not raised.
 *
 * An existing pin is preserved when the site has no coordinates of its own, so a
 * branch pinned by hand on this screen is not wiped by the next settings save.
 */
export async function syncBranchPin(siteId: number): Promise<{ ok: boolean; error?: string }> {
  try {
    // The shop's name lives in the control database beside the group.
    const site = await queryOne<SiteRow>(
      'SELECT company_name, trading_name FROM cp2_sites WHERE id = ?',
      [siteId],
    )
    if (!site) return { ok: false, error: 'That store no longer exists.' }
    const displayName = site.trading_name?.trim() || String(site.company_name ?? '')

    // Both of these are in the store's OWN database and either may be missing on
    // a site that has not run every migration. Each is guarded separately so one
    // absent table does not cost us the other's value.
    let latitude: number | null = null
    let longitude: number | null = null
    let addressLine = ''
    try {
      const loc = await siteQueryOne<LocationRow>(
        siteId,
        `SELECT latitude, longitude, address FROM stock_locations
          WHERE is_main = 1 ORDER BY id ASC LIMIT 1`,
      )
      if (loc) {
        latitude = coord(loc.latitude)
        longitude = coord(loc.longitude)
        addressLine = String(loc.address ?? '').slice(0, 190)
      }
    } catch {
      // No stock_locations, or no lat/lng columns (pre-107). Leave unpinned.
    }

    let acceptsOnline = false
    try {
      const row = await siteQueryOne<EnabledRow>(
        siteId,
        'SELECT is_enabled FROM online_store_settings WHERE id = 1',
      )
      acceptsOnline = Boolean(row?.is_enabled)
    } catch {
      // No online store on this site. Not appearing in the picker is correct.
    }

    /*
     * COALESCE on the pin, so a hand-placed pin survives a sync from a site whose
     * main location has no coordinates. The screen is the only way to clear one
     * deliberately — see setBranchPin.
     */
    await execute(
      `INSERT INTO cp2_store_branches
         (site_id, latitude, longitude, accepts_online, display_name, address_line, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         latitude       = COALESCE(VALUES(latitude), latitude),
         longitude      = COALESCE(VALUES(longitude), longitude),
         accepts_online = VALUES(accepts_online),
         display_name   = VALUES(display_name),
         address_line   = VALUES(address_line),
         synced_at      = NOW()`,
      [siteId, latitude, longitude, acceptsOnline ? 1 : 0, displayName, addressLine],
    )
    return { ok: true }
  } catch (e) {
    console.error('[branches] could not refresh the branch pin for site', siteId, e)
    return { ok: false, error: 'That store’s details could not be read.' }
  }
}

/** Drops a branch's published copy — used when a store leaves a group. */
export async function forgetBranchPin(siteId: number): Promise<void> {
  await execute('DELETE FROM cp2_store_branches WHERE site_id = ?', [siteId])
}
