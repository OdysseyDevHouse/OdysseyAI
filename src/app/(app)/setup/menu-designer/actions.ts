'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import {
  loadMenu,
  moveDepartment,
  moveProductsToDepartment,
  reorderMenuProducts,
  setProductsVisibleInPos,
  updateProductTile,
  type MenuProduct,
} from '@/lib/site/menuDesigner'
import {
  createDepartment,
  patchDepartment,
  reorderDepartments,
  updateDepartment,
  type Department,
} from '@/lib/site/departments'

/**
 * The menu designer's actions.
 *
 * ── EVERY ONE RETURNS THE WHOLE FRESH MENU ─────────────────────────────────
 *
 * Not "ok", and not just the row that changed. Positions are renumbered
 * server-side on every move and reorder, so a canvas applying its own guess at
 * the new order would drift from what the till is about to draw — and the drift
 * would only surface after a reload. This is the same decision the quick-key
 * designer beside it made, for the same reason; the payload is two small arrays.
 *
 * The canvas still paints optimistically for the instant feedback a drag needs.
 * The returned menu is what it reconciles against, so an optimistic guess can
 * never outlive the round trip.
 *
 * ── GUARDED ON setup.edit, ONE CAPABILITY THROUGHOUT ───────────────────────
 *
 * Arranging the till's menu is configuration, like the quick keys and the
 * tender types beside it — the same person, the same screenful of settings.
 * Deliberately not `stock.view`: someone who may LOOK at the product file has
 * no business rearranging what the shop floor sees.
 *
 * The guard is the real boundary. A server action is a public endpoint, so
 * hiding the screen changes what is easy, not what is possible.
 */

export type MenuPayload = { departments: Department[]; products: MenuProduct[] }
export type MenuActionResult = { ok: true; menu: MenuPayload } | { ok: false; error: string }

/** Re-reads the menu and stamps the path. Every successful action ends here. */
async function fresh(siteId: number): Promise<MenuActionResult> {
  revalidatePath('/setup/menu-designer')
  return { ok: true, menu: await loadMenu(siteId) }
}

export async function reloadMenuAction(): Promise<MenuActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  return { ok: true, menu: await loadMenu(ctx.siteId) }
}

/**
 * Files products into a department, or off the menu with `departmentId: null`.
 *
 * Dragging a product onto the menu also makes it VISIBLE there. Without that
 * the drop would appear to do nothing for any product previously hidden — the
 * tile would land in the department and still not reach the till, and the owner
 * would have no way to tell from this screen why. Going the other way is not
 * symmetrical on purpose: taking a product off the menu leaves its visibility
 * alone, because the tray is about where a product sits, not whether it sells.
 */
export async function moveProductsAction(
  productIds: number[],
  departmentId: number | null,
): Promise<MenuActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const moved = await moveProductsToDepartment(siteId, productIds, departmentId)
  if (!moved.ok) return moved

  if (departmentId !== null) {
    const shown = await setProductsVisibleInPos(siteId, productIds, true)
    if (!shown.ok) return shown
  }
  return fresh(siteId)
}

/**
 * Drops products into an exact slot: the move, then the order it landed in.
 *
 * Two writes rather than one because they answer different questions — which
 * department, and where in it — and only the drags aimed at a specific slot pay
 * for the second. The order is the caller's full intended list for that
 * department, not a delta, so the server never has to reconstruct the gesture.
 */
export async function moveAndOrderProductsAction(
  productIds: number[],
  departmentId: number,
  orderedIds: number[],
): Promise<MenuActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const moved = await moveProductsToDepartment(siteId, productIds, departmentId)
  if (!moved.ok) return moved

  const shown = await setProductsVisibleInPos(siteId, productIds, true)
  if (!shown.ok) return shown

  const ordered = await reorderMenuProducts(siteId, departmentId, orderedIds)
  if (!ordered.ok) return ordered

  return fresh(siteId)
}

export async function reorderProductsAction(
  departmentId: number,
  orderedIds: number[],
): Promise<MenuActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await reorderMenuProducts(siteId, departmentId, orderedIds)
  if (!result.ok) return result
  return fresh(siteId)
}

export async function reorderDepartmentsAction(orderedIds: number[]): Promise<MenuActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await reorderDepartments(siteId, orderedIds)
  if (!result.ok) return result
  return fresh(siteId)
}

/** Nest a department under another, or promote it to the top with `null`. */
export async function moveDepartmentAction(
  departmentId: number,
  parentId: number | null,
): Promise<MenuActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await moveDepartment(siteId, departmentId, parentId)
  if (!result.ok) return result
  return fresh(siteId)
}

/** Creates an empty department at the level being browsed. */
export async function createMenuDepartmentAction(input: {
  name: string
  parentId: number | null
  color: string | null
}): Promise<MenuActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await createDepartment(siteId, {
    name: input.name,
    parentId: input.parentId,
    color: input.color,
  })
  if (!result.ok) return result
  return fresh(siteId)
}

/**
 * Renames a department and/or restyles its tile.
 *
 * Colour goes through `patchDepartment` and the name through `updateDepartment`
 * — deliberately, not one call with both. `patchDepartment` exists precisely
 * because the full update rewrites `parent_id`, `code` and `sort_order` from
 * whatever it is handed, and on this screen those are exactly the fields a drag
 * has just set. Recolouring a tile must not be able to undo a move.
 */
export async function updateDepartmentTileAction(
  departmentId: number,
  patch: { name?: string; color?: string | null },
): Promise<MenuActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  if (patch.color !== undefined) {
    const result = await patchDepartment(siteId, departmentId, { color: patch.color })
    if (!result.ok) return result
  }

  if (patch.name !== undefined) {
    const { departments } = await loadMenu(siteId)
    const existing = departments.find((d) => d.id === departmentId)
    if (!existing) return { ok: false, error: 'That department no longer exists.' }

    // Every other field is passed back unchanged so the rename cannot become a
    // silent re-parent — see the note above.
    const result = await updateDepartment(siteId, departmentId, {
      name: patch.name,
      parentId: existing.parentId,
      code: existing.code,
      color: patch.color !== undefined ? patch.color : existing.color,
      sortOrder: existing.sortOrder,
      isActive: existing.isActive,
      posImageId: existing.posImageId,
      onlineImageId: existing.onlineImageId,
    })
    if (!result.ok) return result
  }

  return fresh(siteId)
}

/** Shows or hides a department on the till without deleting anything. */
export async function setDepartmentVisibleAction(
  departmentId: number,
  visible: boolean,
): Promise<MenuActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await patchDepartment(siteId, departmentId, { isActive: visible })
  if (!result.ok) return result
  return fresh(siteId)
}

export async function setProductsVisibleAction(
  productIds: number[],
  visible: boolean,
): Promise<MenuActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await setProductsVisibleInPos(siteId, productIds, visible)
  if (!result.ok) return result
  return fresh(siteId)
}

export async function updateProductTileAction(
  productId: number,
  patch: { description?: string; imageColor?: string | null },
): Promise<MenuActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await updateProductTile(siteId, productId, patch)
  if (!result.ok) return result
  return fresh(siteId)
}
