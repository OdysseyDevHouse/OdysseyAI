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
 *
 * The PICTURE is a different matter and does ride along — see below.
 */
export type Department = {
  id: number
  parentId: number | null
  name: string
  sortOrder: number
  /**
   * The till picture a manager chose for this department (064's `pos_image_id`),
   * or null where nobody has set one — which is most departments, so the derived
   * tone and its glyph remain the fallback rather than an error case.
   *
   * This is NOT the same kind of thing as `color`, which is excluded above: a
   * colour is a stored HEX that a component would have to paint itself with,
   * bypassing the tokens. A picture is an id the till turns into a URL, and the
   * tone underneath it is still derived. Nothing here paints from stored bytes.
   *
   * The id rather than a URL for the reason TillProduct.imageIcon gives: a URL
   * baked into the payload goes stale when the route moves, and the offline
   * catalogue would cache the stale one.
   */
  posImageId: number | null
}
