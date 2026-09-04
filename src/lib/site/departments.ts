import 'server-only'
import { isStorableSwatch } from '@/components/ui/tiles'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'

/**
 * Departments are an arbitrary-depth tree (`parent_id` self-reference) rather
 * than fixed Major/Sub1/Sub2 columns, so adding a level is data, not a schema
 * change. A product points at the DEEPEST department chosen; its ancestors are
 * implied by walking up.
 */

export type Department = {
  id: number
  parentId: number | null
  name: string
  code: string | null
  color: string | null
  sortOrder: number
  isActive: boolean
  /**
   * The picture the TILL shows on its department tiles, as an id into
   * `storefront_images` — null for the colour-and-initial tile it draws today.
   */
  posImageId: number | null
  /**
   * The picture the SHOP shows. A different image from the one above on
   * purpose: see 064_department_images.sql on why one column would have forced
   * the owner to pick which of the two to be bad at.
   */
  onlineImageId: number | null
  /** Products pointing directly at this department, not at its descendants. */
  productCount: number
  childCount: number
}

type Row = RowDataPacket & Record<string, unknown>

function mapDepartment(r: Row): Department {
  return {
    id: Number(r.id),
    parentId: r.parent_id === null ? null : Number(r.parent_id),
    name: String(r.name),
    code: (r.code as string | null) ?? null,
    color: (r.color as string | null) ?? null,
    sortOrder: Number(r.sort_order),
    isActive: !!r.is_active,
    posImageId: imageId(r.pos_image_id),
    onlineImageId: imageId(r.online_image_id),
    productCount: Number(r.product_count ?? 0),
    childCount: Number(r.child_count ?? 0),
  }
}

/**
 * An image id, or null for anything that is not one.
 *
 * 0 and NaN both become null rather than being kept: a 0 would be a reference
 * to a picture that cannot exist, and every reader treats null as "no picture,
 * draw the colour and letter" — which is the right answer for junk too.
 */
function imageId(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

const SELECT_DEPARTMENT = `
  SELECT d.id, d.parent_id, d.name, d.code, d.color, d.sort_order, d.is_active,
         d.pos_image_id, d.online_image_id,
         (SELECT COUNT(*) FROM products p    WHERE p.department_id = d.id) AS product_count,
         (SELECT COUNT(*) FROM departments c WHERE c.parent_id     = d.id) AS child_count
    FROM departments d
`

export async function listDepartments(
  siteId: number,
  includeInactive = false,
): Promise<Department[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_DEPARTMENT}
      ${includeInactive ? '' : 'WHERE d.is_active = 1'}
      ORDER BY d.sort_order ASC, d.name ASC`,
  )
  return rows.map(mapDepartment)
}

export async function getDepartment(siteId: number, id: number): Promise<Department | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_DEPARTMENT} WHERE d.id = ? LIMIT 1`, [id])
  return row ? mapDepartment(row) : null
}

// ── Tree helpers (pure, operate on an already-loaded flat list) ──────────

export function childrenOf(all: Department[], parentId: number | null): Department[] {
  return all.filter((d) => d.parentId === parentId)
}

/**
 * The chain from root down to `id`, inclusive. Guarded against a cycle so one
 * mis-parented row cannot hang a request.
 */
export function ancestors(all: Department[], id: number | null): Department[] {
  if (id === null) return []
  const byId = new Map(all.map((d) => [d.id, d]))
  const chain: Department[] = []
  const seen = new Set<number>()

  let current = byId.get(id)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    chain.unshift(current)
    current = current.parentId === null ? undefined : byId.get(current.parentId)
  }
  return chain
}

/** "Fresh Produce › Fruit › Citrus" */
export function departmentPath(all: Department[], id: number | null): string {
  return ancestors(all, id)
    .map((d) => d.name)
    .join(' › ')
}

/** `id` and everything beneath it. Used to stop a move creating a cycle. */
export function descendantIds(all: Department[], id: number): Set<number> {
  const out = new Set<number>([id])
  const queue = [id]
  while (queue.length) {
    const current = queue.shift()!
    for (const child of all) {
      if (child.parentId === current && !out.has(child.id)) {
        out.add(child.id)
        queue.push(child.id)
      }
    }
  }
  return out
}

