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

/**
 * Which shelf of the picker a type sits on.
 *
 * Ten types in one flat column is a list nobody reads to the end of. Grouping
 * them by what they DO to stock — carries it, is special about it, or has none
 * — means the person choosing can skip two thirds of the list on sight.
 */
export type ProductTypeGroup = 'stocked' | 'special' | 'other'

export const PRODUCT_TYPE_GROUPS: { id: ProductTypeGroup; name: string }[] = [
  { id: 'stocked', name: 'Stocked' },
  { id: 'special', name: 'Special' },
  { id: 'other', name: 'Non-stock / Other' },
]

export type ProductTypeOption = {
  id: ProductTypeId
  name: string
  /**
   * One line, for the picker. What the type IS, in the time it takes to scan
   * past it — the full behaviour is in `description` and is read once, by
   * whoever is deciding rather than whoever is skimming.
   */
  summary: string
  description: string
  group: ProductTypeGroup
  /** Label for the type's own setup screen, where it has one. */
  setupLabel?: string
}

export const PRODUCT_TYPES: ProductTypeOption[] = [
  {
    id: 'normal',
    name: 'Normal product',
    group: 'stocked',
    summary: 'A standard stocked item.',
    description:
      'A standard stocked item. Each sale reduces the quantity on hand by the amount sold.',
  },
  {
    id: 'returnable',
    name: 'Returnable product',
    group: 'stocked',
    summary: 'Tracks returnable items like deposits or containers.',
    description:
      'Tracks returnable items such as deposits or containers. Each sale increases the quantity on hand by the amount sold.',
  },
  {
    id: 'service',
    name: 'Service product',
    group: 'other',
    summary: 'A non-stock item like a service or labour charge.',
    description:
      'A non-stocked item, such as a service or labour charge. It carries no stock on hand, which always remains zero.',
  },
  {
    id: 'recipe',
    name: 'Recipe product',
    group: 'stocked',
    summary: 'Built from a recipe of linked ingredients.',
    description:
      'An item built from a recipe of linked ingredients. Each sale automatically deducts the component ingredients from stock.',
    setupLabel: 'Setup recipe',
  },
  {
    id: 'refer',
    name: 'Refer product',
    group: 'stocked',
    summary: 'Links one product to another for sale.',
    description:
      'Links one product to another for sale, for example a single unit to a six-pack or case.',
    setupLabel: 'Setup refer codes',
  },
  {
    id: 'serial',
    name: 'Serial product',
    group: 'special',
    summary: 'Track individual serial numbers for each unit.',
    description:
      'An item identified by a unique serial number. Link individual serial numbers to track each unit through to sale.',
    setupLabel: 'Setup serial numbers',
  },
  {
    id: 'buyout',
    name: 'Buy-out product',
    group: 'special',
    summary: 'Purchased for a specific order instead of kept in stock.',
    description:
      'An item bought in for a specific order rather than kept in stock. Purchased as needed, so no quantity is carried.',
  },
  {
    id: 'calcqty',
    name: 'Calculate QTY product',
    group: 'special',
    summary: 'Quantity worked out at the till from an amount entered.',
    description:
      'The quantity sold is worked out at the till from the amount entered, rather than typed in directly.',
  },
  {
    id: 'gift_card',
    name: 'Gift card',
    group: 'special',
    summary: 'Sells stored value on a card; not tracked as stock.',
    description:
      'Sells stored value. The till asks for the card number and the amount; no stock is carried, and the sale posts to the gift card liability rather than revenue.',
  },
  {
    id: 'batch',
    name: 'Batch-tracked product',
    group: 'stocked',
    summary: 'Stocked item tracked per batch/lot, with optional expiry dates.',
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
