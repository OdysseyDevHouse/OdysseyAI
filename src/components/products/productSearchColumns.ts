import type { ColumnOption } from '@/components/ui/ColumnPicker'

/**
 * One row of the product search pop-up, and every column it can show.
 *
 * ── WHY ITS OWN FILE ─────────────────────────────────────────────────────
 *
 * The server action needs the catalogue (to filter a stored set) and so does
 * the client dialog (to render the picker and the grid). Declaring it beside
 * the dialog would mean a `'use server'` module importing from a `'use client'`
 * one, which drags that module into the server graph — the route 500s at
 * request time while tsc and the build stay green. Plain data that both sides
 * read lives in a plain module. Same convention as products/columns.ts.
 *
 * ── WHY NOT JUST IMPORT PRODUCT_COLUMNS ──────────────────────────────────
 *
 * Because the brief is that the two must NOT share a set: hiding GP% while
 * pricing must not also hide it while invoicing. Sharing the catalogue would
 * be the first step towards sharing the answer — the store row is keyed by the
 * catalogue's owner, and one list of ids is one list of ids. The two overlap
 * heavily today and are free to diverge, which is the point: this picker will
 * grow columns (supplier, last cost paid) that the catalogue screen has no
 * reason to carry.
 */

/**
 * A product as the picker renders it: plain values only.
 *
 * Deliberately flat. The domain `Product` carries Dates — which a site pool
 * parses as UTC, so one crossing this boundary would be re-read in the
 * viewer's timezone — plus a prices array and a good deal else the grid never
 * reads. Every date here is a string the server already formatted.
 *
 * The money and margin fields are `null` rather than absent when the role
 * cannot read a cost, so the shape stays one type and the grid has one thing
 * to test. Null also means "not applicable": a variant PARENT is never bought
 * and prices per child, so its cost and price are null rather than a zero that
 * would read as free.
 */
export type ProductSearchRow = {
  id: number
  code: string
  description: string
  barcode: string | null
  departmentId: number | null
  productType: string
  /** The tile token, for RowGlyph. */
  imageColor: string | null
  /** Whether there is a picture to fetch from /api/product-icon/[id]. */
  hasImage: boolean
  hasVariants: boolean
  variantCount: number
  parentId: number | null
  isArchived: boolean

  cost: number | null
  costIncl: number | null

  sellExcl: number | null
  priceIncl: number | null
  gpValue: number | null
  gp: number | null
  maxDiscountPct: number

  stockOnHand: number
  belowMinimum: boolean
  minStock: number | null
  maxStock: number | null

  packSize: number
  packDescription: string | null
  packWeight: number
  weightDescription: string | null

  lastSold: string
  lastPurchase: string
  lastAdjust: string
  lastStockTake: string
  edited: string
  created: string
}

/**
 * Every column the picker can show, and what to call it.
 *
 * `locked` is the column the grid is meaningless without: Product carries the
 * description WITH its code underneath, and a row with neither identifies
 * nothing — it is also the cell you click to pick a single product, so hiding
 * it would remove the interaction. `group` gives the picker its headings.
 *
 * Order here is the order the grid renders in.
 */
export const PRODUCT_SEARCH_COLUMNS: ColumnOption[] = [
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

/** Every id, for filtering a stored set against what the grid still knows. */
export const PRODUCT_SEARCH_COLUMN_IDS = PRODUCT_SEARCH_COLUMNS.map((c) => c.id)

/**
 * What a store sees before it has chosen anything.
 *
 * Narrower than the catalogue screen's default, and on purpose. Someone in this
 * dialog has already decided what they are looking for and is answering one
 * question: is this the right product, and is there any of it. Cost and margin
 * are not that question — they are still one tick away, and still gated by
 * `products.cost` on top, but they are not what the picker leads with.
 */
export const PRODUCT_SEARCH_DEFAULT_COLUMNS = [
  'description',
  'department',
  'stock',
  'price',
]
