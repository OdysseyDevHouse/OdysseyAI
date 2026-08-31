import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute, siteTransaction } from '../siteDb'
import { listDepartments, descendantIds, type Department } from './departments'
import { cascadeInherited } from './productVariants'

/**
 * The menu designer's data layer: the till's browse menu as one editable thing.
 *
 * ── WHAT THE MENU ACTUALLY IS ──────────────────────────────────────────────
 *
 * There is no `menu` table, and adding one would have been the wrong move. The
 * till already browses departments and the products pointing at them, so the
 * "menu" is that tree read in display order. A separate menu structure would be
 * a second copy of the hierarchy that could disagree with the department list
 * — and every screen that files a product into a department would have to
 * remember to update it too.
 *
 * So this module owns exactly two things the plain department/product readers
 * do not: the ORDER tiles appear in, and the moves that rearrange them.
 *
 * ── ORDER COMES FROM TWO COLUMNS, ONE RULE ─────────────────────────────────
 *
 * `departments.sort_order` and `products.pos_sort_order` (121). Both follow the
 * same convention, and `MENU_ORDER` below is the single place it is written
 * down: positioned rows first in ascending order, then unpositioned rows (0)
 * alphabetically. See 121_product_menu_order.sql for why 0 cannot mean "first".
 */

/** A product as the designer draws it — one tile on the till's grid. */
export type MenuProduct = {
  id: number
  code: string
  barcode: string | null
  description: string
  departmentId: number | null
  /** Menu position within its department; 0 = never placed (see 121). */
  posSortOrder: number
  /** Hidden products stay sellable by scan or search — they just leave the grid. */
  visibleInPos: boolean
  price: number
  /** The tile's swatch token (tile-1…tile-7, a gradient, or null). */
  imageColor: string | null
  /** Stored icon name, or null for the colour-and-initial tile. */
  imageIcon: string | null
  /**
   * True when this tile is a variant GROUP (070) — a shirt, not a size.
   *
   * The designer needs to say so on the tile, because a group behaves
   * differently from the product beside it: at the till it opens a picker
   * rather than ringing up, and every edit made here reaches its members.
   */
  hasVariants: boolean
  /** How many live members are behind a group tile. 0 on an ordinary product. */
  variantCount: number
}

type Row = RowDataPacket & Record<string, unknown>

/**
 * Positioned rows first, then the rest A–Z.
 *
 * Written once and reused by both reads so the designer and the till can never
 * sort the same grid two different ways.
 */
const productOrder = (alias = 'p') =>
  `CASE WHEN ${alias}.pos_sort_order = 0 THEN 1 ELSE 0 END,
   ${alias}.pos_sort_order ASC,
   ${alias}.description ASC`

function mapProduct(r: Row): MenuProduct {
  return {
    id: Number(r.id),
    code: String(r.code ?? ''),
    barcode: (r.barcode as string | null) ?? null,
    description: String(r.description ?? ''),
    departmentId: r.department_id === null ? null : Number(r.department_id),
    posSortOrder: Number(r.pos_sort_order ?? 0),
    visibleInPos: !!r.visible_in_pos,
    price: Number(r.price ?? 0),
    imageColor: (r.image_color as string | null) ?? null,
    imageIcon: (r.image_icon as string | null) ?? null,
    hasVariants: Number(r.has_variants ?? 0) === 1,
    variantCount: Number(r.variant_count ?? 0),
  }
}

/**
 * Every product the menu can show, in menu order.
 *
 * Archived products are excluded outright rather than dimmed: they are not
 * sellable, so a tile for one is a button that cannot work. Products with no
 * department come back too — those are the "not on the menu" tray, and they are
 * the whole reason the designer has one.
 *
 * Variant MEMBERS are excluded as well, and that is load-bearing rather than
 * cosmetic — see the WHERE clause. A group is one tile here exactly as it is
 * one tile at the till.
 *
 * The price is the DEFAULT price structure's shelf price — the number the till
 * puts on the button. Read as a scalar subquery rather than a join so a product
 * with no price row still returns a tile (at 0) instead of vanishing from the
 * grid entirely, and ordered the same way the product picker orders it so the
 * two screens cannot quote different prices for the same product.
 */
