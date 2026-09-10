/**
 * Which tab the product form is showing.
 *
 * Its own module rather than a ProductForm export because BOTH sides need it:
 * the form to hold the tab in state, and the server page to read the `?tab=`
 * that the save redirect wrote. A `'use client'` module's exports are client
 * references — the server may render its components but cannot call its
 * functions — so exporting `toTabValue` from the form itself typechecked
 * cleanly and then failed at request time with "Attempted to call toTabValue()
 * from the server but toTabValue is on the client".
 *
 * Same shape and same reason as productTypes.ts next door.
 */

export const PRODUCT_TABS = [
  'general',
  'properties',
  'instructions',
  'suppliers',
  'recipe',
  'refer',
  'serials',
  'linked',
  'reporting',
] as const

export type ProductTab = (typeof PRODUCT_TABS)[number]

/** The tab a first visit opens on, and the fallback for anything unrecognised. */
export const DEFAULT_PRODUCT_TAB: ProductTab = 'general'

/**
 * Reads a tab id off a URL.
 *
 * Validated rather than trusted, for the same reason `from` is: it arrives in
 * a typeable URL and is fed straight into the state that picks a panel. A tab
 * that no longer exists — or one for a panel this product does not have, like
 * Serials on a normal product — falls back to General, which is the same place
 * a first visit lands.
 */
export function toProductTab(value: string | null | undefined): ProductTab {
  /* Kitchen printing had a tab of its own until it moved in with the rest of
     the properties. A bookmark or a back button still carrying `?tab=kitchen`
     lands where the panel actually IS now, rather than on General with the
     thing it was opened for two tabs away. */
  if (value === 'kitchen') return 'properties'
  return PRODUCT_TABS.includes(value as ProductTab) ? (value as ProductTab) : DEFAULT_PRODUCT_TAB
}
