import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute } from '../siteDb'

/**
 * Report favourites — PER USER, unlike saved reports which belong to the site.
 *
 * "My reports" means the four someone runs every morning, not the forty the
 * business has accumulated. A shared favourites list would just be a second,
 * worse copy of the catalogue.
 *
 * A favourite is a plain id string: either a built-in report's key
 * ('sales-by-product') or a saved report's id as 'saved:12'. Nothing here
 * validates that the target still exists — a favourite pointing at a deleted
 * report is simply not rendered by the hub, which is cheaper than a foreign key
 * across two different kinds of thing.
 */

type Row = RowDataPacket & { report_id: string }

export async function listFavorites(siteId: number, userId: number): Promise<Set<string>> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT report_id FROM report_favorites WHERE user_id = ?`,
    [userId],
  )
  return new Set(rows.map((r) => String(r.report_id)))
}

/** Toggle, returning the state it ended in. */
export async function toggleFavorite(
  siteId: number,
  userId: number,
  reportId: string,
): Promise<boolean> {
  const removed = await siteExecute(
    siteId,
    `DELETE FROM report_favorites WHERE user_id = ? AND report_id = ?`,
    [userId, reportId],
  )
  if (removed.affectedRows > 0) return false

  // INSERT IGNORE, so two rapid clicks cannot raise a duplicate-key error on
  // what the user experiences as one action.
  await siteExecute(
    siteId,
    `INSERT IGNORE INTO report_favorites (user_id, report_id) VALUES (?, ?)`,
    [userId, reportId.slice(0, 64)],
  )
  return true
}

/** Drop every favourite pointing at a report that no longer exists. */
export async function clearFavorite(siteId: number, reportId: string): Promise<void> {
  await siteExecute(siteId, `DELETE FROM report_favorites WHERE report_id = ?`, [reportId])
}