export async function listMenuProducts(siteId: number): Promise<MenuProduct[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.code, p.barcode, p.description, p.department_id,
            p.pos_sort_order, p.visible_in_pos, p.image_color, p.image_icon,
            p.has_variants,
            -- Both variant subqueries sit behind has_variants = 1, and that
            -- guard is a PERFORMANCE requirement rather than tidiness.
            --
            -- Measured: a shop with 40,036 live products and no groups at all
            -- ran the unguarded version for over nine minutes — 40,036
            -- evaluations of a two-table join to discover there was nothing to
            -- find. MariaDB will not short-circuit a correlated subquery on
            -- its own, so the CASE has to. Guarded, a shop with no variants
            -- pays one integer comparison per row, and a shop with twenty
            -- groups pays the subquery twenty times.
            CASE WHEN p.has_variants = 1 THEN (
              SELECT COUNT(*) FROM products c
               WHERE c.parent_id = p.id AND c.is_archived = 0
            ) ELSE 0 END AS variant_count,
            -- A GROUP has no price row of its own, so it quotes its cheapest
            -- member — the same figure the till's tile shows, and for the same
            -- reason: a shirt priced at R0.00 in the palette is a tile nobody
            -- can place with confidence. See selectProduct in tillSearch.ts.
            CASE WHEN p.has_variants = 1 THEN COALESCE((
              SELECT MIN(cpp.selling_price_incl) FROM products c
                JOIN product_prices cpp ON cpp.product_id = c.id
                JOIN price_structures cps ON cps.id = cpp.price_structure_id
               WHERE c.parent_id = p.id AND c.is_archived = 0
                 AND cps.is_default = 1
            ), 0) ELSE COALESCE((
              SELECT pp.selling_price_incl FROM product_prices pp
                JOIN price_structures ps ON ps.id = pp.price_structure_id
               WHERE pp.product_id = p.id
               ORDER BY ps.is_default DESC, ps.id LIMIT 1
            ), 0) END AS price
       FROM products p
      WHERE p.is_archived = 0
        -- Variant MEMBERS are not tiles (070). The group stands for them, and
        -- listing both would offer a shirt six times — five sizes plus the
        -- thing that contains them — with no way for a shopkeeper to tell
        -- which tile does what once they are side by side on the menu.
        --
        -- This is also what keeps every WRITER below safe: a member cannot be
        -- selected here, so nothing in this module can move one to its own
        -- department (breaking rule 5's inheritance) or hide one out from
        -- under the picker that lists it.
        AND p.parent_id IS NULL
      ORDER BY ${productOrder('p')}`,
  )
  return rows.map(mapProduct)
}

/** The designer's whole payload: the tree and every tile on it. */
export async function loadMenu(
  siteId: number,
): Promise<{ departments: Department[]; products: MenuProduct[] }> {
  const [departments, products] = await Promise.all([
    // Inactive departments included: the designer is where you'd go to fix one,
    // so hiding them would hide the branch a product is stuck under.
    listDepartments(siteId, true),
    listMenuProducts(siteId),
  ])
  return { departments, products }
}

export type MenuResult = { ok: true } | { ok: false; error: string }

/**
 * Files products into a department (or out of the menu entirely, with null).
 *
 * ── EVERY MOVE LANDS AT THE END, NOT THE FRONT ─────────────────────────────
 *
 * Positions continue from whatever is already in the destination, so a drag
 * into a department the owner has arranged does not shove itself in at the top
 * and renumber their work. When the drop was aimed at a slot, the designer
 * follows this with a reorder that says exactly where — one extra write, and
 * only for the drags that asked for a position.
 */
export async function moveProductsToDepartment(
  siteId: number,
  productIds: number[],
  departmentId: number | null,
): Promise<MenuResult> {
  const ids = [...new Set(productIds.filter((id) => Number.isInteger(id) && id > 0))]
  if (ids.length === 0) return { ok: true }

  if (departmentId !== null) {
    const all = await listDepartments(siteId, true)
    if (!all.some((d) => d.id === departmentId)) {
      return { ok: false, error: 'That department no longer exists.' }
    }
  }

  await siteTransaction(siteId, async (tx) => {
    const [maxRow] = await tx.query<RowDataPacket[]>(
      departmentId === null
        ? 'SELECT 0 AS top'
        : 'SELECT COALESCE(MAX(pos_sort_order), 0) AS top FROM products WHERE department_id = ?',
      departmentId === null ? [] : [departmentId],
    )
    let next = Number((maxRow as RowDataPacket[])[0]?.top ?? 0)

    for (const id of ids) {
      // Off the menu means unpositioned: the tray has no order to hold, and
      // keeping a stale number would resurrect it on the next drag back in.
      next = departmentId === null ? 0 : next + 1
      await tx.execute(
        'UPDATE products SET department_id = ?, pos_sort_order = ? WHERE id = ?',
        [departmentId, next, id],
      )
      /*
       * A GROUP takes its members with it (070, rule 5).
       *
       * Department is an INHERITED column: a group filed under Clothing whose
       * mediums sit under Groceries is a broken record, and the storefront's
       * breadcrumb cannot point two ways at once. Dragging the tile here is a
       * legitimate way to change it, so the change has to reach the members.
       *
       * `cascadeInherited` rather than a second UPDATE of `department_id`
       * alone: it is the one definition of what a child inherits, and a copy
       * here would silently stop matching the day a fifth column joins the
       * list. It is a no-op on an ordinary product, which has no children.
       */
      await cascadeInherited(tx, id)
    }
  })

  return { ok: true }
}

/**
 * Rewrites the menu order across the products of ONE department.
 *
 * Verified to belong to the department named before anything is written, so a
 * tampered payload cannot renumber products on another part of the menu. Rows
 * are rewritten 1..n rather than patched, so a department whose positions had
 * gaps or duplicates comes out consistent.
 */
export async function reorderMenuProducts(
  siteId: number,
  departmentId: number,
  orderedIds: number[],
): Promise<MenuResult> {
  if (orderedIds.length === 0) return { ok: true }
  if (new Set(orderedIds).size !== orderedIds.length) {
    return { ok: false, error: 'That order lists the same product twice.' }
  }

  const rows = await siteQuery<RowDataPacket & { id: number }>(
    siteId,
    /* Members excluded, matching `listMenuProducts`: they are not tiles, so
       they can never appear in an order the designer submits. Leaving them in
       would make this guard admit an id the palette cannot produce. */
    `SELECT id FROM products
      WHERE department_id = ? AND is_archived = 0 AND parent_id IS NULL`,
    [departmentId],
  )
  const here = new Set(rows.map((r) => Number(r.id)))
  if (orderedIds.some((id) => !here.has(id))) {
    return { ok: false, error: 'The menu changed while you were arranging it.' }
  }

  await siteTransaction(siteId, async (tx) => {
    for (const [index, id] of orderedIds.entries()) {
      await tx.execute('UPDATE products SET pos_sort_order = ? WHERE id = ?', [index + 1, id])
    }
  })
  return { ok: true }
}

/**
 * Re-parents one department — the designer's "nest" and "promote" gestures.
 *
 * The depth is deliberately NOT capped. Departments here are an arbitrary-depth
 * tree (`parent_id`), so there is no level at which a branch becomes illegal
 * and nothing to merge on the way in.
 */
export async function moveDepartment(
  siteId: number,
  departmentId: number,
  parentId: number | null,
): Promise<MenuResult> {
  const all = await listDepartments(siteId, true)
  const moving = all.find((d) => d.id === departmentId)
  if (!moving) return { ok: false, error: 'That department no longer exists.' }
  if (moving.parentId === parentId) return { ok: true }

  if (parentId !== null) {
    if (!all.some((d) => d.id === parentId)) {
      return { ok: false, error: 'That department no longer exists.' }
    }
    // Into itself or its own descendant would detach the branch from the tree:
    // the rows would survive but nothing could reach them, and an ancestor walk
    // would loop. Same rule updateDepartment() enforces.
    if (descendantIds(all, departmentId).has(parentId)) {
      return { ok: false, error: 'A department cannot be moved inside itself.' }
    }
  }

  // Lands last among its new siblings, for the reason moveProducts documents.
  const siblings = all.filter((d) => d.parentId === parentId && d.id !== departmentId)
  const last = siblings.reduce((max, d) => Math.max(max, d.sortOrder), 0)

  await siteExecute(siteId, 'UPDATE departments SET parent_id = ?, sort_order = ? WHERE id = ?', [
    parentId,
    last + 1,
    departmentId,
  ])
  return { ok: true }
}

/**
 * Shows or hides products on the till's browse grid.
 *
 * Hiding is not archiving and not deleting: the product stays sellable by scan
 * and by search, it just stops taking a tile. That distinction is why the
 * designer offers it at all — a shop with 400 SKUs wants 30 on the grid.
 *
 * ── A GROUP AND ITS MEMBERS MOVE TOGETHER ────────────────────────────────
 *
 * Hiding a variant group means exactly what hiding anything else means: the
 * tile leaves the grid and the goods stay sellable by scan. But the flag has to
 * reach the MEMBERS too, and the reason is `LIVE_GROUP_ONLY` in tillSearch.ts:
 * it deliberately does not check `visible_in_pos` on a child, so that hiding
 * one size thins the picker rather than deleting the whole group. Written only
 * to the parent, "hide" would leave five members still answering to a picker
 * behind a tile that is no longer there.
 *
 * Showing cascades for the same reason from the other side — a group turned
 * back on whose members were left hidden opens an empty picker.
 */
export async function setProductsVisibleInPos(
  siteId: number,
  productIds: number[],
  visible: boolean,
): Promise<MenuResult> {
  const ids = [...new Set(productIds.filter((id) => Number.isInteger(id) && id > 0))]
  if (ids.length === 0) return { ok: true }

  const list = ids.map(() => '?').join(',')
  await siteExecute(
    siteId,
    `UPDATE products SET visible_in_pos = ?
      WHERE id IN (${list})
         OR parent_id IN (${list})`,
    [visible ? 1 : 0, ...ids, ...ids],
  )
  return { ok: true }
}

/** Renames a product and/or restyles its till tile. */
export async function updateProductTile(
  siteId: number,
  productId: number,
  patch: { description?: string; imageColor?: string | null },
): Promise<MenuResult> {
  const sets: string[] = []
  const params: (string | number | null)[] = []

  if (patch.description !== undefined) {
    const description = patch.description.trim()
    if (!description) return { ok: false, error: 'A product needs a name.' }
    if (description.length > 200) return { ok: false, error: 'That name is too long.' }
    sets.push('description = ?')
    params.push(description)
  }

  if (patch.imageColor !== undefined) {
    const token = patch.imageColor?.trim() || null
    // Same allowance patchDepartment() makes: rows written before the palette
    // became tokens still hold a hex string.
    if (token && !/^(tile-([1-7]|none)|grad-[a-z]+|#[0-9a-fA-F]{6})$/.test(token)) {
      return { ok: false, error: 'That is not a colour this app can store.' }
    }
    sets.push('image_color = ?')
    params.push(token)
  }

  if (sets.length === 0) return { ok: true }

  await siteExecute(siteId, `UPDATE products SET ${sets.join(', ')} WHERE id = ?`, [
    ...params,
    productId,
  ])
  return { ok: true }
}
