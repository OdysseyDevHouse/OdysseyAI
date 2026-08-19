import 'server-only'
import type { PoolConnection } from 'mysql2/promise'
import { siteExecute, siteQuery, siteTransaction } from '../siteDb'
import {
  MAX_MENU_CHILDREN,
  MAX_MENU_ITEMS,
  menuHref,
  safeMenuTarget,
  type MenuItem,
  type MenuSlug,
} from '../storefront/menus'
import { safeLinkTarget } from '../storefrontModel'

/**
 * Reading and writing the shop's menu.
 *
 * ── AN EMPTY TABLE MEANS "STILL GENERATED" ───────────────────────────────
 *
 * This is the whole migration story and it is worth stating twice. A shop that
 * has never opened the editor has no rows, and `resolveMenu` returns null — at
 * which point the chrome falls back to the rail it has always drawn. There is
 * no day on which a shop's menu is empty because a feature shipped.
 *
 * The editor's first action is `adoptGeneratedMenu`, which writes the CURRENT
 * generated rail into real rows. An owner starts from what their shop already
 * has, and their first edit is a change rather than a rebuild.
 */

type Row = Record<string, unknown>

/** The ids the two fixed menus have on this site, creating them if needed. */
async function menuId(siteId: number, slug: MenuSlug): Promise<number> {
  const [row] = await siteQuery<Row>(siteId, `SELECT id FROM storefront_menus WHERE slug = ?`, [
    slug,
  ])
  if (row) return Number(row.id)
  await siteExecute(siteId, `INSERT INTO storefront_menus (slug, title) VALUES (?, '')`, [slug])
  const [made] = await siteQuery<Row>(siteId, `SELECT id FROM storefront_menus WHERE slug = ?`, [
    slug,
  ])
  return Number(made?.id ?? 0)
}

/**
 * The shop's own menu, or null when it has not made one.
 *
 * Null rather than an empty array, because the two mean opposite things: an
 * empty menu is an owner who removed every item and meant it, and null is a
 * shop that has never touched this and should keep its generated rail. Reading
 * them the same way is how a feature launch blanks somebody's navigation.
 */
export async function resolveMenu(siteId: number, slug: MenuSlug): Promise<MenuItem[] | null> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT i.id, i.parent_id, i.label, i.target_kind, i.target_id, i.target_url, i.image_id
       FROM storefront_menu_items i
       JOIN storefront_menus m ON m.id = i.menu_id
      WHERE m.slug = ?
      ORDER BY i.sort_order, i.id`,
    [slug],
  )
  if (rows.length === 0) {
    // No rows at all is "never made one". A menu that HAS a row — even one —
    // is the owner's, and stays theirs.
    const [menu] = await siteQuery<Row>(siteId, `SELECT id FROM storefront_menus WHERE slug = ?`, [
      slug,
    ])
    return menu ? [] : null
  }

  const byId = new Map<number, MenuItem>()
  const top: MenuItem[] = []
  for (const row of rows) {
    const item: MenuItem = {
      id: Number(row.id),
      label: String(row.label ?? ''),
      targetKind: safeMenuTarget(row.target_kind),
      targetId: row.target_id === null ? null : Number(row.target_id),
      targetUrl: String(row.target_url ?? ''),
      imageId: row.image_id === null ? null : Number(row.image_id),
      children: [],
    }
    byId.set(item.id, item)
  }
  for (const row of rows) {
    const item = byId.get(Number(row.id))
    if (!item) continue
    const parent = row.parent_id === null ? null : byId.get(Number(row.parent_id))
    /*
     * A child whose parent is itself a child is promoted to the top rather than
     * dropped. The write path caps depth at one, but a row written by an older
     * build — or by hand — must still resolve to something a shopper can use,
     * and losing a menu entry is worse than showing it a level up.
     */
    if (parent && parent.children.length < MAX_MENU_CHILDREN && row.parent_id !== null) {
      parent.children.push(item)
    } else {
      top.push(item)
    }
  }
  return top.slice(0, MAX_MENU_ITEMS)
}

/** What the editor writes: the same shape, without ids it does not have yet. */
export type MenuItemInput = {
  label: string
  targetKind: string
  targetId: number | null
  targetUrl: string
  imageId: number | null
  children?: Omit<MenuItemInput, 'children'>[]
}

/**
 * Replace a menu wholesale.
 *
 * ── DELETE AND REWRITE, NOT A DIFF ───────────────────────────────────────
 *
 * A menu is small, ordered and edited as a whole — an owner drags three things
 * and presses save. Diffing it would mean matching rows by an id the browser
 * has to carry, keeping deletions and reorders straight, and getting the
 * children right; all of that to avoid rewriting twenty rows inside a
 * transaction that already has to be atomic.
 *
 * In a transaction because a menu that is half-written is a masthead with half
 * a navigation, and this is the shop's front door.
 */
export async function saveMenu(
  siteId: number,
  slug: MenuSlug,
  items: MenuItemInput[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = await menuId(siteId, slug)
  if (!id) return { ok: false, error: 'That menu could not be opened.' }

  const clean = (Array.isArray(items) ? items : []).slice(0, MAX_MENU_ITEMS)

  await siteTransaction(siteId, async (tx) => {
    // The children go with them: fk_menu_item_parent cascades, so deleting the
    // top-level rows is enough.
    await tx.execute(`DELETE FROM storefront_menu_items WHERE menu_id = ?`, [id])

    let order = 0
    for (const item of clean) {
      const parentId = await insertItem(tx, id, null, order++, item)
      // Depth is capped HERE, structurally: a child is written with the id of a
      // top-level row and nothing recurses, so there is no path to a third
      // level however the input is shaped. See 188.
      const children = (Array.isArray(item.children) ? item.children : []).slice(
        0,
        MAX_MENU_CHILDREN,
      )
      let childOrder = 0
      for (const child of children) {
        await insertItem(tx, id, parentId, childOrder++, child)
      }
    }
  })

  return { ok: true }
}

async function insertItem(
  // The driver's own connection type. A structural one is WIDER than
  // PoolConnection in the argument position, which tsc rejects rather than
  // accepting loosely — and the cast below is where the tuple gets its shape.
  tx: PoolConnection,
  menuId: number,
  parentId: number | null,
  order: number,
  item: Omit<MenuItemInput, 'children'>,
): Promise<number> {
  const kind = safeMenuTarget(item.targetKind)
  const targetId = Number.isInteger(item.targetId) && (item.targetId ?? 0) > 0 ? item.targetId : null
  const image = Number.isInteger(item.imageId) && (item.imageId ?? 0) > 0 ? item.imageId : null

  const [result] = (await tx.execute(
    `INSERT INTO storefront_menu_items
       (menu_id, parent_id, sort_order, label, target_kind, target_id, target_url, image_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      menuId,
      parentId,
      order,
      String(item.label ?? '').slice(0, 60),
      kind,
      targetId,
      // Only a `url` item stores one, and only through safeLinkTarget — this
      // lands in an href on every page of a shop that takes payments.
      kind === 'url' ? safeLinkTarget(item.targetUrl).slice(0, 300) : '',
      image,
    ],
  )) as unknown as [{ insertId?: number }]
  return Number(result?.insertId ?? 0)
}

