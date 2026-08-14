// `import type` and not a value import: permissions.ts is server-only, and this
// module is read by the wizard in the browser. A type import is erased at
// compile time, so the server-only module never reaches the client bundle.
import type { Capability } from '@/lib/site/permissions'

/**
 * What an importable thing looks like.
 *
 * ── THE SHAPE, AND WHY ───────────────────────────────────────────────────
 *
 * An `ImportField` is the inbound mirror of `ExportColumn` in
 * `@/lib/export/table`. Where an export column is `(row) => cell`, an import
 * field is `(cell, lookups) => value | problem`, plus the aliases and
 * requiredness only the inbound direction needs.
 *
 * One array of these drives FOUR things: auto-mapping (aliases), the mapping
 * screen (label, required, hint), validation (parse), and the downloadable
 * template (label, example). That is deliberate. A column offered on the
 * mapping screen with nothing behind it that reads it, or a template heading
 * no alias matches, are both bugs that cannot happen if all four read the same
 * array — the same property `ProductBulkChange`'s `kind` gives the bulk dialog.
 *
 * It also closes the round trip: export a product list, edit it in Excel,
 * import it back, and every heading matches an alias by construction.
 *
 * ── WHY `parse` IS PURE AND SYNCHRONOUS ──────────────────────────────────
 *
 * Because a 20,000-row file has to validate in one pass with no queries. Every
 * lookup a field could need is already in `LookupTables`, loaded once per run.
 * A `parse` that could await would invite a per-row SELECT, and 20k rows times
 * four lookups is 80,000 round trips — the difference between a preview that
 * appears and one that times out.
 *
 * Purity buys the second thing too: the identical function runs in the browser
 * to preview the file and on the server before anything is written. That is
 * what makes the server-side re-check meaningful rather than ceremony.
 */

/** One cell's worth of source data, with where it came from. */
export type Cell = {
  /** Trimmed text. Never null — an empty cell is ''. */
  text: string
  /** 1-based row number in the SOURCE FILE, header included, for reporting. */
  line: number
}

/**
 * What a field's parse produced.
 *
 * `skip` is not the same as a value of undefined, and the difference matters
 * more than it looks. A blank cell in a partial file means "this file does not
 * speak to this column", which on an update must leave the stored value alone.
 * Returning undefined would be indistinguishable from the field being absent,
 * and `updateProduct` treats an absent field as a DEFAULT rather than as
 * "leave it" — absent `lastCost` becomes 0.0000, absent `weightDescription`
 * becomes 'Kg'. So a blank has to be a value of its own that the merge step
 * can recognise and refuse to write. See `merge.ts`.
 */
export type FieldOutcome<V> =
  | { kind: 'value'; value: V }
  | { kind: 'skip' }
  | { kind: 'problem'; reason: string }

export const VALUE = <V>(value: V): FieldOutcome<V> => ({ kind: 'value', value })
export const SKIP: FieldOutcome<never> = { kind: 'skip' }
export const PROBLEM = (reason: string): FieldOutcome<never> => ({ kind: 'problem', reason })

/**
 * Everything resolved once per run and shared by every row.
 *
 * Pre-loaded, never queried per row — see the note on `parse` above. Keys are
 * normalised (lower-cased, trimmed) because a spreadsheet writes 'FRESH
 * PRODUCE' where the tree holds 'Fresh Produce' and they are the same
 * department.
 */
export type LookupTables = {
  /** By full ' › ' path, and by bare leaf name where that name is unique. */
  departmentByPath: Map<string, number>
  /** Leaf names used by more than one department — a bare name cannot resolve. */
  departmentAmbiguous: Set<string>
  brandByName: Map<string, number>
  /** Keyed by code and by name, separately per VAT type. */
  vatSalesByCode: Map<string, number>
  vatPurchaseByCode: Map<string, number>
  priceStructureByName: Map<string, number>
  locationByCode: Map<string, number>
  supplierByCode: Map<string, number>
  customerGroupByName: Map<string, number>
  salesRepByName: Map<string, number>
  /**
   * Product id by barcode — main barcodes AND the 143 aliases together.
   *
   * Main barcodes are deliberately not unique ("several products may share
   * one"), so a shared barcode goes into `barcodeAmbiguous` instead: a row
   * naming it is asked for the product code rather than silently filed
   * against whichever product loaded first.
   */
  productIdByBarcode: Map<string, number>
  barcodeAmbiguous: Set<string>
  /**
   * Every existing code for THIS entity, upper-cased, for create-vs-update.
   *
   * Built from a raw query that includes closed/archived records. The list
   * helpers exclude 'closed' by default and clamp to 500 rows, so using one
   * here would miss a closed account, try to create a duplicate code, and hand
   * the user a bare "already in use" with nothing to explain it.
   */
  existingIdByCode: Map<string, number>
  /** Decided once for the whole file — see `detectDateFormat`. */
  dateFormat: string | null
}

export function emptyLookups(): LookupTables {
  return {
    departmentByPath: new Map(),
    departmentAmbiguous: new Set(),
    brandByName: new Map(),
    vatSalesByCode: new Map(),
    vatPurchaseByCode: new Map(),
    priceStructureByName: new Map(),
    locationByCode: new Map(),
    supplierByCode: new Map(),
    customerGroupByName: new Map(),
    salesRepByName: new Map(),
    productIdByBarcode: new Map(),
    barcodeAmbiguous: new Set(),
    existingIdByCode: new Map(),
    dateFormat: null,
  }
}

