import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'

/**
 * The floor plan: rooms, where the tables stand in them, and the fixed furniture.
 *
 * ── THE GRID DOES NOT GO AWAY ─────────────────────────────────────────────
 *
 * `pos_tables.section` and `sort_order` still drive the sectioned grid, and a table
 * with `room_id IS NULL` is simply not placed yet. So a shop that never opens the
 * designer keeps exactly the screen it has today, and one that half-places its floor
 * gets the canvas for the room it built and the grid for everything else.
 *
 * That is a deliberate refusal to migrate anybody. A guessed layout that looks nearly
 * right is worse than an honest list — a waiter who trusts a plan that has two tables
 * transposed walks to the wrong one.
 *
 * ── ROOM UNITS, NOT PIXELS ────────────────────────────────────────────────
 *
 * Every coordinate is in room units, and a room declares its own extent (100x70 by
 * default). The canvas scales that to whatever screen it is on, so the same layout
 * reads on a 1024 tablet and a 27" counter display. Storing pixels would bake one
 * screen's dimensions into the data and every other screen would show it wrong.
 *
 * ── WALLS ARE NOT TABLES ──────────────────────────────────────────────────
 *
 * `pos_floor_features` is its own table rather than a `kind` flag on `pos_tables`. A
 * wall has no seats, no bill, no occupancy and cannot be tapped — every property
 * `pos_tables` exists to carry is meaningless on it. Keeping them apart means "how
 * many tables are occupied" needs no clause excluding the furniture.
 */

type Row = RowDataPacket & Record<string, unknown>

export type FloorRoom = {
  id: number
  name: string
  width: number
  height: number
  sortOrder: number
  isActive: boolean
}

export type TablePlacement = {
  id: number
  roomId: number | null
  x: number | null
  y: number | null
  width: number
  height: number
  rotation: number
  shape: 'rect' | 'round'
}

export type FloorFeature = {
  id: number
  roomId: number
  kind: 'wall' | 'bar' | 'pass' | 'door' | 'plant' | 'text'
  label: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

export type SaveResult = { ok: true } | { ok: false; error: string }

/* ── Reading ─────────────────────────────────────────────────────────────── */

function mapRoom(r: Row): FloorRoom {
  return {
    id: Number(r.id),
    name: String(r.name),
    width: toNum(r.width, 100),
    height: toNum(r.height, 70),
    sortOrder: Number(r.sort_order ?? 0),
    isActive: !!r.is_active,
  }
}

export async function listRooms(siteId: number, includeInactive = false): Promise<FloorRoom[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, name, width, height, sort_order, is_active
       FROM pos_floor_rooms
      ${includeInactive ? '' : 'WHERE is_active = 1'}
      ORDER BY sort_order, name`,
  )
  return rows.map(mapRoom)
}

export async function listFeatures(siteId: number): Promise<FloorFeature[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT f.id, f.room_id, f.kind, f.label, f.pos_x, f.pos_y, f.width, f.height, f.rotation
       FROM pos_floor_features f
       JOIN pos_floor_rooms r ON r.id = f.room_id AND r.is_active = 1
      ORDER BY f.id`,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    roomId: Number(r.room_id),
    kind: String(r.kind) as FloorFeature['kind'],
    label: String(r.label ?? ''),
    x: toNum(r.pos_x),
    y: toNum(r.pos_y),
    width: toNum(r.width, 20),
    height: toNum(r.height, 2),
    rotation: Number(r.rotation ?? 0),
  }))
}

/* ── Rooms ───────────────────────────────────────────────────────────────── */

