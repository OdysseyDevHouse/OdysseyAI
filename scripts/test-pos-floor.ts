/**
 * The floor plan: rooms, placements, and the furniture.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-pos-floor.ts
 *
 * Two properties carry this feature, and both are about NOT losing things:
 *
 *   1. A table is never destroyed by a change to the PLAN. Retiring a room unplaces its
 *      tables; taking a table off the plan leaves the table. A floor plan is a drawing of
 *      the restaurant, and a drawing must not be able to delete the furniture.
 *   2. An unplaced table still reaches the waiter, through the sectioned grid. That is
 *      what makes the whole feature optional and what makes a half-built plan safe.
 *
 * Everything else here is the clamping, which exists so a designer's rounding error
 * cannot put a table off the edge of a screen where nobody can tap it.
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  listRooms,
  listFeatures,
  createRoom,
  updateRoom,
  retireRoom,
  savePlacements,
  saveFeature,
  deleteFeature,
} from '../src/lib/site/posFloor'
import { listTables, seatTable } from '../src/lib/site/posTables'
import { saveDraft, saveForLaterDocument } from '../src/lib/site/salesDocuments'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const ACTOR = { userId: 1, userName: 'Floor test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stamp = Date.now().toString().slice(-8)

  /* Sweep an earlier crashed run. Rooms first would orphan nothing (the FK is SET NULL)
     but the unique name would collide, which is the litter lesson from test-offline-sync. */
  const oldRooms = await siteQuery<any>(SITE, "SELECT id FROM pos_floor_rooms WHERE name LIKE 'FLR%'")
  for (const r of oldRooms) {
    await siteExecute(SITE, 'UPDATE pos_tables SET room_id = NULL WHERE room_id = ?', [r.id])
    await siteExecute(SITE, 'DELETE FROM pos_floor_features WHERE room_id = ?', [r.id])
    await siteExecute(SITE, 'DELETE FROM pos_floor_rooms WHERE id = ?', [r.id])
  }
  const oldTables = await siteQuery<any>(SITE, "SELECT id, document_id FROM pos_tables WHERE code LIKE 'FLT%'")
  for (const t of oldTables) {
    await siteExecute(SITE, 'UPDATE pos_tables SET document_id = NULL WHERE id = ?', [t.id])
    if (t.document_id) {
      await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [t.document_id])
      await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [t.document_id])
    }
    await siteExecute(SITE, 'DELETE FROM pos_tables WHERE id = ?', [t.id])
  }
  if (oldRooms.length || oldTables.length) {
    console.log(`      (swept ${oldRooms.length} room(s), ${oldTables.length} table(s))`)
  }

  /* ── 1. Rooms ───────────────────────────────────────────────────────────── */

  const room = await createRoom(SITE, { name: `FLR Inside ${stamp}`, width: 100, height: 60 })
  ok('a room is created', room.ok === true, room.ok ? '' : room.error)
  if (!room.ok) throw new Error('cannot continue')

  const dupe = await createRoom(SITE, { name: `FLR Inside ${stamp}` })
  ok('a duplicate room name is refused', dupe.ok === false, dupe.ok ? '' : dupe.error)
  ok(
    '  and says so in words a manager can act on',
    !dupe.ok && /already a room/i.test(dupe.error),
    dupe.ok ? '' : dupe.error,
  )

  const tooSmall = await createRoom(SITE, { name: `FLR Tiny ${stamp}`, width: 2, height: 2 })
  /* A floor smaller than a table cannot hold one — this is about the canvas being usable
     rather than about what a room could physically be. */
  ok('a room smaller than 10 × 10 is refused', tooSmall.ok === false)

  const rooms = await listRooms(SITE)
  ok('the room lists', rooms.some((r) => r.id === room.id))
  ok('with its own extent', rooms.find((r) => r.id === room.id)?.width === 100)

  /* ── 2. Placing tables ─────────────────────────────────────────────────── */

  const t1 = await siteExecute(
    SITE,
    `INSERT INTO pos_tables (code, name, section, seats, sort_order, is_active) VALUES (?,?,?,4,1,1)`,
    [`FLT1${stamp}`.slice(0, 16), 'Floor test 1', 'Test'],
  )
  const t2 = await siteExecute(
    SITE,
    `INSERT INTO pos_tables (code, name, section, seats, sort_order, is_active) VALUES (?,?,?,2,2,1)`,
    [`FLT2${stamp}`.slice(0, 16), 'Floor test 2', 'Test'],
  )
  const tableA = t1.insertId
  const tableB = t2.insertId

  /* Fresh tables are UNPLACED, which is the state that makes the whole feature optional. */
  let tables = await listTables(SITE)
  ok('a new table starts unplaced', tables.find((t) => t.id === tableA)?.roomId === null)
  ok('  with a default size rather than null', tables.find((t) => t.id === tableA)?.width === 8)

  const placed = await savePlacements(SITE, [
    { tableId: tableA, roomId: room.id, x: 10, y: 20, width: 12, height: 8, rotation: 90, shape: 'round' },
    { tableId: tableB, roomId: room.id, x: 40, y: 30 },
  ])
  ok('the arrangement saves', placed.ok === true, placed.ok ? '' : placed.error)

  tables = await listTables(SITE)
  const a = tables.find((t) => t.id === tableA)!
  ok('the position is stored', a.x === 10 && a.y === 20, `${a.x},${a.y}`)
  ok('the size is stored', a.width === 12 && a.height === 8, `${a.width}×${a.height}`)
  ok('the rotation is stored', a.rotation === 90, String(a.rotation))
  ok('the shape is stored', a.shape === 'round', a.shape)

  /* ── 3. Clamping — the reason positions are not simply trusted ─────────── */

  await savePlacements(SITE, [
    /* A designer that snaps to the edge and computes 100.4 on a 100-wide room has made a
       rounding error, not a mistake worth discarding a whole layout for. */
    { tableId: tableB, roomId: room.id, x: 500, y: 500, width: 10, height: 10 },
  ])
  tables = await listTables(SITE)
  const b = tables.find((t) => t.id === tableB)!
  /* Clamped so the FAR EDGE stays inside the room, not just the origin: a table at x=98
     in a 100-wide room would otherwise hang off the canvas with only its left edge
     visible, which is a table nobody can tap. */
  ok(
    '*** an off-canvas position is clamped so the whole table stays visible ***',
    b.x === 90 && b.y === 50,
    `${b.x},${b.y} in a ${room.ok ? 100 : '?'}×60 room with a 10×10 table`,
  )

  await savePlacements(SITE, [{ tableId: tableB, roomId: room.id, x: 5, y: 5, rotation: 370 }])
  tables = await listTables(SITE)
  ok(
    'a rotation past a full turn normalises',
    tables.find((t) => t.id === tableB)?.rotation === 10,
    String(tables.find((t) => t.id === tableB)?.rotation),
  )

  await savePlacements(SITE, [{ tableId: tableB, roomId: room.id, x: -50, y: -50 }])
  tables = await listTables(SITE)
  ok(
    'a negative position clamps to the corner',
    tables.find((t) => t.id === tableB)?.x === 0,
    String(tables.find((t) => t.id === tableB)?.x),
  )

  const badRoom = await savePlacements(SITE, [{ tableId: tableA, roomId: 999_999_999, x: 1, y: 1 }])
  ok('a placement into a room that does not exist is refused', badRoom.ok === false)

  const notANumber = await savePlacements(SITE, [
    { tableId: tableA, roomId: room.id, x: Number.NaN, y: 1 },
  ])
  ok('a non-finite position is refused', notANumber.ok === false)

  /* ── 4. Features ───────────────────────────────────────────────────────── */

  const wall = await saveFeature(SITE, {
    roomId: room.id,
    kind: 'wall',
    label: '',
    x: 0,
    y: 0,
    width: 40,
    height: 2,
    rotation: 0,
  })
  ok('a wall is added', wall.ok === true, wall.ok ? '' : wall.error)

  const features = await listFeatures(SITE)
  ok('it lists for its room', features.some((f) => f.id === (wall.ok ? wall.id : 0)))

  const oversize = await saveFeature(SITE, {
    roomId: room.id,
    kind: 'bar',
    label: 'Bar',
    x: 90,
    y: 90,
    width: 400,
    height: 400,
    rotation: 0,
  })
  ok('an oversize feature is clamped rather than refused', oversize.ok === true)
  if (oversize.ok) {
    const clamped = (await listFeatures(SITE)).find((f) => f.id === oversize.id)!
    ok('  down to the room', clamped.width <= 100 && clamped.height <= 60, `${clamped.width}×${clamped.height}`)
  }

  /* ── 5. THE RULE: a plan cannot destroy the furniture ──────────────────── */

  /* A table with a LIVE BILL on it — the case that makes this matter. */
  const draft = await saveDraft(SITE, ACTOR, {
    docType: 'invoice',
    documentDate: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
    customerName: 'Floor test party',
    lines: [
      {
        productId: null,
        description: 'Something',
        qty: 1,
        unitPriceIncl: 50,
        vatRatePct: 15,
        unitCostExcl: 10,
      },
    ],
  } as never)
  if (!draft.ok) throw new Error(draft.error)
  await saveForLaterDocument(SITE, draft.id)
  await seatTable(SITE, tableA, draft.id)

  const retired = await retireRoom(SITE, room.id)
  ok('the room retires', retired.ok === true)

  tables = await listTables(SITE)
  const survivor = tables.find((t) => t.id === tableA)
  ok('*** the TABLE survives its room being removed ***', survivor !== undefined)
  ok('  unplaced, not deleted', survivor?.roomId === null && survivor?.x === null)
  /* The whole point. A manager tidying the floor plan must not be able to destroy a
     document with money on it through a foreign key. */
  ok(
    '*** and its OPEN BILL survives too ***',
    survivor?.documentId === draft.id,
    `documentId = ${survivor?.documentId}, expected ${draft.id}`,
  )
  const stillThere = await siteQueryOne<any>(
    SITE,
    'SELECT status, total_incl FROM sales_documents WHERE id = ?',
    [draft.id],
  )
  ok('  with its lines intact', stillThere?.status === 'saved' && toNum(stillThere?.total_incl) === 50)

  /* An unplaced table is exactly what the sectioned grid renders, which is what makes a
     half-built plan safe rather than a screen with tables missing from it. */
  ok(
    'an unplaced table still carries its section, so the grid can show it',
    survivor?.section === 'Test',
    survivor?.section ?? '',
  )

  /*
   * And the room's features went WITH it.
   *
   * This assertion used to expect them to survive, because retiring a room used
   * to flag it inactive. It deletes now, and that was a fix rather than a
   * preference: `uq_room_name` is a plain UNIQUE index that sees retired rows,
   * so an inactive room kept its name reserved forever while every screen
   * filtered it out — a manager who removed "Main" and tried to make a new one
   * was told the name was taken, next to a page saying there were no rooms. See
   * retireRoom for the full reasoning.
   *
   * A wall has no existence without its room, so `pos_floor_features` cascades
   * where `pos_tables.room_id` deliberately does not — a table is a physical
   * thing that may have a live bill on it.
   */
  const orphanFeatures = await siteQueryOne<any>(
    SITE,
    'SELECT COUNT(*) AS n FROM pos_floor_features WHERE room_id = ?',
    [room.id],
  )
  ok(
    '*** retiring a room takes its features with it ***',
    toNum(orphanFeatures?.n) === 0,
    String(orphanFeatures?.n),
  )
  ok(
    '  so none of them list any more',
    (await listFeatures(SITE)).every((f) => f.roomId !== room.id),
  )

  /* ── Clean up ───────────────────────────────────────────────────────────── */

  await siteExecute(SITE, 'UPDATE pos_tables SET document_id = NULL WHERE id IN (?,?)', [tableA, tableB])
  await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [draft.id])
  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [draft.id])
  await siteExecute(SITE, 'DELETE FROM pos_tables WHERE id IN (?,?)', [tableA, tableB])
  await siteExecute(SITE, 'DELETE FROM pos_floor_features WHERE room_id = ?', [room.id])
  await siteExecute(SITE, 'DELETE FROM pos_floor_rooms WHERE id = ?', [room.id])

  console.log(fails === 0 ? '\nAll floor plan checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
