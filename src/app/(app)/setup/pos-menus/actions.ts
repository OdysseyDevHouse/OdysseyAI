'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import {
  listPosMenus,
  createPosMenu,
  updatePosMenu,
  deletePosMenu,
  savePosMenuItems,
  savePosMenuTerminals,
  type PosMenuInput,
  type PosMenuItemInput,
} from '@/lib/site/posMenus'
import type { PosMenu } from '@/lib/posMenuEngine'

/**
 * The rotating menus' actions.
 *
 * ── EVERY ONE RETURNS THE WHOLE FRESH LIST ─────────────────────────────────
 *
 * Not "ok", and not just the row that changed. The same decision the menu
 * designer beside it made: a screen that applied its own guess at the new
 * state would drift from what the till is about to receive, and the drift
 * would only surface on a reload. The payload is a handful of rows.
 *
 * ── GUARDED ON setup.edit ──────────────────────────────────────────────────
 *
 * Deciding what the shop floor shows at nine in the morning is configuration,
 * like the quick keys and the menu designer beside it. Deliberately not
 * `products.edit`: someone who may price a product has no business changing
 * what every till in the shop displays at breakfast.
 *
 * The guard is the real boundary — a server action is a public endpoint, so
 * hiding the screen changes what is easy, not what is possible.
 */

export type MenusResult = { ok: true; menus: PosMenu[] } | { ok: false; error: string }

/** Re-reads the menus and stamps the path. Every successful action ends here. */
async function fresh(siteId: number): Promise<MenusResult> {
  revalidatePath('/setup/pos-menus')
  return { ok: true, menus: await listPosMenus(siteId) }
}

export async function reloadMenusAction(): Promise<MenusResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  return { ok: true, menus: await listPosMenus(ctx.siteId) }
}

export async function createMenuAction(input: PosMenuInput): Promise<MenusResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const res = await createPosMenu(ctx.siteId, input, ctx.actor.userName)
  if (!res.ok) return res
  return fresh(ctx.siteId)
}

/**
 * Saves the menu, its scope AND its tills in one call.
 *
 * One action rather than three because the screen edits them as one thing: a
 * dialog that saved the hours and then failed on the scope would leave a menu
 * live over the wrong products, at the wrong time, with the screen showing
 * what the user typed rather than what was stored.
 *
 * ⚠ `terminalIds` REPLACES the whole pinning, and an empty array legitimately
 * means "every till" (232) — it is not "leave it alone". Every caller must
 * therefore send the list it means, including the one it read unchanged; a
 * caller that omitted it would silently unpin a menu from its tills. This is
 * the partial-save trap, and it is why the parameter is required rather than
 * optional.
 */
export async function saveMenuAction(
  id: number,
  input: PosMenuInput,
  items: PosMenuItemInput[],
  terminalIds: number[],
): Promise<MenusResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const res = await updatePosMenu(ctx.siteId, id, input, ctx.actor.userName)
  if (!res.ok) return res
  await savePosMenuItems(ctx.siteId, id, items)
  await savePosMenuTerminals(ctx.siteId, id, terminalIds)
  return fresh(ctx.siteId)
}

export async function deleteMenuAction(id: number): Promise<MenusResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  await deletePosMenu(ctx.siteId, id)
  return fresh(ctx.siteId)
}

/**
 * The switch on the list, without opening the editor.
 *
 * Its own action rather than a `saveMenuAction` with the whole draft: turning
 * a menu off is the one thing an owner does in a hurry, and making it carry
 * the scope means a stale list row could silently rewrite what is on the menu.
 */
export async function setMenuActiveAction(id: number, isActive: boolean): Promise<MenusResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const menus = await listPosMenus(ctx.siteId)
  const menu = menus.find((m) => m.id === id)
  if (!menu) return { ok: false, error: 'That menu no longer exists.' }
  const res = await updatePosMenu(
    ctx.siteId,
    id,
    {
      name: menu.name,
      isActive,
      dailyStart: menu.dailyStart,
      dailyEnd: menu.dailyEnd,
      daysOfWeek: menu.daysOfWeek,
      priority: menu.priority,
    },
    ctx.actor.userName,
  )
  if (!res.ok) return res
  return fresh(ctx.siteId)
}
