import 'server-only'
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
    productCount: Number(r.product_count ?? 0),
    childCount: Number(r.child_count ?? 0),
  }
}

const SELECT_DEPARTMENT = `
  SELECT d.id, d.parent_id, d.name, d.code, d.color, d.sort_order, d.is_active,
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

// ── Writes ──────────────────────────────────────────────────────────────

export type DepartmentInput = {
  name: string
  parentId?: number | null
  code?: string | null
  color?: string | null
  sortOrder?: number
  isActive?: boolean
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

export function validateDepartment(input: DepartmentInput): string | null {
  if (!input.name?.trim()) return 'A department name is required.'
  if (input.name.trim().length > 120) return 'Name must be 120 characters or fewer.'
  if (input.code && input.code.trim().length > 32) return 'Code must be 32 characters or fewer.'
  if (input.color && !/^#[0-9a-fA-F]{6}$/.test(input.color.trim())) {
    return 'Colour must be a hex value like #2f6fed.'
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

  const res = await siteExecute(
    siteId,
    `INSERT INTO departments (parent_id, name, code, color, sort_order, is_active)
     VALUES (?,?,?,?,?,?)`,
    [
      parentId,
      name,
      input.code?.trim() || null,
      input.color?.trim() || null,
      input.sortOrder ?? 0,
      input.isActive === false ? 0 : 1,
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

  await siteExecute(
    siteId,
    `UPDATE departments
        SET parent_id = ?, name = ?, code = ?, color = ?, sort_order = ?, is_active = ?
      WHERE id = ?`,
    [
      parentId,
      name,
      input.code?.trim() || null,
      input.color?.trim() || null,
      input.sortOrder ?? 0,
      input.isActive === false ? 0 : 1,
      id,
    ],
  )
  return { ok: true, id }
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