/** What kind of existing data a field resolves against, for the review screen. */
export type LookupKind =
  | 'department' | 'brand' | 'vat' | 'supplier' | 'priceList'
  | 'location' | 'customerGroup' | 'salesRep'

/**
 * One importable column.
 *
 * `T` is the entity's draft type — a partial, string-parsed shape, not the
 * entity itself. The draft is what crosses the wire between the browser and
 * each apply batch.
 */
export type ImportField<T> = {
  /** Key on the draft. Also the stable id a saved mapping refers to. */
  key: string
  /** Heading in the template, and the label on the mapping screen. */
  label: string
  /**
   * Accepted headings. Compared through `normaliseHeader`, so spacing,
   * capitalisation and punctuation do not matter. The FIRST entry is what the
   * template writes, so it should be the friendliest spelling.
   */
  aliases: readonly string[]
  /** The plan refuses the whole file when no column maps to this. */
  required?: boolean
  /** Descriptive: groups unresolved values on the review screen. */
  lookup?: LookupKind
  /**
   * Whether a blank cell CLEARS the stored value rather than leaving it.
   *
   * Off by default, and the default is the safe one: a sheet where some rows
   * carry a barcode and some do not must not wipe the barcode off every row
   * that merely left it blank. Turn on only where clearing is a coherent
   * instruction the user would expect.
   */
  blankClears?: boolean
  /** One line under the label on the mapping screen. Not a tooltip. */
  hint?: string
  /** What the template's example row shows in this column. */
  example?: string
  parse: (cell: Cell, lookups: LookupTables) => FieldOutcome<unknown>
}

/**
 * A family of columns that only exists once the site's own data is known.
 *
 * A site with four price structures and three locations has four price columns
 * and six min/max columns that another site does not have, so these cannot be
 * written down statically. Expanded once per run, after the lookups load.
 */
export type ImportFieldGroup<T> = (lookups: LookupTables) => ImportField<T>[]

/** How a row that matches an existing record is treated. Chosen per run. */
export type ExistingMode = 'skip' | 'update'

/** What happened to one row. The unit the whole run reports in. */
export type RowOutcome = {
  /** Source file line, so a message names the row the user can go and look at. */
  line: number
  /** The match key's value, so a message can name the row without the row. */
  code: string
  status: 'created' | 'updated' | 'skipped' | 'failed'
  reason?: string
  /**
   * The record written, on a create.
   *
   * Fed back into `existingIdByCode` so a code repeated later in the same run
   * is recognised as existing rather than colliding on the unique index with a
   * message the user cannot act on.
   */
  id?: number
  /**
   * Sub-steps that failed on a row whose record was still written.
   *
   * Non-empty means the record exists but is incomplete — a product created
   * without its supplier link. Reported rather than swallowed, and counted
   * separately from both success and failure, because it is neither.
   */
  warnings?: { step: string; reason: string }[]
}

/** Everything an apply step needs that is not the rows themselves. */
export type ApplyContext = {
  siteId: number
  actor: { userId: number; userName: string }
  /**
   * Mutable for the life of one batch: a department walked into existence on
   * row 12 is written straight back so row 900 naming the same path resolves
   * from memory instead of re-querying — and so two rows naming one new path
   * cannot create it twice.
   */
  lookups: LookupTables
  /** Which draft keys the FILE actually mapped. Drives the merge. See merge.ts. */
  mapped: ReadonlySet<string>
}

export type ImportSpec<TDraft> = {
  /** Stable id in the URL and the registry: 'products', 'customers', … */
  entity: string
  /** 'Products' — headings, template filename. */
  title: string
  /** 'product' — for '3 products created'. */
  singular: string
  /** One line on the index screen saying what this import is for. */
  description: string
  capability: Capability
  fields: readonly ImportField<TDraft>[]
  groups?: readonly ImportFieldGroup<TDraft>[]
  /** The draft key identifying an existing record. 'code' for everything today. */
  matchKey: string
  loadLookups: (siteId: number) => Promise<LookupTables>
  /**
   * Folds a flat row of columns into whatever shape the record wants.
   *
   * A mapping is per COLUMN, so the plan produces one key per column — a
   * product's `price:3` and `min:1`. A record wants `prices` and `levels` as
   * objects. This runs between the two, so neither has to know about the
   * other's shape. Runs before `validateRow`, which therefore sees the nested
   * form.
   */
  nest?: (draft: Record<string, unknown>) => Record<string, unknown>
  /**
   * Cross-field checks one field cannot make on its own — 'a non-active status
   * needs a reason', 'min may not exceed max'. Runs after every field parses.
   */
  validateRow?: (draft: Record<string, unknown>, lookups: LookupTables) => string | null
  /** Writes one row. Absent on document specs, which only ever plan. */
  applyRow?: (
    ctx: ApplyContext,
    draft: Record<string, unknown>,
    existingId: number | null,
    mode: ExistingMode,
  ) => Promise<RowOutcome>
}

/** Every field a run has, static and expanded, in template/mapping order. */
export function fieldsFor<T>(spec: ImportSpec<T>, lookups: LookupTables): ImportField<T>[] {
  return [
    ...spec.fields,
    ...(spec.groups ?? []).flatMap((group) => group(lookups)),
  ]
}