/** Depth-first order with a depth marker, for rendering an indented tree. */
export function flattenTree(
  all: Department[],
  parentId: number | null = null,
  depth = 0,
): { department: Department; depth: number }[] {
  return childrenOf(all, parentId).flatMap((d) => [
    { department: d, depth },
    ...flattenTree(all, d.id, depth + 1),
  ])
}

// ── Codes ───────────────────────────────────────────────────────────────

/**
 * The next free code for a department sitting under `parentId`.
 *
 * The code is a reporting reference, not a name, and shops do not want to
 * invent one — left to a person it gets typed once, skipped twice, and the
 * report that groups by it silently splits. So the app allocates it and the
 * form no longer asks.
 *
 * The scheme is the one the data already uses: a top-level department gets the
 * next free integer, and a child gets its parent's code plus `.n`. That makes
 * the code say where the department sits, which is exactly what a report
 * sorting on it wants.
 *
 * Only NUMERIC siblings count toward the next number. A hand-typed code like
 * "RBI" is left alone rather than renumbered — it was someone's deliberate
 * choice, and the whole point of allocating from the free numbers is that it
 * never has to argue with one. Gaps are not filled either: `MAX + 1` keeps a
 * code stable once printed on a shelf label or a report, where reusing 30
 * because its department was deleted would quietly merge two years of history.
 */
export async function nextDepartmentCode(
  siteId: number,
  parentId: number | null,
): Promise<string> {
  const parent = parentId === null ? null : await getDepartment(siteId, parentId)

  // A parent with no code of its own has no stem to extend, so its children
  // number from the top-level sequence rather than inheriting an empty prefix
  // and colliding with the roots.
  const stem = parent?.code?.trim() || null

  const siblings = await siteQuery<Row>(
    siteId,
    `SELECT code FROM departments
      WHERE ${parentId === null ? 'parent_id IS NULL' : 'parent_id = ?'}
        AND code IS NOT NULL`,
    parentId === null ? [] : [parentId],
  )

  let highest = 0
  for (const row of siblings) {
    const code = String(row.code ?? '').trim()
    // A child's own number is the last segment; the stem is its parent's and
    // is the same for every sibling, so comparing whole codes would sort
    // "18.10" below "18.9".
    const tail = stem === null ? code : code.startsWith(`${stem}.`) ? code.slice(stem.length + 1) : ''
    if (!/^\d+$/.test(tail)) continue
    highest = Math.max(highest, Number(tail))
  }

  const next = `${stem === null ? '' : `${stem}.`}${highest + 1}`

  /* The column is 32 characters, and a code that cannot be stored is worse
     than none: it would fail the save of a department whose name was fine.
     Deep enough nesting genuinely runs out of room, so it gives up instead. */
  return next.length > 32 ? '' : next
}

// ── Writes ──────────────────────────────────────────────────────────────

export type DepartmentInput = {
  name: string
  parentId?: number | null
  code?: string | null
  color?: string | null
  sortOrder?: number
  isActive?: boolean
  posImageId?: number | null
  onlineImageId?: number | null
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

export function validateDepartment(input: DepartmentInput): string | null {
  if (!input.name?.trim()) return 'A department name is required.'
  if (input.name.trim().length > 120) return 'Name must be 120 characters or fewer.'
  if (input.code && input.code.trim().length > 32) return 'Code must be 32 characters or fewer.'
  /* Asked of the palette rather than of a pattern typed here. This rule used
     to demand '#RRGGBB' and so rejected every swatch the picker can actually
     produce — the form said "Colour must be a hex value like #2f6fed." about a
     value no screen in the app offers. See isStorableSwatch. */
  if (input.color && !isStorableSwatch(input.color)) {
    return 'That is not a colour this app can store.'
  }
  return null
}

/** Two departments under the same parent with the same name would be unusable. */
async function nameClash(
  siteId: number,
  parentId: number | null,
  name: string,
  excludeId?: number,
): Promise<boolean> {
  // parent_id IS NULL needs an IS comparison — `= NULL` is never true.
  const row = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    `SELECT id FROM departments
      WHERE name = ?
        AND ${parentId === null ? 'parent_id IS NULL' : 'parent_id = ?'}
        ${excludeId ? 'AND id <> ?' : ''}
      LIMIT 1`,
    [name, ...(parentId === null ? [] : [parentId]), ...(excludeId ? [excludeId] : [])],
  )
  return row !== null
}

