import { formatQty } from './decimals'
import type { ProductTypeId } from './productTypes'

/**
 * How a product search result describes its own stock.
 *
 * Lives here rather than beside the till screen because two screens now search
 * the same catalogue — the till and the invoice editor — and a shop that reads
 * "none on hand" at the counter but nothing at all on an invoice would be
 * getting two different answers to one question.
 *
 * Deliberately not in lib/site/tillSearch.ts, which is `server-only`: this is
 * presentation, and both callers are client components.
 */

/** Product types that carry no quantity, so stock never applies to them. */
const UNSTOCKED: ReadonlySet<string> = new Set(['service', 'buyout'])

/** The fields a stock note needs. Structural, so both callers' types satisfy it. */
export type StockNoteProduct = {
  productType: ProductTypeId
  stockOnHand: number
  reservedQty: number
  availableQty: number
}

/**
 * The stock note beside a search result, or nothing at all.
 *
 * Silent when there is plenty and none of it is spoken for — which is the
 * overwhelmingly common case, and a note on every line is a note nobody reads.
 * It speaks up for the two situations that change what should be said to the
 * customer: some of this is promised to someone else, or there is none.
 */
export function stockNote(product: StockNoteProduct): string {
  if (UNSTOCKED.has(product.productType)) return ''

  if (product.reservedQty > 0) {
    return ` · ${formatQty(product.availableQty)} available of ${formatQty(product.stockOnHand)} (${formatQty(product.reservedQty)} on order)`
  }
  if (product.stockOnHand <= 0) return ' · none on hand'
  return ''
}
