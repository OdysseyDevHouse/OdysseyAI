import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'

/**
 * How a table is being served — sit down, takeaway, delivery, and whatever else a
 * shop actually does.
 *
 * ── ROWS, NOT AN ENUM ─────────────────────────────────────────────────────
 *
 * The reference POS compiled three upper-case strings into the client. The words a
 * shop uses for its own trade are not the developer's to fix: a hotel wants "Room
 * service", a caterer wants "Function", a drive-through wants "Drive-thru", and none
 * of them should need a release to say so. Same argument as tender types — see the
 * note there about a `tender_kind` ENUM being the trap.
 *
 * ── WHAT "DEFAULT" IS FOR ─────────────────────────────────────────────────
 *
 * A table with no type is the normal case, not a broken one: nothing back-filled the
 * column, and inventing a fact about existing trade would be worse than leaving it
 * blank. The gate files those under the DEFAULT type, so an untouched floor reads as
 * all-sit-down without a migration having claimed so.
 */

export type VisitType = {
  id: number
  name: string
  /** Which type an unlabelled table counts as. Exactly one row carries it. */
  isDefault: boolean
  isActive: boolean
  sortOrder: number
}

type Row = RowDataPacket & Record<string, unknown>

function mapVisitType(r: Row): VisitType {
  return {
    id: Number(r.id),
    name: String(r.name),
    isDefault: !!r.is_default,
    isActive: !!r.is_active,
    sortOrder: Number(r.sort_order),
  }
}

/**
 * Every type, in the order the segments appear.
 *
 * `activeOnly` for the till, everything for the setup screen — which must show a
 * hidden type in order to bring it back, the same rule the quick-key designer follows
 * for hidden keys.
 */
export async function listVisitTypes(siteId: number, activeOnly = false): Promise<VisitType[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, name, is_default, is_active, sort_order
       FROM pos_visit_types
      ${activeOnly ? 'WHERE is_active = 1' : ''}
      ORDER BY sort_order ASC, name ASC`,
  )
  return rows.map(mapVisitType)
}

/** The type an unlabelled table answers to, or null on a floor with none set. */
export async function defaultVisitType(siteId: number): Promise<VisitType | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT id, name, is_default, is_active, sort_order
       FROM pos_visit_types
      WHERE is_default = 1 AND is_active = 1
      LIMIT 1`,
  )
  return row ? mapVisitType(row) : null
}

/**
 * Add a type.
 *
 * The name is trimmed and must be unique — the UNIQUE key enforces it, and this
 * turns the driver's error into a sentence a manager can act on. A duplicate is the
 * one failure a setup screen actually hits, so it is worth naming rather than
 * letting "ER_DUP_ENTRY" reach the toast.
 */
export async function createVisitType(
  siteId: number,
  input: { name: string; isDefault?: boolean },
): Promise<number> {
  const name = input.name.trim()
  if (!name) throw new Error('A visit type needs a name.')

  return siteTransaction(siteId, async (tx) => {
    if (input.isDefault) {
      await tx.execute('UPDATE pos_visit_types SET is_default = 0 WHERE is_default = 1')
    }
    /* Sorted to the END rather than interleaved: a new type appearing between two a
       waiter already knows by position is worse than one appearing last. */
    const [rows] = await tx.query<Row[]>(
      'SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM pos_visit_types',
    )
    const next = Number(rows[0]?.next ?? 10)

    try {
      const [res] = await tx.execute(
        'INSERT INTO pos_visit_types (name, is_default, sort_order) VALUES (?, ?, ?)',
        [name, input.isDefault ? 1 : 0, next],
      )
      return Number((res as { insertId: number }).insertId)
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY') {
        throw new Error(`There is already a visit type called “${name}”.`)
      }
      throw e
    }
  })
}

/**
 * Rename a type, hide it, or make it the default.
 *
 * Clearing the other defaults happens in the SAME transaction as setting this one.
 * Two statements outside one would leave a window with two defaults or none, and the
 * gate reads the default on every load.
 */
export async function updateVisitType(
  siteId: number,
  id: number,
  patch: { name?: string; isDefault?: boolean; isActive?: boolean },
): Promise<void> {
  await siteTransaction(siteId, async (tx) => {
    if (patch.isDefault) {
      await tx.execute('UPDATE pos_visit_types SET is_default = 0 WHERE id <> ?', [id])
    }

    const sets: string[] = []
    /* Typed as the driver's own parameter type rather than unknown[] — mysql2's
       execute() has no overload for unknown[], and widening it here would hide a real
       mismatch behind a cast. */
    const args: (string | number)[] = []
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) throw new Error('A visit type needs a name.')
      sets.push('name = ?')
      args.push(name)
    }
    if (patch.isDefault !== undefined) {
      sets.push('is_default = ?')
      args.push(patch.isDefault ? 1 : 0)
    }
    if (patch.isActive !== undefined) {
      sets.push('is_active = ?')
      args.push(patch.isActive ? 1 : 0)
      /* Hiding the default would leave the floor with no fallback, so the flag goes
         with it and the shop is told to pick another. Silently keeping a hidden row
         as the default is how an unlabelled table ends up filed under a segment
         nobody can see. */
      if (patch.isActive === false) {
        sets.push('is_default = 0')
      }
    }
    if (sets.length === 0) return

    args.push(id)
    try {
      await tx.execute(`UPDATE pos_visit_types SET ${sets.join(', ')} WHERE id = ?`, args)
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY') {
        throw new Error(`There is already a visit type called “${patch.name?.trim()}”.`)
      }
      throw e
    }
  })
}

/** Put the segments in a given order — the ids, first to last. */
export async function reorderVisitTypes(siteId: number, ids: number[]): Promise<void> {
  if (ids.length === 0) return
  await siteTransaction(siteId, async (tx) => {
    for (const [i, id] of ids.entries()) {
      await tx.execute('UPDATE pos_visit_types SET sort_order = ? WHERE id = ?', [(i + 1) * 10, id])
    }
  })
}

/**
 * Remove a type outright, or hide it when a table still names it.
 *
 * Returns what actually happened so the screen can say so. Deleting a type that
 * tables point at would silently move them to the default via ON DELETE SET NULL —
 * which is safe, but a manager who meant "stop offering this" and got "and re-file
 * the eleven tables using it" has been surprised by their own click.
 */
export async function deleteVisitType(
  siteId: number,
  id: number,
): Promise<'deleted' | 'hidden'> {
  const inUse = await siteQueryOne<Row>(
    siteId,
    'SELECT COUNT(*) AS n FROM pos_tables WHERE visit_type_id = ?',
    [id],
  )
  if (Number(inUse?.n ?? 0) > 0) {
    await updateVisitType(siteId, id, { isActive: false })
    return 'hidden'
  }
  await siteExecute(siteId, 'DELETE FROM pos_visit_types WHERE id = ?', [id])
  return 'deleted'
}