/**
 * Write the rail a shop currently gets into real rows, so it can be edited.
 *
 * The editor's first action. Without it an owner's first sight of the feature
 * is an empty menu and a shop whose navigation they have to rebuild before it
 * works again — which is a feature launch that breaks a working shop.
 */
export async function adoptGeneratedMenu(
  siteId: number,
  slug: MenuSlug,
  generated: MenuItemInput[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  return saveMenu(siteId, slug, generated)
}

/** Has this shop made a menu of its own yet? */
export async function hasMenu(siteId: number, slug: MenuSlug): Promise<boolean> {
  const [row] = await siteQuery<Row>(
    siteId,
    `SELECT 1 AS present FROM storefront_menus WHERE slug = ? LIMIT 1`,
    [slug],
  )
  return !!row
}

/** A menu item ready to render: a label, a real href, and its children. */
export type ResolvedMenuItem = {
  label: string
  href: string
  imageId: number | null
  children: { label: string; href: string }[]
}

/**
 * The links a shop's masthead should draw.
 *
 * ── ONE FUNCTION, AND THE FALLBACK LIVES IN IT ───────────────────────────
 *
 * Every caller asks the same question — "what goes in the menu" — and gets an
 * answer whether or not the shop has made one. Putting the fallback in the
 * chrome instead would mean the editor previews the stored menu while the shop
 * draws a generated one, and the two would part company on the first shop that
 * had not adopted yet.
 *
 * An item that cannot resolve is DROPPED rather than drawn: a deleted
 * department leaves a shorter menu, not a link to nowhere.
 */
export async function menuLinks(
  siteId: number,
  slug: MenuSlug,
  base: string,
  generated: () => Promise<ResolvedMenuItem[]>,
): Promise<ResolvedMenuItem[]> {
  const stored = await resolveMenu(siteId, slug)
  if (stored === null) return generated()

  const pageSlugs = await pageSlugMap(siteId)
  const out: ResolvedMenuItem[] = []
  for (const item of stored) {
    const href = hrefFor(item, base, pageSlugs)
    if (!href || !item.label.trim()) continue
    out.push({
      label: item.label,
      href,
      imageId: item.imageId,
      children: item.children
        .map((child) => ({ label: child.label, href: hrefFor(child, base, pageSlugs) }))
        .filter((c): c is { label: string; href: string } => !!c.href && !!c.label.trim()),
    })
  }
  return out
}

/**
 * A page is stored by ID and linked by SLUG.
 *
 * The id is what survives a rename — an owner who renames "Delivery" to
 * "Shipping" should not find their menu pointing at a 404. So the slug is
 * looked up at render time, and a page that was deleted resolves to nothing.
 */
async function pageSlugMap(siteId: number): Promise<Map<number, string>> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, slug FROM storefront_pages WHERE is_published = 1 AND slug IS NOT NULL`,
  )
  return new Map(rows.map((r) => [Number(r.id), String(r.slug)]))
}

function hrefFor(
  item: Pick<MenuItem, 'targetKind' | 'targetId' | 'targetUrl'>,
  base: string,
  pageSlugs: Map<number, string>,
): string | null {
  if (item.targetKind === 'page') {
    const slug = item.targetId === null ? undefined : pageSlugs.get(item.targetId)
    return slug ? `${base}/page/${slug}` : null
  }
  return menuHref(item, base)
}
