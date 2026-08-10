'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { setSetting } from '@/lib/site/settings'
import {
  listTables,
  createTable,
  updateTable,
  deactivateTable,
  type PosTable,
  type TableInput,
} from '@/lib/site/posTables'
import {
  listRooms,
  listFeatures,
  createRoom,
  updateRoom,
  retireRoom,
  savePlacements,
  saveFeature,
  deleteFeature,
  type FloorRoom,
  type FloorFeature,
  type PlacementInput,
} from '@/lib/site/posFloor'

/**
 * Building the floor.
 *
 * Guarded on `setup.edit`, like the tills and tender types beside it: deciding what
 * tables exist is configuration, where USING them is selling. A waiter who may seat a
 * table has no business renaming the floor mid-service.
 *
 * Every mutation returns the whole fresh list, for the same reason the quick-key designer
 * does — the server decides sort order, so a client applying its own guess would drift
 * from what the till draws.
 */

export type TablesResult = { ok: true; tables: PosTable[] } | { ok: false; error: string }

/* ── The floor plan ──────────────────────────────────────────────────────── */

/**
 * Everything the designer draws, in one payload.
 *
 * Returned whole after every mutation, same as `TablesResult`: the server clamps
 * positions to the room and normalises rotation, so a client that trusted its own
 * numbers would drift from what the till renders — and the drift would be invisible
 * until a table appeared half off the edge on the floor screen.
 */
export type FloorResult =
  | { ok: true; rooms: FloorRoom[]; tables: PosTable[]; features: FloorFeature[] }
  | { ok: false; error: string }

async function floorState(siteId: number): Promise<FloorResult> {
  const [rooms, tables, features] = await Promise.all([
    listRooms(siteId),
    listTables(siteId),
    listFeatures(siteId),
  ])
  return { ok: true, rooms, tables, features }
}

export async function loadFloorAction(): Promise<FloorResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  return floorState(ctx.siteId)
}

export async function createRoomAction(input: {
  name: string
  width?: number
  height?: number
}): Promise<FloorResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await createRoom(ctx.siteId, input)
  if (!result.ok) return result

  revalidatePath('/setup/tables')
  return floorState(ctx.siteId)
}

export async function updateRoomAction(
  id: number,
  input: { name: string; width: number; height: number },
): Promise<FloorResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await updateRoom(ctx.siteId, id, input)
  if (!result.ok) return result

  revalidatePath('/setup/tables')
  return floorState(ctx.siteId)
}

/**
 * Retires a room. Its TABLES survive, unplaced.
 *
 * The FK is ON DELETE SET NULL for exactly this: a table may have a bill open on it, and
 * a manager reorganising rooms must not be able to destroy live documents by tidying the
 * plan. Unplaced tables fall back to the sectioned grid, so none of them vanish from the
 * waiter's screen either.
 */
export async function retireRoomAction(id: number): Promise<FloorResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await retireRoom(ctx.siteId, id)
  if (!result.ok) return result

  revalidatePath('/setup/tables')
  return floorState(ctx.siteId)
}

/**
 * Saves the whole arrangement.
 *
 * One call for every table the designer moved, because `savePlacements` writes them in a
 * single transaction — a floor plan that saved table by table could leave half a room
 * moved, and a waiter cannot tell which half.
 */
export async function savePlacementsAction(
  placements: PlacementInput[],
): Promise<FloorResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await savePlacements(ctx.siteId, placements)
  if (!result.ok) return result

  revalidatePath('/setup/tables')
  /* The TILL reads this too, and its page is cached — without this a waiter keeps
     seeing yesterday's arrangement until something else happens to revalidate. */
  revalidatePath('/pos')
  return floorState(ctx.siteId)
}

export async function saveFeatureAction(
  input: Omit<FloorFeature, 'id'> & { id?: number },
): Promise<FloorResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await saveFeature(ctx.siteId, input)
  if (!result.ok) return result

  revalidatePath('/setup/tables')
  revalidatePath('/pos')
  return floorState(ctx.siteId)
}

export async function deleteFeatureAction(id: number): Promise<FloorResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  await deleteFeature(ctx.siteId, id)
  revalidatePath('/setup/tables')
  revalidatePath('/pos')
  return floorState(ctx.siteId)
}

export async function createTableAction(input: TableInput): Promise<TablesResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await createTable(siteId, input)
  if (!result.ok) return result

  revalidatePath('/setup/tables')
  return { ok: true, tables: await listTables(siteId) }
}

export async function updateTableAction(id: number, input: TableInput): Promise<TablesResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await updateTable(siteId, id, input)
  if (!result.ok) return result

  revalidatePath('/setup/tables')
  return { ok: true, tables: await listTables(siteId) }
}

/**
 * Takes a table out of service.
 *
 * Deactivated rather than deleted — its past bills are finalised invoices that must keep
 * resolving. `deactivateTable` refuses while a bill is open, which is the case worth
 * refusing: retiring an occupied table would leave a bill nobody could reach.
 */
export async function retireTableAction(id: number): Promise<TablesResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await deactivateTable(siteId, id)
  if (!result.ok) return result

  revalidatePath('/setup/tables')
  return { ok: true, tables: await listTables(siteId) }
}

export type ModeResult = { ok: true; hospitality: boolean } | { ok: false; error: string }

/**
 * Switches the till between a counter and a floor.
 *
 * ── SAFE IN BOTH DIRECTIONS, AND THAT IS DELIBERATE ───────────────────────
 *
 * Turning hospitality OFF leaves the tables and their open bills exactly where they are —
 * the bills are ordinary saved sales, so they appear in Saved sales and can be paid from
 * the counter like any parked basket. Nothing is stranded and nothing needs migrating.
 *
 * Turning it ON with no tables is also fine: the gate shows "no tables set up" and the
 * walk-in key still works, so a shop can flip the switch and build its floor afterwards
 * rather than being made to do it in the right order.
 */
export async function setPosModeAction(hospitality: boolean): Promise<ModeResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await setSetting(siteId, 'pos_mode', hospitality ? 'hospitality' : 'retail')
  if (!result.ok) return { ok: false, error: result.error ?? 'That mode could not be saved.' }

  /* The till reads this from the offline catalog as well as from the page, so a running
     till picks the change up on its next refresh rather than needing a reload. */
  revalidatePath('/setup/tables')
  revalidatePath('/pos')
  return { ok: true, hospitality }
}

/*
 * There is deliberately no `currentPosMode(siteId)` here.
 *
 * Every export in a `'use server'` file is a PUBLIC ENDPOINT, so one taking a raw siteId
 * would let any caller read another shop's setting by passing its id — the site must come
 * from the session, never from an argument. The page reads `getSetting` directly, which is
 * server code and already knows whose site it is.
 */