export async function createRoom(
  siteId: number,
  input: { name: string; width?: number; height?: number },
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Give the room a name.' }
  if (name.length > 60) return { ok: false, error: 'That name is too long.' }

  const size = validateSize(input.width ?? 100, input.height ?? 70)
  if (size) return { ok: false, error: size }

  try {
    const result = await siteExecute(
      siteId,
      `INSERT INTO pos_floor_rooms (name, width, height, sort_order)
       VALUES (?,?,?, (SELECT COALESCE(MAX(r.sort_order), 0) + 1 FROM pos_floor_rooms r))`,
      [name, (input.width ?? 100).toFixed(2), (input.height ?? 70).toFixed(2)],
    )
    return { ok: true, id: result.insertId }
  } catch (error) {
    if (isDuplicateName(error)) return { ok: false, error: 'There is already a room by that name.' }
    throw error
  }
}

export async function updateRoom(
  siteId: number,
  id: number,
  input: { name: string; width: number; height: number },
): Promise<SaveResult> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Give the room a name.' }
  const size = validateSize(input.width, input.height)
  if (size) return { ok: false, error: size }

  try {
    await siteExecute(
      siteId,
      `UPDATE pos_floor_rooms SET name = ?, width = ?, height = ? WHERE id = ?`,
      [name, input.width.toFixed(2), input.height.toFixed(2), id],
    )
    return { ok: true }
  } catch (error) {
    if (isDuplicateName(error)) return { ok: false, error: 'There is already a room by that name.' }
    throw error
  }
}

/**
 * Retires a room.
 *
 * Its TABLES are unplaced rather than deleted, and this is the point of the FK being
 * ON DELETE SET NULL: a table is a physical thing that may have a bill open on it, and
 * a manager reorganising rooms must not be able to destroy live documents by tidying up
 * the plan. Unplaced tables fall back to the sectioned grid, so nothing disappears from
 * the floor screen either.
 *
 * Deactivated rather than deleted for the same reason `deactivateTable` is: the room's
 * name may appear on old shift reports.
 */
export async function retireRoom(siteId: number, id: number): Promise<SaveResult> {
  await siteExecute(siteId, `UPDATE pos_floor_rooms SET is_active = 0 WHERE id = ?`, [id])
  await siteExecute(
    siteId,
    `UPDATE pos_tables SET room_id = NULL, pos_x = NULL, pos_y = NULL WHERE room_id = ?`,
    [id],
  )
  return { ok: true }
}

/* ── Placing tables ──────────────────────────────────────────────────────── */

export type PlacementInput = {
  tableId: number
  roomId: number | null
  x: number | null
  y: number | null
  width?: number
  height?: number
  rotation?: number
  shape?: 'rect' | 'round'
}

/**
 * Saves the whole room's arrangement in ONE transaction.
 *
 * A designer sends everything it moved, not one table at a time, and it lands
 * atomically — so a dropped connection mid-save leaves the previous arrangement whole
 * rather than half the tables moved. A floor plan that is half-saved is worse than one
 * that did not save: a waiter cannot tell which half.
 *
 * Every value is CLAMPED to its room rather than refused. A designer that snaps a table
 * to the edge and computes 100.4 on a 100-wide room has made a rounding error, not a
 * mistake worth throwing away a manager's whole layout for — and a table off the edge of
 * the canvas is invisible, which is the actual failure to prevent.
 */
