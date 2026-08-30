import type { ColumnOption } from '@/components/ui/ColumnPicker'

/**
 * Every column the products list can show, and what to call it in the picker.
 *
 * ── WHY ITS OWN FILE ─────────────────────────────────────────────────────
 *
 * The server page needs the catalogue (to filter a stored set) and so does the
 * client table (to render the picker). Declaring it beside the table meant the
 * page importing from a `'use client'` module, which drags that module into the
 * server graph — the page 500s at request time while tsc and the build stay
 * green. Plain data that both sides read lives in a plain module.
 *
 * Declared separately from the Column<T> array rather than derived from it
 * because a Column's `header` is a ReactNode and one of them is already a
 * conditional string — there is nothing there a picker can label itself with.
 * Same convention as PURCHASE_COLUMNS beside the purchasing grid.
 *
 * `locked` is the column a product list is meaningless without: the Product
 * column carries the description WITH its code underneath, and a row with
 * neither identifies nothing. There is no separate `code` option because there
 * is no separate code column to hide. `group` gives the picker its headings.
 *
 * Order here is the order the table renders in. It is NOT stored per store — a
 * list whose columns come out in a different order in each shop is a support
 * call nobody can reproduce.
 */
export const PRODUCT_COLUMNS: ColumnOption[] = [
  { id: 'description', label: 'Description and code', group: 'Identity', locked: true },
  { id: 'barcode', label: 'Barcode', group: 'Identity' },
  { id: 'department', label: 'Department', group: 'Identity' },
  { id: 'productType', label: 'Product type', group: 'Identity' },

  { id: 'cost', label: 'Cost excl.', group: 'Cost' },
  { id: 'costIncl', label: 'Cost incl.', group: 'Cost' },

  { id: 'sellExcl', label: 'Selling excl.', group: 'Pricing' },
  { id: 'price', label: 'Selling incl.', group: 'Pricing' },
  { id: 'gpValue', label: 'GP value', group: 'Pricing' },
  { id: 'gp', label: 'GP %', group: 'Pricing' },
  { id: 'maxDiscount', label: 'Max discount %', group: 'Pricing' },

  { id: 'stock', label: 'On hand', group: 'Stock' },
  { id: 'minStock', label: 'Minimum level', group: 'Stock' },
  { id: 'maxStock', label: 'Maximum level', group: 'Stock' },

  { id: 'packSize', label: 'Pack size', group: 'Pack' },
  { id: 'packDescription', label: 'Pack description', group: 'Pack' },
  { id: 'packWeight', label: 'Pack weight', group: 'Pack' },
  { id: 'weightDescription', label: 'Weight unit', group: 'Pack' },

  { id: 'lastSold', label: 'Last sold', group: 'Dates' },
  { id: 'lastPurchase', label: 'Last received', group: 'Dates' },
  { id: 'lastAdjust', label: 'Last adjusted', group: 'Dates' },
  { id: 'lastStockTake', label: 'Last stock take', group: 'Dates' },
  { id: 'edited', label: 'Last edit', group: 'Dates' },
  { id: 'created', label: 'Date created', group: 'Dates' },
]

/** Every id, for filtering a stored set against what the table still knows. */
export const PRODUCT_COLUMN_IDS = PRODUCT_COLUMNS.map((c) => c.id)

/**
 * What a store sees before it has chosen anything.
 *
 * The list as it was before this feature existed, so an upgrade changes nothing
 * until somebody opens the picker. Cost and GP stay in the set and are still
 * gated by the permission on top — being in the default does not grant anybody
 * sight of a cost.
 */
export const PRODUCT_DEFAULT_COLUMNS = [
  'description',
  'department',
  'cost',
  'price',
  'gp',
  'stock',
]