export async function createDepartment(
  siteId: number,
  input: DepartmentInput,
): Promise<SaveResult> {
  const invalid = validateDepartment(input)
  if (invalid) return { ok: false, error: invalid }

  const name = input.name.trim()
  const parentId = input.parentId ?? null

  if (parentId !== null && !(await getDepartment(siteId, parentId))) {
    return { ok: false, error: 'That parent department no longer exists.' }
  }
  if (await nameClash(siteId, parentId, name)) {
    return { ok: false, error: `"${name}" already exists at this level.` }
  }

  /* No caller types a code any more, so an unset one is allocated rather than
     stored as null — a department with no code drops out of every report that
     groups by it. An explicit code is still honoured, for the importer and for
     anything restoring a row that already had one. */
  const code = input.code?.trim() || (await nextDepartmentCode(siteId, parentId))

  const res = await siteExecute(
    siteId,
    `INSERT INTO departments
       (parent_id, name, code, color, sort_order, is_active, pos_image_id, online_image_id)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      parentId,
      name,
      code || null,
      input.color?.trim() || null,
      input.sortOrder ?? 0,
      input.isActive === false ? 0 : 1,
      imageId(input.posImageId),
      imageId(input.onlineImageId),
    ],
  )
  return { ok: true, id: res.insertId }
}

export async function updateDepartment(
  siteId: number,
  id: number,
  input: DepartmentInput,
): Promise<SaveResult> {
  const invalid = validateDepartment(input)
  if (invalid) return { ok: false, error: invalid }

  const existing = await getDepartment(siteId, id)
  if (!existing) return { ok: false, error: 'Department not found.' }

  const name = input.name.trim()
  const parentId = input.parentId ?? null

  if (parentId !== null) {
    // Re-parenting under itself or one of its own descendants would detach the
    // branch from the tree entirely — the rows would still exist but nothing
    // could reach them, and ancestor walks would loop.
    const all = await listDepartments(siteId, true)
    if (descendantIds(all, id).has(parentId)) {
      return { ok: false, error: 'A department cannot be moved inside itself.' }
    }
    if (!all.some((d) => d.id === parentId)) {
      return { ok: false, error: 'That parent department no longer exists.' }
    }
  }

  if (await nameClash(siteId, parentId, name, id)) {
    return { ok: false, error: `"${name}" already exists at this level.` }
  }

  /*
   * An absent code means "leave it alone", not "clear it".
   *
   * The edit form stopped asking for a code once it was allocated
   * automatically, so it posts none — and reading that as null would wipe the
   * code off every department the moment someone renamed one. `undefined` is
   * the only way a caller now says "no opinion"; an empty string still clears,
   * which is what an importer sending a blank column means.
   *
   * A department that has never had one is given a code here rather than left
   * without, so the rows predating this fill themselves in as they are edited.
   */
  const code =
    input.code === undefined
      ? existing.code || (await nextDepartmentCode(siteId, parentId))
      : input.code?.trim() || null

  await siteExecute(
    siteId,
    `UPDATE departments
        SET parent_id = ?, name = ?, code = ?, color = ?, sort_order = ?, is_active = ?,
            pos_image_id = ?, online_image_id = ?
      WHERE id = ?`,
    [
      parentId,
      name,
      code || null,
      input.color?.trim() || null,
      input.sortOrder ?? 0,
      input.isActive === false ? 0 : 1,
      imageId(input.posImageId),
      imageId(input.onlineImageId),
      id,
    ],
  )
  return { ok: true, id }
}

/**
 * A narrow update for the inline controls on the list — the colour swatch and
 * the active switch.
 *
 * Deliberately NOT `updateDepartment` with a partial input: that helper reads
 * every field off the form and would rewrite `parent_id`, `code` and
 * `sort_order` from whatever the caller happened to pass. Flipping a switch
 * must not be able to re-parent a branch, so this touches only the named
 * column and leaves the rest of the row alone.
 */
export async function patchDepartment(
  siteId: number,
  id: number,
  patch: { color?: string | null; isActive?: boolean },
): Promise<SaveResult> {
  const existing = await getDepartment(siteId, id)
  if (!existing) return { ok: false, error: 'Department not found.' }

  const sets: string[] = []
  const params: (string | number | null)[] = []

  if ('color' in patch) {
    const color = patch.color?.trim() || null
    /* The list stores a swatch TOKEN, and rows written before the palette
       became tokens still hold a hex string, so both go through.
       This used to name 'tile-1…tile-7' in a literal pattern, written when
       that WAS the palette. The palette then moved to 'cat-*' and this went
       stale in silence — the inline colour control on the list refused all
       twenty swatches. It now asks the palette, which cannot go out of date. */
    if (color && !isStorableSwatch(color)) {
      return { ok: false, error: 'That is not a colour this app can store.' }
    }
    sets.push('color = ?')
    params.push(color)
  }

  if ('isActive' in patch) {
    sets.push('is_active = ?')
    params.push(patch.isActive ? 1 : 0)
  }

  if (sets.length === 0) return { ok: true, id }

  await siteExecute(siteId, `UPDATE departments SET ${sets.join(', ')} WHERE id = ?`, [
    ...params,
    id,
  ])
  return { ok: true, id }
}

export type ReorderResult = { ok: true } | { ok: false; error: string }

/**
 * Rewrites `sort_order` across one set of SIBLINGS, in the order given.
 *
 * Reordering is sibling-only by design: dragging a row onto a different parent
 * would be a move, which has cycle rules of its own (see updateDepartment) and
 * is a different gesture. Rows are verified to share `ids`' parent before
 * anything is written, so a tampered payload cannot silently re-parent a
 * branch or renumber a department on another site.
 */
export async function reorderDepartments(
  siteId: number,
  orderedIds: number[],
): Promise<ReorderResult> {
  if (orderedIds.length === 0) return { ok: true }
  if (new Set(orderedIds).size !== orderedIds.length) {
    return { ok: false, error: 'That order lists the same department twice.' }
  }

  const all = await listDepartments(siteId, true)
  const byId = new Map(all.map((d) => [d.id, d]))

  const rows = orderedIds.map((id) => byId.get(id))
  if (rows.some((r) => r === undefined)) {
    return { ok: false, error: 'One of those departments no longer exists.' }
  }

  // Every row must share one parent, or this is a move dressed up as a sort.
  const parents = new Set(rows.map((r) => r!.parentId))
  if (parents.size > 1) {
    return { ok: false, error: 'Only departments under the same parent can be reordered.' }
  }

  // Positions are rewritten 1..n rather than patched, so a list that had
  // duplicate or missing sort_order values comes out consistent.
  for (const [index, id] of orderedIds.entries()) {
    await siteExecute(siteId, 'UPDATE departments SET sort_order = ? WHERE id = ?', [
      index + 1,
      id,
    ])
  }
  return { ok: true }
}

export type DeleteResult = { ok: true } | { ok: false; error: string }

/**
 * Deletes a department, but only when nothing depends on it.
 *
 * The schema would otherwise allow a silent surprise: `products.department_id`
 * is ON DELETE SET NULL, so deleting a department in use would quietly
 * unassign every product on it. Refusing is better than a change nobody asked
 * for and nobody sees.
 */
export async function deleteDepartment(siteId: number, id: number): Promise<DeleteResult> {
  const department = await getDepartment(siteId, id)
  if (!department) return { ok: false, error: 'Department not found.' }

  if (department.childCount > 0) {
    return {
      ok: false,
      error: `"${department.name}" has ${department.childCount} sub-department${
        department.childCount === 1 ? '' : 's'
      }. Remove or move those first.`,
    }
  }
  if (department.productCount > 0) {
    return {
      ok: false,
      error: `${department.productCount} product${
        department.productCount === 1 ? ' is' : 's are'
      } still assigned to "${department.name}". Reassign ${
        department.productCount === 1 ? 'it' : 'them'
      } first, or deactivate this department instead.`,
    }
  }

  await siteExecute(siteId, 'DELETE FROM departments WHERE id = ?', [id])
  return { ok: true }
}
