'use server'

import { requireSiteId } from '@/lib/auth'
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
  const siteId = await requireSiteId()
  return searchProductsForPicker(siteId, { search, exclude, limit: 20 })
}

export type SupplierPick = { id: number; code: string; name: string; canOrder: boolean }

export async function searchSuppliersAction(search: string): Promise<SupplierPick[]> {
  const siteId = await requireSiteId()
  // listSuppliers already drops closed accounts when no statuses are named,
  // which is what we want: linking a product to an account nobody may order
  // against is a trap rather than a choice.
  const { items } = await listSuppliers(siteId, { search, limit: 20 })
  return items.map((s) => ({ id: s.id, code: s.code, name: s.name, canOrder: s.canOrder }))
}
