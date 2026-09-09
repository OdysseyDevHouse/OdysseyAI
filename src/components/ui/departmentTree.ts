import { toneForId } from './CategoryTile'
import { toneForTileToken } from './tiles'
import type { TreeSelectOption } from './TreeSelect'

/**
 * The department rows a `<TreeSelect>` needs, built once for every screen that
 * filters by department.
 *
 * ── WHY A SHARED BUILDER AND NOT A MAP AT EACH CALL SITE ──────────────────
 *
 * Six screens offer this filter — the products list, bulk pricing, the online
 * store's product list, the product search dialog, purchasing's picker and the
 * shop builder's — and they must agree about three things a call site is easy
 * to get wrong: which tone a department carries (it has to be the same colour
 * here as on the till, or the colour stops being learnable), where its picture
 * is served from, and what happens to a department whose parent is missing.
 *
 * Plain data only, and no 'use client': a Server Component builds this array
 * and passes it across the boundary, and the two dialogs build the same array
 * in the browser from what an action returned.
 */
export type DepartmentTreeInput = {
  id: number
  parentId: number | null
  name: string
  /**
   * The stored tile token, if the shop picked one. Null takes the derived hue.
   *
   * Required rather than optional, along with `imageId` below: both are
   * OPTIONAL-looking properties whose absence renders perfectly — a grey tile
   * with a tag on it — so a call site that forgot to map them would look merely
   * plain rather than broken, and nobody would find it.
   */
  color: string | null
  /**
   * The department's picture, as an id into `storefront_images`, or null.
   *
   * The id of the picture, not of the department: a department holds two of
   * them — one for the till, one for the shop — and only the caller knows which
   * of the two its screen is about. Served through /api/storefront-images,
   * which addresses the library and so can hand back either.
   */
  imageId: number | null
  /** Products under it, shown at the row's right edge when a caller has it. */
  count?: number
}

export function departmentTreeOptions(
  departments: readonly DepartmentTreeInput[],
  {
    allLabel = 'All departments',
    allHref,
    hrefFor,
  }: {
    /** The clear-the-filter row, always first. */
    allLabel?: string
    /** Where clearing goes, for a filter living in the URL. */
    allHref?: string
    /** Where picking one goes. Omit for a filter held in React state. */
    hrefFor?: (id: number) => string
  } = {},
): TreeSelectOption[] {
  const present = new Set(departments.map((d) => d.id))

  return [
    /* An ordinary top-level row that happens to clear the filter — not a
       special case inside TreeSelect, so it scrolls, highlights and carries a
       tick like any other choice. */
    { value: '', label: allLabel, parent: null, href: allHref },
    ...departments.map((d) => ({
      value: String(d.id),
      /* This level's name alone. The full path is the tooltip TreeSelect builds
         by walking `parent`, so a menu never repeats "Drinks > Beer >" on every
         row of the Beer level. */
      label: d.name,
      /* A department whose parent is not in this list is shown at the top level
         rather than dropped. Callers filter — the products list hides inactive
         departments — and a live child under a hidden parent would otherwise
         group under a key nothing renders and vanish from the menu entirely. */
      parent: d.parentId !== null && present.has(d.parentId) ? String(d.parentId) : null,
      tone: toneForTileToken(d.color) ?? toneForId(d.id),
      image: d.imageId == null ? null : `/api/storefront-images/${d.imageId}`,
      count: d.count,
      href: hrefFor?.(d.id),
    })),
  ]
}
