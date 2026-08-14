/**
 * The kinds of thing a product can be.
 *
 * The type decides how a sale moves stock, which is why it is a single stored
 * value rather than a set of independent flags — an item cannot both deduct and
 * add quantity on sale, and modelling it as booleans would allow that
 * contradiction to be saved.
 *
 * `id` is the value stored in products.product_type. Adding a type here is
 * enough for the form to offer it; the stock behaviour it describes lives with
 * whatever processes sales.
 */

export type ProductTypeId =
  | 'normal'
  | 'returnable'
  | 'service'
  | 'recipe'
  | 'refer'
  | 'serial'
  | 'buyout'
  | 'calcqty'
  | 'gift_card'
  | 'batch'

export type ProductTypeOption = {
  id: ProductTypeId
  name: string
  description: string
  /** Label for the type's own setup screen, where it has one. */
  setupLabel?: string
  /** Shown as a badge — the type is only usable on the online store. */
  onlineOnly?: boolean
}

export const PRODUCT_TYPES: ProductTypeOption[] = [
  {
    id: 'normal',
    name: 'Normal product',
    description:
      'A standard stocked item. Each sale reduces the quantity on hand by the amount sold.',
  },
  {
    id: 'returnable',
    name: 'Returnable product',
    description:
      'Tracks returnable items such as deposits or containers. Each sale increases the quantity on hand by the amount sold.',
  },
  {
    id: 'service',
    name: 'Service product',
    description:
      'A non-stocked item, such as a service or labour charge. It carries no stock on hand, which always remains zero.',
  },
  {
    id: 'recipe',
    name: 'Recipe product',
    description:
      'An item built from a recipe of linked ingredients. Each sale automatically deducts the component ingredients from stock.',
    setupLabel: 'Setup recipe',
  },
  {
    id: 'refer',
    name: 'Refer product',
    description:
      'Links one product to another for sale, for example a single unit to a six-pack or case.',
    setupLabel: 'Setup refer codes',
  },
  {
    id: 'serial',
    name: 'Serial product',
    description:
      'An item identified by a unique serial number. Link individual serial numbers to track each unit through to sale.',
    setupLabel: 'Setup serial numbers',
    onlineOnly: true,
  },
  {
    id: 'buyout',
    name: 'Buy-out product',
    description:
      'An item bought in for a specific order rather than kept in stock. Purchased as needed, so no quantity is carried.',
  },
  {
    id: 'calcqty',
    name: 'Calculate QTY product',
    description:
      'The quantity sold is worked out at the till from the amount entered, rather than typed in directly.',
  },
  {
    id: 'gift_card',
    name: 'Gift card',
    description:
      'Sells stored value. The till asks for the card number and the amount; no stock is carried, and the sale posts to the gift card liability rather than revenue.',
  },
  {
    id: 'batch',
    name: 'Batch-tracked product',
    description:
      'A stocked item tracked per lot, with an optional expiry date. Receipts capture the batch number; sales take the earliest expiry first automatically.',
    setupLabel: 'Batches',
  },
]

const IDS = new Set<string>(PRODUCT_TYPES.map((t) => t.id))

export const DEFAULT_PRODUCT_TYPE: ProductTypeId = 'normal'

/**
 * Narrows an arbitrary stored or submitted value to a known type.
 *
 * Falls back to 'normal' rather than throwing: an unrecognised value in an old
 * row should render an editable form, not break the page.
 */
export function toProductType(value: unknown): ProductTypeId {
  const raw = String(value ?? '').trim().toLowerCase()
  return IDS.has(raw) ? (raw as ProductTypeId) : DEFAULT_PRODUCT_TYPE
}
