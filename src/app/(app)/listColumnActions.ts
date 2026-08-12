'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { setListColumns, clearListColumns, type ListKey } from '@/lib/site/listColumns'

/**
 * Setting which columns a list shows, for the whole store.
 *
 * Shared rather than per-screen: the products list is the first to use it, but
 * customers, suppliers and the rest take the same shape, and three copies of a
 * ten-line action would drift.
 *
 * ── WHY setup.edit ───────────────────────────────────────────────────────
 *
 * This changes what every user of the store sees, so it is a setup decision
 * rather than a personal one — the same capability that governs departments,
 * reasons and numbering. A user without it still has the per-device picker,
 * which changes only their own screen.
 *
 * The catalogue is passed in by the caller and filtered against on the server
 * (setListColumns), so a hand-rolled POST cannot store an id the table does not
 * know about.
 */
export async function setListColumnsAction(
  listKey: ListKey,
  visible: string[],
  known: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await setListColumns(ctx.siteId, listKey, visible, known, ctx.actor.userId)
  if (!result.ok) return result

  revalidatePath(`/${listKey}`)
  return { ok: true }
}

/** Forgets the store's choice, so the list's own default applies again. */
export async function clearListColumnsAction(
  listKey: ListKey,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  await clearListColumns(ctx.siteId, listKey)
  revalidatePath(`/${listKey}`)
  return { ok: true }
}
