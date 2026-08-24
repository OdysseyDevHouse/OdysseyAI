import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute, siteTransaction } from '../siteDb'
import { listDepartments, ancestors, type Department } from './departments'
import type { PosMenu, PosMenuItem } from '../posMenuEngine'

/**
 * Reading and writing the till's rotating menus.
 *
 * The window arithmetic lives in lib/posMenuEngine.ts, which is pure — this
 * module only loads rows and validates what a screen sends. Keeping them
 * apart is what lets the till (offline, in the browser), the back office and
 * the tests all agree about which menu is showing.
 */

type Row = RowDataPacket & Record<string, unknown>

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }
export type ActionResult = { ok: true } | { ok: false; error: string }

/** Long enough to name a service, short enough to fit the till's menu chip. */
const NAME_MAX = 80

function mapMenu(r: Row, items: PosMenuItem[], terminalIds: number[]): PosMenu {
  return {
    id: Number(r.id),
    name: String(r.name ?? ''),
    isActive: !!r.is_active,
    // Already the wall-clock text somebody typed — see 231's note on why
    // these are not TIME columns.
    dailyStart: String(r.daily_start ?? ''),
    dailyEnd: String(r.daily_end ?? ''),
    daysOfWeek: String(r.days_of_week ?? '1111111'),
    priority: Number(r.priority ?? 0),
    items,
    terminalIds,
  }
}

function mapItem(r: Row): PosMenuItem {
  return {
    // Coerced rather than trusted: one row written by a future version must
    // not take down every till that reads it.
    effect: String(r.effect) === 'exclude' ? 'exclude' : 'include',
    productId: r.product_id === null || r.product_id === undefined ? null : Number(r.product_id),
    departmentId:
      r.department_id === null || r.department_id === undefined ? null : Number(r.department_id),
  }
}

/**
 * Every menu with its scope, in priority order.
 *
 * Two queries rather than a join: a menu naming six departments would repeat
 * its own row six times, and the mapper would have to de-duplicate what the
 * join multiplied.
 */
export async function listPosMenus(siteId: number): Promise<PosMenu[]> {
  const menus = await siteQuery<Row>(
    siteId,
    `SELECT id, name, is_active, daily_start, daily_end, days_of_week, priority
       FROM pos_menus
      ORDER BY priority ASC, id ASC`,
  )
  if (menus.length === 0) return []

  const items = await siteQuery<Row>(
    siteId,
    `SELECT menu_id, effect, product_id, department_id
       FROM pos_menu_items
      WHERE menu_id IN (${menus.map(() => '?').join(',')})`,
    menus.map((m) => Number(m.id)),
  )

  const byMenu = new Map<number, PosMenuItem[]>()
  for (const row of items) {
    const id = Number(row.menu_id)
    const list = byMenu.get(id)
    if (list) list.push(mapItem(row))
    else byMenu.set(id, [mapItem(row)])
  }

  /* Which tills each menu is pinned to (232). A third query for the same
     reason there is a second: a join would repeat the menu row once per till
     and once per scope row, multiplying into a cross product the mapper would
     have to undo. */
  const pins = await siteQuery<Row>(
    siteId,
    `SELECT menu_id, terminal_id
       FROM pos_menu_terminals
      WHERE menu_id IN (${menus.map(() => '?').join(',')})`,
    menus.map((m) => Number(m.id)),
  )

  const tillsByMenu = new Map<number, number[]>()
  for (const row of pins) {
    const id = Number(row.menu_id)
    const list = tillsByMenu.get(id)
    if (list) list.push(Number(row.terminal_id))
    else tillsByMenu.set(id, [Number(row.terminal_id)])
  }

  return menus.map((m) =>
    mapMenu(m, byMenu.get(Number(m.id)) ?? [], tillsByMenu.get(Number(m.id)) ?? []),
  )
}

/**
 * The menus worth sending to a till.
 *
 * Filtered only on the owner's switch. The daily band and the day mask are
 * deliberately NOT applied here — they are evaluated against the clock at the
 * moment the grid is drawn, so a till that cached its catalogue at ten to
 * eleven still switches to lunch at eleven, and a till that has been offline
 * since yesterday still switches at all.
 *
 * This mirrors `liveSpecials` (specials.ts:167) exactly, and for the same
 * reason. If it ever starts filtering by time, the switchover silently
 * becomes "within fifteen minutes, on each till separately".
 */
