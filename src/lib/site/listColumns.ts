import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQueryOne, siteExecute } from '../siteDb'

/**
 * Which columns a list screen shows, decided for the whole store.
 *
 * The reasoning for a table rather than a setting, and for per-store rather
 * than per-user, is in 109_list_columns.sql. What matters here:
 *
 *   - The VISIBLE ids are stored, never the hidden ones. A column added in a
 *     later release is absent from every stored row and stays hidden until
 *     someone asks for it, instead of appearing unannounced in every store.
 *   - Unknown ids are dropped on read, so removing a column from the catalogue
 *     needs no migration.
 *   - No row means "the screen's own default", which is what a store that has
 *     never opened the picker should see.
 *
 * This is the STORE's answer. The per-device picker (useColumnPrefs) layers on
 * top and may narrow it further for one person at one screen.
 */

type Row = RowDataPacket & Record<string, unknown>

/** Which list. One row per screen; namespaced like the localStorage keys. */
export type ListKey = 'products' | 'customers' | 'suppliers'

/**
 * The store's visible set, or null when it has never chosen.
 *
 * Null rather than an empty array on purpose: "the store hid every column" and
 * "the store has not decided" are different, and only the first should produce
 * a table with nothing in it. Callers fall back to their own default on null.
 */
export async function listColumnsFor(
  siteId: number,
  listKey: ListKey,
  /** The catalogue. A stored id not in here is dropped. */
  known: readonly string[],
): Promise<string[] | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT columns FROM list_columns WHERE list_key = ?',
    [listKey],
  ).catch(() => null)

  if (!row) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(String(row.columns ?? '[]'))
  } catch {
    // A hand-edited row, or one written by a version that stored something
    // else. The screen's own default is a working table; a broken one is not.
    return null
  }
  if (!Array.isArray(parsed)) return null

  const allowed = new Set(known)
  return parsed.filter((id): id is string => typeof id === 'string' && allowed.has(id))
}

/**
 * Sets the store's visible columns for one list.
 *
 * Filtered against the catalogue on the way in as well as on the way out — an
 * id that does not exist would sit in the row forever, and the round trip
 * through a client is not a place to trust a string.
 */
export async function setListColumns(
  siteId: number,
  listKey: ListKey,
  visible: readonly string[],
  known: readonly string[],
  userId?: number | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const allowed = new Set(known)
  const clean = [...new Set(visible.filter((id) => allowed.has(id)))]

  if (clean.length === 0) {
    return {
      ok: false,
      error: 'Keep at least one column — a list with no columns shows nothing.',
    }
  }

  await siteExecute(
    siteId,
    `INSERT INTO list_columns (list_key, columns, updated_by)
          VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE columns = VALUES(columns), updated_by = VALUES(updated_by)`,
    [listKey, JSON.stringify(clean), userId ?? null],
  )

  return { ok: true }
}

/** Forgets the store's choice, so the screen's own default applies again. */
export async function clearListColumns(siteId: number, listKey: ListKey): Promise<void> {
  await siteExecute(siteId, 'DELETE FROM list_columns WHERE list_key = ?', [listKey])
}
