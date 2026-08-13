import type { Department } from '@/lib/site/departments'
import type { MenuProduct } from '@/lib/site/menuDesigner'

export type { Department, MenuProduct }

/**
 * The designer's drag vocabulary.
 *
 * Both payloads live here rather than beside the tiles because the canvas is
 * the only thing that reads them: a tile declares what it IS, and the canvas
 * decides what a drop between two of them means. Keeping the shapes in one file
 * is what stops a tile and the handler that receives it drifting apart.
 */

/** Attached to a draggable tile via dnd-kit's `data` option. */
export type DragData =
  | { kind: 'product'; productId: number; fromTray: boolean }
  | { kind: 'department'; departmentId: number }

/** Attached to a droppable target via dnd-kit's `data` option. */
export type DropData =
  | { kind: 'product-tile'; productId: number }
  | { kind: 'department-tile'; departmentId: number }
  | { kind: 'back' }
  /** Index into the browsing path; -1 is the root ("Departments"). */
  | { kind: 'crumb'; index: number }
  | { kind: 'tray' }
  /** The strip: "file this into the level I'm looking at". */
  | { kind: 'level' }

/** How the dragged tile sits over a target. */
export type DropZone = 'before' | 'after' | 'onto'

export interface OverState {
  /** dnd-kit droppable id currently hovered. */
  id: string
  zone: DropZone
}

/**
 * Menu order for products: positioned tiles first, then the unplaced ones A–Z.
 *
 * The mirror of the SQL in `lib/site/menuDesigner.ts`. It has to exist twice —
 * the server sorts what it reads, and the canvas re-sorts after an optimistic
 * move that has not been round-tripped yet — so both are written against the
 * same sentence: 0 means "never placed", and never placed sorts last.
 */
export function byMenuOrder(a: MenuProduct, b: MenuProduct): number {
  const aLast = a.posSortOrder === 0 ? 1 : 0
  const bLast = b.posSortOrder === 0 ? 1 : 0
  if (aLast !== bLast) return aLast - bLast
  if (a.posSortOrder !== b.posSortOrder) return a.posSortOrder - b.posSortOrder
  return a.description.localeCompare(b.description, 'en-ZA', {
    numeric: true,
    sensitivity: 'base',
  })
}

/** Departments in the order the till draws them: by sort order, then name. */
export function byDepartmentOrder(a: Department, b: Department): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
}

/**
 * The children of one node, in menu order.
 *
 * A local copy rather than an import from `lib/site/departments`, which is
 * `server-only`: importing even a pure helper out of it would drag the site DB
 * layer into the browser bundle. Only the TYPE crosses over, and types erase.
 * `DepartmentsClient` keeps its own copy for exactly the same reason.
 */
export function childrenOf(all: Department[], parentId: number | null): Department[] {
  return all.filter((d) => d.parentId === parentId).sort(byDepartmentOrder)
}

/** `id` and everything beneath it — used to stop a drag landing inside itself. */
export function descendantsOf(all: Department[], id: number): Set<number> {
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