export async function livePosMenus(siteId: number): Promise<PosMenu[]> {
  const all = await listPosMenus(siteId)
  return all.filter((m) => m.isActive)
}

export async function getPosMenu(siteId: number, id: number): Promise<PosMenu | null> {
  const menus = await listPosMenus(siteId)
  return menus.find((m) => m.id === id) ?? null
}

/**
 * A lookup from a department to itself plus every ancestor above it.
 *
 * Built ONCE per render and handed to the engine, rather than walking the
 * tree per product: a grid of four hundred tiles would otherwise climb the
 * department hierarchy four hundred times to answer the same handful of
 * questions.
 *
 * A department naming "Drinks" must catch a coffee filed under Drinks → Hot,
 * so the path runs upward — the product's own department is the deepest node
 * and every parent above it also claims the product.
 *
 * `ancestors()` ALREADY INCLUDES the department itself (departments.ts:102 —
 * it unshifts `current` before climbing), so this is the whole chain and
 * prepending the id again would only duplicate it.
 */
export function departmentPaths(all: Department[]): (departmentId: number | null) => number[] {
  const cache = new Map<number, number[]>()
  return (departmentId: number | null): number[] => {
    if (departmentId === null) return []
    const hit = cache.get(departmentId)
    if (hit) return hit
    const path = ancestors(all, departmentId).map((d) => d.id)
    cache.set(departmentId, path)
    return path
  }
}

/** The same lookup, loading the department tree itself. */
export async function departmentPathsFor(
  siteId: number,
): Promise<(departmentId: number | null) => number[]> {
  return departmentPaths(await listDepartments(siteId))
}

/* ── Writing ──────────────────────────────────────────────────────────────── */

export type PosMenuInput = {
  name: string
  isActive: boolean
  dailyStart: string
  dailyEnd: string
  daysOfWeek: string
  priority: number
}

export type PosMenuItemInput = {
  effect: 'include' | 'exclude'
  productId: number | null
  departmentId: number | null
}

const TIME_RE = /^\d{1,2}:\d{2}$/

function validTime(value: string): boolean {
  const m = TIME_RE.exec(value)
  if (!m) return false
  const [h, min] = value.split(':').map(Number)
  return h <= 23 && min <= 59
}

/**
 * What the editor refuses to save.
 *
 * Returns the message, or null when the input is sound — the shape every
 * validator in this codebase uses.
 */
export function validatePosMenu(input: PosMenuInput): string | null {
  const name = input.name.trim()
  if (!name) return 'Give the menu a name.'
  if (name.length > NAME_MAX) return `Keep the name under ${NAME_MAX} characters.`

  const from = input.dailyStart.trim()
  const to = input.dailyEnd.trim()
  /*
   * Both or neither, and this is the one rule worth refusing over. A start
   * with no end is a menu that begins and never gives way — so a shop that
   * typed a breakfast start and got distracted would find lunch never
   * arrived, with nothing on screen to explain why. Guessing the missing end
   * would invent a window nobody asked for.
   */
  if (!!from !== !!to) return 'Give the menu both a start and an end time, or neither for all day.'
  if (from && !validTime(from)) return 'Start time must be HH:MM.'
  if (to && !validTime(to)) return 'End time must be HH:MM.'
  /*
   * Equal ends are refused because they are ambiguous rather than wrong:
   * 09:00–09:00 could mean "one instant" or "the whole day round", and the
   * shop meant one of them. Unequal ends that run backwards are NOT refused —
   * that is the overnight band, and it is deliberate.
   */
  if (from && to && from === to) return 'Start and end cannot be the same time.'

  if (!/^[01]{7}$/.test(input.daysOfWeek)) return 'Pick which days this menu runs.'
  if (!input.daysOfWeek.includes('1')) return 'A menu must run on at least one day.'

  return null
}

