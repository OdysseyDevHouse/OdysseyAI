'use server'

import { requireSiteId, actorFor, actorForOrThrow } from '@/lib/auth'
import { searchProductsForPicker, type ProductPick } from '@/lib/site/products'
import { listSuppliers } from '@/lib/site/suppliers'

/**
 * Lookups for the pickers on the product form.
 *
 * Server actions rather than route handlers: they are only ever called by this
 * one form, they inherit the session's site the same way every other action
 * does, and adding an API route would mean re-doing that auth by hand.
 */

export async function searchProductsAction(
  search: string,
  exclude?: number,
): Promise<ProductPick[]> {
  const ctx = await actorForOrThrow('products.view')
  const { siteId } = ctx
  return searchProductsForPicker(siteId, { search, exclude, limit: 20 })
}

/**
 * The same picks, fetched by id.
 *
 * For the big search dialog: its rows are shaped for a grid and carry no cost
 * (cost is capability-gated there), but a recipe line must be costed whoever
 * added it. The panel sends back what was ticked and gets whole picks.
 *
 * `exclude` is honoured so a recipe still cannot list itself, even if the
 * dialog offered the row — the save path refuses it too.
 */
export async function productPicksByIdAction(
  ids: number[],
  exclude?: number,
): Promise<ProductPick[]> {
  const ctx = await actorForOrThrow('products.view')
  const { siteId } = ctx
  // Guard the input rather than trusting the client's array: this is a live
  // endpoint, and a junk id here would otherwise reach the query as NaN.
  const clean = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
  return searchProductsForPicker(siteId, { ids: clean, exclude })
}

export type SupplierPick = { id: number; code: string; name: string; canOrder: boolean }

export async function searchSuppliersAction(search: string): Promise<SupplierPick[]> {
  const ctx = await actorForOrThrow('products.view')
  const { siteId } = ctx
  // listSuppliers already drops closed accounts when no statuses are named,
  // which is what we want: linking a product to an account nobody may order
  // against is a trap rather than a choice.
  const { items } = await listSuppliers(siteId, { search, limit: 20 })
  return items.map((s) => ({ id: s.id, code: s.code, name: s.name, canOrder: s.canOrder }))
}