export async function savePlacements(
  siteId: number,
  placements: PlacementInput[],
): Promise<SaveResult> {
  if (placements.length === 0) return { ok: true }
  if (placements.length > 500) return { ok: false, error: 'Too many tables in one save.' }

  for (const p of placements) {
    if (!Number.isInteger(p.tableId) || p.tableId <= 0) {
      return { ok: false, error: 'A table id was missing.' }
    }
    for (const value of [p.x, p.y, p.width, p.height, p.rotation]) {
      if (value !== null && value !== undefined && !Number.isFinite(value)) {
        return { ok: false, error: 'A position was not a number.' }
      }
    }
  }

  const rooms = await listRooms(siteId, true)
  const byId = new Map(rooms.map((r) => [r.id, r]))

  return siteTransaction(siteId, async (tx) => {
    for (const p of placements) {
      const room = p.roomId === null ? null : byId.get(p.roomId)
      if (p.roomId !== null && !room) {
        return { ok: false, error: 'That room no longer exists.' }
      }

      const width = clamp(p.width ?? 8, 1, room?.width ?? 100)
      const height = clamp(p.height ?? 8, 1, room?.height ?? 70)
      /* Clamped so the table's far edge stays inside the room, not just its origin — a
         table placed at x=98 in a 100-wide room would otherwise hang off the canvas with
         only its left edge visible. */
      const x =
        p.x === null || p.x === undefined
          ? null
          : clamp(p.x, 0, Math.max(0, (room?.width ?? 100) - width))
      const y =
        p.y === null || p.y === undefined
          ? null
          : clamp(p.y, 0, Math.max(0, (room?.height ?? 70) - height))

      await tx.execute(
        `UPDATE pos_tables
            SET room_id = ?, pos_x = ?, pos_y = ?, width = ?, height = ?, rotation = ?, shape = ?
          WHERE id = ?`,
        [
          p.roomId,
          x === null ? null : x.toFixed(2),
          y === null ? null : y.toFixed(2),
          width.toFixed(2),
          height.toFixed(2),
          /* Normalised into 0..359 rather than refused: a designer that rotates past a
             full turn has computed 370, which means 10. */
          ((Math.round(p.rotation ?? 0) % 360) + 360) % 360,
          p.shape === 'round' ? 'round' : 'rect',
          p.tableId,
        ] as never,
      )
    }
    return { ok: true }
  })
}

/* ── Features ────────────────────────────────────────────────────────────── */

export async function saveFeature(
  siteId: number,
  input: Omit<FloorFeature, 'id'> & { id?: number },
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const rooms = await listRooms(siteId, true)
  const room = rooms.find((r) => r.id === input.roomId)
  if (!room) return { ok: false, error: 'That room no longer exists.' }

  const width = clamp(input.width, 0.5, room.width)
  const height = clamp(input.height, 0.5, room.height)
  const x = clamp(input.x, 0, Math.max(0, room.width - width))
  const y = clamp(input.y, 0, Math.max(0, room.height - height))
  const rotation = ((Math.round(input.rotation) % 360) + 360) % 360
  const label = input.label.trim().slice(0, 60)

  if (input.id) {
    await siteExecute(
      siteId,
      `UPDATE pos_floor_features
          SET room_id = ?, kind = ?, label = ?, pos_x = ?, pos_y = ?, width = ?, height = ?, rotation = ?
        WHERE id = ?`,
      [
        input.roomId,
        input.kind,
        label,
        x.toFixed(2),
        y.toFixed(2),
        width.toFixed(2),
        height.toFixed(2),
        rotation,
        input.id,
      ],
    )
    return { ok: true, id: input.id }
  }

  const result = await siteExecute(
    siteId,
    `INSERT INTO pos_floor_features (room_id, kind, label, pos_x, pos_y, width, height, rotation)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      input.roomId,
      input.kind,
      label,
      x.toFixed(2),
      y.toFixed(2),
      width.toFixed(2),
      height.toFixed(2),
      rotation,
    ],
  )
  return { ok: true, id: result.insertId }
}

export async function deleteFeature(siteId: number, id: number): Promise<SaveResult> {
  await siteExecute(siteId, `DELETE FROM pos_floor_features WHERE id = ?`, [id])
  return { ok: true }
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function validateSize(width: number, height: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 'Give the room a size.'
  /* A floor smaller than a table cannot hold one, and one larger than 1000 units makes
     every table a speck. Both ends are about the canvas being usable rather than about
     what a room could physically be. */
  if (width < 10 || height < 10) return 'A room must be at least 10 × 10.'
  if (width > 1000 || height > 1000) return 'A room cannot be larger than 1000 × 1000.'
  return null
}

function isDuplicateName(error: unknown): boolean {
  const e = error as { code?: string; message?: string }
  return e?.code === 'ER_DUP_ENTRY' && /uq_room_name/.test(e?.message ?? '')
}
