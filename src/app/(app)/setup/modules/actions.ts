'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { areasFor, isMenuArea, type MenuArea } from '@/lib/menuAreas'
import { hiddenAreas, setVisibleAreas } from '@/lib/site/menuVisibility'

/**
 * Which parts of the product appear in this shop's menus.
 *
 * ── WHY THIS CAN NEVER GRANT ANYTHING ───────────────────────────────────────
 *
 * The client sends what it wants SHOWN, and `setVisibleAreas` intersects that
 * with the areas this shop is entitled to before it writes anything. So the
 * worst a forged request can do is hide something — and hiding is not a
 * boundary, since every one of those pages still guards itself. `setup.edit` is
 * therefore the right capability: this is a display preference, of the same
 * weight as the decimal places next to it in the catalogue.
 */

export type SaveResult =
  | { ok: true; message: string; shown: MenuArea[] }
  | { ok: false; error: string }

export async function saveVisibleAreasAction(shown: string[]): Promise<SaveResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  /* The entitlements the guard just resolved, not what the screen was rendered
     with: a module could have been added or cancelled in the minutes the form
     was open, and the entitlement is what decides which keys may be written. */
  const { modules } = ctx

  const saved = await setVisibleAreas(
    ctx.siteId,
    modules,
    shown.filter(isMenuArea),
  )
  if (!saved.ok) return saved

  /*
   * The whole authenticated tree. The sidebar is rendered by the layout, and
   * every hub — setup, accounting, the dashboard — filters its own tiles on the
   * same answer, so anything narrower would leave the menu showing what was just
   * switched off until the next hard reload.
   */
  revalidatePath('/', 'layout')

  /* Read back rather than echoing the input, so the screen shows what was
     actually stored — an area the shop is not entitled to is dropped on the way
     in, and silently keeping its switch on would be a lie. */
  const hidden = await hiddenAreas(ctx.siteId)
  return {
    ok: true,
    message: 'Menu updated.',
    shown: areasFor(modules.held as ReadonlySet<string>).filter((area) => !hidden.has(area)),
  }
}
