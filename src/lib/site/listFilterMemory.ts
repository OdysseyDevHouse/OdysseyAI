import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQueryOne, siteExecute } from '../siteDb'
import type { ListKey } from './listColumns'

/**
 * The filter a person asked to be remembered while they work through a list.
 *
 * The reasoning for the table — per user rather than per store, expiring, and
 * why not localStorage — is in 241_list_filters.sql. What matters here:
 *
 *   - The stored value is the SAME encoded string the URL carries. There is one
 *     format and one parser; see lib/listFilters.ts.
 *   - A row past its expiry reads as nothing, without needing a sweep. The
 *     write replaces it, so a person's filter is refreshed every time they
 *     change it rather than aging out mid-task.
 *   - Every function here fails SOFT. A remembered filter is a convenience; a
 *     list screen that 500s because a preference table is missing on one site
 *     is a real outage caused by a nicety. Schema drifts between sites (a table
 *     in sql/site/ may not exist on a given one), so this is not theoretical.
 */

type Row = RowDataPacket & Record<string, unknown>

/**
 * How long a remembered filter lives.
 *
 * Long enough to cover a working day, so someone editing a list of products
 * over an afternoon does not lose it to lunch. Short enough that it cannot
 * quietly narrow tomorrow's catalogue — the trap this feature has to avoid.
 */
const LIFETIME_HOURS = 12

/**
 * The remembered filter string, or null.
 *
 * Null covers all of: never set, cleared, expired, and the table not existing.
 * Every one of those means the same thing to a caller — show the whole list.
 */
export async function rememberedFilters(
  siteId: number,
  listKey: ListKey,
  userId: number,
): Promise<string | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT filters FROM list_filters
      WHERE list_key = ? AND user_id = ? AND expires_at > UTC_TIMESTAMP()`,
    [listKey, userId],
  ).catch(() => null)

  const value = row ? String(row.filters ?? '') : ''
  return value || null
}

/**
 * Remember this filter for the next `LIFETIME_HOURS`.
 *
 * Called with the encoded string straight off the URL, so what is stored and
 * what was in the address bar cannot disagree. An empty string forgets instead
 * of storing nothing — "remember" with no filter applied is a clear.
 */
export async function rememberFilters(
  siteId: number,
  listKey: ListKey,
  userId: number,
  encoded: string,
): Promise<void> {
  if (!encoded) {
    await forgetFilters(siteId, listKey, userId)
    return
  }

  await siteExecute(
    siteId,
    `INSERT INTO list_filters (list_key, user_id, filters, expires_at)
          VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR))
     ON DUPLICATE KEY UPDATE filters = VALUES(filters), expires_at = VALUES(expires_at)`,
    [listKey, userId, encoded, LIFETIME_HOURS],
  ).catch(() => undefined)
}

/** Stop remembering — the tick coming off, or "Clear filters". */
export async function forgetFilters(
  siteId: number,
  listKey: ListKey,
  userId: number,
): Promise<void> {
  await siteExecute(siteId, 'DELETE FROM list_filters WHERE list_key = ? AND user_id = ?', [
    listKey,
    userId,
  ]).catch(() => undefined)
}
