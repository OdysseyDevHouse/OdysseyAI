/**
 * Shapes the till's own panes pass between themselves.
 *
 * Plain types with no imports from a server module, so both a client component
 * and a pure test can use them. Anything that already has a home elsewhere —
 * BasketLine, TillProduct, TenderType, Special — is imported from there rather
 * than restated here: a second declaration of a shape is a second thing to keep
 * in step.
 */

/**
 * A department as the till sees it.
 *
 * Narrower than lib/site/departments' `Department` on purpose. The till needs to
 * draw a rail and drill a tree, which takes an id, a parent, a name and an order.
 * It deliberately does NOT carry `color`: that column stores a hex string, and a
 * tile painting itself from one would put a raw colour into a component, which the
 * design system does not allow. Tile colour comes from `toneForId`.
 */
export type Department = {
  id: number
  parentId: number | null
  name: string
  sortOrder: number
}