export async function createPosMenu(
  siteId: number,
  input: PosMenuInput,
  by: string,
): Promise<SaveResult> {
  const error = validatePosMenu(input)
  if (error) return { ok: false, error }

  const res = await siteExecute(
    siteId,
    `INSERT INTO pos_menus
       (name, is_active, daily_start, daily_end, days_of_week, priority, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.name.trim(),
      input.isActive ? 1 : 0,
      input.dailyStart.trim(),
      input.dailyEnd.trim(),
      input.daysOfWeek,
      input.priority,
      by,
      by,
    ],
  )
  return { ok: true, id: Number(res.insertId) }
}

export async function updatePosMenu(
  siteId: number,
  id: number,
  input: PosMenuInput,
  by: string,
): Promise<SaveResult> {
  const error = validatePosMenu(input)
  if (error) return { ok: false, error }

  await siteExecute(
    siteId,
    `UPDATE pos_menus
        SET name = ?, is_active = ?, daily_start = ?, daily_end = ?,
            days_of_week = ?, priority = ?, updated_by = ?
      WHERE id = ?`,
    [
      input.name.trim(),
      input.isActive ? 1 : 0,
      input.dailyStart.trim(),
      input.dailyEnd.trim(),
      input.daysOfWeek,
      input.priority,
      by,
      id,
    ],
  )
  return { ok: true, id }
}

/**
 * Replace a menu's whole scope in one transaction.
 *
 * Delete-then-insert rather than a diff: the editor sends the list it means,
 * and reconciling two lists to save three UPDATEs would be more code and one
 * more way to leave the stored scope disagreeing with the screen.
 *
 * ⚠ This writes the WHOLE scope. A caller that sends a partial list silently
 * deletes the rest — see the note on partial saves in the products form.
 */
export async function savePosMenuItems(
  siteId: number,
  menuId: number,
  items: PosMenuItemInput[],
): Promise<ActionResult> {
  /*
   * Deduped here, in code, because the unique key CANNOT do it: exactly one
   * of product_id/department_id is ever set, and MySQL treats NULLs as
   * distinct in a unique index — so (7, NULL) and (7, NULL) are two rows as
   * far as uq_menu_target is concerned. 231's docblock says so; this is the
   * only writer, which is what makes that safe.
   */
  const seen = new Set<string>()
  const clean: PosMenuItemInput[] = []
  for (const item of items) {
    // A row targeting neither, or both, is not a statement about anything.
    if ((item.productId === null) === (item.departmentId === null)) continue
    const key = `${item.productId ?? 'd' + item.departmentId}`
    if (seen.has(key)) continue
    seen.add(key)
    clean.push(item)
  }

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(`DELETE FROM pos_menu_items WHERE menu_id = ?`, [menuId])
    if (clean.length === 0) return
    await tx.execute(
      `INSERT INTO pos_menu_items (menu_id, effect, product_id, department_id)
       VALUES ${clean.map(() => '(?, ?, ?, ?)').join(', ')}`,
      clean.flatMap((i) => [menuId, i.effect, i.productId, i.departmentId]),
    )
  })

  return { ok: true }
}

/**
 * Replace which tills a menu runs on. Empty means EVERY till (232).
 *
 * Delete-then-insert, exactly as `savePosMenuItems` does and for the same
 * reason: the editor sends the list it means, and diffing two lists to save a
 * couple of statements is more code and one more way to leave the stored
 * pinning disagreeing with the screen.
 */
export async function savePosMenuTerminals(
  siteId: number,
  menuId: number,
  terminalIds: number[],
): Promise<ActionResult> {
  // Deduped and coerced: the unique key would refuse a repeat with an error
  // the screen cannot act on, and a bad id from a stale screen must not abort
  // the whole save.
  const clean = [...new Set(terminalIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))]

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(`DELETE FROM pos_menu_terminals WHERE menu_id = ?`, [menuId])
    if (clean.length === 0) return
    await tx.execute(
      `INSERT INTO pos_menu_terminals (menu_id, terminal_id)
       VALUES ${clean.map(() => '(?, ?)').join(', ')}`,
      clean.flatMap((id) => [menuId, id]),
    )
  })

  return { ok: true }
}

export async function deletePosMenu(siteId: number, id: number): Promise<ActionResult> {
  // The scope goes with it, by the CASCADE on fk_pos_menu_item_menu.
  await siteExecute(siteId, `DELETE FROM pos_menus WHERE id = ?`, [id])
  return { ok: true }
}
