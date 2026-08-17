'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { setSetting, getSetting } from '@/lib/site/settings'
import {
  listTables,
  createTable,
  updateTable,
  deactivateTable,
  type PosTable,
  type TableInput,
} from '@/lib/site/posTables'
import {
  listVisitTypes,
  createVisitType,
  updateVisitType,
  deleteVisitType,
  type VisitType,
} from '@/lib/site/visitTypes'
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

/**
 * Adds a table from the FLOOR DESIGNER, and hands back the whole floor.
 *
 * Deliberately separate from `createTableAction` rather than a flag on it. The two
 * differ only in what they RETURN, and that difference is the whole point: the list
 * screen holds tables, the designer holds rooms + tables + features, and a designer that
 * adopted a bare `{ tables }` would blank its own rooms the moment somebody added a
 * table. Same `createTable` underneath, so the code clash and the sort_order rule are
 * answered in one place.
 */
export async function createTableOnFloorAction(input: TableInput): Promise<FloorResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await createTable(ctx.siteId, input)
  if (!result.ok) return result

  revalidatePath('/setup/tables')
  /* The till too, unlike an unplaced table added from the list: this one arrives WITH a
     position, so the floor view has something new to draw and would otherwise keep
     showing yesterday's room until something else revalidated it. */
  revalidatePath('/pos')
  return floorState(ctx.siteId)
}

/**
 * Copies tables, offset a little so the copies are visible.
 *
 * ── WHY THE SERVER PICKS THE NAMES ────────────────────────────────────────
 *
 * A code is UNIQUE and it is what a waiter types, so the suffix search has to happen
 * where the uniqueness is enforced. A client guessing "12 (2)" races every other till
 * and every other tab: two managers duplicating at once would both compute the same
 * free name and the second would simply fail. Here the whole loop runs inside one
 * request against live rows.
 *
 * Partial success is REPORTED, not rolled back. Duplicating eight tables and having the
 * seventh clash should leave six copies and say so — undoing the six a manager can see
 * on their screen is the more surprising outcome.
 */
export async function duplicateTablesAction(
  ids: number[],
): Promise<FloorResult & { made?: number }> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  if (ids.length === 0) return { ok: false, error: 'Nothing was selected to copy.' }
  if (ids.length > 50) return { ok: false, error: 'Copy 50 tables at a time or fewer.' }

  const all = await listTables(siteId)
  const taken = new Set(all.map((t) => t.code.trim().toLowerCase()))

  /** The next free "<code> (n)", skipping any that already exist. */
  const nextCode = (base: string): string | null => {
    const stem = base.replace(/\s*\(\d+\)$/, '')
    for (let n = 2; n < 100; n++) {
      const candidate = `${stem} (${n})`
      /* 16 chars is the column, and a name that cannot be stored is not a name. */
      if (candidate.length > 16) return null
      if (!taken.has(candidate.toLowerCase())) {
        taken.add(candidate.toLowerCase())
        return candidate
      }
    }
    return null
  }

  let made = 0
  for (const id of ids) {
    const source = all.find((t) => t.id === id)
    if (!source || source.roomId === null || source.x === null || source.y === null) continue

    const code = nextCode(source.code)
    if (!code) continue

    const result = await createTable(siteId, {
      code,
      name: source.name,
      section: source.section,
      seats: source.seats,
      visitTypeId: source.visitTypeId,
      placement: {
        roomId: source.roomId,
        /* Offset so the copy is visibly a second table rather than hidden exactly
           beneath the original. savePlacements clamps it back inside the room. */
        x: source.x + 3,
        y: source.y + 3,
        width: source.width,
        height: source.height,
        shape: source.shape,
      },
    })
    if (result.ok) made++
  }

  if (made === 0) {
    return { ok: false, error: 'Those tables could not be copied — the codes are taken.' }
  }

  revalidatePath('/setup/tables')
  revalidatePath('/pos')
  return { ...(await floorState(siteId)), made }
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

  /*
   * "Off" means RETAIL — unless this shop is running the trade counter, in which
   * case off means staying there.
   *
   * This switch is a two-way toggle on the tables screen, and it predates there
   * being a third mode. Written naively it would answer a question nobody asked:
   * a paint shop that never touches this screen would still have its till turned
   * into a supermarket the first time somebody opened Setup → Tables and saved.
   *
   * So the OFF branch reads what is there and only changes it if it is about to
   * change something this screen owns.
   */
  const current = await getSetting(siteId, 'pos_mode')
  const next = hospitality ? 'hospitality' : current === 'invoicing' ? 'invoicing' : 'retail'

  const result = await setSetting(siteId, 'pos_mode', next)
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

/* ── Visit types ─────────────────────────────────────────────────────────── */

/**
 * Every mutation returns the whole fresh list, like the table actions above.
 *
 * The server owns sort order and the "exactly one default" rule, so a client applying
 * its own guess would drift from what the till reads — and the default in particular
 * changes a row the caller did not touch, which no optimistic update can predict.
 */
export type VisitTypesResult =
  | { ok: true; types: VisitType[]; outcome?: 'deleted' | 'hidden' }
  | { ok: false; error: string }

export async function createVisitTypeAction(input: {
  name: string
}): Promise<VisitTypesResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  try {
    await createVisitType(siteId, input)
  } catch (e) {
    /* The module raises a sentence a manager can act on — a duplicate name is the one
       failure a setup screen actually hits, and "ER_DUP_ENTRY" in a toast is not an
       answer to anything. */
    return { ok: false, error: e instanceof Error ? e.message : 'That could not be saved.' }
  }

  revalidatePath('/setup/tables')
  revalidatePath('/pos')
  return { ok: true, types: await listVisitTypes(siteId) }
}

export async function updateVisitTypeAction(
  id: number,
  patch: { name?: string; isDefault?: boolean; isActive?: boolean },
): Promise<VisitTypesResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  try {
    await updateVisitType(siteId, id, patch)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'That could not be saved.' }
  }

  revalidatePath('/setup/tables')
  revalidatePath('/pos')
  return { ok: true, types: await listVisitTypes(siteId) }
}

/**
 * Remove a type — or hide it, when a table still names it.
 *
 * The outcome travels back so the screen can say which happened. A manager who meant
 * "stop offering this" and is silently given "and re-filed the eleven tables using it"
 * has been surprised by their own click.
 */
export async function deleteVisitTypeAction(id: number): Promise<VisitTypesResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  try {
    const outcome = await deleteVisitType(siteId, id)
    revalidatePath('/setup/tables')
    revalidatePath('/pos')
    return { ok: true, types: await listVisitTypes(siteId), outcome }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'That could not be removed.' }
  }
}
