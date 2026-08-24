import type { ColumnType } from './spec'
import type { Capability } from '../site/permissions'
import { LINE_KINDS } from '../jobStatusModel'
import { ACCOUNT_TYPES } from '../accountTypes'

/**
 * The report builder's FIELD CATALOG — the whitelist of everything anyone is
 * allowed to put in a report they build themselves.
 *
 * ── THIS FILE IS THE SECURITY BOUNDARY ────────────────────────────────────────
 *
 * A spec arriving from the browser never carries SQL, a table name, or a column
 * name. The client sends field KEYS; the server looks each key up here and uses
 * the catalog's own `expr`. Filter VALUES are the only user text that reaches
 * the database, and they are always bound as `?` parameters, never interpolated.
 * The AI path follows the identical rule (lib/site/askReport.ts): the model
 * picks intent, this file owns every byte of SQL.
 *
 * Consequently: adding a field here is a one-line change that appears in the
 * builder immediately, and a field that is NOT here cannot be reached by any
 * report, however the spec was composed.
 *
 * ── PERMISSIONS ───────────────────────────────────────────────────────────────
 *
 * Two levels, because "may open the reports screen" and "may see what we paid
 * for stock" are different questions:
 *
 *   SOURCE-level (`permission`) — the capability needed to query the dataset at
 *   all. Someone without customers.view cannot build a customer report, so the
 *   builder is not a way around the screens they are already denied.
 *
 *   FIELD-level (`permission`) — a capability needed for one column. Cost and
 *   margin fields carry products.cost, so a user without it gets the report
 *   with those columns silently absent rather than an error. Silence is right
 *   here: a saved report shared across a shop will be opened by people with
 *   different rights, and it should degrade for the junior rather than break.
 *
 * ── SHAPES ────────────────────────────────────────────────────────────────────
 *
 *   SNAPSHOT — describes the business as it is NOW (products, customers). The
 *   report's date range does NOT filter these; a stock-on-hand figure has no
 *   date. Date fields on a snapshot (last sold, created) are still filterable
 *   as ordinary fields.
 *
 *   TIMELINE — a dated record of things that happened (sales, movements,
 *   ledger entries). The date range applies, via `dateColumn`.
 *
 * Unlike the POS build this was modelled on, there are no monthly history
 * partitions here: one site, one database, one table per source. That removes
 * the entire partition-sweep and partial-aggregate-merge machinery, so a
 * summarised report is a single GROUP BY the database executes itself.
 *
 * ── JOINS ─────────────────────────────────────────────────────────────────────
 *
 * Joins are declared as NAMED UNITS and pulled in ON DEMAND: a unit is added
 * only when a selected, filtered or grouped field declares it in `needs`. So a
 * report of product codes and quantities reads one table, while asking for the
 * department adds exactly the one lookup that answers it. Units may depend on
 * each other's aliases — declare both in `needs` and they are emitted in
 * catalog order.
 */

/* ── field + source metadata ───────────────────────────────────────────────── */

/** Section headings in the field picker — presentational grouping only. */
export const FIELD_GROUPS = {
  IDENTITY: 'Identity',
  CLASSIFICATION: 'Classification',
  PEOPLE: 'People',
  QUANTITIES: 'Quantities',
  MONEY: 'Money',
  COST: 'Cost and margin',
  TENDER: 'Tender',
  DATES: 'Dates',
  FLAGS: 'Yes / no',
  TIME: 'Time periods',
  PRODUCT: 'Current product details',
  ACCOUNT: 'Account details',
  AGEING: 'Balance and ageing',
  OTHER: 'Other',
} as const

/** How a catalog field behaves — drives the UI, the SQL and the formatting. */
export interface CatalogField {
  /** Stable key. Also the output column key and the SQL alias. */
  key: string
  label: string
  type: ColumnType
  /**
   * The SQL expression, written against this source's aliases (`t` is always
   * the primary table). NEVER contains user input — authored here only.
   */
  expr: string
  /** Money/quantity field: offered for SUM/AVG/MIN/MAX and totalled in the grid. */
  numeric?: boolean
  /** Pre-ticked when the source is chosen, so a new report is never blank. */
  starter?: boolean
  /**
   * Excluded from the column total even though numeric — for values repeated
   * across rows (an invoice total carried on every line) or rates that must not
   * be added.
   */
  noTotal?: boolean
  /**
   * For a `percent` field: the two OTHER amounts it is really a ratio of.
   * A percentage must never be averaged row-by-row — the mean of a R5 line at
   * 80% and a R5,000 line at 10% is not the business's margin. When a ratio is
   * declared, summarising sums the numerator and denominator and divides them,
   * giving the properly WEIGHTED figure.
   */
  ratio?: { numerator: string; denominator: string }
  /** Join units required for `expr` to resolve. Pulled in only when used. */
  needs?: string[]
  /** Picker section. Defaults by type when omitted. */
  group?: string
  /** Optional note shown next to the field in the builder and the grid. */
  hint?: string
  /**
   * Capability required to see this column. Absent = anyone who may read the
   * source. A field the caller lacks is dropped from the report, not refused.
   */
  permission?: Capability
  /** Closed value list — turns the filter value box into a picker. */
  options?: { value: string; label: string }[]
  /**
   * Colour this column's cells by what the number MEANS, not by its size.
   *
   * 'variance' is the only rule so far, and it reads a signed figure the way a
   * person counting a drawer does: below zero is SHORT and the thing to chase
   * (danger), above zero is over and still wrong but differently — usually a
   * keying error rather than missing money (warning) — and exactly zero is the
   * drawer balancing (success).
   *
   * Deliberately a named RULE rather than a colour or a threshold. A catalogue
   * entry that could name its own colour would let one report invent a palette
   * the rest of the app does not share, and "red below zero" is a judgement
   * about cash-ups that belongs next to the field it describes.
   *
   * Applies to the cell only, never the footer: a column of variances that sums
   * to zero has not balanced, it has cancelled out, and colouring that green
   * would state the opposite of what happened.
   */
  tone?: 'variance'
  /**
   * For a `document` field: what the number identifies, and where its id is.
   *
   * `type: 'document'` alone only says "this reads as a reference". It does NOT
   * say which record — the sales file, the purchase file, a job card and a stock
   * take all carry a `document_number`, and opening the wrong one is worse than
   * opening nothing. A field that wants to be CLICKABLE says so here.
   *
   * `idExpr` is a SQL expression on this source's own aliases, exactly like
   * `expr`, and is subject to the same rule: authored here, never user input.
   * It is selected alongside the number under a sidecar key (see LINK_KEY_PREFIX
   * in run.ts) so the id reaches the browser without becoming a column anybody
   * has to look at.
   *
   * Omitted means the number renders as plain text, which is the correct
   * outcome for a reference whose record has no screen to open.
   */
  link?: {
    /** Which viewer opens it. The grid maps this to a dialog. */
    kind: DocumentLinkKind
    /** SQL for the record's primary key, on this source's aliases. */
    idExpr: string
  }
}

/**
 * The record kinds a `document` column can open.
 *
 * Deliberately a closed union rather than a route string: the grid decides what
 * to open, and a catalogue entry that could name any URL would be a way to send
 * somebody anywhere from a report cell.
 */
export type DocumentLinkKind = 'sale' | 'cashup'

export type SourceShape = 'snapshot' | 'timeline'

/** A named, optional JOIN. Only added when something asks for it. */
export interface JoinUnit {
  /** The name fields reference in `needs`. */
  name: string
  sql: string
  /**
   * Other joins this one's SQL reads an alias from.
   *
   * A join is emitted only when something asks for it, so one that reads
   * another's alias has to say so or it lands in a query where that alias does
   * not exist. saleModifiers is the case: its `product` join is written against
   * `sl`, which its `line` join introduces, so picking a product field without
   * a line field produced "Unknown column 'sl.product_id'".
   *
   * Resolved transitively — a join may depend on a join that depends on a join.
   */
  needs?: string[]
  /**
   * Emitted whether or not anything references it.
   *
   * For the joins a source cannot be queried without: the parent document that
   * carries the date the period filters on. Previously a hardcoded list of two
   * names inside joinsFor(), which meant a third source needing one had no way
   * to say so.
   */
  always?: boolean
}

/** A pre-filled filter a source starts with (removable by the user). */
export interface DefaultFilter {
  field: string
  op: 'eq' | 'ne'
  value: string
}

/* ── Naming the customer file across a shared-store boundary ──────────────
 *
 * A store group may share one customer file: the group's primary holds it and
 * every branch reads and writes it. See customerOwnerSite() in
 * lib/storeGroups.ts.
 *
 * The report engine composes its joins into ONE SQL string, so it cannot route
 * a query the way lib/site modules do — half of it belongs to the branch and
 * half to the owner. It qualifies instead, and these tokens are how a
 * catalogue entry says which side a table is on:
 *
 *   {C}  a customer-owned table — customers, customer_groups, the ledger
 *   {S}  a supplier-owned table — suppliers and the creditors book
 *   {L}  a loyalty-owned table — members, the points ledger, the tier ladder
 *   {G}  a gift-card-owned table — gift_cards and gift_card_events
 *   {B}  a branch-owned table reached FROM an owner-side source —
 *        products, tender_types, terminals
 *
 * FOUR files, not one: a group may share any combination of them, and gift
 * cards in particular follow their own switch rather than the loyalty one (see
 * `ownedBy` below). A table listed under the wrong token reads the wrong shop's
 * data on exactly the groups these tokens exist for.
 *
 * run.ts replaces each with a database prefix (or with nothing, for a store
 * that owns its own files, so the SQL is byte-for-byte what it was).
 *
 * A token rather than a per-join flag because the same JoinUnit is reused
 * across sources — CUSTOMER_GROUP_JOIN is on four — and the answer belongs to
 * the TABLE, not to the join that happens to reach it.
 */
export const CUSTOMER_DB = '{C}'
export const SUPPLIER_DB = '{S}'
export const LOYALTY_DB = '{L}'
export const GIFT_CARD_DB = '{G}'
export const BRANCH_DB = '{B}'

/** One queryable dataset offered in the builder's first step. */
export interface CatalogSource {
  key: string
  label: string
  /** One-line description shown on the source card. */
  description: string
  /** Grouping on the source picker. */
  category: 'Sales' | 'Stock' | 'Customers' | 'Suppliers' | 'Money' | 'Operations'
  /** The capability needed to query this dataset at all. */
  permission: Capability
  shape: SourceShape
  /** The primary table, aliased `t`. */
  table: string
  /**
   * Which shared file the primary table belongs to. Omitted means the caller's
   * own database, which is every source but those built on the debtors book,
   * the creditors book, the loyalty programme and the gift card scheme.
   *
   * This decides WHERE the query runs. The {C} / {S} / {L} / {G} / {B} tokens
   * decide how the tables on the other side are named once it is running.
   *
   * FOUR, not two, and each answered separately — a group may share any
   * combination (015, 017). 'loyalty' is exempt from the legal-entity gate, so
   * a group of separately owned shops can run one programme while keeping
   * separate debtors books. A loyalty source marked 'customer' would read the
   * wrong database for exactly that group.
   *
   * 'giftcard' is NOT an alias for 'loyalty', and the gap is the point. Points
   * cost nothing to honour and were never anybody's money; a gift card is cash
   * the shopper handed over, so a card sold at store 3 and spent at store 7
   * leaves store 3 holding money store 7 gave goods for. A group of separate
   * companies that shares its programme may therefore still keep stored value
   * apart — giftCardOwnerSite answers that separately from loyaltyOwnerSite,
   * and a gift card source marked 'loyalty' would report another company's
   * money as its own. See sql/tickets/018_share_gift_cards.sql.
   */
  ownedBy?: 'customer' | 'supplier' | 'loyalty' | 'giftcard'
  /** TIMELINE only: the column the date range filters on. */
  dateColumn?: string
  /**
   * The join whose table `dateColumn` lives on, when it is not the primary one.
   *
   * A line-level source dates from its parent — a stock take line from the
   * sheet, an adjustment line from the document. Naming the join here is what
   * lets the parent be called anything; without it, only joins named 'doc' or
   * 'exp' were found and every other source's date filter looked for the column
   * on `t`, where it does not exist.
   */
  dateJoin?: string
  joins?: JoinUnit[]
  /** Filters the source starts with (e.g. finalised invoices only). */
  defaultFilters?: DefaultFilter[]
  /** Caveat shown on the build screen. */
  note?: string
  fields: CatalogField[]
}

/* ── shared helpers ────────────────────────────────────────────────────────── */

/**
 * The date-bucket fields every timeline source gets, derived from its own date
 * column. These are what make "turnover per month", "sales per weekday" or
 * "takings per hour" possible without anyone writing anything.
 *
 * Every bucket is formatted to TEXT in SQL rather than returned as a DATE: a
 * DATE comes back from the driver as a JS Date at midnight UTC, which the local
 * timezone then shifts a day backwards ("2026-06-11" arriving as
 * 2026-06-10T22:00Z). Formatting server-side keeps the label exactly what the
 * database grouped by.
 */
function timeBuckets(
  dateCol: string,
  opts: { hours?: boolean; hourColumn?: string } = {},
): CatalogField[] {
  const d = `t.\`${dateCol}\``
  const g = FIELD_GROUPS.TIME
  const out: CatalogField[] = [
    { key: 'day', label: 'Day', type: 'text', expr: `DATE_FORMAT(${d}, '%Y-%m-%d')`, group: g },
    {
      key: 'week',
      label: 'Week starting',
      type: 'text',
      expr: `DATE_FORMAT(DATE_SUB(${d}, INTERVAL WEEKDAY(${d}) DAY), '%Y-%m-%d')`,
      group: g,
      hint: 'The Monday of the week the transaction falls in.',
    },
    { key: 'month', label: 'Month', type: 'text', expr: `DATE_FORMAT(${d}, '%Y-%m')`, group: g },
    { key: 'quarter', label: 'Quarter', type: 'text', expr: `CONCAT(YEAR(${d}), '-Q', QUARTER(${d}))`, group: g },
    { key: 'year', label: 'Year', type: 'text', expr: `DATE_FORMAT(${d}, '%Y')`, group: g },
    { key: 'weekday', label: 'Day of week', type: 'text', expr: `DAYNAME(${d})`, group: g },
  ]
  // The hour has to come from a DATETIME, and the column a source is dated by
  // is often a plain DATE — a sales document is filed against a trading day,
  // not a timestamp. `hourCol` lets such a source still offer a real hour by
  // naming the timestamp that carries one.
  const hourCol = opts.hourColumn ?? (opts.hours ? dateCol : null)
  if (hourCol) {
    const h = `t.\`${hourCol}\``
    out.push({
      key: 'hour',
      label: 'Hour of day',
      type: 'text',
      expr: `LPAD(HOUR(${h}), 2, '0')`,
      group: g,
      hint: 'The hour the transaction was captured, 00–23.',
    })
  }
  return out
}

/** A yes/no flag rendered as readable text rather than 1/0. */
function yesNo(key: string, label: string, expr: string, needs?: string[]): CatalogField {
  return {
    key,
    label,
    type: 'text',
    expr: `(CASE WHEN ${expr} = 1 THEN 'Yes' ELSE 'No' END)`,
    group: FIELD_GROUPS.FLAGS,
    options: [
      { value: 'Yes', label: 'Yes' },
      { value: 'No', label: 'No' },
    ],
    ...(needs ? { needs } : {}),
  }
}

/** An ENUM column, offered as a picker so nobody has to guess the spelling. */
function enumField(
  key: string,
  label: string,
  expr: string,
  values: string[],
  extra: Partial<CatalogField> = {},
): CatalogField {
  return {
    key,
    label,
    type: 'text',
    expr,
    group: FIELD_GROUPS.CLASSIFICATION,
    options: values.map((v) => ({ value: v, label: humanise(v) })),
    ...extra,
  }
}

/** 'credit_note' -> 'Credit note'. */
function humanise(v: string): string {
  const s = v.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * The five ageing buckets as SUMmable columns, for both open-item ledgers.
 *
 * Boundaries are bucketFor()'s (site/ledger.ts): due or not yet due is
 * Current, then 30-day rungs, everything past 90 in the top bucket. Grouping
 * by customer or supplier and summing these IS the classic bucketed age
 * analysis — the report the dedicated pages draw, now buildable and
 * schedulable like any other.
 *
 * Aged from CURDATE(), deliberately: the as-at ladder on the dedicated pages
 * rolls back allocations by date, which is not expressible in one authored
 * expression here, and pretending otherwise would produce a ladder that
 * disagrees with the page. The template note says so.
 */
function agedBucketFields(): CatalogField[] {
  const due = 'DATEDIFF(CURDATE(), t.`due_date`)'
  const out = 't.`amount_outstanding`'
  const bucket = (key: string, label: string, cond: string, hint?: string): CatalogField => ({
    key,
    label,
    type: 'currency',
    expr: `(CASE WHEN ${out} > 0 AND ${cond} THEN ${out} ELSE 0 END)`,
    numeric: true,
    group: FIELD_GROUPS.AGEING,
    ...(hint ? { hint } : {}),
  })
  return [
    bucket(
      'agedCurrent',
      'Current',
      `(t.\`due_date\` IS NULL OR ${due} <= 0)`,
      'Outstanding but not yet due — including anything with no due date.',
    ),
    bucket('aged30', '30 days', `${due} BETWEEN 1 AND 30`),
    bucket('aged60', '60 days', `${due} BETWEEN 31 AND 60`),
    bucket('aged90', '90 days', `${due} BETWEEN 61 AND 90`),
    bucket('aged120', '120+ days', `${due} > 90`),
  ]
}

/* ── reusable join units ───────────────────────────────────────────────────── */

const PRODUCT_JOIN: JoinUnit = {
  name: 'product',
  sql: 'LEFT JOIN products pm ON pm.id = t.product_id',
}
const PRODUCT_DEPT_JOIN: JoinUnit = {
  name: 'productDept',
  sql: 'LEFT JOIN departments pdm ON pdm.id = pm.department_id',
}
const PRODUCT_BRAND_JOIN: JoinUnit = {
  name: 'productBrand',
  sql: 'LEFT JOIN brands pb ON pb.id = pm.brand_id',
}
/** Reorder levels for the looked-up product — see the `levels` join on products. */
const PRODUCT_LEVELS_JOIN: JoinUnit = {
  name: 'productLevels',
  sql:
    'LEFT JOIN product_location_stock plm ON plm.product_id = pm.id ' +
    'AND plm.location_id = (SELECT id FROM stock_locations WHERE is_main = 1 ORDER BY id LIMIT 1)',
}
/** The department recorded ON the line — the snapshot, not today's filing. */
const LINE_DEPT_JOIN: JoinUnit = {
  name: 'lineDept',
  sql: 'LEFT JOIN departments ld ON ld.id = t.department_id',
}

/**
 * "What is this product NOW" — the cross-source lookup that turns a sales report
 * into a decision: what did I sell of the things I am about to run out of, or
 * have already discontinued.
 */
const PRODUCT_LOOKUP_FIELDS: CatalogField[] = [
  /*
   * The product's own department and brand.
   *
   * PRODUCT_DEPT_JOIN and PRODUCT_BRAND_JOIN have been declared on several
   * sources for a while with no field exposing them, so the join was there and
   * unreachable. Grouping a stock movement by department is the question
   * "which aisle is losing stock", which a shrinkage report cannot answer
   * without this.
   *
   * Distinct from `lineDepartment` on sales lines, which is the department the
   * line was SOLD under and can differ from the product's own.
   */
  {
    key: 'productDepartment',
    label: 'Department',
    type: 'text',
    expr: 'pdm.name',
    needs: ['product', 'productDept'],
    group: FIELD_GROUPS.CLASSIFICATION,
  },
  {
    key: 'productBrand',
    label: 'Brand',
    type: 'text',
    expr: 'pb.name',
    needs: ['product', 'productBrand'],
    group: FIELD_GROUPS.CLASSIFICATION,
  },
  {
    key: 'currentSoh',
    label: 'Stock on hand now',
    type: 'number',
    expr: 'pm.stock_on_hand',
    numeric: true,
    noTotal: true,
    needs: ['product'],
    group: FIELD_GROUPS.PRODUCT,
    hint: 'The product’s CURRENT stock on hand, not its level at the time of the transaction.',
  },
  {
    key: 'currentMinStock',
    label: 'Minimum level now',
    type: 'number',
    expr: 'plm.min_stock',
    numeric: true,
    noTotal: true,
    needs: ['product', 'productLevels'],
    group: FIELD_GROUPS.PRODUCT,
  },
  {
    key: 'currentShortfall',
    label: 'Short of minimum now',
    type: 'number',
    expr: '(COALESCE(plm.min_stock, 0) - pm.stock_on_hand)',
    numeric: true,
    noTotal: true,
    needs: ['product', 'productLevels'],
    group: FIELD_GROUPS.PRODUCT,
    hint: 'Positive means the product is below its minimum level right now.',
  },
  {
    key: 'currentAvgCost',
    label: 'Average cost now',
    type: 'currency',
    expr: 'pm.average_cost',
    numeric: true,
    noTotal: true,
    needs: ['product'],
    group: FIELD_GROUPS.PRODUCT,
    permission: 'products.cost',
  },
  {
    key: 'currentDepartment',
    label: 'Department now',
    type: 'text',
    expr: 'pdm.name',
    needs: ['product', 'productDept'],
    group: FIELD_GROUPS.PRODUCT,
    hint: 'The department the product sits in today, which may differ from the one recorded on the transaction.',
  },
  {
    key: 'currentBrand',
    label: 'Brand',
    type: 'text',
    expr: 'pb.name',
    needs: ['product', 'productBrand'],
    group: FIELD_GROUPS.PRODUCT,
  },
  {
    key: 'currentProductType',
    label: 'Product type',
    type: 'text',
    expr: 'pm.product_type',
    needs: ['product'],
    group: FIELD_GROUPS.PRODUCT,
  },
  yesNo('currentArchived', 'Archived now', 'pm.is_archived', ['product']),
  {
    key: 'currentLastSold',
    label: 'Last sold (ever)',
    type: 'datetime',
    expr: 'pm.last_sold_date',
    needs: ['product'],
    group: FIELD_GROUPS.PRODUCT,
  },
]

/* ── sales documents ───────────────────────────────────────────────────────── */

/*
 * 'credit_sale', not 'credit_note': 022 renamed the doc_type value and the enum
 * here was never updated, so every template filtering on credit_note has been
 * matching nothing. Both spellings are offered — the old one because it is
 * stored in saved reports and schedules that would otherwise break, and it
 * still matches on a site that has not run 022.
 */
const SALE_DOC_TYPES = ['quote', 'sales_order', 'invoice', 'credit_sale', 'credit_note']
/*
 * The statuses a sales document can actually hold.
 *
 * Checked against the live enum rather than kept as history: 022 merged 'void'
 * into 'cancelled' and 'parked' became 'saved'. Both of the old values were
 * still offered here, and offering a filter value the column cannot hold is
 * worse than offering none — it returns an empty report with no hint that the
 * question itself was unanswerable.
 */
const SALE_STATUSES = ['draft', 'saved', 'issued', 'finalised', 'cancelled']

const CUSTOMER_JOIN: JoinUnit = {
  name: 'customer',
  sql: 'LEFT JOIN {C}customers c ON c.id = t.customer_id',
}
const CUSTOMER_GROUP_JOIN: JoinUnit = {
  name: 'customerGroup',
  sql: 'LEFT JOIN {C}customer_groups cg ON cg.id = c.group_id',
}

/**
 * The two coded reason lists, joined off sales_documents.
 *
 * Both are LEFT joins and stay that way: every void and credit note raised
 * before 102 has free text and no code, and an INNER join would silently drop
 * exactly the history somebody is trying to compare against.
 */
/*
 * The document this one reverses — a self-join on sales_documents.
 *
 * LEFT, because the overwhelming majority of documents reverse nothing, and an
 * INNER join here would silently turn any report using the column into
 * "credit notes only".
 */
const REVERSES_JOIN: JoinUnit = {
  name: 'reverses',
  sql: 'LEFT JOIN sales_documents rev ON rev.id = t.reverses_id',
}

const VOID_REASON_JOIN = {
  name: 'voidReason',
  sql: 'LEFT JOIN sales_void_reasons vr ON vr.id = t.cancel_reason_id',
}

const RETURN_REASON_JOIN = {
  name: 'returnReason',
  sql: 'LEFT JOIN sales_return_reasons rr ON rr.id = t.return_reason_id',
}

/*
 * The five lookups a sales document points at but never carried a field for.
 *
 * All LEFT, without exception. A visit type can be retired, a till decommissioned
 * and a user deleted long after the sale they touched — 125_sale_covers.sql is
 * explicit that history must not be rewritten when configuration changes — so an
 * INNER join here would silently drop finalised sales out of a turnover figure.
 */
const VISIT_TYPE_JOIN: JoinUnit = {
  name: 'visitType',
  sql: 'LEFT JOIN pos_visit_types vt ON vt.id = t.visit_type_id',
}

const SALE_USER_JOIN: JoinUnit = {
  name: 'saleUser',
  sql: 'LEFT JOIN users su ON su.id = t.user_id',
}

const SALE_TERMINAL_JOIN: JoinUnit = {
  name: 'saleTerminal',
  sql: 'LEFT JOIN terminals strm ON strm.id = t.terminal_id',
}

const SALE_PRICE_STRUCTURE_JOIN: JoinUnit = {
  name: 'salePriceStructure',
  sql: 'LEFT JOIN price_structures sps ON sps.id = t.price_structure_id',
}

const SALE_SHIFT_JOIN: JoinUnit = {
  name: 'saleShift',
  sql: 'LEFT JOIN shifts ssh ON ssh.id = t.shift_id',
}

/** The quote this document was raised from, and the quote this one supersedes. */
const CONVERTED_FROM_JOIN: JoinUnit = {
  name: 'convertedFrom',
  sql: 'LEFT JOIN sales_documents cf ON cf.id = t.converted_from_id',
}

const SUPERSEDES_JOIN: JoinUnit = {
  name: 'supersedes',
  sql: 'LEFT JOIN sales_documents sup ON sup.id = t.supersedes_id',
}

const SALE_JOB_CARD_JOIN: JoinUnit = {
  name: 'saleJobCard',
  sql: 'LEFT JOIN job_cards sjc ON sjc.id = t.job_card_id',
}

/** Account context for a transaction — who they are and what they may owe. */
const CUSTOMER_LOOKUP_FIELDS: CatalogField[] = [
  {
    key: 'accountCode',
    label: 'Account code',
    type: 'text',
    expr: 'c.code',
    needs: ['customer'],
    group: FIELD_GROUPS.ACCOUNT,
  },
  enumField('accountStatus', 'Account status', 'c.status', ['active', 'on_hold', 'inactive', 'closed'], {
    needs: ['customer'],
    group: FIELD_GROUPS.ACCOUNT,
  }),
  {
    key: 'accountGroup',
    label: 'Customer group',
    type: 'text',
    expr: 'cg.name',
    needs: ['customer', 'customerGroup'],
    group: FIELD_GROUPS.ACCOUNT,
  },
  {
    key: 'accountRep',
    label: 'Sales rep',
    type: 'text',
    expr: 'c.rep_name',
    needs: ['customer'],
    group: FIELD_GROUPS.PEOPLE,
  },
  {
    key: 'accountCategory',
    label: 'Customer category',
    type: 'text',
    expr: 'c.category',
    needs: ['customer'],
    group: FIELD_GROUPS.ACCOUNT,
  },
  {
    key: 'accountCity',
    label: 'Customer city',
    type: 'text',
    expr: 'c.city',
    needs: ['customer'],
    group: FIELD_GROUPS.ACCOUNT,
  },
  {
    key: 'accountBalanceNow',
    label: 'Account balance now',
    type: 'currency',
    expr: 'c.balance',
    numeric: true,
    noTotal: true,
    needs: ['customer'],
    group: FIELD_GROUPS.ACCOUNT,
    hint: 'The account’s CURRENT balance, not what it was when this transaction happened.',
    permission: 'customers.view',
  },
  {
    key: 'accountCreditLimit',
    label: 'Credit limit',
    type: 'currency',
    expr: 'c.credit_limit',
    numeric: true,
    noTotal: true,
    needs: ['customer'],
    group: FIELD_GROUPS.ACCOUNT,
    permission: 'customers.view',
  },
]

const SALES_SOURCE: CatalogSource = {
  key: 'sales',
  label: 'Sales documents',
  description:
    'One row per invoice, credit note, quote or order — totals, who served, how it was paid.',
  category: 'Sales',
  permission: 'sales.view',
  shape: 'timeline',
  table: 'sales_documents',
  dateColumn: 'document_date',
  joins: [
    CUSTOMER_JOIN,
    CUSTOMER_GROUP_JOIN,
    VOID_REASON_JOIN,
    RETURN_REASON_JOIN,
    REVERSES_JOIN,
    VISIT_TYPE_JOIN,
    SALE_USER_JOIN,
    SALE_TERMINAL_JOIN,
    SALE_PRICE_STRUCTURE_JOIN,
    SALE_SHIFT_JOIN,
    CONVERTED_FROM_JOIN,
    SUPERSEDES_JOIN,
    SALE_JOB_CARD_JOIN,
  ],
  // A report about "sales" means money that counted. Drafts, quotes and voids
  // are all reachable by removing this, but none of them belongs in a turnover
  // figure by default.
  defaultFilters: [{ field: 'status', op: 'eq', value: 'finalised' }],
  note: 'Starts with finalised documents only. Remove the status filter to include quotes, drafts or voided documents.',
  fields: [
    {
      key: 'documentNumber',
      label: 'Document number',
      type: 'document',
      expr: 't.document_number',
      /* The sale itself — one row IS one document here, so its own key. */
      link: { kind: 'sale', idExpr: 't.id' },
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'documentDate',
      label: 'Document date',
      type: 'date',
      expr: 't.document_date',
      starter: true,
      group: FIELD_GROUPS.DATES,
    },
    enumField('docType', 'Document type', 't.doc_type', SALE_DOC_TYPES, { starter: true }),
    enumField('status', 'Status', 't.status', SALE_STATUSES),
    {
      key: 'customerName',
      label: 'Customer',
      type: 'text',
      expr: 't.customer_name',
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
      hint: 'The name as it was on the document — renaming an account does not rewrite history.',
    },
    {
      key: 'userName',
      label: 'Served by',
      type: 'text',
      expr: 't.user_name',
      group: FIELD_GROUPS.PEOPLE,
    },
    {
      key: 'terminalCode',
      label: 'Till',
      type: 'text',
      expr: 't.terminal_code',
      group: FIELD_GROUPS.PEOPLE,
    },
    {
      key: 'reference',
      label: 'Customer reference',
      type: 'text',
      expr: 't.reference',
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'totalIncl',
      label: 'Total (incl.)',
      type: 'currency',
      expr: 't.total_incl',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'subtotalExcl',
      label: 'Total (excl.)',
      type: 'currency',
      expr: 't.subtotal_excl',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'vatTotal',
      label: 'VAT',
      type: 'currency',
      expr: 't.vat_total',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'discountTotal',
      label: 'Discount',
      type: 'currency',
      expr: 't.discount_total',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'roundingAdj',
      label: 'Rounding',
      type: 'currency',
      expr: 't.rounding_adj',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'changeGiven',
      label: 'Change given',
      type: 'currency',
      expr: 't.change_given',
      numeric: true,
      group: FIELD_GROUPS.TENDER,
    },
    {
      key: 'dueDate',
      label: 'Due date',
      type: 'date',
      expr: 't.due_date',
      group: FIELD_GROUPS.DATES,
    },
    {
      key: 'finalisedAt',
      label: 'Finalised at',
      type: 'datetime',
      expr: 't.finalised_at',
      group: FIELD_GROUPS.DATES,
    },
    {
      key: 'voidReason',
      // 029 renamed the column to cancel_reason and 022 merged the status value
      // 'void' into 'cancelled'. The field KEY is left alone: it is stored in
      // saved reports and schedules, and renaming it would break them for a
      // label change. Ids are data; names are display — the label below is what
      // a person reads, and it says cancel.
      //
      // Kept alongside the coded field below rather than replaced, for the same
      // reason: this key is in saved reports. It is also still the only field
      // that reads on a cancellation raised before 102, and the only one that
      // shows the free-text note beside a code.
      label: 'Cancel reason (text)',
      type: 'text',
      expr: 't.cancel_reason',
      group: FIELD_GROUPS.OTHER,
    },
    {
      key: 'cancelReasonCode',
      label: 'Cancel reason',
      type: 'text',
      expr: 'vr.code',
      needs: ['voidReason'],
      group: FIELD_GROUPS.OTHER,
    },
    {
      key: 'cancelReasonName',
      label: 'Cancel reason name',
      type: 'text',
      /* Labelled rather than left blank. Every cancellation raised before 102
         has free text and no code, and those rows genuinely belong in the total
         — a grouped report that showed them as an unnamed row would read as a
         bug in the report rather than as the truth about the history. */
      expr: "COALESCE(vr.name, 'Not recorded')",
      needs: ['voidReason'],
      group: FIELD_GROUPS.OTHER,
    },
    {
      key: 'returnReasonCode',
      label: 'Return reason',
      type: 'text',
      expr: 'rr.code',
      needs: ['returnReason'],
      group: FIELD_GROUPS.OTHER,
    },
    {
      key: 'returnReasonName',
      label: 'Return reason name',
      type: 'text',
      // Labelled for the same reason the cancel one is — see above.
      expr: "COALESCE(rr.name, 'Not recorded')",
      needs: ['returnReason'],
      group: FIELD_GROUPS.OTHER,
    },
    {
      key: 'printCount',
      label: 'Times printed',
      type: 'number',
      expr: 't.print_count',
      numeric: true,
      group: FIELD_GROUPS.OTHER,
    },
    {
      /* The SNAPSHOT taken when the document was raised, not the live customer
         record. Those differ once somebody edits a customer, and on a tax
         document the snapshot is the one that matters: it is what was printed
         and what a return was filed against. accountCode reads the live row. */
      key: 'customerVatNo',
      label: 'Customer VAT number',
      type: 'text',
      expr: 't.customer_vat_no',
      group: FIELD_GROUPS.IDENTITY,
      hint: 'As captured on the document, not the customer’s current record.',
    },
    {
      key: 'customerPhone',
      label: 'Customer phone',
      type: 'text',
      expr: 't.customer_phone',
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'notes',
      label: 'Note',
      type: 'text',
      expr: 't.notes',
      group: FIELD_GROUPS.OTHER,
      hint: 'The note printed on the document.',
    },
    {
      key: 'internalNote',
      label: 'Internal note',
      type: 'text',
      expr: 't.internal_note',
      group: FIELD_GROUPS.OTHER,
      hint: 'Never printed — the note staff leave for each other.',
    },
    {
      /* Which document this one reverses: a credit note points at the invoice
         it credits. v2's refund history carried it as "Orig. invoice", and
         without it a credit note cannot be traced back to what it undid.
         A self-join on the same table, so it needs its own alias. */
      key: 'reversesNumber',
      label: 'Reverses document',
      type: 'document',
      expr: 'rev.document_number',
      /* Opens the ORIGINAL, which is the whole point of carrying this column:
         reading a credit note and wanting to see what it undid. `t.reverses_id`
         rather than `rev.id` so the id needs no join of its own — the number
         still does, hence `needs` stays. */
      link: { kind: 'sale', idExpr: 't.reverses_id' },
      needs: ['reverses'],
      group: FIELD_GROUPS.IDENTITY,
    },
    /* ── Covers and visit type — the restaurant facts on a bill ──────────
     *
     * Both are written by the till when a table is opened (125_sale_covers.sql)
     * and neither was reportable, so "average spend per head" and "eat-in vs
     * takeaway" could not be asked at all.
     */
    {
      key: 'personCount',
      label: 'Covers',
      type: 'number',
      expr: 't.person_count',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
      /* SUMmable on purpose: "how many people did we feed in March" is the
         question, and it is a true total across bills. NULL on every retail
         sale, quote and credit note — 125 chose NULL over 0 so that "not a
         table bill" and "a table nobody sat at" stay different answers, and
         SUM() ignoring NULL is exactly the behaviour that needs. */
      hint: 'How many people were on the bill. Blank on sales that never sat at a table.',
    },
    {
      key: 'spendPerHead',
      label: 'Spend per head',
      type: 'currency',
      /* Guarded against NULL as well as 0: a retail sale has no cover count,
         and dividing by NULL yields NULL, which stays out of an average rather
         than dragging it towards nothing. */
      expr: '(CASE WHEN COALESCE(t.person_count, 0) = 0 THEN NULL ELSE t.total_incl / t.person_count END)',
      numeric: true,
      noTotal: true,
      /* A rate must never be averaged row-by-row — a R80 table of one and a
         R2,000 table of ten do not average to a meaningful head rate. Declaring
         the ratio makes a summarised report sum both sides and divide, which is
         the weighted figure a restaurant actually runs on. */
      ratio: { numerator: 'totalIncl', denominator: 'personCount' },
      group: FIELD_GROUPS.MONEY,
      hint: 'Bill total divided by covers, weighted by bill size when summarised. Blank where no covers were recorded.',
    },
    {
      key: 'visitType',
      label: 'Visit type',
      type: 'text',
      /* Labelled rather than blank, for the reason cancelReasonName is: every
         sale raised before 125, and every counter sale since, has no visit type
         and genuinely belongs in the total. An unnamed group reads as a broken
         report rather than as the truth. */
      expr: "COALESCE(vt.name, 'Not recorded')",
      needs: ['visitType'],
      group: FIELD_GROUPS.CLASSIFICATION,
      hint: 'Eat in, takeaway or delivery, as chosen at the till.',
    },
    enumField('origin', 'Raised at', 't.origin', ['till', 'back_office'], {
      hint: 'Whether the document came off a till or was raised in the back office.',
    }),

    /* ── The quote funnel ────────────────────────────────────────────────
     *
     * 048_quotes.sql calls the outcome "the single most useful thing a quote
     * register knows" and names conversion rate as the question it exists to
     * answer — and none of it was reachable from a report.
     */
    enumField('quoteOutcome', 'Quote outcome', 't.quote_outcome', ['open', 'accepted', 'declined'], {
      hint: 'What the customer decided. Only meaningful on quotes.',
    }),
    {
      key: 'quoteOutcomeAt',
      label: 'Quote decided on',
      type: 'datetime',
      expr: 't.quote_outcome_at',
      group: FIELD_GROUPS.DATES,
    },
    {
      key: 'quoteLostReason',
      label: 'Quote lost reason',
      type: 'text',
      expr: 't.quote_lost_reason',
      group: FIELD_GROUPS.OTHER,
      hint: 'Why a declined quote was declined — a pattern in the losses is worth more than any one of them.',
    },
    {
      key: 'validUntil',
      label: 'Valid until',
      type: 'date',
      expr: 't.valid_until',
      group: FIELD_GROUPS.DATES,
      hint: 'The date the prices on a quote stop standing.',
    },
    {
      key: 'quoteSentAt',
      label: 'Quote sent on',
      type: 'datetime',
      expr: 't.quote_sent_at',
      group: FIELD_GROUPS.DATES,
    },
    {
      key: 'quoteSentTo',
      label: 'Quote sent to',
      type: 'text',
      expr: 't.quote_sent_to',
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'quoteViewedAt',
      label: 'Quote first viewed',
      type: 'datetime',
      expr: 't.quote_viewed_at',
      group: FIELD_GROUPS.DATES,
      /* 227_quote_sent_viewed.sql is careful about what this can honestly claim,
         and the limit belongs in front of whoever builds the report rather than
         only in the migration nobody reads. */
      hint: 'When somebody first opened the quote link. NOT proof they read it, nor that the decision-maker saw it.',
    },
    {
      key: 'quoteViewCount',
      label: 'Times viewed',
      type: 'number',
      expr: 't.quote_view_count',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    enumField(
      'quoteAcceptMethod',
      'Accepted how',
      't.quote_accept_method',
      ['verbal', 'email', 'link', 'in_person', 'internal'],
      {
        hint: 'The strength of the evidence — a dispute six months later turns on which of these it was.',
      },
    ),
    {
      key: 'quoteAcceptedBy',
      label: 'Accepted by',
      type: 'text',
      expr: 't.quote_accepted_by',
      group: FIELD_GROUPS.PEOPLE,
    },
    {
      key: 'quoteAcceptReference',
      label: 'Acceptance reference',
      type: 'text',
      expr: 't.quote_accept_reference',
      group: FIELD_GROUPS.OTHER,
      hint: 'The message id or note that backs up the acceptance.',
    },
    {
      key: 'quoteRevision',
      label: 'Quote revision',
      type: 'number',
      expr: 't.quote_revision',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'supersedesNumber',
      label: 'Supersedes quote',
      type: 'document',
      expr: 'sup.document_number',
      link: { kind: 'sale', idExpr: 't.supersedes_id' },
      needs: ['supersedes'],
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'convertedFromNumber',
      label: 'Converted from',
      type: 'document',
      expr: 'cf.document_number',
      link: { kind: 'sale', idExpr: 't.converted_from_id' },
      needs: ['convertedFrom'],
      group: FIELD_GROUPS.IDENTITY,
      hint: 'The quote or order this document was raised from.',
    },

    /* ── Who, where and against what ─────────────────────────────────────── */
    {
      key: 'userNameLive',
      label: 'Served by (current name)',
      type: 'text',
      expr: 'su.name',
      needs: ['saleUser'],
      group: FIELD_GROUPS.PEOPLE,
      /* t.user_name is the snapshot and stays the default. This one exists so a
         report can be FILTERED to a person: the snapshot spells whatever their
         name was that day, so grouping by it splits one person in two after a
         rename. */
      hint: 'The user record as it reads today — use this to group or filter by person across a name change.',
    },
    {
      key: 'terminalName',
      label: 'Till name',
      type: 'text',
      expr: 'strm.name',
      needs: ['saleTerminal'],
      group: FIELD_GROUPS.PEOPLE,
    },
    {
      key: 'priceStructureName',
      label: 'Price structure',
      type: 'text',
      expr: "COALESCE(sps.name, 'Default')",
      needs: ['salePriceStructure'],
      group: FIELD_GROUPS.CLASSIFICATION,
      hint: 'Which price list the sale was rung up on.',
    },
    {
      key: 'shiftNumber',
      label: 'Cash-up',
      type: 'document',
      expr: 'ssh.document_number',
      link: { kind: 'cashup', idExpr: 't.shift_id' },
      needs: ['saleShift'],
      group: FIELD_GROUPS.IDENTITY,
      hint: 'The cash-up this sale falls inside.',
    },
    {
      key: 'jobCardNumber',
      label: 'Job card',
      type: 'text',
      expr: 'sjc.document_number',
      needs: ['saleJobCard'],
      group: FIELD_GROUPS.IDENTITY,
    },

    /* ── Remaining document facts ────────────────────────────────────────── */
    {
      key: 'tenderedTotal',
      label: 'Tendered',
      type: 'currency',
      expr: 't.tendered_total',
      numeric: true,
      group: FIELD_GROUPS.TENDER,
      hint: 'What was handed over, before change. Exceeds the total on a cash sale.',
    },
    {
      key: 'cancelledAt',
      label: 'Cancelled at',
      type: 'datetime',
      expr: 't.cancelled_at',
      group: FIELD_GROUPS.DATES,
    },
    {
      key: 'customerCode',
      label: 'Customer code (on document)',
      type: 'text',
      expr: 't.customer_code',
      group: FIELD_GROUPS.IDENTITY,
      hint: 'As captured on the document, not the current customer record.',
    },
    {
      key: 'customerAddress',
      label: 'Customer address (on document)',
      type: 'text',
      expr: 't.customer_address',
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'discountCode',
      label: 'Discount code',
      type: 'text',
      expr: 't.discount_code',
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    ...CUSTOMER_LOOKUP_FIELDS,
    // document_date is a DATE, so "trading by hour" has to read the timestamp
    // the sale was actually finalised at.
    ...timeBuckets('document_date', { hourColumn: 'finalised_at' }),
  ],
}

const SALE_LINES_SOURCE: CatalogSource = {
  key: 'saleLines',
  label: 'Sales lines',
  description:
    'One row per product sold — quantities, prices, discount and margin. The source for "what sold".',
  category: 'Sales',
  permission: 'sales.view',
  shape: 'timeline',
  table: 'sales_document_lines',
  dateColumn: 'document_date',
  joins: [
    // The line's own date and document context live on the parent. This join is
    // NOT optional — the date range filters through it — so it is emitted
    // always, not via `needs`.
    { name: 'doc', sql: 'INNER JOIN sales_documents d ON d.id = t.document_id' },
    PRODUCT_JOIN,
    PRODUCT_DEPT_JOIN,
    PRODUCT_BRAND_JOIN,
    PRODUCT_LEVELS_JOIN,
    LINE_DEPT_JOIN,
    { name: 'customer', sql: 'LEFT JOIN {C}customers c ON c.id = d.customer_id' },
    /* Off the PARENT document, which on this source is `d` rather than `t` — so
       it cannot reuse RETURN_REASON_JOIN. A credit note line has no reason of
       its own; the whole document has one. */
    { name: 'returnReason', sql: 'LEFT JOIN sales_return_reasons rr ON rr.id = d.return_reason_id' },
    CUSTOMER_GROUP_JOIN,
    /*
     * The promotion that discounted the line, if one did.
     *
     * `special_id` has been written on every discounted line since 056 —
     * specifically so "what did that promotion cost us" could be answered from
     * the sales data rather than guessed at — and until now no catalog field
     * reached it, so no report could ask. The column was collecting evidence
     * nobody could read.
     *
     * NOT named `doc`: a join by that name shadows the parent document alias
     * this source's date filter runs through, and every report on the source
     * fails at request time.
     */
    { name: 'special', sql: 'LEFT JOIN specials sp ON sp.id = t.special_id' },
  ],
  defaultFilters: [{ field: 'status', op: 'eq', value: 'finalised' }],
  note: 'Starts with finalised documents only. Credit note lines carry negative quantities, so totals net off returns.',
  fields: [
    {
      key: 'productCode',
      label: 'Product code',
      type: 'text',
      expr: 't.product_code',
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'description',
      label: 'Description',
      type: 'text',
      expr: 't.description',
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'lineDepartment',
      label: 'Department',
      type: 'text',
      expr: 'ld.name',
      needs: ['lineDept'],
      starter: true,
      group: FIELD_GROUPS.CLASSIFICATION,
      hint: 'The department recorded on the line when it was sold. Use “Department now” for today’s filing.',
    },
    {
      key: 'productType',
      label: 'Product type',
      type: 'text',
      expr: 't.product_type',
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    {
      key: 'qty',
      label: 'Quantity',
      type: 'number',
      expr: 't.qty',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'qtyDelivered',
      label: 'Quantity delivered',
      type: 'number',
      expr: 't.qty_delivered',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'unitPriceIncl',
      label: 'Unit price (incl.)',
      type: 'currency',
      expr: 't.unit_price_incl',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'A per-unit price. Adding these up is meaningless — use the line total instead.',
    },
    {
      key: 'lineTotalIncl',
      label: 'Line total (incl.)',
      type: 'currency',
      expr: 't.line_total_incl',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      /* Where the line sat on the slip. v2's detailed history led with it, and
         it is the only way to put a re-exported invoice back in its original
         order once a spreadsheet has sorted it by something else. */
      key: 'lineNumber',
      label: 'Line number',
      type: 'number',
      expr: 't.line_number',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      /* Off the PARENT (`d`), not the line. The customer's own order number —
         the same field the sales source calls `reference`. */
      key: 'reference',
      label: 'Customer reference',
      type: 'text',
      expr: 'd.reference',
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'invoiceTotalIncl',
      label: 'Document total (incl.)',
      type: 'currency',
      expr: 'd.total_incl',
      numeric: true,
      /* NOT totalled: the parent's total repeats on every line of the document,
         so a column sum would count a R500 invoice once per line on it. It is
         here to give a line its context, not to be added up. */
      noTotal: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'The whole document’s total, repeated on each of its lines.',
    },
    {
      key: 'lineTotalExcl',
      label: 'Line total (excl.)',
      type: 'currency',
      expr: 't.line_total_excl',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'lineVat',
      label: 'VAT',
      type: 'currency',
      expr: 't.line_vat',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'vatRatePct',
      label: 'VAT rate',
      type: 'percent',
      expr: 't.vat_rate_pct',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'discountIncl',
      label: 'Discount',
      type: 'currency',
      expr: 't.discount_incl',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'discountPct',
      label: 'Discount %',
      type: 'percent',
      expr: 't.discount_pct',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.MONEY,
    },
    /*
     * WHICH promotion discounted this line.
     *
     * The whole point of `special_id`, unreadable until now. Grouping a sales
     * report by this is what turns "we gave away R8,400 in discounts" into "the
     * Friday happy hour cost R8,400 and sold 300 burgers", which is the
     * difference between a number and a decision.
     *
     * The NAME comes off the specials table rather than being snapshotted onto
     * the line, so renaming a promotion renames it everywhere it is reported —
     * and a deleted one reads as blank rather than as a stale name, which is
     * honest: the sale still happened, the promotion no longer exists.
     */
    {
      key: 'specialName',
      label: 'Promotion',
      type: 'text',
      expr: 'sp.name',
      needs: ['special'],
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'specialShape',
      label: 'Promotion kind',
      type: 'text',
      expr: 'sp.shape',
      needs: ['special'],
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'onSpecial',
      label: 'On promotion',
      type: 'text',
      // A plain yes/no, so a report can split promotional sales from ordinary
      // ones without needing to know any promotion's name.
      expr: "CASE WHEN t.special_id IS NULL THEN 'No' ELSE 'Yes' END",
      group: FIELD_GROUPS.MONEY,
    },
    // ── cost and margin: gated, because "what we paid" is a separate question
    // from "what we charged" and plenty of staff may see only the second.
    {
      key: 'unitCostExcl',
      label: 'Unit cost (excl.)',
      type: 'currency',
      expr: 't.unit_cost_excl',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.COST,
      permission: 'products.cost',
    },
    {
      key: 'lineCostExcl',
      label: 'Cost of sale (excl.)',
      type: 'currency',
      expr: '(t.unit_cost_excl * t.qty)',
      numeric: true,
      group: FIELD_GROUPS.COST,
      permission: 'products.cost',
    },
    {
      key: 'grossProfit',
      label: 'Gross profit',
      type: 'currency',
      expr: '(t.line_total_excl - (t.unit_cost_excl * t.qty))',
      numeric: true,
      group: FIELD_GROUPS.COST,
      permission: 'products.cost',
      hint: 'Line total excluding VAT, less what the stock cost.',
    },
    {
      key: 'grossProfitPct',
      label: 'Gross profit %',
      type: 'percent',
      expr:
        '(CASE WHEN t.line_total_excl = 0 THEN 0 ' +
        'ELSE ((t.line_total_excl - (t.unit_cost_excl * t.qty)) / t.line_total_excl) * 100 END)',
      numeric: true,
      noTotal: true,
      // Declaring the ratio is what makes summarising this WEIGHTED rather than
      // a mean of per-line percentages.
      ratio: { numerator: 'grossProfit', denominator: 'lineTotalExcl' },
      group: FIELD_GROUPS.COST,
      permission: 'products.cost',
      hint: 'Weighted by value when summarised — a big line counts for more than a small one.',
    },
    // ── document context, from the parent
    {
      key: 'documentNumber',
      label: 'Document number',
      type: 'document',
      expr: 'd.document_number',
      /* The parent sale. `t.document_id` is the line's own FK, so the id costs
         no join even though the NUMBER is read across one. */
      link: { kind: 'sale', idExpr: 't.document_id' },
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'documentDate',
      label: 'Document date',
      type: 'date',
      expr: 'd.document_date',
      group: FIELD_GROUPS.DATES,
    },
    enumField('docType', 'Document type', 'd.doc_type', SALE_DOC_TYPES),
    enumField('status', 'Document status', 'd.status', SALE_STATUSES),
    {
      key: 'customerName',
      label: 'Customer',
      type: 'text',
      expr: 'd.customer_name',
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'userName',
      label: 'Served by',
      type: 'text',
      expr: 'd.user_name',
      group: FIELD_GROUPS.PEOPLE,
    },
    {
      key: 'terminalCode',
      label: 'Till',
      type: 'text',
      expr: 'd.terminal_code',
      group: FIELD_GROUPS.PEOPLE,
    },
    /* Only populated on a credit-note line — an ordinary sale has no return
       reason. That is what makes "refunds by reason and product" answerable
       from this source: the reason is the document's, the product is the
       line's, and neither exists on the other. */
    {
      key: 'returnReasonCode',
      label: 'Return reason',
      type: 'text',
      expr: 'rr.code',
      needs: ['returnReason'],
      group: FIELD_GROUPS.OTHER,
    },
    {
      key: 'returnReasonName',
      label: 'Return reason name',
      type: 'text',
      // Labelled for the same reason the cancel one is — see above.
      expr: "COALESCE(rr.name, 'Not recorded')",
      needs: ['returnReason'],
      group: FIELD_GROUPS.OTHER,
    },
    {
      key: 'lineNote',
      label: 'Line note',
      type: 'text',
      expr: 't.line_note',
      group: FIELD_GROUPS.OTHER,
      hint: 'What was typed against this line at the till — a preparation instruction, a serial, a reason.',
    },
    {
      key: 'giftCardCode',
      label: 'Gift card code',
      type: 'text',
      expr: 't.gift_card_code',
      group: FIELD_GROUPS.IDENTITY,
      hint: 'Set where the line sold or loaded a gift card.',
    },
    {
      key: 'orderedAt',
      label: 'Sent to kitchen at',
      type: 'datetime',
      expr: 't.ordered_at',
      group: FIELD_GROUPS.DATES,
      hint: 'When the line was fired to the kitchen. Blank on a line that was never sent.',
    },
    ...CUSTOMER_LOOKUP_FIELDS,
    ...PRODUCT_LOOKUP_FIELDS,
    ...timeBuckets('document_date').map((f) => ({
      ...f,
      // The buckets are derived from the PARENT's date column here.
      expr: f.expr.replace(/t\.`document_date`/g, 'd.`document_date`'),
    })),
  ],
}

const TENDERS_SOURCE: CatalogSource = {
  key: 'tenders',
  label: 'Payments taken',
  description: 'One row per tender — what money actually arrived, and in what form.',
  category: 'Sales',
  permission: 'sales.view',
  shape: 'timeline',
  table: 'sales_tenders',
  dateColumn: 'document_date',
  joins: [{ name: 'doc', sql: 'INNER JOIN sales_documents d ON d.id = t.document_id' }],
  defaultFilters: [{ field: 'status', op: 'eq', value: 'finalised' }],
  note: 'This is money received, which is not the same as sales: an invoice left on account moves no money here.',
  fields: [
    {
      key: 'tenderName',
      label: 'Tender',
      type: 'text',
      expr: 't.tender_name',
      starter: true,
      group: FIELD_GROUPS.TENDER,
    },
    {
      key: 'tenderCode',
      label: 'Tender code',
      type: 'text',
      expr: 't.tender_code',
      group: FIELD_GROUPS.TENDER,
    },
    {
      key: 'amount',
      label: 'Amount',
      type: 'currency',
      expr: 't.amount',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'changeGiven',
      label: 'Change given',
      type: 'currency',
      expr: 't.change_given',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'netAmount',
      label: 'Net amount',
      type: 'currency',
      expr: '(t.amount - t.change_given)',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'What was handed over, less any change given back.',
    },
    {
      key: 'surcharge',
      label: 'Surcharge',
      type: 'currency',
      expr: 't.surcharge',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'tenderReference',
      label: 'Reference',
      type: 'text',
      expr: 't.reference',
      group: FIELD_GROUPS.OTHER,
    },
    {
      key: 'documentNumber',
      label: 'Document number',
      type: 'document',
      expr: 'd.document_number',
      /* The sale the payment was taken against — see the note on saleLines. */
      link: { kind: 'sale', idExpr: 't.document_id' },
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'documentDate',
      label: 'Document date',
      type: 'date',
      expr: 'd.document_date',
      starter: true,
      group: FIELD_GROUPS.DATES,
    },
    enumField('status', 'Document status', 'd.status', SALE_STATUSES),
    {
      key: 'customerName',
      label: 'Customer',
      type: 'text',
      expr: 'd.customer_name',
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'userName',
      label: 'Served by',
      type: 'text',
      expr: 'd.user_name',
      group: FIELD_GROUPS.PEOPLE,
    },
    {
      key: 'terminalCode',
      label: 'Till',
      type: 'text',
      expr: 'd.terminal_code',
      group: FIELD_GROUPS.PEOPLE,
    },
    ...timeBuckets('document_date').map((f) => ({
      ...f,
      expr: f.expr.replace(/t\.`document_date`/g, 'd.`document_date`'),
    })),
  ],
}

/* ── products (snapshot) ───────────────────────────────────────────────────── */

const PRODUCTS_SOURCE: CatalogSource = {
  key: 'products',
  label: 'Products',
  description: 'The catalogue as it stands now — stock on hand, cost, price and margin.',
  category: 'Stock',
  permission: 'products.view',
  shape: 'snapshot',
  table: 'products',
  joins: [
    { name: 'dept', sql: 'LEFT JOIN departments pd ON pd.id = t.department_id' },
    { name: 'brand', sql: 'LEFT JOIN brands pbr ON pbr.id = t.brand_id' },
    // The group a variant belongs to. LEFT because the great majority of
    // products have no parent, and an inner join would quietly drop them.
    { name: 'parent', sql: 'LEFT JOIN products pvp ON pvp.id = t.parent_id' },
    {
      // Levels moved off `products` in 028 — they belong to a pile of stock, not
      // to the catalogue entry. The main location is the one a site that never
      // opened the locations screen still has, so it is what "the" level means.
      name: 'levels',
      sql:
        'LEFT JOIN product_location_stock pl ON pl.product_id = t.id ' +
        'AND pl.location_id = (SELECT id FROM stock_locations WHERE is_main = 1 ORDER BY id LIMIT 1)',
    },
    {
      name: 'price',
      sql:
        'LEFT JOIN product_prices ppr ON ppr.product_id = t.id ' +
        'AND ppr.price_structure_id = (SELECT id FROM price_structures WHERE is_default = 1 ORDER BY position LIMIT 1)',
    },
    {
      /* The SELLING rate specifically. A product carries two rate ids and they
         are not always the same (001), so deriving an exclusive selling price
         from the purchase rate would be quietly wrong on exactly the products
         where it matters. */
      name: 'sellingVat',
      sql: 'LEFT JOIN vat_rates svr ON svr.id = t.selling_vat_rate_id',
    },
  ],
  defaultFilters: [{ field: 'isArchived', op: 'eq', value: 'No' }],
  note: 'A snapshot of today. The report’s date range does not apply — use the date fields to filter on when something last moved.',
  fields: [
    { key: 'code', label: 'Product code', type: 'text', expr: 't.code', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'barcode', label: 'Barcode', type: 'text', expr: 't.barcode', group: FIELD_GROUPS.IDENTITY },
    {
      key: 'description',
      label: 'Description',
      type: 'text',
      expr: 't.description',
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'department',
      label: 'Department',
      type: 'text',
      expr: 'pd.name',
      needs: ['dept'],
      starter: true,
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    { key: 'brand', label: 'Brand', type: 'text', expr: 'pbr.name', needs: ['brand'], group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'productType', label: 'Product type', type: 'text', expr: 't.product_type', group: FIELD_GROUPS.CLASSIFICATION },
    /*
     * Variants. Reported on the CHILD, which is the row that carries stock,
     * price and sales — so "sales by size" is a group-by on these two columns
     * rather than a join nobody would think to write.
     *
     * A parent is left in the file rather than filtered out here: it is
     * legitimately part of the catalogue, and a stock report that silently
     * omitted rows would be worse than one that shows a zero. "Has variants"
     * is offered as a filter so anyone who wants only sellable rows can say so.
     */
    {
      key: 'variantGroup',
      label: 'Variant group',
      type: 'text',
      expr: 'pvp.description',
      needs: ['parent'],
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    {
      key: 'variantValue',
      label: 'Variant',
      type: 'text',
      // The two axes read as one label — "Medium" or "Medium / Red" — because a
      // report column showing 'Medium' with an empty neighbour is a column that
      // looks broken on every standalone product.
      expr:
        "NULLIF(TRIM(BOTH ' / ' FROM CONCAT(COALESCE(t.axis_1_value,''), ' / ', " +
        "COALESCE(t.axis_2_value,''))), '')",
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    yesNo('hasVariants', 'Has variants', 't.has_variants'),
    yesNo('isArchived', 'Archived', 't.is_archived'),
    {
      key: 'stockOnHand',
      label: 'Stock on hand',
      type: 'number',
      expr: 't.stock_on_hand',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'minStock',
      label: 'Minimum level',
      type: 'number',
      expr: 'pl.min_stock',
      numeric: true,
      needs: ['levels'],
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'maxStock',
      label: 'Maximum level',
      type: 'number',
      expr: 'pl.max_stock',
      numeric: true,
      needs: ['levels'],
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'shortfall',
      label: 'Short of minimum',
      type: 'number',
      expr: '(COALESCE(pl.min_stock, 0) - t.stock_on_hand)',
      numeric: true,
      needs: ['levels'],
      group: FIELD_GROUPS.QUANTITIES,
      hint: 'Positive means the product is below its minimum level.',
    },
    {
      key: 'sellingPriceIncl',
      label: 'Selling price (incl.)',
      type: 'currency',
      expr: 'ppr.selling_price_incl',
      numeric: true,
      noTotal: true,
      needs: ['price'],
      group: FIELD_GROUPS.MONEY,
      hint: 'From the default price structure.',
    },
    {
      /* Derived, because only the INCLUSIVE price is stored — 001 keeps one
         copy so the two cannot drift. Divided by the product's own selling VAT
         rate, which is not always the purchase one.
         NULLIF guards a rate of -100, which would divide by zero; a rate that
         has been deleted leaves svr.rate NULL and COALESCE reads it as zero,
         so an unrated product returns its inclusive price unchanged. */
      key: 'sellingPriceExcl',
      label: 'Selling price (excl.)',
      type: 'currency',
      expr: 'ppr.selling_price_incl / NULLIF(1 + COALESCE(svr.rate, 0) / 100, 0)',
      numeric: true,
      noTotal: true,
      needs: ['price', 'sellingVat'],
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'sellingVatRate',
      label: 'Selling VAT rate',
      type: 'percent',
      expr: 'COALESCE(svr.rate, 0)',
      numeric: true,
      noTotal: true,
      needs: ['sellingVat'],
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    {
      /* What the shelf is worth at RETAIL, where stockValue is what it is worth
         at cost. A shop counts one and insures the other. */
      key: 'stockValueRetail',
      label: 'Stock value at retail',
      type: 'currency',
      expr: 't.stock_on_hand * COALESCE(ppr.selling_price_incl, 0)',
      numeric: true,
      needs: ['price'],
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'averageCost',
      label: 'Average cost',
      type: 'currency',
      expr: 't.average_cost',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.COST,
      permission: 'products.cost',
    },
    {
      key: 'lastCost',
      label: 'Last cost',
      type: 'currency',
      expr: 't.last_cost',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.COST,
      permission: 'products.cost',
    },
    {
      key: 'stockValue',
      label: 'Stock value at cost',
      type: 'currency',
      expr: '(t.stock_on_hand * t.average_cost)',
      numeric: true,
      group: FIELD_GROUPS.COST,
      permission: 'products.cost',
      hint: 'What the stock on hand is worth at average cost — the money sitting on the shelf.',
    },
    {
      key: 'marginPct',
      label: 'Margin %',
      type: 'percent',
      expr:
        '(CASE WHEN COALESCE(ppr.selling_price_incl, 0) = 0 THEN 0 ELSE ' +
        '((ppr.selling_price_incl - t.average_cost) / ppr.selling_price_incl) * 100 END)',
      numeric: true,
      noTotal: true,
      needs: ['price'],
      group: FIELD_GROUPS.COST,
      permission: 'products.cost',
      hint: 'Against the default selling price, including VAT.',
    },
    { key: 'lastSoldDate', label: 'Last sold', type: 'datetime', expr: 't.last_sold_date', group: FIELD_GROUPS.DATES },
    { key: 'lastPurchaseDate', label: 'Last purchased', type: 'datetime', expr: 't.last_purchase_date', group: FIELD_GROUPS.DATES },
    { key: 'lastEditDate', label: 'Last edited', type: 'datetime', expr: 't.last_edit_date', group: FIELD_GROUPS.DATES },
    { key: 'createdAt', label: 'Created', type: 'datetime', expr: 't.created_at', group: FIELD_GROUPS.DATES },
    {
      key: 'daysSinceSold',
      label: 'Days since last sold',
      type: 'number',
      expr: '(CASE WHEN t.last_sold_date IS NULL THEN NULL ELSE DATEDIFF(CURDATE(), t.last_sold_date) END)',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.DATES,
      hint: 'Empty when the product has never been sold.',
    },
    {
      key: 'daysSincePurchased',
      label: 'Days since last purchased',
      type: 'number',
      expr: '(CASE WHEN t.last_purchase_date IS NULL THEN NULL ELSE DATEDIFF(CURDATE(), t.last_purchase_date) END)',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.DATES,
      hint: 'Empty when the product has never been received on a GRV.',
    },
    {
      /* Measured from the last SALE, not the last purchase: dead stock is
         stock nobody is buying, and a product restocked yesterday that last
         sold in January is exactly what this band must not hide. A product
         never sold ages from when it was first received instead — brand-new
         stock is not dead, it is untried — and one never sold NOR purchased
         (a legacy import) is called what it is. Band edges match the
         stock-intel page (stockIntel.ts AGE_BANDS) so the two never disagree. */
      key: 'ageBand',
      label: 'Age band',
      type: 'text',
      expr:
        '(CASE ' +
        "WHEN COALESCE(t.last_sold_date, t.last_purchase_date) IS NULL THEN 'Never moved' " +
        "WHEN DATEDIFF(CURDATE(), COALESCE(t.last_sold_date, t.last_purchase_date)) <= 30 THEN '0–30 days' " +
        "WHEN DATEDIFF(CURDATE(), COALESCE(t.last_sold_date, t.last_purchase_date)) <= 60 THEN '31–60 days' " +
        "WHEN DATEDIFF(CURDATE(), COALESCE(t.last_sold_date, t.last_purchase_date)) <= 90 THEN '61–90 days' " +
        "WHEN DATEDIFF(CURDATE(), COALESCE(t.last_sold_date, t.last_purchase_date)) <= 180 THEN '91–180 days' " +
        "WHEN DATEDIFF(CURDATE(), COALESCE(t.last_sold_date, t.last_purchase_date)) <= 365 THEN '181–365 days' " +
        "ELSE 'Over a year' END)",
      group: FIELD_GROUPS.DATES,
      hint: 'How long since the product last sold (or, never sold, since it arrived).',
    },
    /* ── Stock-control dates ────────────────────────────────────────────
     *
     * "Not counted in eighteen months" is a real stock-control question and
     * neither date could be asked. Both sit beside ageBand above, which already
     * reasons about last_sold_date and last_purchase_date.
     */
    {
      key: 'lastStockTakeDate',
      label: 'Last counted',
      type: 'datetime',
      expr: 't.last_stock_take_date',
      group: FIELD_GROUPS.DATES,
      hint: 'When the product last appeared on a completed stock take. Blank if it never has.',
    },
    {
      key: 'lastAdjustDate',
      label: 'Last adjusted',
      type: 'datetime',
      expr: 't.last_adjust_date',
      group: FIELD_GROUPS.DATES,
    },

    /* ── Pack and weight ────────────────────────────────────────────────
     *
     * Config, but the kind a buyer and a shelf-planner report on: what a case
     * holds and what it weighs. Dimensions are deliberately NOT here — three
     * millimetre columns are a spec sheet, not a report.
     */
    {
      key: 'packSize',
      label: 'Pack size',
      type: 'number',
      expr: 't.pack_size',
      numeric: true,
      /* A property of one product, never a total across products: adding a
         case of 6 to a case of 24 answers nothing. */
      noTotal: true,
      group: FIELD_GROUPS.PRODUCT,
    },
    { key: 'packDescription', label: 'Pack description', type: 'text', expr: 't.pack_description', group: FIELD_GROUPS.PRODUCT },
    { key: 'packWeight', label: 'Pack weight', type: 'number', expr: 't.pack_weight', numeric: true, noTotal: true, group: FIELD_GROUPS.PRODUCT },
    { key: 'weightDescription', label: 'Weight unit', type: 'text', expr: 't.weight_description', group: FIELD_GROUPS.PRODUCT },

    /* ── Policy flags ───────────────────────────────────────────────────
     *
     * Which products are exempt from the rules everything else is measured by —
     * the question a margin review starts with.
     */
    {
      key: 'maxDiscountPct',
      label: 'Max discount %',
      type: 'percent',
      expr: 't.max_discount_pct',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.PRODUCT,
      hint: 'The ceiling a till will allow on this product without an override.',
    },
    yesNo('nonGpProduct', 'Excluded from margin targets', 't.non_gp_product'),
    yesNo('isManufactured', 'Manufactured', 't.is_manufactured'),
    yesNo('showOnline', 'Sold online', 't.show_online'),
    yesNo('visibleInPos', 'Visible on the till', 't.visible_in_pos'),
    yesNo('scaleItem', 'Weighed at the scale', 't.scale_item'),
    yesNo('allowFractions', 'Sold in fractions', 't.allow_fractions'),
    {
      key: 'expiresInDays',
      label: 'Shelf life (days)',
      type: 'number',
      expr: 't.expires_in_days',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.PRODUCT,
    },
    {
      key: 'extraDescription',
      label: 'Extra description',
      type: 'text',
      expr: 't.extra_description',
      group: FIELD_GROUPS.PRODUCT,
    },
    {
      key: 'kitchenGroup',
      label: 'Kitchen group',
      type: 'text',
      expr: 't.kitchen_group',
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    {
      key: 'prepTimeMinutes',
      label: 'Prep time (minutes)',
      type: 'number',
      expr: 't.prep_time_minutes',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.PRODUCT,
      hint: 'How long the kitchen is expected to take. What it ACTUALLY took is not on this source.',
    },
  ],
}

const STOCK_MOVEMENTS_SOURCE: CatalogSource = {
  key: 'stockMovements',
  label: 'Stock movements',
  description: 'Every change in stock — sales, receipts, adjustments and transfers.',
  category: 'Stock',
  permission: 'stock.view',
  shape: 'timeline',
  table: 'stock_movements',
  dateColumn: 'created_at',
  joins: [PRODUCT_JOIN, PRODUCT_DEPT_JOIN, PRODUCT_BRAND_JOIN, PRODUCT_LEVELS_JOIN],
  fields: [
    {
      key: 'movementType',
      label: 'Movement type',
      type: 'text',
      expr: 't.movement_type',
      starter: true,
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    {
      key: 'productCode',
      label: 'Product code',
      type: 'text',
      expr: 'pm.code',
      needs: ['product'],
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'productDescription',
      label: 'Description',
      type: 'text',
      expr: 'pm.description',
      needs: ['product'],
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'qtyChange',
      label: 'Quantity change',
      type: 'number',
      expr: 't.qty_change',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.QUANTITIES,
      hint: 'Negative for stock leaving, positive for stock arriving.',
    },
    {
      key: 'qtyAfter',
      label: 'Stock after',
      type: 'number',
      expr: 't.qty_after',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'unitCostExcl',
      label: 'Unit cost',
      type: 'currency',
      expr: 't.unit_cost_excl',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.COST,
      permission: 'products.cost',
    },
    {
      key: 'movementValue',
      label: 'Value moved',
      type: 'currency',
      expr: '(t.qty_change * t.unit_cost_excl)',
      numeric: true,
      group: FIELD_GROUPS.COST,
      permission: 'products.cost',
    },
    { key: 'movedAt', label: 'Date', type: 'datetime', expr: 't.created_at', starter: true, group: FIELD_GROUPS.DATES },
    { key: 'userName', label: 'By', type: 'text', expr: 't.user_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'source', label: 'Source', type: 'text', expr: 't.source', group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'note', label: 'Note', type: 'text', expr: 't.note', group: FIELD_GROUPS.OTHER },
    /* Which document caused the movement. Only the id is stored — the document
       could be a sale, a GRV, a transfer or a stock take, in four different
       tables, so there is nothing to join to without knowing `source` first.
       The number is what a person traces with; the id is what they can search
       for, and it beats having no thread back at all. */
    {
      key: 'sourceDocId',
      label: 'Source document',
      type: 'number',
      expr: 't.source_doc_id',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.IDENTITY,
      hint: 'The id of the document that caused this movement — read it with Source.',
    },
    ...PRODUCT_LOOKUP_FIELDS.filter((f) => f.key !== 'currentLastSold'),
    ...timeBuckets('created_at', { hours: true }),
  ],
}

/* ── customers ─────────────────────────────────────────────────────────────── */

const CUSTOMERS_SOURCE: CatalogSource = {
  key: 'customers',
  label: 'Customers',
  description: 'The account list as it stands now — balances, limits, terms and who looks after them.',
  category: 'Customers',
  permission: 'customers.view',
  shape: 'snapshot',
  table: 'customers',
  ownedBy: 'customer',
  joins: [
    { name: 'group', sql: 'LEFT JOIN {C}customer_groups g ON g.id = t.group_id' },
  ],
  note: 'A snapshot of today. Balances are the current figure, not the balance on any past date.',
  fields: [
    { key: 'code', label: 'Account code', type: 'text', expr: 't.code', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'name', label: 'Name', type: 'text', expr: 't.name', starter: true, group: FIELD_GROUPS.IDENTITY },
    enumField('status', 'Status', 't.status', ['active', 'on_hold', 'inactive', 'closed'], { starter: true }),
    { key: 'group', label: 'Customer group', type: 'text', expr: 'g.name', needs: ['group'], group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'rep', label: 'Sales rep', type: 'text', expr: 't.rep_name', needs: [], group: FIELD_GROUPS.PEOPLE },
    { key: 'category', label: 'Category', type: 'text', expr: 't.category', group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'contactName', label: 'Contact', type: 'text', expr: 't.contact_name', group: FIELD_GROUPS.IDENTITY },
    { key: 'email', label: 'Email', type: 'text', expr: 't.email', group: FIELD_GROUPS.IDENTITY },
    { key: 'phone', label: 'Phone', type: 'text', expr: 't.phone', group: FIELD_GROUPS.IDENTITY },
    { key: 'city', label: 'City', type: 'text', expr: 't.city', group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'vatNumber', label: 'VAT number', type: 'text', expr: 't.vat_number', group: FIELD_GROUPS.IDENTITY },
    {
      key: 'balance',
      label: 'Balance',
      type: 'currency',
      expr: 't.balance',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.AGEING,
    },
    { key: 'creditLimit', label: 'Credit limit', type: 'currency', expr: 't.credit_limit', numeric: true, group: FIELD_GROUPS.AGEING },
    {
      key: 'availableCredit',
      label: 'Credit available',
      type: 'currency',
      expr: '(t.credit_limit - t.balance)',
      numeric: true,
      group: FIELD_GROUPS.AGEING,
      hint: 'Negative means the account is over its limit.',
    },
    { key: 'addressLine1', label: 'Address line 1', type: 'text', expr: 't.address_line1', group: FIELD_GROUPS.IDENTITY },
    { key: 'addressLine2', label: 'Address line 2', type: 'text', expr: 't.address_line2', group: FIELD_GROUPS.IDENTITY },
    { key: 'postalCode', label: 'Postal code', type: 'text', expr: 't.postal_code', group: FIELD_GROUPS.IDENTITY },
    { key: 'customerNotes', label: 'Notes', type: 'text', expr: 't.notes', group: FIELD_GROUPS.OTHER },
    {
      key: 'statusReason',
      label: 'Status reason',
      type: 'text',
      expr: 't.status_reason',
      group: FIELD_GROUPS.OTHER,
      hint: 'Why the account was suspended or closed.',
    },
    {
      key: 'customerDiscountPct',
      label: 'Standing discount %',
      type: 'percent',
      expr: 't.discount_pct',
      numeric: true,
      /* A RATE, so it is never totalled. No `ratio` either: the weight that
         would make an average meaningful is turnover, which is not on this
         snapshot source — declaring a ratio against something absent would be
         worse than leaving the figure plainly un-summarised. */
      noTotal: true,
      group: FIELD_GROUPS.ACCOUNT,
    },
    { key: 'dailyLimit', label: 'Daily limit', type: 'currency', expr: 't.daily_limit', numeric: true, noTotal: true, group: FIELD_GROUPS.ACCOUNT },
    { key: 'monthlyLimit', label: 'Monthly limit', type: 'currency', expr: 't.monthly_limit', numeric: true, noTotal: true, group: FIELD_GROUPS.ACCOUNT },
    enumField('statementCycle', 'Statement cycle', 't.statement_cycle', ['monthly', '14day', '7day'], {
      group: FIELD_GROUPS.ACCOUNT,
    }),
    {
      key: 'statementAnchorDay',
      label: 'Statement day',
      type: 'number',
      expr: 't.statement_anchor_day',
      numeric: true,
      /* A day-of-month. Never a total. */
      noTotal: true,
      group: FIELD_GROUPS.ACCOUNT,
      hint: 'The day of the month the account is statemented on.',
    },
    { key: 'statementAnchorDate', label: 'Statement anchor date', type: 'date', expr: 't.statement_anchor_date', group: FIELD_GROUPS.ACCOUNT },
    { key: 'interestRatePct', label: 'Interest rate %', type: 'percent', expr: 't.interest_rate_pct', numeric: true, noTotal: true, group: FIELD_GROUPS.ACCOUNT },
    yesNo('interestEnabled', 'Charges interest', 't.interest_enabled'),
    { key: 'interestGraceDays', label: 'Interest grace (days)', type: 'number', expr: 't.interest_grace_days', numeric: true, noTotal: true, group: FIELD_GROUPS.ACCOUNT },
    yesNo('autoEmailInvoices', 'Auto-emails invoices', 't.auto_email_invoices'),
    {
      key: 'limitUsedPct',
      label: 'Limit used %',
      type: 'percent',
      expr: '(CASE WHEN t.credit_limit = 0 THEN 0 ELSE (t.balance / t.credit_limit) * 100 END)',
      numeric: true,
      noTotal: true,
      ratio: { numerator: 'balance', denominator: 'creditLimit' },
      group: FIELD_GROUPS.AGEING,
    },
    { key: 'termsDays', label: 'Payment terms (days)', type: 'number', expr: 't.payment_terms_days', numeric: true, noTotal: true, group: FIELD_GROUPS.ACCOUNT },
    /*
     * How the account settles. There is no is_cash_only column — this field
     * referenced one and had been unusable since it was written, which nothing
     * noticed because no template picks it. The concept lives in account_type,
     * where 'cash' is the cash-only case.
     *
     * The KEY is kept as isCashOnly: it may be sitting in a saved report or a
     * schedule, and renaming it would break those for a change of wording. It
     * now answers the same question correctly.
     */
    {
      key: 'isCashOnly',
      label: 'Cash only',
      type: 'text',
      expr: "CASE WHEN t.account_type = 'cash' THEN 'Yes' ELSE 'No' END",
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
      ],
      group: FIELD_GROUPS.ACCOUNT,
    },
    /* Read from the shared constant rather than listed again here: a filter
       whose options are a second copy of an enum is how one silently stops
       matching the values in the column. */
    enumField('accountType', 'Account type', 't.account_type', [...ACCOUNT_TYPES]),
    { key: 'createdAt', label: 'Account opened', type: 'datetime', expr: 't.created_at', group: FIELD_GROUPS.DATES },
  ],
}

const CUSTOMER_TXN_SOURCE: CatalogSource = {
  key: 'customerTransactions',
  label: 'Customer ledger',
  description: 'Every invoice, payment, credit and journal on a customer account, with what is still outstanding.',
  category: 'Customers',
  permission: 'customers.view',
  shape: 'timeline',
  table: 'customer_transactions',
  ownedBy: 'customer',
  dateColumn: 'doc_date',
  joins: [
    { name: 'customer', sql: 'LEFT JOIN {C}customers c ON c.id = t.customer_id' },
    CUSTOMER_GROUP_JOIN,
  ],
  fields: [
    {
      key: 'docNumber',
      label: 'Document number',
      type: 'document',
      expr: 't.doc_number',
      /*
       * The ledger holds MIXED kinds — invoices and credit notes come from a
       * sales document, while payments, journals, opening balances and interest
       * do not. `source_doc_id` is the sale for the first group and NULL for the
       * second, which is exactly the right shape: the grid renders a link only
       * where there is an id, so a payment row stays plain text rather than
       * leading somewhere wrong.
       */
      link: { kind: 'sale', idExpr: 't.source_doc_id' },
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    { key: 'docDate', label: 'Date', type: 'date', expr: 't.doc_date', starter: true, group: FIELD_GROUPS.DATES },
    enumField('docType', 'Type', 't.doc_type', ['invoice', 'credit_note', 'payment', 'journal', 'opening', 'interest'], {
      starter: true,
    }),
    {
      key: 'customerName',
      label: 'Customer',
      type: 'text',
      expr: 'c.name',
      needs: ['customer'],
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    { key: 'customerCode', label: 'Account code', type: 'text', expr: 'c.code', needs: ['customer'], group: FIELD_GROUPS.IDENTITY },
    {
      key: 'amountSigned',
      label: 'Amount',
      type: 'currency',
      expr: 't.amount_signed',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Signed so the column adds up to the movement on the account: invoices positive, payments negative.',
    },
    { key: 'amountGross', label: 'Gross amount', type: 'currency', expr: 't.amount_gross', numeric: true, group: FIELD_GROUPS.MONEY },
    { key: 'amountVat', label: 'VAT', type: 'currency', expr: 't.amount_vat', numeric: true, group: FIELD_GROUPS.MONEY },
    {
      key: 'amountOutstanding',
      label: 'Still outstanding',
      type: 'currency',
      expr: 't.amount_outstanding',
      numeric: true,
      group: FIELD_GROUPS.AGEING,
    },
    { key: 'dueDate', label: 'Due date', type: 'date', expr: 't.due_date', group: FIELD_GROUPS.DATES },
    {
      key: 'daysOverdue',
      label: 'Days overdue',
      type: 'number',
      expr: '(CASE WHEN t.due_date IS NULL OR t.amount_outstanding <= 0 THEN NULL ELSE GREATEST(0, DATEDIFF(CURDATE(), t.due_date)) END)',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.AGEING,
      hint: 'Empty for anything already settled or with no due date.',
    },
    { key: 'reference', label: 'Reference', type: 'text', expr: 't.reference', group: FIELD_GROUPS.OTHER },
    { key: 'description', label: 'Description', type: 'text', expr: 't.description', group: FIELD_GROUPS.OTHER },
    { key: 'userName', label: 'Captured by', type: 'text', expr: 't.user_name', group: FIELD_GROUPS.PEOPLE },
    {
      key: 'accountGroup',
      label: 'Customer group',
      type: 'text',
      expr: 'cg.name',
      needs: ['customer', 'customerGroup'],
      group: FIELD_GROUPS.ACCOUNT,
    },
    /* The VAT split 014_subledger.sql stores "for the VAT report" — and which
       no report could read. Zero on a payment, which carries no VAT. */
    { key: 'amountNet', label: 'Amount (excl.)', type: 'currency', expr: 't.amount_net', numeric: true, group: FIELD_GROUPS.MONEY },
    {
      key: 'sourceModule',
      label: 'Raised by',
      type: 'text',
      expr: 't.source',
      group: FIELD_GROUPS.CLASSIFICATION,
      hint: 'Which part of the system wrote the entry — a sale, a payment run, an interest run, an opening balance.',
    },
    { key: 'accountRep', label: 'Sales rep', type: 'text', expr: 'c.rep_name', needs: ['customer'], group: FIELD_GROUPS.PEOPLE },
    ...agedBucketFields(),
    ...timeBuckets('doc_date'),
  ],
}

/* ── suppliers and purchasing ──────────────────────────────────────────────── */

const SUPPLIERS_SOURCE: CatalogSource = {
  key: 'suppliers',
  label: 'Suppliers',
  description: 'The supplier list as it stands now — balances, terms and lead times.',
  category: 'Suppliers',
  permission: 'suppliers.view',
  shape: 'snapshot',
  table: 'suppliers',
  // The supplier file may be the group's — see 206.
  ownedBy: 'supplier',
  fields: [
    { key: 'code', label: 'Supplier code', type: 'text', expr: 't.code', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'name', label: 'Name', type: 'text', expr: 't.name', starter: true, group: FIELD_GROUPS.IDENTITY },
    enumField('status', 'Status', 't.status', ['active', 'on_hold', 'inactive', 'closed'], { starter: true }),
    { key: 'category', label: 'Category', type: 'text', expr: 't.category', group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'contactName', label: 'Contact', type: 'text', expr: 't.contact_name', group: FIELD_GROUPS.IDENTITY },
    { key: 'email', label: 'Email', type: 'text', expr: 't.email', group: FIELD_GROUPS.IDENTITY },
    { key: 'phone', label: 'Phone', type: 'text', expr: 't.phone', group: FIELD_GROUPS.IDENTITY },
    { key: 'city', label: 'City', type: 'text', expr: 't.city', group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'balance', label: 'Balance owed', type: 'currency', expr: 't.balance', numeric: true, starter: true, group: FIELD_GROUPS.AGEING },
    { key: 'termsDays', label: 'Payment terms (days)', type: 'number', expr: 't.payment_terms_days', numeric: true, noTotal: true, group: FIELD_GROUPS.ACCOUNT },
    { key: 'leadTimeDays', label: 'Lead time (days)', type: 'number', expr: 't.lead_time_days', numeric: true, noTotal: true, group: FIELD_GROUPS.ACCOUNT },
    { key: 'minimumOrder', label: 'Minimum order', type: 'currency', expr: 't.minimum_order', numeric: true, noTotal: true, group: FIELD_GROUPS.MONEY },
    { key: 'accountNumber', label: 'Our account number', type: 'text', expr: 't.account_number', group: FIELD_GROUPS.IDENTITY },
    { key: 'supplierVatNumber', label: 'VAT number', type: 'text', expr: 't.vat_number', group: FIELD_GROUPS.IDENTITY },
    { key: 'addressLine1', label: 'Address line 1', type: 'text', expr: 't.address_line1', group: FIELD_GROUPS.IDENTITY },
    { key: 'addressLine2', label: 'Address line 2', type: 'text', expr: 't.address_line2', group: FIELD_GROUPS.IDENTITY },
    { key: 'postalCode', label: 'Postal code', type: 'text', expr: 't.postal_code', group: FIELD_GROUPS.IDENTITY },
    { key: 'supplierNotes', label: 'Notes', type: 'text', expr: 't.notes', group: FIELD_GROUPS.OTHER },
    { key: 'statusReason', label: 'Status reason', type: 'text', expr: 't.status_reason', group: FIELD_GROUPS.OTHER },
    /* Settlement terms: money left on the table if nobody looks at them. */
    { key: 'settlementDiscountPct', label: 'Settlement discount %', type: 'percent', expr: 't.settlement_discount_pct', numeric: true, noTotal: true, group: FIELD_GROUPS.ACCOUNT },
    { key: 'settlementDiscountDays', label: 'Settlement within (days)', type: 'number', expr: 't.settlement_discount_days', numeric: true, noTotal: true, group: FIELD_GROUPS.ACCOUNT },
    /* Banking details carry the same weight as the account number beside them,
       which is already offered without a narrower capability than the source's
       own suppliers.view. Kept consistent with that rather than inventing a
       distinction only these three fields would observe. */
    { key: 'bankName', label: 'Bank', type: 'text', expr: 't.bank_name', group: FIELD_GROUPS.ACCOUNT },
    { key: 'bankBranch', label: 'Bank branch', type: 'text', expr: 't.bank_branch', group: FIELD_GROUPS.ACCOUNT },
    { key: 'bankAccount', label: 'Bank account', type: 'text', expr: 't.bank_account', group: FIELD_GROUPS.ACCOUNT },
    { key: 'createdAt', label: 'Added', type: 'datetime', expr: 't.created_at', group: FIELD_GROUPS.DATES },
  ],
}

const PURCHASE_DOC_TYPES = ['purchase_order', 'grv', 'supplier_return']
/* As SALE_STATUSES: 'void' is not in the live enum and never can be. */
const PURCHASE_STATUSES = ['draft', 'issued', 'finalised', 'cancelled']

const PURCHASES_SOURCE: CatalogSource = {
  key: 'purchases',
  label: 'Purchase documents',
  description: 'One row per order, GRV or return — what was bought and from whom.',
  category: 'Suppliers',
  permission: 'purchasing.view',
  shape: 'timeline',
  table: 'purchase_documents',
  dateColumn: 'document_date',
  // purchase_documents stays in the branch (206) while the supplier file may
  // not, so the join names the far side.
  joins: [{ name: 'supplier', sql: 'LEFT JOIN {S}suppliers s ON s.id = t.supplier_id' }],
  defaultFilters: [{ field: 'status', op: 'eq', value: 'finalised' }],
  fields: [
    { key: 'documentNumber', label: 'Document number', type: 'document', expr: 't.document_number', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'documentDate', label: 'Document date', type: 'date', expr: 't.document_date', starter: true, group: FIELD_GROUPS.DATES },
    enumField('docType', 'Document type', 't.doc_type', PURCHASE_DOC_TYPES, { starter: true }),
    enumField('status', 'Status', 't.status', PURCHASE_STATUSES),
    { key: 'supplierName', label: 'Supplier', type: 'text', expr: 't.supplier_name', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'supplierCode', label: 'Supplier code', type: 'text', expr: 't.supplier_code', group: FIELD_GROUPS.IDENTITY },
    { key: 'supplierInvoiceNo', label: 'Supplier invoice no.', type: 'text', expr: 't.supplier_invoice_no', group: FIELD_GROUPS.IDENTITY },
    { key: 'totalIncl', label: 'Total (incl.)', type: 'currency', expr: 't.total_incl', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    { key: 'subtotalExcl', label: 'Total (excl.)', type: 'currency', expr: 't.subtotal_excl', numeric: true, group: FIELD_GROUPS.MONEY },
    { key: 'vatTotal', label: 'VAT', type: 'currency', expr: 't.vat_total', numeric: true, group: FIELD_GROUPS.MONEY },
    { key: 'chargesExcl', label: 'Charges', type: 'currency', expr: 't.charges_excl', numeric: true, group: FIELD_GROUPS.MONEY },
    { key: 'dueDate', label: 'Due date', type: 'date', expr: 't.due_date', group: FIELD_GROUPS.DATES },
    { key: 'userName', label: 'Captured by', type: 'text', expr: 't.user_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'reference', label: 'Reference', type: 'text', expr: 't.reference', group: FIELD_GROUPS.OTHER },
    {
      key: 'supplierStatus',
      label: 'Supplier status',
      type: 'text',
      expr: 's.status',
      needs: ['supplier'],
      group: FIELD_GROUPS.ACCOUNT,
    },
    {
      key: 'purchaseDiscountPct',
      label: 'Document discount %',
      type: 'percent',
      expr: 't.discount_pct',
      numeric: true,
      /* A rate on the document, not a per-row quantity. The cash it came to is
         the field below, and that one DOES total. */
      noTotal: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'purchaseDiscountExcl',
      label: 'Document discount',
      type: 'currency',
      expr: 't.discount_excl',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Settlement or deal discount taken off the whole order, over and above any per-line discount.',
    },
    { key: 'finalisedAt', label: 'Finalised at', type: 'datetime', expr: 't.finalised_at', group: FIELD_GROUPS.DATES },
    { key: 'cancelledAt', label: 'Cancelled at', type: 'datetime', expr: 't.cancelled_at', group: FIELD_GROUPS.DATES },
    { key: 'cancelReason', label: 'Cancel reason', type: 'text', expr: 't.cancel_reason', group: FIELD_GROUPS.OTHER },
    {
      key: 'purchaseNotes',
      label: 'Note',
      type: 'text',
      expr: 't.notes',
      group: FIELD_GROUPS.OTHER,
      hint: 'The note printed on the order.',
    },
    {
      key: 'internalNote',
      label: 'Internal note',
      type: 'text',
      expr: 't.internal_note',
      group: FIELD_GROUPS.OTHER,
      hint: 'Never printed — the note staff leave for each other.',
    },
    {
      key: 'supplierCategory',
      label: 'Supplier category',
      type: 'text',
      expr: 's.category',
      needs: ['supplier'],
      group: FIELD_GROUPS.ACCOUNT,
    },
    ...timeBuckets('document_date'),
  ],
}

const PURCHASE_LINES_SOURCE: CatalogSource = {
  key: 'purchaseLines',
  label: 'Purchase lines',
  description: 'One row per product bought — quantities ordered and received, and what they cost.',
  category: 'Suppliers',
  permission: 'purchasing.view',
  shape: 'timeline',
  table: 'purchase_document_lines',
  dateColumn: 'document_date',
  joins: [
    { name: 'doc', sql: 'INNER JOIN purchase_documents d ON d.id = t.document_id' },
    PRODUCT_JOIN,
    PRODUCT_DEPT_JOIN,
    PRODUCT_BRAND_JOIN,
    PRODUCT_LEVELS_JOIN,
    LINE_DEPT_JOIN,
  ],
  defaultFilters: [{ field: 'status', op: 'eq', value: 'finalised' }],
  fields: [
    { key: 'productCode', label: 'Product code', type: 'text', expr: 't.product_code', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'description', label: 'Description', type: 'text', expr: 't.description', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'supplierCode', label: 'Supplier’s code', type: 'text', expr: 't.supplier_code', group: FIELD_GROUPS.IDENTITY },
    /* Off the parent (`d`), whose join is always emitted. Who booked the stock
       in is the first question asked of a GRV that looks wrong, and v2's GRV
       history carried it. */
    { key: 'userName', label: 'Captured by', type: 'text', expr: 'd.user_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'reference', label: 'Reference', type: 'text', expr: 'd.reference', group: FIELD_GROUPS.OTHER },
    { key: 'supplierInvoiceNo', label: 'Supplier invoice no.', type: 'text', expr: 'd.supplier_invoice_no', group: FIELD_GROUPS.IDENTITY },
    {
      key: 'lineDepartment',
      label: 'Department',
      type: 'text',
      expr: 'ld.name',
      needs: ['lineDept'],
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    { key: 'qtyOrdered', label: 'Quantity ordered', type: 'number', expr: 't.qty_ordered', numeric: true, starter: true, group: FIELD_GROUPS.QUANTITIES },
    { key: 'qtyReceived', label: 'Quantity received', type: 'number', expr: 't.qty_received', numeric: true, starter: true, group: FIELD_GROUPS.QUANTITIES },
    {
      key: 'qtyOutstanding',
      label: 'Still to come',
      type: 'number',
      expr: '(t.qty_ordered - t.qty_received)',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    { key: 'unitCostExcl', label: 'Unit cost (excl.)', type: 'currency', expr: 't.unit_cost_excl', numeric: true, noTotal: true, group: FIELD_GROUPS.COST },
    { key: 'lineTotalExcl', label: 'Line total (excl.)', type: 'currency', expr: 't.line_total_excl', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    { key: 'lineTotalIncl', label: 'Line total (incl.)', type: 'currency', expr: 't.line_total_incl', numeric: true, group: FIELD_GROUPS.MONEY },
    { key: 'lineVat', label: 'VAT', type: 'currency', expr: 't.line_vat', numeric: true, group: FIELD_GROUPS.MONEY },
    { key: 'discountPct', label: 'Discount %', type: 'percent', expr: 't.discount_pct', numeric: true, noTotal: true, group: FIELD_GROUPS.MONEY },
    { key: 'landedCostExcl', label: 'Landed cost', type: 'currency', expr: 't.landed_cost_excl', numeric: true, noTotal: true, group: FIELD_GROUPS.COST, hint: 'Unit cost with charges apportioned in.' },
    { key: 'documentNumber', label: 'Document number', type: 'document', expr: 'd.document_number', group: FIELD_GROUPS.IDENTITY },
    { key: 'documentDate', label: 'Document date', type: 'date', expr: 'd.document_date', group: FIELD_GROUPS.DATES },
    enumField('docType', 'Document type', 'd.doc_type', PURCHASE_DOC_TYPES),
    enumField('status', 'Document status', 'd.status', PURCHASE_STATUSES),
    { key: 'supplierName', label: 'Supplier', type: 'text', expr: 'd.supplier_name', starter: true, group: FIELD_GROUPS.IDENTITY },
    {
      key: 'qtyBonus',
      label: 'Bonus qty',
      type: 'number',
      expr: 't.qty_bonus',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
      hint: 'Free stock the supplier added — received and costed at nothing.',
    },
    { key: 'lineDiscountAmount', label: 'Line discount', type: 'currency', expr: 't.discount_amount', numeric: true, group: FIELD_GROUPS.MONEY },
    { key: 'vatRatePct', label: 'VAT rate %', type: 'percent', expr: 't.vat_rate_pct', numeric: true, noTotal: true, group: FIELD_GROUPS.MONEY },
    {
      key: 'chargeExcl',
      label: 'Charges (excl.)',
      type: 'currency',
      expr: 't.charge_excl',
      numeric: true,
      group: FIELD_GROUPS.COST,
      hint: 'Freight and duty apportioned onto the line — part of what the stock really cost.',
    },
    {
      key: 'sellingPriceIncl',
      label: 'Selling price at receipt',
      type: 'currency',
      expr: 't.selling_price_incl',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'What the item was to be sold at when it was received — blank where none was set.',
    },
    { key: 'productType', label: 'Line type', type: 'text', expr: 't.product_type', group: FIELD_GROUPS.CLASSIFICATION },
    ...PRODUCT_LOOKUP_FIELDS,
    ...timeBuckets('document_date').map((f) => ({
      ...f,
      expr: f.expr.replace(/t\.`document_date`/g, 'd.`document_date`'),
    })),
  ],
}

/* ── expenses ──────────────────────────────────────────────────────────────── */

const EXPENSE_LINES_SOURCE: CatalogSource = {
  key: 'expenseLines',
  label: 'Expenses',
  description: 'One row per expense line — what was spent, on what category, and whether VAT is claimable.',
  category: 'Money',
  permission: 'cashbook.view',
  shape: 'timeline',
  table: 'expense_lines',
  dateColumn: 'expense_date',
  joins: [
    { name: 'exp', sql: 'INNER JOIN expenses e ON e.id = t.expense_id' },
    { name: 'cat', sql: 'LEFT JOIN expense_categories ec ON ec.id = t.category_id' },
    { name: 'expDept', sql: 'LEFT JOIN departments ed ON ed.id = t.department_id' },
  ],
  defaultFilters: [{ field: 'status', op: 'eq', value: 'finalised' }],
  fields: [
    { key: 'categoryName', label: 'Category', type: 'text', expr: 't.category_name', starter: true, group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'categoryCode', label: 'Account code', type: 'text', expr: 't.category_code', group: FIELD_GROUPS.CLASSIFICATION },
    {
      key: 'categoryType',
      label: 'Category type',
      type: 'text',
      expr: 'ec.category_type',
      needs: ['cat'],
      group: FIELD_GROUPS.CLASSIFICATION,
      options: ['operating', 'cost_of_sales', 'capital', 'other'].map((v) => ({ value: v, label: humanise(v) })),
    },
    { key: 'department', label: 'Department', type: 'text', expr: 'ed.name', needs: ['expDept'], group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'lineDescription', label: 'Description', type: 'text', expr: 't.description', group: FIELD_GROUPS.IDENTITY },
    { key: 'lineExcl', label: 'Amount (excl.)', type: 'currency', expr: 't.line_excl', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    { key: 'lineVat', label: 'VAT', type: 'currency', expr: 't.line_vat', numeric: true, group: FIELD_GROUPS.MONEY },
    { key: 'lineIncl', label: 'Amount (incl.)', type: 'currency', expr: 't.line_incl', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    { key: 'expenseDate', label: 'Date', type: 'date', expr: 'e.expense_date', starter: true, group: FIELD_GROUPS.DATES },
    { key: 'documentNumber', label: 'Document number', type: 'document', expr: 'e.document_number', group: FIELD_GROUPS.IDENTITY },
    { key: 'supplierName', label: 'Paid to', type: 'text', expr: 'e.supplier_name', starter: true, group: FIELD_GROUPS.IDENTITY },
    /* 'void' is right HERE, unlike on sales and purchases: expenses.status is
       still enum('draft','finalised','void') — 022 only merged the value on
       sales documents. Checked against the live column, not assumed. */
    enumField('status', 'Status', 'e.status', ['draft', 'finalised', 'void']),
    enumField('paymentType', 'Payment type', 'e.payment_type', ['on_account', 'direct']),
    { key: 'supplierInvoiceNo', label: 'Supplier invoice no.', type: 'text', expr: 'e.supplier_invoice_no', group: FIELD_GROUPS.IDENTITY },
    { key: 'reference', label: 'Reference', type: 'text', expr: 'e.reference', group: FIELD_GROUPS.OTHER },
    { key: 'userName', label: 'Captured by', type: 'text', expr: 'e.user_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'dueDate', label: 'Due date', type: 'date', expr: 'e.due_date', group: FIELD_GROUPS.DATES },
    { key: 'vatRatePct', label: 'VAT rate %', type: 'percent', expr: 't.vat_rate_pct', numeric: true, noTotal: true, group: FIELD_GROUPS.MONEY },
    /* Whether the VAT on this line can actually be claimed back. The source
       description already promises this column ("whether VAT is claimable")
       and it was the one thing the source could not answer. */
    yesNo('vatClaimable', 'VAT claimable', 't.vat_claimable'),
    ...timeBuckets('expense_date').map((f) => ({
      ...f,
      expr: f.expr.replace(/t\.`expense_date`/g, 'e.`expense_date`'),
    })),
  ],
}

/* ── operations ────────────────────────────────────────────────────────────── */

const SHIFTS_SOURCE: CatalogSource = {
  key: 'shifts',
  label: 'Cash-ups',
  description: 'One row per shift — what was expected in the drawer, what was counted, and the variance.',
  category: 'Operations',
  permission: 'sales.cashup',
  shape: 'timeline',
  table: 'shifts',
  dateColumn: 'opened_at',
  fields: [
    /*
     * The cash-up itself, as something you can OPEN.
     *
     * Shows the NUMBER — CSH_01_000001 — and links to the signed declaration,
     * which is the record a reader chasing a variance actually wants.
     *
     * It used to show `t.id` and was kept out of `starter` precisely because a
     * row id is a poor thing to read: it counts every shift ever opened, it is
     * not the 47th cash-up of anything, and it means something different at each
     * branch of a group. 233 gave a shift a real number, so the column is worth
     * reading on its own and now leads the starter set.
     *
     * COALESCE, not a bare column: a shift opened before its site had a sequence
     * has no number, and a blank cell in the identity column reads as a broken
     * report rather than as an old row.
     */
    {
      key: 'cashupRef',
      label: 'Cash-up',
      type: 'document',
      expr: "COALESCE(t.document_number, CONCAT('Cash-up #', t.id))",
      link: { kind: 'cashup', idExpr: 't.id' },
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
      hint: 'Opens the signed count for this shift.',
    },
    { key: 'terminalCode', label: 'Till', type: 'text', expr: 't.terminal_code', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'userName', label: 'Opened by', type: 'text', expr: 't.user_name', starter: true, group: FIELD_GROUPS.PEOPLE },
    { key: 'closedByName', label: 'Closed by', type: 'text', expr: 't.closed_by_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'openedAt', label: 'Opened at', type: 'datetime', expr: 't.opened_at', starter: true, group: FIELD_GROUPS.DATES },
    { key: 'closedAt', label: 'Closed at', type: 'datetime', expr: 't.closed_at', group: FIELD_GROUPS.DATES },
    { key: 'openingFloat', label: 'Opening float', type: 'currency', expr: 't.opening_float', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    /*
     * The drawer movements, split by kind and summed per shift.
     *
     * shift_movements stores the amount SIGNED — a payout and a drop are both
     * negative, a pay-in positive — so that the drawer position is a plain SUM.
     * That is right for the arithmetic and wrong for a column someone reads: a
     * manager asking "what went out in payouts" wants R240, not −R240, and a
     * column of negatives beside a column of positives invites adding them into
     * a number that means nothing.
     *
     * So each of these reports its own MAGNITUDE, and `drawerMovements` below
     * keeps the signed sum for anyone who wants the net effect on the drawer.
     */
    {
      key: 'payouts',
      label: 'Payouts',
      type: 'currency',
      expr:
        "(SELECT COALESCE(SUM(ABS(sm.amount)), 0) FROM shift_movements sm " +
        "WHERE sm.shift_id = t.id AND sm.movement_type = 'payout')",
      numeric: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Money taken out for an expense. Shown as a positive amount — it left the drawer.',
    },
    {
      key: 'payins',
      label: 'Pay-ins',
      type: 'currency',
      expr:
        "(SELECT COALESCE(SUM(ABS(sm.amount)), 0) FROM shift_movements sm " +
        "WHERE sm.shift_id = t.id AND sm.movement_type = 'payin')",
      numeric: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Money added that was not a sale — a top-up, or change brought in.',
    },
    {
      key: 'drops',
      label: 'Drops to safe',
      type: 'currency',
      expr:
        "(SELECT COALESCE(SUM(ABS(sm.amount)), 0) FROM shift_movements sm " +
        "WHERE sm.shift_id = t.id AND sm.movement_type = 'drop')",
      numeric: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Cash moved to the safe mid-shift. Shown as a positive amount — it left the drawer.',
    },
    {
      key: 'drawerMovements',
      label: 'Movements (net)',
      type: 'currency',
      expr:
        '(SELECT COALESCE(SUM(sm.amount), 0) FROM shift_movements sm WHERE sm.shift_id = t.id)',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Pay-ins less payouts and drops — the net effect on the drawer. Negative means more left than came in.',
    },
    {
      key: 'saleCount',
      label: 'Sales',
      type: 'number',
      /*
       * How many sales were rung on this shift — the "you did 11 sales today"
       * figure, counted once per DOCUMENT rather than per tender or per line.
       *
       * Cancelled documents are excluded: they were reversed, so counting them
       * would inflate the day against takings that are not there. The tender
       * breakdown counts differently on purpose — see `transactionCount` on the
       * by-tender source, which counts tender ROWS, so a split-tender sale
       * lands in two tenders while staying ONE sale here.
       */
      expr:
        "(SELECT COUNT(*) FROM sales_documents sd WHERE sd.shift_id = t.id " +
        "AND sd.status <> 'cancelled')",
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.QUANTITIES,
      hint: 'Documents rung on this shift, cancelled ones excluded. A split-tender sale counts once.',
    },
    { key: 'expectedTotal', label: 'Expected', type: 'currency', expr: 't.expected_total', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    { key: 'countedTotal', label: 'Counted', type: 'currency', expr: 't.counted_total', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    {
      key: 'variance',
      label: 'Variance',
      type: 'currency',
      expr: 't.variance',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
      tone: 'variance',
      hint: 'Negative means the drawer was short.',
    },
    {
      key: 'varianceAbs',
      label: 'Variance (ignoring sign)',
      type: 'currency',
      expr: 'ABS(t.variance)',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Use this to rank who is furthest out either way — a R100 over and a R100 short are both worth a look.',
    },
    { key: 'varianceNote', label: 'Variance note', type: 'text', expr: 't.variance_note', group: FIELD_GROUPS.OTHER },
    {
      key: 'shiftHours',
      label: 'Hours open',
      type: 'number',
      expr: '(CASE WHEN t.closed_at IS NULL THEN NULL ELSE TIMESTAMPDIFF(MINUTE, t.opened_at, t.closed_at) / 60 END)',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.OTHER,
    },
    enumField('mode', 'Cash-up mode', 't.mode', ['terminal', 'user'], {
      hint: 'Whether the drawer belongs to a till or to a person and their own float.',
    }),
    ...timeBuckets('opened_at', { hours: true }),
  ],
}

/* ── Job time, travel and visits ─────────────────────────────────────────────
 *
 * Three tables that existed since phases 5, 6 and 4 and were never exposed to
 * the builder — which is why twelve of the PRD's fifteen Phase-1 reports could
 * not be expressed even by hand. A source is the durable half of a report:
 * once a table is in the catalog, anybody can answer a question nobody
 * anticipated, without a developer.
 *
 * All three hang off a job and date from their OWN event rather than from the
 * job, unlike job_card_lines. A line dates from its job because a part added on
 * Friday to a Monday job belongs to Monday's cost. But a trip made on Friday IS
 * a Friday trip — a travel report scoped to last week must show last week's
 * driving, not the driving on jobs logged last week.
 */

const JOB_TIME_SOURCE: CatalogSource = {
  key: 'jobTime',
  label: 'Job time',
  description: 'Hours worked on jobs — who, when, how long, and what it cost.',
  category: 'Operations',
  // jobs.view, not staff.view: this answers "what did this job take", and the
  // job capability is what already gates every other job figure. The COST
  // fields carry their own jobs.cost requirement below.
  permission: 'jobs.view',
  shape: 'timeline',
  table: 'staff_time_entries',
  dateColumn: 'started_at',
  /*
   * INNER JOIN, and `always`.
   *
   * staff_time_entries holds every clock-in in the business, most of which have
   * no job at all — it is the till's timesheet table too. Without the inner
   * join this source would report a shop assistant's Tuesday as job time. The
   * join IS the filter.
   */
  joins: [
    { name: 'job', sql: 'INNER JOIN job_cards j ON j.id = t.job_card_id', always: true },
    { name: 'jobStatus', sql: 'LEFT JOIN job_statuses js ON js.id = j.status_id' },
    { name: 'jobCustomer', sql: 'LEFT JOIN {C}customers jc ON jc.id = j.customer_id' },
  ],
  note: 'Only time booked against a job. A shift with no job on it is on the timesheet, not here.',
  fields: [
    {
      key: 'jobNumber',
      label: 'Job number',
      type: 'document',
      expr: 'j.document_number',
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'jobTitle',
      label: 'What the job is',
      type: 'text',
      expr: 'j.title',
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'customerName',
      label: 'Customer',
      type: 'text',
      expr: 'COALESCE(jc.name, j.customer_name)',
      starter: true,
      needs: ['jobCustomer'],
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'statusName',
      label: 'Stage',
      type: 'text',
      expr: 'js.name',
      needs: ['jobStatus'],
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    {
      key: 'userName',
      label: 'Who worked',
      type: 'text',
      expr: 't.user_name',
      starter: true,
      group: FIELD_GROUPS.PEOPLE,
    },
    {
      key: 'startedAt',
      label: 'Started',
      type: 'datetime',
      expr: 't.started_at',
      starter: true,
      group: FIELD_GROUPS.DATES,
    },
    { key: 'endedAt', label: 'Ended', type: 'datetime', expr: 't.ended_at', group: FIELD_GROUPS.DATES },
    {
      /*
       * Minutes, net of breaks, and NULL while the timer is still running.
       *
       * A running entry has no end, so TIMESTAMPDIFF against NULL is NULL — and
       * that is right: counting an open timer as "zero minutes" would quietly
       * understate a technician's day, and counting it up to NOW() would make
       * the same report give a different answer every time it ran.
       */
      key: 'minutes',
      label: 'Minutes worked',
      type: 'number',
      expr: 'CASE WHEN t.ended_at IS NULL THEN NULL ELSE GREATEST(0, TIMESTAMPDIFF(MINUTE, t.started_at, t.ended_at) - COALESCE(t.break_minutes, 0)) END',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'hours',
      label: 'Hours worked',
      type: 'number',
      expr: 'CASE WHEN t.ended_at IS NULL THEN NULL ELSE ROUND(GREATEST(0, TIMESTAMPDIFF(MINUTE, t.started_at, t.ended_at) - COALESCE(t.break_minutes, 0)) / 60, 2) END',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'breakMinutes',
      label: 'Break minutes',
      type: 'number',
      expr: 'COALESCE(t.break_minutes, 0)',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    yesNo('stillRunning', 'Timer still running', 'CASE WHEN t.ended_at IS NULL THEN 1 ELSE 0 END'),
    /*
     * An entry somebody corrected after the fact. BCEA s31 requires the original
     * to survive, which it does in original_started_at — this flag is what makes
     * the corrected ones findable.
     */
    yesNo('wasEdited', 'Time was corrected', 'CASE WHEN t.edited_at IS NULL THEN 0 ELSE 1 END'),
    {
      key: 'editedReason',
      label: 'Why it was corrected',
      type: 'text',
      expr: 't.edited_reason',
      group: FIELD_GROUPS.OTHER,
    },
    enumField('entrySource', 'Captured by', 't.source', ['pin', 'manual', 'import'], {
      hint: 'Clocked in on a till PIN, typed in afterwards, or imported.',
    }),
    /* The approval and edit trail. A timesheet edited after the fact is an
       audit question, and none of it could be asked. */
    { key: 'approvedAt', label: 'Approved at', type: 'datetime', expr: 't.approved_at', group: FIELD_GROUPS.DATES },
    { key: 'approvedByName', label: 'Approved by', type: 'text', expr: 't.approved_by_name', group: FIELD_GROUPS.PEOPLE },
    {
      key: 'isApproved',
      label: 'Approved',
      type: 'text',
      expr: "(CASE WHEN t.approved_at IS NULL THEN 'No' ELSE 'Yes' END)",
      group: FIELD_GROUPS.FLAGS,
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
      ],
    },
    { key: 'editedByName', label: 'Edited by', type: 'text', expr: 't.edited_by_name', group: FIELD_GROUPS.PEOPLE },
    {
      key: 'originalStartedAt',
      label: 'Originally started at',
      type: 'datetime',
      expr: 't.original_started_at',
      group: FIELD_GROUPS.DATES,
      hint: 'What the clock said before somebody edited it. Blank where the entry was never edited.',
    },
    { key: 'originalEndedAt', label: 'Originally ended at', type: 'datetime', expr: 't.original_ended_at', group: FIELD_GROUPS.DATES },
    {
      key: 'wasEdited',
      label: 'Edited after capture',
      type: 'text',
      expr: "(CASE WHEN t.original_started_at IS NULL AND t.original_ended_at IS NULL THEN 'No' ELSE 'Yes' END)",
      group: FIELD_GROUPS.FLAGS,
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
      ],
    },
    { key: 'note', label: 'Note', type: 'text', expr: 't.note', group: FIELD_GROUPS.OTHER },
    ...timeBuckets('started_at', { hours: true }),
  ],
}

const JOB_TRAVEL_SOURCE: CatalogSource = {
  key: 'jobTravel',
  label: 'Job travel',
  description: 'Every trip — expected, recorded, verified and what was charged.',
  category: 'Operations',
  permission: 'jobs.view',
  shape: 'timeline',
  table: 'job_card_travel',
  // The date the driving happened, not the date the job was logged. See the
  // block comment above.
  dateColumn: 'travelled_on',
  joins: [
    { name: 'job', sql: 'INNER JOIN job_cards j ON j.id = t.job_card_id', always: true },
    { name: 'jobCustomer', sql: 'LEFT JOIN {C}customers jc ON jc.id = j.customer_id' },
  ],
  fields: [
    {
      key: 'jobNumber',
      label: 'Job number',
      type: 'document',
      expr: 'j.document_number',
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'customerName',
      label: 'Customer',
      type: 'text',
      expr: 'COALESCE(jc.name, j.customer_name)',
      starter: true,
      needs: ['jobCustomer'],
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'userName',
      label: 'Who drove',
      type: 'text',
      expr: 't.user_name',
      starter: true,
      group: FIELD_GROUPS.PEOPLE,
    },
    {
      key: 'travelledOn',
      label: 'Date',
      type: 'date',
      expr: 't.travelled_on',
      starter: true,
      group: FIELD_GROUPS.DATES,
    },
    { key: 'fromLabel', label: 'From', type: 'text', expr: 't.from_label', group: FIELD_GROUPS.OTHER },
    { key: 'toLabel', label: 'To', type: 'text', expr: 't.to_label', group: FIELD_GROUPS.OTHER },
    /*
     * FOUR distances, and they are four different facts — see the header of
     * 108_job_travel. Expected is the map, recorded is the claim, verified is a
     * manager accepting it, chargeable is after the rounding rule. A report that
     * showed one of them would be answering a question nobody asked.
     */
    {
      key: 'expectedKm',
      label: 'Expected km',
      type: 'number',
      expr: 't.expected_km',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'recordedKm',
      label: 'Recorded km',
      type: 'number',
      expr: 't.recorded_km',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'verifiedKm',
      label: 'Verified km',
      type: 'number',
      expr: 't.verified_km',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'chargeableKm',
      label: 'Chargeable km',
      type: 'number',
      expr: 't.chargeable_km',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      /* Recorded minus expected. The figure the tolerance check is really about,
         and NULL where there is no expectation to compare against. */
      key: 'varianceKm',
      label: 'Over the expected',
      type: 'number',
      expr: 'CASE WHEN t.expected_km IS NULL THEN NULL ELSE t.recorded_km - t.expected_km END',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'travelMinutes',
      label: 'Travel minutes',
      type: 'number',
      expr: 't.travel_minutes',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'ratePerKm',
      label: 'Rate per km',
      type: 'currency',
      expr: 't.rate_per_km',
      numeric: true,
      // A rate is not a total. Summing R6.50 across forty trips is meaningless.
      noTotal: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'travelCharge',
      label: 'Travel charge',
      type: 'currency',
      expr: 'ROUND(COALESCE(t.chargeable_km, 0) * COALESCE(t.rate_per_km, 0), 2)',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'travelCost',
      label: 'Travel cost',
      type: 'currency',
      expr: 'ROUND(COALESCE(t.chargeable_km, 0) * COALESCE(t.cost_per_km, 0), 2)',
      numeric: true,
      // Cost is not the same permission as the job itself: a dispatcher may see
      // the kilometres without seeing what they cost the business.
      permission: 'jobs.cost',
      group: FIELD_GROUPS.COST,
    },
    yesNo('verified', 'Checked by somebody', 'CASE WHEN t.verified_at IS NULL THEN 0 ELSE 1 END'),
    yesNo('toleranceBreached', 'Over the tolerance', 't.tolerance_breached'),
    {
      key: 'verifiedByName',
      label: 'Checked by',
      type: 'text',
      expr: 't.verified_by_name',
      group: FIELD_GROUPS.PEOPLE,
    },
    enumField('recordedSource', 'Distance from', 't.recorded_source', ['manual', 'odometer', 'gps'], {
      hint: 'How the distance was arrived at. Verifying a claim against this is the point of recording it.',
    }),
    enumField('expectedSource', 'Expected distance from', 't.expected_source', ['estimated', 'provider', 'manual']),
    yesNo('isReturn', 'Return leg', 't.is_return'),
    { key: 'verifyNote', label: 'Verification note', type: 'text', expr: 't.verify_note', group: FIELD_GROUPS.OTHER },
    {
      /* The coordinates themselves are not a report column — four decimal
         columns tell nobody anything. Whether the trip was GPS-stamped at all
         is the fact a manager checks, so that is what is offered. */
      key: 'hasGpsFix',
      label: 'GPS recorded',
      type: 'text',
      expr:
        "(CASE WHEN t.departed_lat IS NOT NULL OR t.arrived_lat IS NOT NULL " +
        "THEN 'Yes' ELSE 'No' END)",
      group: FIELD_GROUPS.FLAGS,
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
      ],
      hint: 'Whether the phone stamped a position at either end of the trip.',
    },
    { key: 'userCreatedName', label: 'Captured by', type: 'text', expr: 't.user_created_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'note', label: 'Note', type: 'text', expr: 't.note', group: FIELD_GROUPS.OTHER },
    ...timeBuckets('travelled_on'),
  ],
}

const JOB_VISITS_SOURCE: CatalogSource = {
  key: 'jobVisits',
  label: 'Job visits',
  description: 'Every appointment — booked, attended, late, missed or cancelled.',
  category: 'Operations',
  permission: 'jobs.view',
  shape: 'timeline',
  table: 'job_card_appointments',
  dateColumn: 'starts_at',
  joins: [
    { name: 'job', sql: 'INNER JOIN job_cards j ON j.id = t.job_card_id', always: true },
    { name: 'jobCustomer', sql: 'LEFT JOIN {C}customers jc ON jc.id = j.customer_id' },
    { name: 'visitAddress', sql: 'LEFT JOIN service_addresses jsa ON jsa.id = t.service_address_id' },
  ],
  fields: [
    {
      key: 'jobNumber',
      label: 'Job number',
      type: 'document',
      expr: 'j.document_number',
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'customerName',
      label: 'Customer',
      type: 'text',
      expr: 'COALESCE(jc.name, j.customer_name)',
      starter: true,
      needs: ['jobCustomer'],
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'addressName',
      label: 'Where',
      type: 'text',
      expr: 'jsa.name',
      needs: ['visitAddress'],
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'visitNumber',
      label: 'Visit number',
      type: 'number',
      expr: 't.visit_number',
      // A visit NUMBER is an identifier, not a quantity. Summing them is
      // nonsense, and a grid that totals the column invites the question.
      noTotal: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'status',
      label: 'Outcome',
      type: 'text',
      expr: 't.status',
      starter: true,
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    {
      key: 'visitType',
      label: 'Kind of visit',
      type: 'text',
      expr: 't.visit_type',
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    {
      key: 'startsAt',
      label: 'Booked for',
      type: 'datetime',
      expr: 't.starts_at',
      starter: true,
      group: FIELD_GROUPS.DATES,
    },
    { key: 'arrivedAt', label: 'Arrived', type: 'datetime', expr: 't.arrived_at', group: FIELD_GROUPS.DATES },
    { key: 'departedAt', label: 'Left', type: 'datetime', expr: 't.departed_at', group: FIELD_GROUPS.DATES },
    {
      key: 'durationMinutes',
      label: 'Booked minutes',
      type: 'number',
      expr: 't.duration_minutes',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      /*
       * Minutes late. NEGATIVE means early, and that is deliberate — a report
       * that clamped early arrivals to zero would make the average look worse
       * than the service actually is.
       *
       * NULL where nobody arrived, which is what keeps a no-show out of the
       * punctuality average instead of counting as infinitely late.
       */
      key: 'minutesLate',
      label: 'Minutes late',
      type: 'number',
      expr: 'CASE WHEN t.arrived_at IS NULL THEN NULL ELSE TIMESTAMPDIFF(MINUTE, t.starts_at, t.arrived_at) END',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'onSiteMinutes',
      label: 'Minutes on site',
      type: 'number',
      expr: 'CASE WHEN t.arrived_at IS NULL OR t.departed_at IS NULL THEN NULL ELSE TIMESTAMPDIFF(MINUTE, t.arrived_at, t.departed_at) END',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    /* "On time" needs a definition, and the PRD gives one: within fifteen
       minutes of the booking. Hard-coded rather than a setting, because a report
       whose definition moves is a report two people read differently. */
    yesNo(
      'onTime',
      'On time (within 15 min)',
      'CASE WHEN t.arrived_at IS NULL THEN 0 WHEN TIMESTAMPDIFF(MINUTE, t.starts_at, t.arrived_at) <= 15 THEN 1 ELSE 0 END',
    ),
    yesNo('attended', 'Somebody arrived', 'CASE WHEN t.arrived_at IS NULL THEN 0 ELSE 1 END'),
    yesNo('missed', 'No-show', "CASE WHEN t.status = 'no_show' THEN 1 ELSE 0 END"),
    yesNo('cancelled', 'Cancelled', "CASE WHEN t.status = 'cancelled' THEN 1 ELSE 0 END"),
    {
      key: 'outcomeReason',
      label: 'Why it ended that way',
      type: 'text',
      expr: 't.outcome_reason',
      group: FIELD_GROUPS.OTHER,
    },
    { key: 'visitUserName', label: 'Assigned to', type: 'text', expr: 't.user_name', group: FIELD_GROUPS.PEOPLE },
    {
      key: 'travelStartedAt',
      label: 'Travel started at',
      type: 'datetime',
      expr: 't.travel_started_at',
      group: FIELD_GROUPS.DATES,
      hint: 'When the technician set off, as against when the visit was booked to start.',
    },
    { key: 'overrideReason', label: 'Override reason', type: 'text', expr: 't.override_reason', group: FIELD_GROUPS.OTHER },
    { key: 'notes', label: 'Notes', type: 'text', expr: 't.notes', group: FIELD_GROUPS.OTHER },
    ...timeBuckets('starts_at', { hours: true }),
  ],
}

const ACTIVITY_SOURCE: CatalogSource = {
  key: 'activity',
  label: 'Activity log',
  description: 'Who did what, and when — the audit trail behind every change.',
  category: 'Operations',
  permission: 'setup.view',
  shape: 'timeline',
  table: 'activity_log',
  dateColumn: 'created_at',
  fields: [
    { key: 'action', label: 'Action', type: 'text', expr: 't.action', starter: true, group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'entityType', label: 'Record type', type: 'text', expr: 't.entity', starter: true, group: FIELD_GROUPS.CLASSIFICATION },
    {
      /* What actually changed, field by field. Written as JSON and read here as
         text: nothing queries INSIDE it (011), and a report that could filter
         on a key within the document would be promising an index that does not
         exist. Shown, not searched — which is what an audit trail is read for.
         This is the column that answers "who changed this price", the one
         question v2 had a dedicated report for and this system had no way to
         answer at all. */
      key: 'changes',
      label: 'What changed',
      type: 'text',
      expr: 't.changes',
      group: FIELD_GROUPS.OTHER,
      hint: 'The before and after values, as recorded.',
    },
    {
      key: 'entityLabel',
      label: 'Record',
      type: 'text',
      // The log stores what was acted on as entity + entity_id and never the
      // record's name — deliberately, so a line survives the record being
      // deleted. There is nothing to join to (the entity names a different
      // table per row), so the reference is shown as written.
      expr: "CONCAT(t.entity, COALESCE(CONCAT(' #', t.entity_id), ''))",
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
      hint: 'The record the entry is against, as type and id — the log stores no name.',
    },
    { key: 'userName', label: 'By', type: 'text', expr: 't.user_name', starter: true, group: FIELD_GROUPS.PEOPLE },
    { key: 'detail', label: 'Detail', type: 'text', expr: 't.detail', group: FIELD_GROUPS.OTHER },
    { key: 'createdAt', label: 'When', type: 'datetime', expr: 't.created_at', starter: true, group: FIELD_GROUPS.DATES },
    ...timeBuckets('created_at', { hours: true }),
  ],
}

/**
 * The answers a till was given when it asked its questions.
 *
 * ── WHY THIS IS A SOURCE OF ITS OWN ─────────────────────────────────────────
 *
 * "How many extra bacon did we sell in March, and what did it earn?" cannot be
 * answered from `saleLines`: a modifier is not a line, and deliberately so —
 * everything downstream of sales_document_lines is built on "one row is one
 * product sold", and a bacon posing as a line would land in units-sold and
 * margin reports as though somebody had bought one.
 *
 * So the answers live in their own table, and this is what makes them
 * askable-about. In hospitality the modifiers are a real slice of the margin,
 * and a shop that can price them but never count them is only half served.
 *
 * ── THE FIGURE THAT NEEDS EXPLAINING ────────────────────────────────────────
 *
 * `lineAdjustIncl` is what an answer contributed to its line — and that money is
 * ALREADY inside the line's own total, because an answer's price is folded into
 * `unit_price_incl` so specials, discounts and VAT price the item as sold.
 *
 * This source and `saleLines` therefore overlap on purpose, and adding a total
 * from each together double-counts. The hint on the field says so, because the
 * person building the report is the one who needs to know.
 */
const SALE_MODIFIERS_SOURCE: CatalogSource = {
  key: 'saleModifiers',
  label: 'Sales instructions',
  description:
    'One row per answer chosen when the till asked — extra bacon, no onions, which sauce. The source for "what did they ask for".',
  category: 'Sales',
  permission: 'sales.view',
  shape: 'timeline',
  table: 'sales_document_line_instructions',
  dateColumn: 'document_date',
  joins: [
    // The date and the document context live on the parent document. NOT
    // optional — the date range filters through it — so it is always emitted.
    { name: 'doc', sql: 'INNER JOIN sales_documents d ON d.id = t.document_id' },
    // The LINE this answer hangs off, so "which product was it asked about" can
    // be answered. Marked `always` because the comment has claimed it is not
    // optional since it was written, while joinsFor only ever forced `doc` and
    // `exp` — so it was in fact dropped whenever nothing referenced it.
    { name: 'line', sql: 'INNER JOIN sales_document_lines sl ON sl.id = t.line_id', always: true },
    // Reads `sl`, so it depends on the line join above.
    {
      name: 'product',
      sql: 'LEFT JOIN products pm ON pm.id = sl.product_id',
      needs: ['line'],
    },
    PRODUCT_DEPT_JOIN,
    { name: 'customer', sql: 'LEFT JOIN {C}customers c ON c.id = d.customer_id' },
  ],
  defaultFilters: [{ field: 'status', op: 'eq', value: 'finalised' }],
  note: 'Starts with finalised documents only. The money here is already inside the sales-line totals — it is the breakdown of what was charged, not an extra charge.',
  fields: [
    {
      key: 'optionName',
      label: 'Answer',
      type: 'text',
      // The SNAPSHOT, not a join to instruction_options: renaming "Extra bacon"
      // must not rewrite what last month's tickets said, and the option may
      // since have been deleted entirely.
      expr: 't.option_name',
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'groupName',
      label: 'Question',
      type: 'text',
      expr: 't.group_name',
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
      hint: 'The question this was an answer to, as it was named at the time.',
    },
    {
      key: 'soldProductCode',
      label: 'Sold on product',
      type: 'text',
      expr: 'sl.product_code',
      needs: ['line'],
      starter: true,
      group: FIELD_GROUPS.CLASSIFICATION,
      hint: 'The product the question was asked about — the burger, not the bacon.',
    },
    {
      key: 'soldProductDescription',
      label: 'Sold on description',
      type: 'text',
      expr: 'sl.description',
      needs: ['line'],
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    {
      key: 'department',
      label: 'Department',
      type: 'text',
      expr: 'pdm.name',
      needs: ['product', 'productDept'],
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    {
      key: 'qtyPerItem',
      label: 'Number per item',
      type: 'number',
      expr: 't.qty',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.QUANTITIES,
      hint: 'How many of this answer ONE item carried. Adding these up counts burgers, not rashers — use “Number sold”.',
    },
    {
      key: 'qtySold',
      label: 'Number sold',
      type: 'number',
      // Per item x the line's own quantity: two burgers each with bacon x3 is
      // six rashers, and this is the figure anybody means by "how many".
      expr: 't.qty * sl.qty',
      needs: ['line'],
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'priceAdjustIncl',
      label: 'Price each (incl.)',
      type: 'currency',
      expr: 't.price_adjust_incl',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'What ONE of this answer adds. A per-unit price — adding these up is meaningless.',
    },
    {
      key: 'lineAdjustIncl',
      label: 'Earned (incl.)',
      type: 'currency',
      expr: 't.line_adjust_incl',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'What this answer added across the line. Already inside the sales-line total — do not add the two together.',
    },
    {
      key: 'stockProductCode',
      label: 'Deducts product',
      type: 'text',
      expr: '(SELECT p2.code FROM products p2 WHERE p2.id = t.product_id)',
      group: FIELD_GROUPS.CLASSIFICATION,
      hint: 'The stocked item this answer consumed, when it was linked to one.',
    },
    {
      key: 'stockTaken',
      label: 'Stock taken',
      type: 'number',
      expr: 't.stock_qty_per * t.qty * sl.qty',
      needs: ['line'],
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
      hint: 'How much of the linked product came off the shelf. Zero for an answer that is only words.',
    },
    yesNo('printsOnKitchen', 'On kitchen ticket', 't.prints_on_kitchen'),
    yesNo('printsOnReceipt', 'On receipt', 't.prints_on_receipt'),
    {
      key: 'documentNumber',
      label: 'Document number',
      type: 'text',
      expr: 'd.document_number',
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'status',
      label: 'Status',
      type: 'text',
      expr: 'd.status',
      group: FIELD_GROUPS.OTHER,
    },
    {
      key: 'customerName',
      label: 'Customer',
      type: 'text',
      expr: 'd.customer_name',
      group: FIELD_GROUPS.PEOPLE,
    },
    {
      key: 'documentDate',
      label: 'Document date',
      type: 'date',
      expr: 'd.document_date',
      group: FIELD_GROUPS.DATES,
    },
    ...timeBuckets('document_date').map((f) => ({
      ...f,
      // Derived from the PARENT's date column, exactly as the sales lines do:
      // an answer has no date of its own, it has the date of the sale it was
      // part of.
      expr: f.expr.replace(/t\.`document_date`/g, 'd.`document_date`'),
    })),
  ],
}

/* ── cash-up detail ────────────────────────────────────────────────────────── */

/*
 * The shifts source rolls a cash-up up to one expected, one counted and one
 * variance. That is the right summary and the wrong grain for the question a
 * manager actually asks, which is "which tender was short". These two sources
 * are the detail underneath it, and together they are most of what v2's cash-up
 * history carried as columns.
 */

const SHIFT_JOIN: JoinUnit = {
  name: 'shift',
  sql: 'INNER JOIN shifts sh ON sh.id = t.shift_id',
  always: true,
}

const SHIFT_COUNTS_SOURCE: CatalogSource = {
  key: 'shiftCounts',
  label: 'Cash-up by tender',
  description:
    'One row per tender per cash-up — what was expected in the drawer, what was counted, and the difference.',
  category: 'Operations',
  permission: 'sales.cashup',
  shape: 'timeline',
  table: 'shift_counts',
  /* The count has its own created_at, but a cash-up belongs to the day its
     SHIFT opened — counting at one minute past midnight must not move the
     figures into the next day's report. */
  dateColumn: 'opened_at',
  dateJoin: 'shift',
  joins: [SHIFT_JOIN],
  fields: [
    { key: 'tenderName', label: 'Tender', type: 'text', expr: 't.tender_name', starter: true, group: FIELD_GROUPS.TENDER },
    { key: 'tenderCode', label: 'Tender code', type: 'text', expr: 't.tender_code', group: FIELD_GROUPS.TENDER },
    { key: 'expected', label: 'Expected', type: 'currency', expr: 't.expected', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    { key: 'counted', label: 'Counted', type: 'currency', expr: 't.counted', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    {
      key: 'variance',
      label: 'Variance',
      type: 'currency',
      expr: 't.variance',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
      tone: 'variance',
      hint: 'Negative is short.',
    },
    { key: 'terminalCode', label: 'Till', type: 'text', expr: 'sh.terminal_code', starter: true, group: FIELD_GROUPS.PEOPLE },
    { key: 'userName', label: 'Opened by', type: 'text', expr: 'sh.user_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'closedByName', label: 'Closed by', type: 'text', expr: 'sh.closed_by_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'openedAt', label: 'Opened at', type: 'datetime', expr: 'sh.opened_at', group: FIELD_GROUPS.DATES },
    { key: 'closedAt', label: 'Closed at', type: 'datetime', expr: 'sh.closed_at', group: FIELD_GROUPS.DATES },
    {
      key: 'transactionCount',
      label: 'Transactions',
      type: 'number',
      expr: 't.transaction_count',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
      hint: 'How many tender rows made up the expected figure — a split-tender sale counts once per tender, not once per sale.',
    },
    {
      key: 'floatIncluded',
      label: 'Float included',
      type: 'currency',
      expr: 't.float_included',
      numeric: true,
      group: FIELD_GROUPS.TENDER,
      hint: 'Only ever non-zero on a drawer-cash tender.',
    },
    {
      key: 'movementsIncluded',
      label: 'Drawer movements included',
      type: 'currency',
      expr: 't.movements_included',
      numeric: true,
      group: FIELD_GROUPS.TENDER,
      hint: 'Pay-outs and drops folded into the expected figure. Frozen at cash-up, so it still reads true after the movements are edited.',
    },
    { key: 'varianceNote', label: 'Variance note', type: 'text', expr: 'sh.variance_note', group: FIELD_GROUPS.OTHER },
    ...timeBuckets('opened_at', { hours: true }).map((f) => ({
      ...f,
      // Off the shift, for the reason dateColumn is.
      expr: f.expr.replace(/t\.`opened_at`/g, 'sh.`opened_at`'),
    })),
  ],
}

const SHIFT_MOVEMENTS_SOURCE: CatalogSource = {
  key: 'shiftMovements',
  label: 'Drawer movements',
  description:
    'Money in and out of the drawer that is not a sale — payouts, pay-ins and cash drops.',
  category: 'Operations',
  permission: 'sales.cashup',
  shape: 'timeline',
  table: 'shift_movements',
  dateColumn: 'created_at',
  joins: [{ name: 'shift', sql: 'LEFT JOIN shifts sh ON sh.id = t.shift_id' }],
  fields: [
    { key: 'movedAt', label: 'When', type: 'datetime', expr: 't.created_at', starter: true, group: FIELD_GROUPS.DATES },
    /* v2 had a report per kind — Payout history, Cashout history, Top-up
       history. One source with the kind as a column answers all three, and a
       filter turns it into any of them. */
    enumField('movementType', 'Kind', 't.movement_type', ['payout', 'payin', 'drop'], {
      starter: true,
    }),
    { key: 'amount', label: 'Amount', type: 'currency', expr: 't.amount', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    { key: 'reason', label: 'Reason', type: 'text', expr: 't.reason', starter: true, group: FIELD_GROUPS.OTHER },
    { key: 'userName', label: 'By', type: 'text', expr: 't.user_name', starter: true, group: FIELD_GROUPS.PEOPLE },
    { key: 'terminalCode', label: 'Till', type: 'text', expr: 'sh.terminal_code', needs: ['shift'], group: FIELD_GROUPS.PEOPLE },
    { key: 'shiftOpenedAt', label: 'Cash-up opened', type: 'datetime', expr: 'sh.opened_at', needs: ['shift'], group: FIELD_GROUPS.DATES },
    ...timeBuckets('created_at', { hours: true }),
  ],
}

/* ── tips ──────────────────────────────────────────────────────────────────── */

/**
 * Tips split by TENDER, as SUMmable columns — one row per person, one column per method.
 *
 * The same trick as agedBucketFields above, and for the same reason: the engine builds its
 * column list from the spec BEFORE it reads a row, so columns can never be discovered from
 * the data. A cross-tab has to be declared, which means declaring which tenders get one.
 *
 * Matched on `tt.code`, never `tt.name`. The code is the stable handle — UNIQUE,
 * /^[A-Z0-9_]{2,24}$/, and unchangeable on a system tender — while the name is what a shop
 * renames. A store calling its card tender "Speedpoint" must not empty the Card column.
 *
 * `tipOther` is the NEGATION of the named set rather than a list of the rest, so a tender
 * added after this was written always lands somewhere and the columns ALWAYS add up to the
 * tip total. That identity is the point: a breakdown that can silently lose a column is
 * worse than no breakdown. Other growing large is a SIGNAL — the shop has a tender that
 * deserves promoting to its own column — not a bug to fix by hardcoding one more code.
 *
 * Why these four: CASH is the only tip physically in the drawer, CARD and EFT settle by two
 * different routes, and ACCOUNT posts to a debtor so the shop has not been paid yet.
 * GIFT_CARD, ONLINE and EXCHANGE are low-volume variants of those same stories. DEPOSIT
 * should read ZERO — that tender is capped at the document total and gives no change, so
 * there is no excess to become a tip; a non-zero figure is a data smell, and it belongs in
 * Other where it looks like one rather than in a column that legitimises it.
 */
const NAMED_TIP_TENDERS = ['CASH', 'CARD', 'EFT', 'ACCOUNT'] as const

function tipTenderFields(): CatalogField[] {
  /* NULL-safe because the tender join is a LEFT one: an unmatched row must fall into
     Other, not drop out of every column and break the adds-up-to-the-total identity. */
  const code = "COALESCE(tt.`code`, '')"
  const named = NAMED_TIP_TENDERS.map((c) => `'${c}'`).join(',')
  const bucket = (key: string, label: string, cond: string, hint?: string): CatalogField => ({
    key,
    label,
    type: 'currency',
    expr: `(CASE WHEN ${cond} THEN t.\`amount\` ELSE 0 END)`,
    numeric: true,
    needs: ['tender'],
    group: FIELD_GROUPS.TENDER,
    ...(hint ? { hint } : {}),
  })
  return [
    bucket('tipCash', 'Cash tips', `${code} = 'CASH'`, 'In the drawer — counted at cash-up.'),
    bucket('tipCard', 'Card tips', `${code} = 'CARD'`, 'Settled by the card machine, so paid out separately.'),
    bucket('tipEft', 'EFT tips', `${code} = 'EFT'`),
    bucket('tipAccount', 'Account tips', `${code} = 'ACCOUNT'`, 'On a debtor account — not money received yet.'),
    bucket(
      'tipOther',
      'Other tips',
      `${code} NOT IN (${named})`,
      'Every other tender, including a shop’s own — so the columns always add up to the total.',
    ),
    /* The drawer question answered from the shop's own flag rather than inferred from the
       codes above: tip_in_drawer defaults to 1, so a shop's cash-like tender of its own is
       in the drawer even though its code is not CASH. Deriving this would understate it. */
    {
      key: 'tipInDrawer',
      label: 'Tips in the drawer',
      type: 'currency',
      expr: '(CASE WHEN tt.`tip_in_drawer` = 1 THEN t.`amount` ELSE 0 END)',
      numeric: true,
      needs: ['tender'],
      group: FIELD_GROUPS.TENDER,
      hint: 'How much of this is cash the till should be holding.',
    },
  ]
}

/**
 * The tip percentage, and the double-count it has to dodge.
 *
 * `sales_tips` is one row per tip, so a bill carrying an over-tender tip AND a service
 * charge is two rows on one document_id. SUM(d.total_incl) over those rows counts that sale
 * twice and the percentage reads low — which is exactly why `documentTotal` below is marked
 * noTotal. The engine has no SUM(DISTINCT), no window function and no HAVING.
 *
 * So the denominator counts a sale once per person, on the lowest-id tip THAT PERSON left
 * on it. A correlated subquery inside an authored expr is established practice in this
 * catalog (see the deducts-product and job-card-lines fields), and it resolves from
 * ix_tip_document without touching the table. `ratio` then makes summarising emit
 * SUM(numerator)/SUM(denominator), so the sale enters each person's denominator once.
 *
 * ── THE ONE CASE THIS READS HIGH ──────────────────────────────────────────
 *
 * The subquery cannot see the report's own filters — they are assembled in buildWhere and
 * never reach a field's expr. Filter the report to source = 'service' and a person whose
 * FIRST tip on that bill was an over_tender one loses the total from their denominator
 * while their service tip stays in the numerator, so the percentage overstates. Not fixable
 * inside the engine; the hint says so in words a user can act on, which is the honest
 * option — a caveat a reader can apply beats a number that is quietly wrong.
 */
function tipPercentFields(): CatalogField[] {
  /* Once per document PER PERSON, not once per document.
   *
   * The obvious version — the document's lowest tip id, full stop — is wrong, and wrong in
   * a way that reads as a plausible number: on a bill two waiters both tipped on, only the
   * FIRST waiter's row carries the sale, so the second one contributes a numerator with a
   * zero denominator and their percentage collapses to 0%. A split bill is not exotic; it
   * is a Friday night. Measured, not reasoned about — the test that caught this inserts two
   * tips on a document that already had two.
   *
   * The NULL-safe comparison is what makes the pool work: `user_id` is NULL for pooled
   * tips, and `=` against NULL is never true, so a plain `t2.user_id = t.user_id` would
   * give the entire pool a zero denominator. `<=>` is NULL-safe equality in MariaDB. */
  const firstForPerson =
    '(SELECT MIN(t2.`id`) FROM `sales_tips` t2 ' +
    'WHERE t2.`document_id` = t.`document_id` AND t2.`user_id` <=> t.`user_id`)'
  return [
    {
      key: 'tippedSaleTotal',
      label: 'Tipped sale value (incl.)',
      type: 'currency',
      expr: `(CASE WHEN t.\`id\` = ${firstForPerson} THEN d.\`total_incl\` ELSE 0 END)`,
      numeric: true,
      needs: ['doc'],
      group: FIELD_GROUPS.MONEY,
      hint: 'The value of the sales that carried a tip, each counted ONCE per person however many tips they left on it.',
    },
    {
      key: 'tipPct',
      label: 'Tip %',
      type: 'percent',
      expr: '(CASE WHEN d.`total_incl` = 0 THEN 0 ELSE (t.`amount` / d.`total_incl`) * 100 END)',
      numeric: true,
      noTotal: true,
      ratio: { numerator: 'amount', denominator: 'tippedSaleTotal' },
      needs: ['doc'],
      group: FIELD_GROUPS.MONEY,
      hint: 'Tips as a share of the bills that carried one — NOT of all turnover. When the report is filtered to particular tips, the denominator still counts each tipped sale once from that person’s first tip, which can push this above the true share.',
    },
  ]
}

const TIPS_SOURCE: CatalogSource = {
  key: 'tips',
  label: 'Tips',
  description: 'Every tip taken — how it arrived, who it belongs to, and on which tender.',
  category: 'Operations',
  permission: 'sales.cashup',
  shape: 'timeline',
  table: 'sales_tips',
  dateColumn: 'created_at',
  joins: [
    { name: 'doc', sql: 'LEFT JOIN sales_documents d ON d.id = t.document_id' },
    { name: 'tender', sql: 'LEFT JOIN tender_types tt ON tt.id = t.tender_type_id' },
  ],
  fields: [
    { key: 'takenAt', label: 'When', type: 'datetime', expr: 't.created_at', starter: true, group: FIELD_GROUPS.DATES },
    { key: 'userName', label: 'Whose tip', type: 'text', expr: 't.user_name', starter: true, group: FIELD_GROUPS.PEOPLE },
    { key: 'amount', label: 'Tip', type: 'currency', expr: 't.amount', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    /* How it arrived. over_tender is change left behind, declared is typed in,
       service is an automatic charge, manual is added afterwards — different
       enough that a total mixing them answers nothing. */
    enumField('source', 'How', 't.source', ['over_tender', 'declared', 'service', 'manual'], {
      starter: true,
    }),
    { key: 'tenderName', label: 'Tender', type: 'text', expr: 'tt.name', needs: ['tender'], group: FIELD_GROUPS.TENDER },
    { key: 'tenderCode', label: 'Tender code', type: 'text', expr: 'tt.code', needs: ['tender'], group: FIELD_GROUPS.TENDER },
    ...tipTenderFields(),
    ...tipPercentFields(),
    { key: 'documentNumber', label: 'Document', type: 'document', expr: 'd.document_number', needs: ['doc'], group: FIELD_GROUPS.IDENTITY },
    { key: 'documentTotal', label: 'Sale total (incl.)', type: 'currency', expr: 'd.total_incl', numeric: true, noTotal: true, needs: ['doc'], group: FIELD_GROUPS.MONEY },
    /* Reassignment is an audit trail: a tip put on the wrong name and moved
       leaves both names and a reason, which is the whole point of recording it
       rather than editing the row. */
    { key: 'reassignedByName', label: 'Reassigned by', type: 'text', expr: 't.reassigned_by_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'reassignedAt', label: 'Reassigned at', type: 'datetime', expr: 't.reassigned_at', group: FIELD_GROUPS.DATES },
    { key: 'reassignReason', label: 'Reassign reason', type: 'text', expr: 't.reassign_reason', group: FIELD_GROUPS.OTHER },
    {
      key: 'wasReassigned',
      label: 'Reassigned',
      type: 'text',
      /* Derived rather than exposing the raw user id beside the name that is
         already offered: "which tips were moved" is the question, and an
         integer column cannot be filtered to it. */
      expr: "(CASE WHEN t.reassigned_by IS NULL THEN 'No' ELSE 'Yes' END)",
      group: FIELD_GROUPS.FLAGS,
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
      ],
      hint: 'Whether the tip was moved from the person who originally took it.',
    },
    ...timeBuckets('created_at', { hours: true }),
  ],
}

/* ── till voids ────────────────────────────────────────────────────────────── */

/**
 * What came off a sale before anybody paid for it.
 *
 * ── THIS IS NOT THE CANCELLED-SALES REPORT ────────────────────────────────
 *
 * A cancel reverses a FINALISED sale and lives on sales_documents, where the
 * Sales source already reports it via `voidReason`. This source is the other
 * event entirely: a line or an item taken off a DRAFT, where nothing posted and
 * no document may ever have existed. The two answer different questions and
 * mixing them would put reversed invoices in a report about till behaviour.
 *
 * ── WHY `sale` ROWS MUST BE FILTERED WHEN SUMMING ─────────────────────────
 *
 * An abandoned basket writes a `sale` rollup AND a `line` row per line, so a
 * total over both counts every abandoned basket twice. The starter columns lead
 * with the kind for exactly that reason: the first thing anyone building on
 * this must see is that the rows are two levels, not one.
 */
const POS_VOIDS_SOURCE: CatalogSource = {
  key: 'posVoids',
  label: 'Till voids',
  description:
    'Items, lines and whole sales voided off a draft at the till — with the reason, who did it and what it was worth. Not the same as a cancelled sale, which is a finalised document reversed.',
  category: 'Operations',
  /* The same right that guards the cash-up. A void report names individual
     cashiers and is the first place a manager looks when stock walks, so it
     belongs with the other supervisory numbers rather than with general sales. */
  permission: 'sales.cashup',
  shape: 'timeline',
  table: 'pos_void_events',
  dateColumn: 'voided_at',
  joins: [
    /* LEFT, and the fields below fall back to the stored code: a reason that has
       since been deleted must not blank out the history naming it. */
    { name: 'reason', sql: 'LEFT JOIN sales_void_reasons vr ON vr.id = t.reason_id' },
    { name: 'product', sql: 'LEFT JOIN products p ON p.id = t.product_id' },
    /* NOT named 'doc'. A join by that name is taken to be the PARENT that owns
       the source's date — see dateColumnExpr — and the range filter is then
       qualified with its alias. A void carries its own voided_at on `t`, so
       borrowing the convention pointed every filter at d.voided_at, a column
       that does not exist, and took all three reports down at request time. */
    { name: 'draft', sql: 'LEFT JOIN sales_documents sd ON sd.id = t.document_id' },
  ],
  fields: [
    { key: 'voidedAt', label: 'When', type: 'datetime', expr: 't.voided_at', starter: true, group: FIELD_GROUPS.DATES },
    /* The distinction the cashier made with their hands, and the one the whole
       report turns on — one unit off, a whole line off, or the sale abandoned. */
    enumField('voidType', 'Kind', 't.void_type', ['item', 'line', 'sale'], { starter: true }),
    {
      key: 'reasonName',
      label: 'Reason',
      type: 'text',
      /* Current name first so a renamed reason reads correctly, stored code as
         the fallback, and a plain label when nobody was ever asked. */
      expr: "COALESCE(vr.name, t.reason_code, 'Not recorded')",
      needs: ['reason'],
      starter: true,
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    {
      key: 'reasonCode',
      label: 'Reason code',
      type: 'text',
      expr: "COALESCE(vr.code, t.reason_code, 'NOT-RECORDED')",
      needs: ['reason'],
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    { key: 'description', label: 'What', type: 'text', expr: 't.description', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'qty', label: 'Qty', type: 'number', expr: 't.qty', numeric: true, starter: true, group: FIELD_GROUPS.QUANTITIES },
    /* Gross, VAT in, before line discount — what the customer would have been
       asked for. The figure that makes a pattern of voids worth reading. */
    { key: 'value', label: 'Value (incl.)', type: 'currency', expr: 't.value_incl', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    { key: 'note', label: 'Note', type: 'text', expr: 't.note', group: FIELD_GROUPS.OTHER },
    /* The PIN operator who did it, not whoever signed the browser in. */
    { key: 'userName', label: 'By', type: 'text', expr: 't.user_name', starter: true, group: FIELD_GROUPS.PEOPLE },
    { key: 'terminalCode', label: 'Till', type: 'text', expr: 't.terminal_code', group: FIELD_GROUPS.PEOPLE },
    { key: 'shiftId', label: 'Cash-up', type: 'number', expr: 't.shift_id', noTotal: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'productCode', label: 'Stock code', type: 'text', expr: 't.product_code', group: FIELD_GROUPS.IDENTITY },
    /* `description`, not `name` — the products table has no `name` column, and
       this field 500'd the moment anybody put it on a report. The stored
       `product_code` beside it is what the void recorded at the time; this is
       what the product is called TODAY, which is why it needs the join. */
    { key: 'productName', label: 'Product (current name)', type: 'text', expr: 'p.description', needs: ['product'], group: FIELD_GROUPS.PRODUCT },
    /* Only a parked tab, a table or a recalled draft has one. Null is the normal
       case for a counter sale, which never reaches the database before it is paid. */
    { key: 'documentNumber', label: 'Draft', type: 'document', expr: 'sd.document_number', needs: ['draft'], group: FIELD_GROUPS.IDENTITY },
    ...timeBuckets('voided_at', { hours: true }),
  ],
}

/* ── stock takes ───────────────────────────────────────────────────────────── */

const STOCK_TAKE_LINES_SOURCE: CatalogSource = {
  key: 'stockTakeLines',
  label: 'Stock take lines',
  description:
    'Every counted line — what the book said, what was counted, and the difference between them.',
  category: 'Stock',
  permission: 'stock.view',
  shape: 'timeline',
  table: 'stock_take_lines',
  dateColumn: 'document_date',
  dateJoin: 'take',
  joins: [
    { name: 'take', sql: 'INNER JOIN stock_takes st ON st.id = t.stock_take_id', always: true },
    { name: 'location', sql: 'LEFT JOIN stock_locations loc ON loc.id = st.location_id' },
    { name: 'product', sql: 'LEFT JOIN products pm ON pm.id = t.product_id' },
    /* The reason a large variance was signed off with (218). The SAME table the
       adjustment source reads, deliberately — approving a count variance and
       raising a write-off answer the same question, so "what did breakage cost
       last quarter" must not split across two vocabularies. */
    { name: 'approvalReason', sql: 'LEFT JOIN stock_adjustment_reasons ar ON ar.id = t.approval_reason_id' },
    PRODUCT_DEPT_JOIN,
  ],
  /* A draft count is somebody halfway through a shelf. Only a posted sheet is
     a fact about stock, and it is the only one that moved any. */
  defaultFilters: [{ field: 'status', op: 'eq', value: 'posted' }],
  fields: [
    { key: 'documentNumber', label: 'Stock take', type: 'document', expr: 'st.document_number', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'documentDate', label: 'Date', type: 'date', expr: 'st.document_date', starter: true, group: FIELD_GROUPS.DATES },
    { key: 'productCode', label: 'Product code', type: 'text', expr: 't.product_code', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'description', label: 'Description', type: 'text', expr: 't.description', starter: true, group: FIELD_GROUPS.IDENTITY },
    {
      key: 'department',
      label: 'Department',
      type: 'text',
      expr: 'pdm.name',
      needs: ['product', 'productDept'],
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    {
      /* What the book said when the counter was handed the sheet. NOT what it
         said when the sheet posted — that is postedQtyBefore, and the two
         differ exactly when something sold mid-count. */
      key: 'snapshotQty',
      label: 'Book quantity',
      type: 'number',
      expr: 't.snapshot_qty',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
      hint: 'What the system held when the sheet was printed.',
    },
    { key: 'countedQty', label: 'Counted', type: 'number', expr: 't.counted_qty', numeric: true, starter: true, group: FIELD_GROUPS.QUANTITIES },
    {
      key: 'postedQtyBefore',
      label: 'Book at posting',
      type: 'number',
      expr: 't.posted_qty_before',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
      hint: 'What the system held when the sheet was posted — this is what the variance was measured against.',
    },
    { key: 'varianceQty', label: 'Variance', type: 'number', expr: 't.variance_qty', numeric: true, starter: true, group: FIELD_GROUPS.QUANTITIES },
    {
      key: 'varianceValue',
      label: 'Variance value',
      type: 'currency',
      expr: 't.variance_qty * COALESCE(t.unit_cost_excl, 0)',
      numeric: true,
      permission: 'products.cost',
      group: FIELD_GROUPS.COST,
    },
    { key: 'unitCostExcl', label: 'Unit cost (excl.)', type: 'currency', expr: 't.unit_cost_excl', numeric: true, noTotal: true, permission: 'products.cost', group: FIELD_GROUPS.COST },
    enumField('lineMode', 'How counted', 't.line_mode', ['count', 'topup', 'recount']),
    { key: 'countedBy', label: 'Counted by', type: 'text', expr: 't.counted_by', group: FIELD_GROUPS.PEOPLE },
    { key: 'countedAt', label: 'Counted at', type: 'datetime', expr: 't.counted_at', group: FIELD_GROUPS.DATES },
    { key: 'lineNumber', label: 'Line number', type: 'number', expr: 't.line_number', numeric: true, noTotal: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'note', label: 'Note', type: 'text', expr: 't.note', group: FIELD_GROUPS.OTHER },
    { key: 'locationName', label: 'Location', type: 'text', expr: 'loc.name', needs: ['location'], group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'takenBy', label: 'Sheet raised by', type: 'text', expr: 'st.user_name', group: FIELD_GROUPS.PEOPLE },

    /* ── Sign-off (218) ───────────────────────────────────────────────────
       The whole value of a second signature is that somebody can ask about it
       afterwards — who signed off what, for which reason, over what period.
       A control nobody can report on is a control nobody audits. */
    { key: 'approvedBy', label: 'Signed off by', type: 'text', expr: 't.approved_by', group: FIELD_GROUPS.PEOPLE },
    { key: 'approvedAt', label: 'Signed off at', type: 'datetime', expr: 't.approved_at', group: FIELD_GROUPS.DATES },
    {
      key: 'approvalReasonName',
      label: 'Sign-off reason',
      type: 'text',
      /* Blank rather than "Not recorded": on this source the overwhelming
         majority of lines never crossed a threshold, so they were never
         REQUIRED to have a reason. Saying one is missing would report a
         control failure on every ordinary line in the shop. */
      expr: "COALESCE(ar.name, '')",
      needs: ['approvalReason'],
      group: FIELD_GROUPS.CLASSIFICATION,
      hint: 'Only lines whose variance crossed the sign-off threshold carry one.',
    },
    { key: 'approvalNote', label: 'Sign-off note', type: 'text', expr: 't.approval_note', group: FIELD_GROUPS.OTHER },

    enumField('status', 'Status', 'st.status', ['draft', 'counting', 'posted', 'cancelled']),
    enumField('scope', 'Scope', 'st.scope', ['full', 'department', 'brand', 'supplier', 'manual']),
    /* How the count was TAKEN, which is part of how far it can be trusted.
       Filterable, so "our shrinkage on blind counts vs sighted ones" is a
       report somebody can actually run — the question that shows whether
       blind counting is earning its keep. */
    {
      key: 'enteredQty',
      label: 'Entered qty',
      type: 'number',
      expr: 't.entered_qty',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
      hint: 'What the counter typed, before any approval adjusted it. Blank where the line was never entered.',
    },
    yesNo('isBlind', 'Counted blind', 'st.is_blind'),
    ...timeBuckets('document_date').map((f) => ({
      ...f,
      expr: f.expr.replace(/t\.`document_date`/g, 'st.`document_date`'),
    })),
  ],
}

/* ── stock adjustments, with their reasons ─────────────────────────────────── */

const ADJUSTMENT_LINES_SOURCE: CatalogSource = {
  key: 'adjustmentLines',
  label: 'Stock adjustment lines',
  description:
    'Every write-off and correction, with the reason it was given — what shrinkage cost and why.',
  category: 'Stock',
  permission: 'stock.view',
  shape: 'timeline',
  table: 'stock_adjustment_lines',
  dateColumn: 'document_date',
  dateJoin: 'adj',
  joins: [
    { name: 'adj', sql: 'INNER JOIN stock_adjustments adj ON adj.id = t.adjustment_id', always: true },
    { name: 'location', sql: 'LEFT JOIN stock_locations loc ON loc.id = adj.location_id' },
    /* The reason may be set per LINE or fall back to the document's. Both are
       joined so COALESCE can prefer the line's, which is the one the person
       chose for this particular write-off. */
    { name: 'lineReason', sql: 'LEFT JOIN stock_adjustment_reasons lr ON lr.id = t.reason_id' },
    { name: 'docReason', sql: 'LEFT JOIN stock_adjustment_reasons dr ON dr.id = adj.reason_id' },
    { name: 'product', sql: 'LEFT JOIN products pm ON pm.id = t.product_id' },
    PRODUCT_DEPT_JOIN,
  ],
  defaultFilters: [{ field: 'status', op: 'eq', value: 'posted' }],
  fields: [
    { key: 'documentNumber', label: 'Adjustment', type: 'document', expr: 'adj.document_number', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'documentDate', label: 'Date', type: 'date', expr: 'adj.document_date', starter: true, group: FIELD_GROUPS.DATES },
    { key: 'productCode', label: 'Product code', type: 'text', expr: 't.product_code', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'description', label: 'Description', type: 'text', expr: 't.description', starter: true, group: FIELD_GROUPS.IDENTITY },
    {
      key: 'department',
      label: 'Department',
      type: 'text',
      expr: 'pdm.name',
      needs: ['product', 'productDept'],
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    {
      /* THE column this source exists for. "How much did we lose to breakage
         last quarter" is the question an adjustment document is raised to
         answer, and until now nothing could group by it. Line reason first,
         document reason behind it. */
      key: 'reasonName',
      label: 'Reason',
      type: 'text',
      expr: "COALESCE(lr.name, dr.name, 'Not recorded')",
      needs: ['lineReason', 'docReason'],
      starter: true,
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    {
      key: 'reasonCode',
      label: 'Reason code',
      type: 'text',
      expr: 'COALESCE(lr.code, dr.code)',
      needs: ['lineReason', 'docReason'],
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    { key: 'qtyBefore', label: 'Quantity before', type: 'number', expr: 't.qty_before', numeric: true, group: FIELD_GROUPS.QUANTITIES },
    { key: 'qtyChange', label: 'Adjusted by', type: 'number', expr: 't.qty_change', numeric: true, starter: true, group: FIELD_GROUPS.QUANTITIES, hint: 'Negative is a write-off.' },
    {
      key: 'qtyAfter',
      label: 'Quantity after',
      type: 'number',
      expr: 't.qty_before + t.qty_change',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'valueExcl',
      label: 'Value (excl.)',
      type: 'currency',
      expr: 't.qty_change * COALESCE(t.unit_cost_excl, 0)',
      numeric: true,
      starter: true,
      permission: 'products.cost',
      group: FIELD_GROUPS.COST,
    },
    { key: 'unitCostExcl', label: 'Unit cost (excl.)', type: 'currency', expr: 't.unit_cost_excl', numeric: true, noTotal: true, permission: 'products.cost', group: FIELD_GROUPS.COST },
    { key: 'userName', label: 'By', type: 'text', expr: 'adj.user_name', starter: true, group: FIELD_GROUPS.PEOPLE },
    { key: 'locationName', label: 'Location', type: 'text', expr: 'loc.name', needs: ['location'], group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'note', label: 'Note', type: 'text', expr: 't.note', group: FIELD_GROUPS.OTHER },
    { key: 'reference', label: 'Reference', type: 'text', expr: 'adj.reference', group: FIELD_GROUPS.OTHER },
    enumField('status', 'Status', 'adj.status', ['draft', 'posted', 'cancelled']),
    ...timeBuckets('document_date').map((f) => ({
      ...f,
      expr: f.expr.replace(/t\.`document_date`/g, 'adj.`document_date`'),
    })),
  ],
}

/* ── what a supplier charges for what ──────────────────────────────────────── */

const PRODUCT_SUPPLIERS_SOURCE: CatalogSource = {
  key: 'productSuppliers',
  label: 'Supplier price list',
  description:
    'What each supplier charges for each product — the buying catalogue, not what was actually bought.',
  category: 'Suppliers',
  permission: 'purchasing.view',
  /* A SNAPSHOT, which is what makes it different from purchaseLines. That
     source can only show a product somebody has already bought in the period;
     this one lists everything on the supplier's list whether or not it has ever
     been ordered, which is what a buyer compares prices from. */
  shape: 'snapshot',
  table: 'product_suppliers',
  joins: [
    { name: 'supplier', sql: 'INNER JOIN {S}suppliers s ON s.id = t.supplier_id', always: true },
    { name: 'product', sql: 'INNER JOIN products pm ON pm.id = t.product_id', always: true },
    PRODUCT_DEPT_JOIN,
    {
      name: 'price',
      sql:
        'LEFT JOIN product_prices ppr ON ppr.product_id = pm.id ' +
        'AND ppr.price_structure_id = (SELECT id FROM price_structures WHERE is_default = 1 ORDER BY position LIMIT 1)',
    },
    /* The margin field derives an exclusive selling price, which needs the
       product's own SELLING rate — not the purchase one, which may differ. */
    { name: 'sellingVat', sql: 'LEFT JOIN vat_rates pvr ON pvr.id = pm.selling_vat_rate_id' },
  ],
  fields: [
    { key: 'supplierName', label: 'Supplier', type: 'text', expr: 's.name', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'productCode', label: 'Product code', type: 'text', expr: 'pm.code', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'description', label: 'Description', type: 'text', expr: 'pm.description', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'supplierCode', label: 'Supplier’s code', type: 'text', expr: 't.supplier_code', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'barcode', label: 'Barcode', type: 'text', expr: 'pm.barcode', group: FIELD_GROUPS.IDENTITY },
    {
      key: 'department',
      label: 'Department',
      type: 'text',
      expr: 'pdm.name',
      needs: ['productDept'],
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    { key: 'supplierCost', label: 'Supplier cost', type: 'currency', expr: 't.last_cost', numeric: true, noTotal: true, starter: true, permission: 'products.cost', group: FIELD_GROUPS.COST },
    { key: 'packSize', label: 'Pack size', type: 'number', expr: 't.pack_size', numeric: true, noTotal: true, group: FIELD_GROUPS.QUANTITIES },
    yesNo('isPreferred', 'Preferred supplier', 't.is_preferred'),
    { key: 'currentSoh', label: 'Stock on hand', type: 'number', expr: 'pm.stock_on_hand', numeric: true, group: FIELD_GROUPS.QUANTITIES },
    { key: 'ourAvgCost', label: 'Our average cost', type: 'currency', expr: 'pm.average_cost', numeric: true, noTotal: true, permission: 'products.cost', group: FIELD_GROUPS.COST },
    { key: 'sellingPriceIncl', label: 'Selling price (incl.)', type: 'currency', expr: 'ppr.selling_price_incl', numeric: true, noTotal: true, needs: ['price'], group: FIELD_GROUPS.MONEY },
    {
      /* Margin against THIS supplier's price, which is the number a buyer is
         comparing when two suppliers quote the same product. */
      key: 'marginPct',
      label: 'Margin % at this cost',
      type: 'percent',
      expr:
        'CASE WHEN COALESCE(ppr.selling_price_incl, 0) = 0 THEN 0 ELSE ' +
        '((ppr.selling_price_incl / NULLIF(1 + COALESCE(pvr.rate, 0) / 100, 0)) - COALESCE(t.last_cost, 0)) ' +
        '/ NULLIF(ppr.selling_price_incl / NULLIF(1 + COALESCE(pvr.rate, 0) / 100, 0), 0) * 100 END',
      numeric: true,
      noTotal: true,
      needs: ['price', 'sellingVat'],
      permission: 'products.cost',
      group: FIELD_GROUPS.COST,
    },
    { key: 'lastPurchaseDate', label: 'Last purchased', type: 'datetime', expr: 'pm.last_purchase_date', group: FIELD_GROUPS.DATES },
    yesNo('isArchived', 'Archived', 'pm.is_archived'),
  ],
}

/* ── batches ───────────────────────────────────────────────────────────────── */

const BATCHES_SOURCE: CatalogSource = {
  key: 'batches',
  label: 'Batches',
  description: 'Every lot on the shelf — what it is, when it expires, and what is left of it.',
  category: 'Stock',
  permission: 'stock.view',
  /* A snapshot: the lots as they stand now. The expiring-soon report is a
     filter on daysToExpiry, which is what makes it schedulable for free. */
  shape: 'snapshot',
  table: 'product_batches',
  joins: [
    { name: 'product', sql: 'INNER JOIN products pm ON pm.id = t.product_id', always: true },
    PRODUCT_DEPT_JOIN,
    { name: 'location', sql: 'LEFT JOIN stock_locations bl ON bl.id = t.location_id' },
    { name: 'grv', sql: 'LEFT JOIN purchase_documents bpd ON bpd.id = t.received_doc_id' },
  ],
  fields: [
    { key: 'productCode', label: 'Product code', type: 'text', expr: 'pm.code', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'description', label: 'Description', type: 'text', expr: 'pm.description', starter: true, group: FIELD_GROUPS.IDENTITY },
    {
      key: 'batchNo',
      label: 'Lot number',
      type: 'text',
      // The untracked bucket reads as words rather than an empty cell.
      expr: "COALESCE(NULLIF(t.batch_no, ''), '(untracked)')",
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'department',
      label: 'Department',
      type: 'text',
      expr: 'pdm.name',
      needs: ['productDept'],
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    { key: 'location', label: 'Location', type: 'text', expr: 'bl.code', needs: ['location'], group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'expiryDate', label: 'Expiry date', type: 'date', expr: 't.expiry_date', starter: true, group: FIELD_GROUPS.DATES },
    {
      key: 'daysToExpiry',
      label: 'Days to expiry',
      type: 'number',
      expr: '(CASE WHEN t.expiry_date IS NULL THEN NULL ELSE DATEDIFF(t.expiry_date, CURDATE()) END)',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.DATES,
      hint: 'Negative means already expired. Empty when the lot carries no date.',
    },
    { key: 'qtyRemaining', label: 'Qty remaining', type: 'number', expr: 't.qty_remaining', numeric: true, starter: true, group: FIELD_GROUPS.QUANTITIES },
    { key: 'qtyReceived', label: 'Qty received', type: 'number', expr: 't.qty_received', numeric: true, group: FIELD_GROUPS.QUANTITIES },
    { key: 'costExcl', label: 'Landed cost', type: 'currency', expr: 't.cost_excl', numeric: true, noTotal: true, permission: 'products.cost', group: FIELD_GROUPS.COST },
    {
      key: 'valueRemaining',
      label: 'Value remaining',
      type: 'currency',
      expr: '(t.qty_remaining * t.cost_excl)',
      numeric: true,
      permission: 'products.cost',
      group: FIELD_GROUPS.COST,
    },
    { key: 'receivedAt', label: 'Received', type: 'datetime', expr: 't.received_at', group: FIELD_GROUPS.DATES },
    { key: 'note', label: 'Note', type: 'text', expr: 't.note', group: FIELD_GROUPS.OTHER },
    { key: 'grvNumber', label: 'GRV number', type: 'text', expr: 'bpd.document_number', needs: ['grv'], group: FIELD_GROUPS.IDENTITY },
  ],
}

/* ── job cards ─────────────────────────────────────────────────────────────── */

/**
 * TWO SOURCES, NOT ONE, for the reason sales and sale lines are two.
 *
 * A job is one row with one customer and one status; a job LINE is a part or an
 * hour. Asking "how many urgent jobs did we close last month" against the lines
 * counts every job once per line, and asking "what did we spend on parts" against
 * the jobs cannot see a part at all. One source cannot answer both without every
 * count silently meaning something different depending on which fields were
 * picked.
 *
 * WHY REVENUE IS NOT A FIELD ON EITHER
 *
 * Because it does not live here. A job line carries `unit_price_incl`, which is an
 * INTENTION; what the customer owes is on the invoice after documentMath has
 * applied its discounts and VAT. A revenue column read off the line would agree
 * with itself and disagree with the sales report, and the sales report is right.
 * `invoicedQty` and the invoice id are offered instead, so a report can join the
 * thread back to the paper.
 */

const JOB_STATUS_JOIN: JoinUnit = {
  name: 'jobStatus',
  sql: 'LEFT JOIN job_statuses js ON js.id = t.status_id',
}

const JOB_SLA_JOIN: JoinUnit = {
  name: 'jobSla',
  sql: 'LEFT JOIN job_sla_policies jsp ON jsp.id = t.sla_policy_id',
}

const JOB_ADDRESS_JOIN: JoinUnit = {
  name: 'jobAddress',
  sql: 'LEFT JOIN service_addresses jsa ON jsa.id = t.service_address_id',
}

const JOB_CARDS_SOURCE: CatalogSource = {
  key: 'jobCards',
  label: 'Job cards',
  description: 'Every job — who it was for, what stage it reached, and how long it took.',
  category: 'Operations',
  permission: 'jobs.view',
  shape: 'timeline',
  table: 'job_cards',
  dateColumn: 'reported_at',
  /*
   * There used to be a CUSTOMER_REP_JOIN here, because CUSTOMER_LOOKUP_FIELDS
   * includes accountRep and its `needs` named it — a spread field set brings its
   * join requirements with it, and omitting one fails only when somebody picks
   * that single column.
   *
   * The join is gone: it read sales_reps in the CALLER's database while `c` came
   * from the customer file's owner, so under sharing it named a different person
   * or nobody. accountRep now reads c.rep_name and needs no join at all (205).
   */
  joins: [
    JOB_STATUS_JOIN,
    JOB_SLA_JOIN,
    JOB_ADDRESS_JOIN,
    CUSTOMER_JOIN,
    CUSTOMER_GROUP_JOIN,
  ],
  fields: [
    {
      // 'document' rather than 'text': it renders as the link back to the record.
      key: 'documentNumber',
      label: 'Job number',
      type: 'document',
      expr: 't.document_number',
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'title',
      label: 'What it is',
      type: 'text',
      expr: 't.title',
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'customerPhone',
      label: 'Customer phone',
      type: 'text',
      expr: 't.customer_phone',
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'customerName',
      label: 'Customer',
      type: 'text',
      expr: 't.customer_name',
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
      hint: 'The name as it was when the job was logged. Empty for a walk-in.',
    },
    {
      key: 'statusName',
      label: 'Stage',
      type: 'text',
      expr: 'js.name',
      needs: ['jobStatus'],
      starter: true,
      group: FIELD_GROUPS.CLASSIFICATION,
      hint: 'This shop can rename its stages, so this is whatever it calls them.',
    },
    enumField(
      'lifecycle',
      'Open or closed',
      't.status',
      ['open', 'closed', 'cancelled'],
      { starter: true },
    ),
    enumField('priority', 'Priority', 't.priority', ['low', 'normal', 'high', 'urgent'], {
      starter: true,
    }),
    // All eight values the column actually holds. A picker missing one silently
    // offers a filter that can never match.
    enumField('source', 'How it came in', 't.source', [
      'manual',
      'phone',
      'email',
      'walk_in',
      'internal',
      'quote',
      'portal',
      'public_form',
    ]),
    {
      key: 'lineCount',
      label: 'Lines',
      type: 'number',
      expr: '(SELECT COUNT(*) FROM job_card_lines jl WHERE jl.job_card_id = t.id)',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'ownerName',
      label: 'Assigned to',
      type: 'text',
      expr: 't.owner_name',
      starter: true,
      group: FIELD_GROUPS.PEOPLE,
      hint: 'Empty means nobody has been made responsible yet.',
    },
    {
      key: 'addressName',
      label: 'Where the work is',
      type: 'text',
      expr: 'jsa.name',
      needs: ['jobAddress'],
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'addressCity',
      label: 'Town',
      type: 'text',
      expr: 'jsa.city',
      needs: ['jobAddress'],
      group: FIELD_GROUPS.IDENTITY,
    },

    /* ── Cost, and why there is no revenue beside it ─────────────────────── */
    {
      key: 'totalCost',
      label: 'Cost of the job',
      type: 'currency',
      expr:
        '(SELECT COALESCE(SUM(jl.qty * jl.unit_cost_excl), 0) ' +
        'FROM job_card_lines jl WHERE jl.job_card_id = t.id)',
      numeric: true,
      permission: 'jobs.cost',
      group: FIELD_GROUPS.COST,
      hint: 'Every line, including work we chose not to charge for.',
    },
    {
      key: 'absorbedCost',
      label: 'Cost we absorbed',
      type: 'currency',
      expr:
        '(SELECT COALESCE(SUM(jl.qty * jl.unit_cost_excl), 0) ' +
        "FROM job_card_lines jl WHERE jl.job_card_id = t.id " +
        "AND jl.billing_state IN ('internal','written_off'))",
      numeric: true,
      permission: 'jobs.cost',
      group: FIELD_GROUPS.COST,
      hint: 'Rework, goodwill and warranty — the figure that quietly eats a margin.',
    },
    {
      key: 'undecidedCost',
      label: 'Cost awaiting a decision',
      type: 'currency',
      expr:
        '(SELECT COALESCE(SUM(jl.qty * jl.unit_cost_excl), 0) ' +
        "FROM job_card_lines jl WHERE jl.job_card_id = t.id AND jl.billing_state = 'pending')",
      numeric: true,
      permission: 'jobs.cost',
      group: FIELD_GROUPS.COST,
      hint: 'Nobody has said yet who pays for this. A job cannot close while it is above zero.',
    },

    /* ── The SLA, as facts rather than a live verdict ─────────────────────── */
    {
      key: 'slaPolicy',
      label: 'Service target',
      type: 'text',
      expr: 'jsp.name',
      needs: ['jobSla'],
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    {
      key: 'respondBy',
      label: 'Reply promised by',
      type: 'datetime',
      expr: 't.respond_by',
      group: FIELD_GROUPS.DATES,
    },
    {
      key: 'respondedAt',
      label: 'First reply',
      type: 'datetime',
      expr: 't.responded_at',
      group: FIELD_GROUPS.DATES,
      hint: 'Empty means nobody has picked it up yet.',
    },
    {
      key: 'respondedByName',
      label: 'Picked up by',
      type: 'text',
      expr: 't.responded_by_name',
      group: FIELD_GROUPS.PEOPLE,
    },
    {
      /*
       * A COMPARISON OF TWO STORED FACTS, not a live breach verdict.
       *
       * The app derives breach on read against business hours, and SQL has no
       * business-hours arithmetic — reimplementing it here would give a second
       * answer that disagrees with every screen. So this compares the two
       * timestamps that were actually recorded, which is the same answer for a
       * job that has been replied to and is honestly blank for one that has not.
       * A report asking "did we answer late" wants exactly that; a report asking
       * "what is late right now" is the worklist, and belongs on the worklist.
       */
      key: 'respondedLate',
      label: 'Reply was late',
      type: 'text',
      expr:
        'CASE WHEN t.responded_at IS NULL OR t.respond_by IS NULL THEN NULL ' +
        "WHEN t.responded_at > t.respond_by THEN 'Yes' ELSE 'No' END",
      group: FIELD_GROUPS.FLAGS,
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
      ],
      hint: 'Blank until somebody has replied. Compares what was promised against what happened.',
    },
    {
      key: 'resolveBy',
      label: 'Fix promised by',
      type: 'datetime',
      expr: 't.resolve_by',
      group: FIELD_GROUPS.DATES,
    },
    {
      key: 'closedLate',
      label: 'Fix was late',
      type: 'text',
      expr:
        'CASE WHEN t.closed_at IS NULL OR t.resolve_by IS NULL THEN NULL ' +
        "WHEN t.closed_at > t.resolve_by THEN 'Yes' ELSE 'No' END",
      group: FIELD_GROUPS.FLAGS,
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
      ],
      hint: 'Blank until the job is closed.',
    },

    /* ── Dates and durations ─────────────────────────────────────────────── */
    {
      key: 'reportedAt',
      label: 'Logged',
      type: 'datetime',
      expr: 't.reported_at',
      starter: true,
      group: FIELD_GROUPS.DATES,
    },
    { key: 'dueAt', label: 'Due', type: 'datetime', expr: 't.due_at', group: FIELD_GROUPS.DATES },
    {
      key: 'startedAt',
      label: 'Work started',
      type: 'datetime',
      expr: 't.started_at',
      group: FIELD_GROUPS.DATES,
    },
    {
      key: 'closedAt',
      label: 'Closed',
      type: 'datetime',
      expr: 't.closed_at',
      group: FIELD_GROUPS.DATES,
    },
    {
      /*
       * ONE column for two questions, via COALESCE on the closing date: an open
       * job's age and a closed job's turnaround are the same measurement, and two
       * columns each blank half the time is how a report ends up with gaps nobody
       * can explain.
       *
       * CALENDAR days, and the label says so. Business-day arithmetic lives in
       * jobStatusModel and cannot be reproduced in SQL without a second,
       * disagreeing implementation — so this measures what it can measure honestly
       * rather than pretending to be the SLA clock.
       */
      key: 'daysOpen',
      label: 'Days open',
      type: 'number',
      expr: 'DATEDIFF(COALESCE(t.closed_at, NOW()), t.reported_at)',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.DATES,
      hint: 'To close, or to now if it is still open. Calendar days, not working ones.',
    },
    {
      /*
       * Against the DUE date rather than the SLA deadline, and deliberately not
       * clamped at zero: "what did we close early" is as real a question as "what
       * ran late", and GREATEST(0, ...) would throw away half the answer.
       */
      key: 'daysOverdue',
      label: 'Days overdue',
      type: 'number',
      expr: 'DATEDIFF(COALESCE(t.closed_at, NOW()), t.due_at)',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.DATES,
      hint: 'Negative means it was closed early, or is not due yet. Empty when no due date was set.',
    },
    {
      key: 'closeReason',
      label: 'Closing note',
      type: 'text',
      expr: 't.close_reason',
      group: FIELD_GROUPS.OTHER,
    },
    {
      key: 'cancelReason',
      label: 'Why it was called off',
      type: 'text',
      expr: 't.cancel_reason',
      group: FIELD_GROUPS.OTHER,
    },
    {
      key: 'reference',
      label: 'Their reference',
      type: 'text',
      expr: 't.reference',
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'jobDescription',
      label: 'Description',
      type: 'text',
      expr: 't.description',
      group: FIELD_GROUPS.IDENTITY,
      hint: 'What the customer asked for, as taken down.',
    },
    {
      key: 'internalNote',
      label: 'Internal note',
      type: 'text',
      expr: 't.internal_note',
      group: FIELD_GROUPS.OTHER,
      hint: 'Never shown to the customer.',
    },
    { key: 'customerEmail', label: 'Customer email (on job)', type: 'text', expr: 't.customer_email', group: FIELD_GROUPS.IDENTITY },
    { key: 'customerCode', label: 'Customer code (on job)', type: 'text', expr: 't.customer_code', group: FIELD_GROUPS.IDENTITY },
    { key: 'cancelledAt', label: 'Cancelled at', type: 'datetime', expr: 't.cancelled_at', group: FIELD_GROUPS.DATES },
    /* Sign-off, both sides. "Was this job actually signed for" is the question
       a disputed invoice turns on, and neither timestamp was reportable. */
    { key: 'customerSignedAt', label: 'Customer signed at', type: 'datetime', expr: 't.customer_signed_at', group: FIELD_GROUPS.DATES },
    { key: 'customerSignedName', label: 'Customer signed by', type: 'text', expr: 't.customer_signed_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'technicianSignedAt', label: 'Technician signed at', type: 'datetime', expr: 't.technician_signed_at', group: FIELD_GROUPS.DATES },
    { key: 'technicianSignedName', label: 'Technician signed by', type: 'text', expr: 't.technician_signed_name', group: FIELD_GROUPS.PEOPLE },
    {
      key: 'isSignedOff',
      label: 'Signed off by customer',
      type: 'text',
      /* Derived rather than raw: the useful question is "which jobs are NOT
         signed", and a timestamp column cannot be filtered to that in the
         builder without an is-null operator the spec does not offer. */
      expr: "(CASE WHEN t.customer_signed_at IS NULL THEN 'No' ELSE 'Yes' END)",
      group: FIELD_GROUPS.FLAGS,
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
      ],
    },
    { key: 'userName', label: 'Logged by', type: 'text', expr: 't.user_name', group: FIELD_GROUPS.PEOPLE },
    ...CUSTOMER_LOOKUP_FIELDS,
    // Hours included: "when do the calls come in" is a real staffing question,
    // and it is the one bucket a job source can answer that a daily one cannot.
    ...timeBuckets('reported_at', { hours: true }),
  ],
}

const JOB_LINES_SOURCE: CatalogSource = {
  key: 'jobCardLines',
  label: 'Job card lines',
  description: 'Every part, hour, kilometre and charge on a job, and who pays for it.',
  category: 'Operations',
  permission: 'jobs.view',
  shape: 'timeline',
  table: 'job_card_lines',
  /*
   * A line dates from its JOB, not from when the line was typed. A part added on
   * Friday to a job logged on Monday belongs in Monday's week — otherwise a
   * month-end report on job costs splits one job across two periods.
   */
  dateColumn: 'reported_at',
  dateJoin: 'job',
  joins: [
    { name: 'job', sql: 'INNER JOIN job_cards j ON j.id = t.job_card_id', always: true },
    { name: 'jobStatus', sql: 'LEFT JOIN job_statuses js ON js.id = j.status_id' },
    { name: 'product', sql: 'LEFT JOIN products pm ON pm.id = t.product_id' },
    { name: 'productDept', sql: 'LEFT JOIN departments pdm ON pdm.id = pm.department_id', needs: ['product'] },
    { name: 'invoice', sql: 'LEFT JOIN sales_documents jinv ON jinv.id = t.invoiced_doc_id' },
  ],
  fields: [
    {
      key: 'jobNumber',
      label: 'Job number',
      type: 'document',
      expr: 'j.document_number',
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'jobTitle',
      label: 'What the job is',
      type: 'text',
      expr: 'j.title',
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'customerName',
      label: 'Customer',
      type: 'text',
      expr: 'j.customer_name',
      group: FIELD_GROUPS.IDENTITY,
    },
    /*
     * The kinds come FROM the union, not from a copy of it.
     *
     * This line previously spelled the four values out. A string array is
     * something the compiler cannot tie back to JobLineKind, so adding
     * 'expense' to the union left this list four-long and silently correct-
     * looking: the field still worked, still filtered, and simply never offered
     * — or matched — an expense. A report of "everything except parts" would
     * have quietly omitted the whole new category.
     *
     * Spreading LINE_KINDS means the next kind appears here by construction.
     */
    enumField('lineKind', 'Kind', 't.line_kind', [...LINE_KINDS], {
      starter: true,
    }),
    /*
     * THE FIELD THIS SOURCE EXISTS FOR. Six states, and the difference between
     * them is the whole of job profitability: internal and written_off carry cost
     * and no revenue, pending is a decision nobody has made.
     */
    enumField(
      'billingState',
      'Who pays',
      't.billing_state',
      ['quoted', 'variation', 'additional', 'internal', 'pending', 'written_off'],
      { starter: true },
    ),
    {
      key: 'description',
      label: 'Description',
      type: 'text',
      expr: 't.description',
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    {
      key: 'productCode',
      label: 'Product code',
      type: 'text',
      expr: 't.product_code',
      group: FIELD_GROUPS.IDENTITY,
      hint: 'The code as it was at the time. Empty for labour, travel or a free-text charge.',
    },
    {
      key: 'productDepartment',
      label: 'Department',
      type: 'text',
      expr: 'pdm.name',
      needs: ['product', 'productDept'],
      group: FIELD_GROUPS.PRODUCT,
    },
    { key: 'qty', label: 'Quantity', type: 'number', expr: 't.qty', numeric: true, starter: true, group: FIELD_GROUPS.QUANTITIES },
    {
      key: 'unitCostExcl',
      label: 'Unit cost',
      type: 'currency',
      expr: 't.unit_cost_excl',
      numeric: true,
      noTotal: true,
      permission: 'jobs.cost',
      group: FIELD_GROUPS.COST,
    },
    {
      key: 'lineCost',
      label: 'Line cost',
      type: 'currency',
      expr: '(t.qty * t.unit_cost_excl)',
      numeric: true,
      starter: true,
      permission: 'jobs.cost',
      group: FIELD_GROUPS.COST,
    },
    {
      /*
       * An INTENTION, and labelled as one. What the customer actually owes is on
       * the invoice after documentMath; this is what somebody meant to charge when
       * they typed the line. Naming it "revenue" is how a job report comes to
       * disagree with the sales report.
       */
      key: 'intendedPriceIncl',
      label: 'Intended price (incl.)',
      type: 'currency',
      expr: '(t.qty * t.unit_price_incl)',
      numeric: true,
      /* Gated since the §26.6 split. A selling price is commercial information,
         and before a key existed for it these three fields were readable by
         anyone with reports.view — which is how a margin leaks out of a report
         that never names one. */
      permission: 'jobs.price',
      group: FIELD_GROUPS.MONEY,
      hint: 'What was meant to be charged. The invoice is what the customer actually owes.',
    },
    {
      key: 'quotedQty',
      label: 'Quoted qty',
      type: 'number',
      expr: 't.quoted_qty',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
      hint: 'What was quoted, as against what was actually used. Blank on a line that was never quoted.',
    },
    {
      key: 'quotedCostExcl',
      label: 'Quoted cost (excl.)',
      type: 'currency',
      expr: 't.quoted_cost_excl',
      numeric: true,
      /* jobs.cost, matching unitCost and lineCost beside it — not jobs.price,
         which gates what the customer is charged. A quoted cost is what the
         job was expected to cost US, so it belongs on the cost side of that
         split. */
      permission: 'jobs.cost',
      group: FIELD_GROUPS.COST,
      hint: 'The cost the quote was built on — compare against actual cost to see where an estimate slipped.',
    },
    {
      key: 'lineDiscountPct',
      label: 'Line discount %',
      type: 'percent',
      expr: 't.discount_pct',
      numeric: true,
      noTotal: true,
      permission: 'jobs.price',
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'unitPriceIncl',
      label: 'Unit price (incl.)',
      type: 'currency',
      expr: 't.unit_price_incl',
      numeric: true,
      noTotal: true,
      permission: 'jobs.price',
      group: FIELD_GROUPS.MONEY,
    },
    {
      /* Excluding VAT, so it can be compared against cost. The incl. figure
         divided by the line's own rate — not a site-wide rate, because two lines
         on one job can carry different ones. */
      key: 'intendedPriceExcl',
      label: 'Intended price (excl.)',
      type: 'currency',
      expr: '(t.qty * t.unit_price_incl / NULLIF(1 + t.vat_rate_pct / 100, 0))',
      numeric: true,
      permission: 'jobs.price',
      group: FIELD_GROUPS.MONEY,
      hint: 'The ex-VAT equivalent, so it lines up against cost.',
    },
    {
      /*
       * INTENDED margin, and the label has to say so.
       *
       * Both sides are off the line: cost is real, but the price is what somebody
       * meant to charge, so this is the margin as planned rather than as banked.
       * Realised margin needs the invoice, and lives in the sales sources.
       */
      key: 'intendedProfit',
      label: 'Intended profit',
      type: 'currency',
      expr:
        '((t.qty * t.unit_price_incl / NULLIF(1 + t.vat_rate_pct / 100, 0)) ' +
        '- (t.qty * t.unit_cost_excl))',
      numeric: true,
      /* `jobs.profit`, not `jobs.cost`: this field derives from BOTH sides, so
         gating it on cost alone would hand the margin to somebody granted only
         the buying price — the leak the §26.6 split exists to close. */
      permission: 'jobs.profit',
      group: FIELD_GROUPS.COST,
      hint: 'Price as intended, less cost. Zero-priced lines (internal, written off) show as a loss, which is the point.',
    },
    {
      key: 'invoicedQty',
      label: 'Quantity invoiced',
      type: 'number',
      expr: 't.invoiced_qty',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'invoiceNumber',
      label: 'Invoice',
      type: 'text',
      expr: 'jinv.document_number',
      needs: ['invoice'],
      group: FIELD_GROUPS.IDENTITY,
      hint: 'The thread back to what the customer was actually charged.',
    },
    {
      key: 'issuedQty',
      label: 'Quantity on a vehicle',
      type: 'number',
      expr: 't.issued_qty',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
      hint: 'Parts that have left the shelf for a van and not yet come back.',
    },
    {
      key: 'stillToInvoice',
      label: 'Still to invoice',
      type: 'number',
      expr:
        "CASE WHEN t.billing_state IN ('quoted','variation','additional') " +
        'THEN GREATEST(0, t.qty - t.invoiced_qty) ELSE 0 END',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
      hint: 'Billable and not yet billed. Zero for anything internal or written off.',
    },
    {
      key: 'decidedReason',
      label: 'Why',
      type: 'text',
      expr: 't.decided_reason',
      group: FIELD_GROUPS.OTHER,
      hint: 'The reason given when somebody decided who pays. The thing an owner asks about a write-off.',
    },
    {
      key: 'decidedAt',
      label: 'Decided',
      type: 'datetime',
      expr: 't.decided_at',
      group: FIELD_GROUPS.DATES,
    },
    {
      key: 'jobStatusName',
      label: 'Job stage',
      type: 'text',
      expr: 'js.name',
      needs: ['jobStatus'],
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    enumField('jobLifecycle', 'Job open or closed', 'j.status', ['open', 'closed', 'cancelled']),
    enumField('jobPriority', 'Job priority', 'j.priority', ['low', 'normal', 'high', 'urgent']),
    {
      key: 'jobOwnerName',
      label: 'Job assigned to',
      type: 'text',
      expr: 'j.owner_name',
      group: FIELD_GROUPS.PEOPLE,
    },
    {
      key: 'reportedAt',
      label: 'Job logged',
      type: 'datetime',
      expr: 'j.reported_at',
      starter: true,
      group: FIELD_GROUPS.DATES,
    },
    {
      key: 'jobClosedAt',
      label: 'Job closed',
      type: 'datetime',
      expr: 'j.closed_at',
      group: FIELD_GROUPS.DATES,
    },
    { key: 'note', label: 'Note', type: 'text', expr: 't.note', group: FIELD_GROUPS.OTHER },
    /*
     * The buckets come off the PARENT's date column, so the alias is rewritten —
     * the same move every line-level source makes. timeBuckets() builds `t.<col>`
     * and a job line has no reported_at of its own; without this every bucket
     * failed with "Unknown column 't.reported_at'".
     */
    ...timeBuckets('reported_at', { hours: true }).map((f) => ({
      ...f,
      expr: f.expr.replace(/t\.`reported_at`/g, 'j.`reported_at`'),
    })),
  ],
}

/* ── what a supplier is owed ───────────────────────────────────────────────── */

/*
 * The mirror of customerTransactions, and an asymmetry worth naming: debtors
 * have had a ledger source since the catalog was written, creditors have not.
 * So "what do we owe, and how old is it" — the question a payment run is built
 * from — could be answered for money coming in and not for money going out.
 */
const SUPPLIER_TXN_SOURCE: CatalogSource = {
  key: 'supplierTransactions',
  label: 'Supplier ledger',
  description:
    'Every invoice, payment, credit and journal on a supplier account, with what is still outstanding.',
  category: 'Suppliers',
  permission: 'suppliers.view',
  shape: 'timeline',
  table: 'supplier_transactions',
  // The creditors ledger moves with the file it belongs to.
  ownedBy: 'supplier',
  dateColumn: 'doc_date',
  // Unprefixed on purpose: both tables are on the same owner, so naming the
  // database here would be right but redundant.
  joins: [{ name: 'supplier', sql: 'LEFT JOIN suppliers s ON s.id = t.supplier_id' }],
  fields: [
    { key: 'docNumber', label: 'Document number', type: 'document', expr: 't.doc_number', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'docDate', label: 'Date', type: 'date', expr: 't.doc_date', starter: true, group: FIELD_GROUPS.DATES },
    enumField('docType', 'Type', 't.doc_type', ['invoice', 'credit_note', 'payment', 'journal', 'opening', 'interest'], {
      starter: true,
    }),
    { key: 'supplierName', label: 'Supplier', type: 'text', expr: 's.name', needs: ['supplier'], starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'supplierCode', label: 'Supplier code', type: 'text', expr: 's.code', needs: ['supplier'], group: FIELD_GROUPS.IDENTITY },
    {
      /* SIGNED, so a column of these adds up to the movement on the account.
         amount_gross is always positive and would total to nonsense across a
         mix of invoices and payments. */
      key: 'amountSigned',
      label: 'Amount',
      type: 'currency',
      expr: 't.amount_signed',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Positive increases what is owed; a payment is negative.',
    },
    { key: 'amountGross', label: 'Gross', type: 'currency', expr: 't.amount_gross', numeric: true, group: FIELD_GROUPS.MONEY },
    { key: 'amountVat', label: 'VAT', type: 'currency', expr: 't.amount_vat', numeric: true, group: FIELD_GROUPS.MONEY },
    { key: 'amountNet', label: 'Net', type: 'currency', expr: 't.amount_net', numeric: true, group: FIELD_GROUPS.MONEY },
    {
      key: 'amountOutstanding',
      label: 'Outstanding',
      type: 'currency',
      expr: 't.amount_outstanding',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.AGEING,
      hint: 'What is still unsettled on this document.',
    },
    {
      /* Age of the DEBT, from the due date. Negative means not yet due, which
         is why it is not clamped: "how much is not due yet" is as real a
         question as "how much is overdue". */
      key: 'daysOverdue',
      label: 'Days overdue',
      type: 'number',
      expr: 'DATEDIFF(CURDATE(), t.due_date)',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.AGEING,
      hint: 'Negative means it is not due yet.',
    },
    { key: 'dueDate', label: 'Due date', type: 'date', expr: 't.due_date', group: FIELD_GROUPS.DATES },
    { key: 'reference', label: 'Reference', type: 'text', expr: 't.reference', group: FIELD_GROUPS.OTHER },
    { key: 'description', label: 'Description', type: 'text', expr: 't.description', group: FIELD_GROUPS.OTHER },
    { key: 'userName', label: 'Captured by', type: 'text', expr: 't.user_name', group: FIELD_GROUPS.PEOPLE },
    {
      key: 'sourceModule',
      label: 'Raised by',
      type: 'text',
      expr: 't.source',
      group: FIELD_GROUPS.CLASSIFICATION,
      hint: 'Which part of the system wrote the entry — a GRV, a payment run, an opening balance.',
    },
    { key: 'supplierBalance', label: 'Account balance now', type: 'currency', expr: 's.balance', numeric: true, noTotal: true, needs: ['supplier'], group: FIELD_GROUPS.AGEING },
    ...agedBucketFields(),
    ...timeBuckets('doc_date'),
  ],
}

/* ── loyalty ───────────────────────────────────────────────────────────────── */

const LOYALTY_LEDGER_SOURCE: CatalogSource = {
  key: 'loyaltyLedger',
  label: 'Loyalty activity',
  description:
    'Every point earned, redeemed, expired or adjusted — what the programme is costing and who is using it.',
  category: 'Customers',
  permission: 'customers.view',
  shape: 'timeline',
  table: 'loyalty_ledger',
  ownedBy: 'loyalty',
  dateColumn: 'created_at',
  /*
   * Through the MEMBER, and only then to the customer.
   *
   * The ledger carried customer_id and joined customers directly. It no longer
   * has that column — the report would 500 at request time — and the indirection
   * is not merely mechanical: a walk-in member has no customer row, so the
   * customer join must be LEFT or every walk-in's points vanish from the report
   * that is supposed to account for the programme's liability.
   */
  joins: [
    { name: 'member', sql: 'LEFT JOIN {L}loyalty_members m ON m.id = t.member_id' },
    {
      name: 'customer',
      sql: 'LEFT JOIN {C}customers c ON c.id = m.customer_id',
      needs: ['member'],
    },
  ],
  fields: [
    { key: 'happenedAt', label: 'When', type: 'datetime', expr: 't.created_at', starter: true, group: FIELD_GROUPS.DATES },
    { key: 'memberName', label: 'Member', type: 'text', expr: 'm.name', needs: ['member'], starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'memberNumber', label: 'Member number', type: 'text', expr: 'm.member_number', needs: ['member'], starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'customerName', label: 'Customer', type: 'text', expr: 'c.name', needs: ['customer'], group: FIELD_GROUPS.IDENTITY, hint: 'Blank for a member with no debtors account, which is ordinary.' },
    { key: 'customerCode', label: 'Account code', type: 'text', expr: 'c.code', needs: ['customer'], group: FIELD_GROUPS.IDENTITY },
    enumField('entryType', 'Type', 't.entry_type', ['earn', 'redeem', 'expire', 'adjust', 'reverse'], {
      starter: true,
    }),
    {
      /* SIGNED: an earn is positive, a redemption negative, so a column of
         these totals to the movement in the programme's liability. */
      key: 'points',
      label: 'Points',
      type: 'number',
      expr: 't.points',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    { key: 'basisAmount', label: 'Qualifying spend', type: 'currency', expr: 't.basis_amount', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    { key: 'tierName', label: 'Tier', type: 'text', expr: 't.tier_name', group: FIELD_GROUPS.CLASSIFICATION, hint: 'The tier as it was at the time, not today’s.' },
    { key: 'multiplier', label: 'Multiplier', type: 'number', expr: 't.multiplier', numeric: true, noTotal: true, group: FIELD_GROUPS.OTHER },
    { key: 'documentNumber', label: 'Document', type: 'document', expr: 't.document_number', group: FIELD_GROUPS.IDENTITY },
    { key: 'note', label: 'Note', type: 'text', expr: 't.note', group: FIELD_GROUPS.OTHER },
    { key: 'userName', label: 'By', type: 'text', expr: 't.user_name', group: FIELD_GROUPS.PEOPLE },
    ...timeBuckets('created_at', { hours: true }),
  ],
}

const LOYALTY_MEMBERS_SOURCE: CatalogSource = {
  key: 'loyaltyMembers',
  label: 'Loyalty members',
  description:
    'Who is on the programme, what tier they are in, and what their points are worth.',
  category: 'Customers',
  permission: 'customers.view',
  shape: 'snapshot',
  table: 'loyalty_members',
  ownedBy: 'loyalty',
  /*
   * The customer join is LEFT and no longer `always`.
   *
   * It was an INNER JOIN forced on every query, which was right when a member
   * WAS a customer row. It is now the bug that would hide the people this
   * report exists to count: every walk-in member would be dropped from
   * "who is on the programme", silently and without an empty result to notice.
   *
   * The tier join reads {L}, not {B} — one shared programme has one ladder, on
   * the owner alongside the members.
   */
  joins: [
    { name: 'customer', sql: 'LEFT JOIN {C}customers c ON c.id = t.customer_id' },
    { name: 'tier', sql: 'LEFT JOIN {L}loyalty_tiers lt ON lt.id = t.tier_id' },
  ],
  fields: [
    { key: 'memberName', label: 'Member', type: 'text', expr: 't.name', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'memberNumber', label: 'Member number', type: 'text', expr: 't.member_number', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'customerName', label: 'Customer', type: 'text', expr: 'c.name', needs: ['customer'], group: FIELD_GROUPS.IDENTITY, hint: 'Blank for a member with no debtors account, which is ordinary.' },
    { key: 'customerCode', label: 'Account code', type: 'text', expr: 'c.code', needs: ['customer'], group: FIELD_GROUPS.IDENTITY },
    { key: 'phone', label: 'Phone', type: 'text', expr: 't.phone', group: FIELD_GROUPS.IDENTITY },
    { key: 'email', label: 'Email', type: 'text', expr: 't.email', group: FIELD_GROUPS.IDENTITY },
    { key: 'tierName', label: 'Tier', type: 'text', expr: 'lt.name', needs: ['tier'], starter: true, group: FIELD_GROUPS.CLASSIFICATION },
    {
      key: 'pointsBalance',
      label: 'Points balance',
      type: 'number',
      expr: 't.points_balance',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    {
      key: 'walletBalance',
      label: 'Wallet balance',
      type: 'currency',
      expr: 't.wallet_balance',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Money on account, which is a real liability — unlike points, which are only worth what redemption makes them.',
    },
    { key: 'tierMultiplier', label: 'Tier multiplier', type: 'number', expr: 'lt.multiplier', numeric: true, noTotal: true, needs: ['tier'], group: FIELD_GROUPS.OTHER },
    { key: 'tierDiscountPct', label: 'Tier discount %', type: 'percent', expr: 'lt.discount_pct', numeric: true, noTotal: true, needs: ['tier'], group: FIELD_GROUPS.OTHER },
    { key: 'joinedAt', label: 'Joined', type: 'datetime', expr: 't.joined_at', group: FIELD_GROUPS.DATES },
    { key: 'lastActivityAt', label: 'Last activity', type: 'datetime', expr: 't.last_activity_at', starter: true, group: FIELD_GROUPS.DATES },
    {
      key: 'daysSinceActivity',
      label: 'Days since activity',
      type: 'number',
      expr: 'DATEDIFF(CURDATE(), t.last_activity_at)',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.DATES,
    },
    { key: 'tierSince', label: 'In tier since', type: 'datetime', expr: 't.tier_since', group: FIELD_GROUPS.DATES },
    {
      key: 'tierReviewDate',
      label: 'Tier reviewed on',
      type: 'date',
      expr: 't.tier_review_date',
      group: FIELD_GROUPS.DATES,
      hint: 'When the member is next assessed for promotion or demotion.',
    },
    yesNo('isActive', 'Active', 't.is_active'),
  ],
}

/* ── the general ledger ────────────────────────────────────────────────────── */

/**
 * Every source value a journal batch can carry — the mirrors in glPosting.ts
 * plus 'manual'. Offered as a picker so nobody has to guess the spellings;
 * an unlisted value (a future mirror) still passes through as text.
 */
const JOURNAL_SOURCES = [
  'manual', 'sale', 'credit_note', 'grv', 'supplier_return', 'expense', 'receipt',
  'payment', 'cashup', 'bank_txn', 'bank_txn_void', 'bank_transfer', 'bank_transfer_void',
  'manufacture', 'manufacture_cancel', 'stock_take', 'stock_take_cancel',
  'stock_adjustment', 'stock_adjust_cancel', 'interest', 'write_off',
  'depreciation', 'asset_disposal', 'year_end',
]

const JOURNAL_LINES_SOURCE: CatalogSource = {
  key: 'journalLines',
  label: 'Journal lines',
  description:
    'Every debit and credit in the general ledger, with the journal that carried it and the account it landed on.',
  category: 'Money',
  /* The capability on every /accounting page. The joins expose customer and
     supplier NAMES, which reports.financial already sees on the statements. */
  permission: 'reports.financial',
  shape: 'timeline',
  table: 'journal_lines',
  dateColumn: 'journal_date',
  dateJoin: 'batch',
  joins: [
    { name: 'batch', sql: 'INNER JOIN journal_batches b ON b.id = t.batch_id', always: true },
    { name: 'account', sql: 'INNER JOIN gl_accounts a ON a.id = t.account_id', always: true },
    { name: 'dept', sql: 'LEFT JOIN departments jd ON jd.id = t.department_id' },
    { name: 'customer', sql: 'LEFT JOIN {C}customers jc ON jc.id = t.customer_id' },
    // The {C} above was already here; this is its creditors twin, left
    // unqualified when the customer side was done because suppliers were not
    // shared yet. journal_lines is a BRANCH table naming an owner supplier.
    { name: 'supplier', sql: 'LEFT JOIN {S}suppliers js ON js.id = t.supplier_id' },
  ],
  /* Drafts have moved nothing and voids are reversals' tombstones. Only a
     posted batch is a fact about the ledger — same rule every statement
     query applies. Removable, for someone auditing drafts deliberately. */
  defaultFilters: [{ field: 'status', op: 'eq', value: 'posted' }],
  note: 'Posted journals only by default. The sign convention is the ledger’s own: positive is a debit, negative a credit, and any batch sums to zero.',
  fields: [
    { key: 'journalNumber', label: 'Journal', type: 'document', expr: 'b.journal_number', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'journalDate', label: 'Date', type: 'date', expr: 'b.journal_date', starter: true, group: FIELD_GROUPS.DATES },
    enumField('source', 'Source', 'b.source', JOURNAL_SOURCES, { starter: true }),
    enumField('status', 'Status', 'b.status', ['draft', 'posted', 'void']),
    /* The LIVE chart, not the snapshot: filtering and grouping should follow
       an account as it is named today. The snapshot the line carries is its
       own field below, for reading a journal exactly as it was posted. */
    { key: 'accountCode', label: 'Account code', type: 'text', expr: 'a.account_code', starter: true, group: FIELD_GROUPS.ACCOUNT },
    { key: 'accountName', label: 'Account', type: 'text', expr: 'a.name', starter: true, group: FIELD_GROUPS.ACCOUNT },
    enumField('accountType', 'Account type', 'a.account_type', ['asset', 'liability', 'equity', 'income', 'expense'], { group: FIELD_GROUPS.ACCOUNT }),
    { key: 'subtype', label: 'Subtype', type: 'text', expr: 'a.subtype', group: FIELD_GROUPS.ACCOUNT },
    { key: 'snapshotAccount', label: 'Account as posted', type: 'text', expr: "CONCAT(t.account_code, ' — ', t.account_name)", group: FIELD_GROUPS.ACCOUNT, hint: 'Frozen at posting — how the journal itself reads, even if the account was renamed since.' },
    {
      key: 'amount',
      label: 'Amount',
      type: 'currency',
      expr: 't.amount',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Signed: positive is a debit, negative a credit. A column of these sums to the period’s movement.',
    },
    {
      key: 'debit',
      label: 'Debit',
      type: 'currency',
      expr: '(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END)',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'credit',
      label: 'Credit',
      type: 'currency',
      expr: '(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END)',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Shown positive, as a ledger prints it.',
    },
    { key: 'lineDescription', label: 'Line description', type: 'text', expr: 't.description', group: FIELD_GROUPS.OTHER },
    { key: 'batchDescription', label: 'Journal description', type: 'text', expr: 'b.description', group: FIELD_GROUPS.OTHER },
    { key: 'reference', label: 'Reference', type: 'text', expr: 'b.reference', group: FIELD_GROUPS.OTHER },
    { key: 'departmentName', label: 'Department', type: 'text', expr: 'jd.name', needs: ['dept'], group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'customerName', label: 'Customer', type: 'text', expr: 'jc.name', needs: ['customer'], group: FIELD_GROUPS.IDENTITY },
    { key: 'supplierName', label: 'Supplier', type: 'text', expr: 'js.name', needs: ['supplier'], group: FIELD_GROUPS.IDENTITY },
    { key: 'postedBy', label: 'Posted by', type: 'text', expr: 'b.user_name', group: FIELD_GROUPS.PEOPLE },
    ...timeBuckets('journal_date').map((f) => ({
      ...f,
      expr: f.expr.replace(/t\.`journal_date`/g, 'b.`journal_date`'),
    })),
  ],
}

const GL_ACCOUNTS_SOURCE: CatalogSource = {
  key: 'glAccounts',
  label: 'Ledger accounts',
  description: 'The chart of accounts as it stands now — every account and its balance.',
  category: 'Money',
  permission: 'reports.financial',
  shape: 'snapshot',
  table: 'gl_accounts',
  fields: [
    { key: 'accountCode', label: 'Code', type: 'text', expr: 't.account_code', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'name', label: 'Account', type: 'text', expr: 't.name', starter: true, group: FIELD_GROUPS.IDENTITY },
    enumField('accountType', 'Type', 't.account_type', ['asset', 'liability', 'equity', 'income', 'expense'], { starter: true }),
    { key: 'subtype', label: 'Subtype', type: 'text', expr: 't.subtype', group: FIELD_GROUPS.CLASSIFICATION },
    enumField('controlType', 'Control account for', 't.control_type', ['debtors', 'creditors', 'bank', 'stock', 'vat_input', 'vat_output']),
    {
      key: 'balance',
      label: 'Balance (debit-signed)',
      type: 'currency',
      expr: 't.balance',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'The ledger’s own sign: assets and expenses positive, liabilities, equity and income negative.',
    },
    {
      /* The figure a reader expects: 480 000 of sales, not -480 000. */
      key: 'balanceDisplay',
      label: 'Balance',
      type: 'currency',
      expr: "(CASE WHEN t.account_type IN ('liability','equity','income') THEN -t.balance ELSE t.balance END)",
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Sign-corrected per account type, the way a statement prints it. Do not total across types.',
      noTotal: true,
    },
    yesNo('isPostable', 'Postable', 't.is_postable'),
    yesNo('isActive', 'Active', 't.is_active'),
    { key: 'sortOrder', label: 'Sort order', type: 'number', expr: 't.sort_order', numeric: true, noTotal: true, group: FIELD_GROUPS.OTHER },
    { key: 'notes', label: 'Notes', type: 'text', expr: 't.notes', group: FIELD_GROUPS.OTHER },
  ],
}

/* ── the catalog ───────────────────────────────────────────────────────────── */

/* ── gift cards ────────────────────────────────────────────────────────────── */

/*
 * Two sources, because a card and its movements answer different questions and
 * neither substitutes for the other.
 *
 *   giftCards   what is OUTSTANDING right now — the liability on the books.
 *   giftCardEvents  what HAPPENED — sold, redeemed, reloaded, expired.
 *
 * A shop closing its year needs the first; a shop asking whether the scheme is
 * working needs the second. Summing events to derive a balance would drift from
 * the card's own balance the first time an adjustment was posted, so the
 * snapshot is read where it is stored.
 *
 * Both are ownedBy 'giftcard' — NOT 'loyalty'. See the note on `ownedBy`: a
 * group may share its programme while keeping stored value apart, and getting
 * this wrong reports another company's money.
 */
const GIFT_CARD_STATUSES = ['pending', 'active', 'redeemed', 'expired', 'void']

const GIFT_CARDS_SOURCE: CatalogSource = {
  key: 'giftCards',
  label: 'Gift cards',
  description:
    'One row per card — what is still loaded on it, who holds it, and when it expires. The outstanding liability.',
  category: 'Money',
  permission: 'giftcards.view',
  /* A SNAPSHOT: "what do we owe in gift cards" has no date range. The dates on
     it (issued, expires) stay filterable as ordinary fields. */
  shape: 'snapshot',
  table: 'gift_cards',
  ownedBy: 'giftcard',
  joins: [
    /* The holder, where there is one. LEFT because a card sold over the counter
       to a walk-in has no customer, and those are the ones most likely to be
       outstanding — an INNER join would hide exactly the liability this source
       exists to total. */
    { name: 'customer', sql: 'LEFT JOIN {C}customers c ON c.id = t.customer_id' },
  ],
  fields: [
    { key: 'code', label: 'Card number', type: 'text', expr: 't.code', starter: true, group: FIELD_GROUPS.IDENTITY },
    enumField('status', 'Status', 't.status', GIFT_CARD_STATUSES, { starter: true }),
    {
      key: 'balance',
      label: 'Balance',
      type: 'currency',
      expr: 't.balance',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'What is still loaded. Summed across active cards this is the outstanding liability.',
    },
    {
      key: 'initialValue',
      label: 'Loaded value',
      type: 'currency',
      expr: 't.initial_value',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'What the card was originally sold for, before anything was spent off it.',
    },
    {
      key: 'spent',
      label: 'Spent',
      type: 'currency',
      /* Derived rather than stored, and clamped at zero: a reload raises the
         balance above the initial value, and a negative "spent" reads as a bug
         to whoever is looking at the column. */
      expr: '(GREATEST(t.initial_value - t.balance, 0))',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
    },
    { key: 'expiresOn', label: 'Expires on', type: 'date', expr: 't.expires_on', group: FIELD_GROUPS.DATES },
    { key: 'activatedAt', label: 'Sold at', type: 'datetime', expr: 't.activated_at', starter: true, group: FIELD_GROUPS.DATES },
    {
      key: 'activatedDocNumber',
      label: 'Sold on document',
      type: 'document',
      expr: 't.activated_doc_number',
      /* No `link`: the document may live in another branch's database on a
         shared scheme, and a link that opens the wrong shop's invoice — or
         nothing — is worse than plain text. */
      group: FIELD_GROUPS.IDENTITY,
    },
    { key: 'customerName', label: 'Customer', type: 'text', expr: 'c.name', needs: ['customer'], group: FIELD_GROUPS.IDENTITY },
    { key: 'userName', label: 'Sold by', type: 'text', expr: 't.user_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'note', label: 'Note', type: 'text', expr: 't.note', group: FIELD_GROUPS.OTHER },
    { key: 'createdAt', label: 'Issued', type: 'datetime', expr: 't.created_at', group: FIELD_GROUPS.DATES },
    {
      key: 'isExpiring',
      label: 'Expiring within 90 days',
      type: 'text',
      expr:
        "(CASE WHEN t.expires_on IS NULL THEN 'No expiry' " +
        "WHEN t.expires_on < CURDATE() THEN 'Already expired' " +
        "WHEN DATEDIFF(t.expires_on, CURDATE()) <= 90 THEN 'Yes' ELSE 'No' END)",
      group: FIELD_GROUPS.FLAGS,
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
        { value: 'Already expired', label: 'Already expired' },
        { value: 'No expiry', label: 'No expiry' },
      ],
      hint: 'Cards about to lapse — money the shop is about to stop owing, and a customer about to be disappointed.',
    },
  ],
}

const GIFT_CARD_EVENT_TYPES = ['activation', 'redeem', 'reload', 'refund', 'expire', 'adjust']

const GIFT_CARD_EVENTS_SOURCE: CatalogSource = {
  key: 'giftCardEvents',
  label: 'Gift card activity',
  description: 'Every load, redemption, refund and expiry against a card — what the scheme is actually doing.',
  category: 'Money',
  permission: 'giftcards.view',
  shape: 'timeline',
  table: 'gift_card_events',
  ownedBy: 'giftcard',
  dateColumn: 'created_at',
  joins: [{ name: 'card', sql: 'LEFT JOIN {G}gift_cards gc ON gc.id = t.card_id' }],
  fields: [
    { key: 'happenedAt', label: 'When', type: 'datetime', expr: 't.created_at', starter: true, group: FIELD_GROUPS.DATES },
    { key: 'cardCode', label: 'Card number', type: 'text', expr: 'gc.code', needs: ['card'], starter: true, group: FIELD_GROUPS.IDENTITY },
    enumField('entryType', 'Movement', 't.entry_type', GIFT_CARD_EVENT_TYPES, { starter: true }),
    {
      key: 'amount',
      label: 'Amount',
      type: 'currency',
      expr: 't.amount',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Signed by the movement: a load adds, a redemption takes away. Summing every movement gives the net change in liability.',
    },
    { key: 'documentNumber', label: 'Document', type: 'document', expr: 't.document_number', group: FIELD_GROUPS.IDENTITY },
    { key: 'userName', label: 'Done by', type: 'text', expr: 't.user_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'note', label: 'Note', type: 'text', expr: 't.note', group: FIELD_GROUPS.OTHER },
    ...timeBuckets('created_at', { hours: true }),
  ],
}

/* ── laybys ────────────────────────────────────────────────────────────────── */

/*
 * Customer money the shop is holding against goods it has not handed over. Two
 * sources for the same reason gift cards get two: the agreement and its
 * payments are different questions.
 *
 * The laybys table lives in the BRANCH (it carries customer_id into the shared
 * file, but the agreement itself is the branch's), so no ownedBy — only the
 * customer join crosses.
 */
const LAYBY_STATUSES = ['open', 'completed', 'cancelled', 'expired']

const LAYBYS_SOURCE: CatalogSource = {
  key: 'laybys',
  label: 'Laybys',
  description: 'One row per layby — what was put aside, what has been paid, and what is still owing.',
  category: 'Sales',
  permission: 'sales.view',
  shape: 'timeline',
  table: 'laybys',
  dateColumn: 'created_at',
  joins: [{ name: 'customer', sql: 'LEFT JOIN {C}customers c ON c.id = t.customer_id' }],
  fields: [
    { key: 'documentNumber', label: 'Layby number', type: 'text', expr: 't.document_number', starter: true, group: FIELD_GROUPS.IDENTITY },
    enumField('status', 'Status', 't.status', LAYBY_STATUSES, { starter: true }),
    { key: 'customerName', label: 'Customer', type: 'text', expr: 'c.name', needs: ['customer'], starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'totalIncl', label: 'Total', type: 'currency', expr: 't.total_incl', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    {
      key: 'paidTotal',
      label: 'Paid',
      type: 'currency',
      expr: 't.paid_total',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Customer money the shop is holding against goods not yet handed over.',
    },
    {
      key: 'outstanding',
      label: 'Still owing',
      type: 'currency',
      expr: '(t.total_incl - t.paid_total)',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'paidPct',
      label: 'Paid off %',
      type: 'percent',
      expr: '(CASE WHEN t.total_incl = 0 THEN 0 ELSE (t.paid_total / t.total_incl) * 100 END)',
      numeric: true,
      noTotal: true,
      /* Weighted when summarised — a R50 layby at 90% and a R5,000 one at 10%
         do not average to half paid off. */
      ratio: { numerator: 'paidTotal', denominator: 'totalIncl' },
      group: FIELD_GROUPS.MONEY,
    },
    { key: 'dueDate', label: 'Due date', type: 'date', expr: 't.due_date', group: FIELD_GROUPS.DATES },
    {
      key: 'isOverdue',
      label: 'Overdue',
      type: 'text',
      expr:
        "(CASE WHEN t.status <> 'open' THEN 'Not open' " +
        "WHEN t.due_date IS NULL THEN 'No due date' " +
        "WHEN t.due_date < CURDATE() THEN 'Yes' ELSE 'No' END)",
      group: FIELD_GROUPS.FLAGS,
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
        { value: 'Not open', label: 'Not open' },
        { value: 'No due date', label: 'No due date' },
      ],
      hint: 'An open layby past its date — goods held for somebody who has stopped paying.',
    },
    { key: 'completedAt', label: 'Completed at', type: 'datetime', expr: 't.completed_at', group: FIELD_GROUPS.DATES },
    { key: 'cancelledAt', label: 'Cancelled at', type: 'datetime', expr: 't.cancelled_at', group: FIELD_GROUPS.DATES },
    { key: 'cancelReason', label: 'Cancel reason', type: 'text', expr: 't.cancel_reason', group: FIELD_GROUPS.OTHER },
    {
      key: 'cancellationFee',
      label: 'Cancellation fee',
      type: 'currency',
      expr: 't.cancellation_fee',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Kept from a cancelled layby. What was NOT kept is the waiver reason beside it.',
    },
    { key: 'cancellationFeePct', label: 'Cancellation fee %', type: 'percent', expr: 't.cancellation_fee_pct', numeric: true, noTotal: true, group: FIELD_GROUPS.MONEY },
    { key: 'feeWaivedReason', label: 'Fee waived because', type: 'text', expr: 't.fee_waived_reason', group: FIELD_GROUPS.OTHER },
    { key: 'remindedAt', label: 'Last reminded', type: 'datetime', expr: 't.reminded_at', group: FIELD_GROUPS.DATES },
    { key: 'userName', label: 'Taken by', type: 'text', expr: 't.user_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'note', label: 'Note', type: 'text', expr: 't.note', group: FIELD_GROUPS.OTHER },
    { key: 'createdAt', label: 'Started', type: 'datetime', expr: 't.created_at', group: FIELD_GROUPS.DATES },
    ...timeBuckets('created_at', { hours: true }),
  ],
}

const LAYBY_PAYMENT_KINDS = ['deposit', 'instalment', 'refund', 'forfeit']

const LAYBY_PAYMENTS_SOURCE: CatalogSource = {
  key: 'laybyPayments',
  label: 'Layby payments',
  description: 'Every deposit, instalment, refund and forfeit taken against a layby.',
  category: 'Sales',
  permission: 'sales.view',
  shape: 'timeline',
  table: 'layby_payments',
  dateColumn: 'paid_on',
  joins: [
    { name: 'layby', sql: 'INNER JOIN laybys l ON l.id = t.layby_id', always: true },
    { name: 'customer', sql: 'LEFT JOIN {C}customers c ON c.id = l.customer_id', needs: ['layby'] },
  ],
  fields: [
    { key: 'paidOn', label: 'Paid on', type: 'date', expr: 't.paid_on', starter: true, group: FIELD_GROUPS.DATES },
    { key: 'laybyNumber', label: 'Layby number', type: 'text', expr: 'l.document_number', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'customerName', label: 'Customer', type: 'text', expr: 'c.name', needs: ['customer'], group: FIELD_GROUPS.IDENTITY },
    enumField('kind', 'Kind', 't.kind', LAYBY_PAYMENT_KINDS, { starter: true }),
    { key: 'amount', label: 'Amount', type: 'currency', expr: 't.amount', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    { key: 'tenderName', label: 'Paid by', type: 'text', expr: 't.tender_name', group: FIELD_GROUPS.TENDER },
    { key: 'reference', label: 'Reference', type: 'text', expr: 't.reference', group: FIELD_GROUPS.IDENTITY },
    { key: 'userName', label: 'Taken by', type: 'text', expr: 't.user_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'note', label: 'Note', type: 'text', expr: 't.note', group: FIELD_GROUPS.OTHER },
    ...timeBuckets('paid_on'),
  ],
}

/* ── commission ────────────────────────────────────────────────────────────── */

/*
 * What staff have earned, line by line. The RUN is the period and its lock; the
 * ENTRY is the money. Only entries get a source: a run with no entries is an
 * empty page, and every question worth asking ("what did Johan earn in March",
 * "which rule is costing us most") is an entry question grouped differently.
 *
 * Dated by the DOCUMENT's date, not the run's. A run calculated in April for
 * March must report as March, or every commission report lands in the wrong
 * month the moment a run is late.
 */
const COMMISSION_SOURCE: CatalogSource = {
  key: 'commissionEntries',
  label: 'Commission',
  description: 'One row per commissionable line — who earned it, on what rule, and how much.',
  category: 'Money',
  permission: 'commission.edit',
  shape: 'timeline',
  table: 'commission_entries',
  dateColumn: 'document_date',
  joins: [{ name: 'run', sql: 'LEFT JOIN commission_runs cr ON cr.id = t.run_id' }],
  fields: [
    { key: 'documentDate', label: 'Document date', type: 'date', expr: 't.document_date', starter: true, group: FIELD_GROUPS.DATES },
    { key: 'userName', label: 'Earned by', type: 'text', expr: 't.user_name', starter: true, group: FIELD_GROUPS.PEOPLE },
    {
      key: 'amount',
      label: 'Commission',
      type: 'currency',
      expr: 't.amount',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
    },
    { key: 'documentNumber', label: 'Document', type: 'document', expr: 't.document_number', link: { kind: 'sale', idExpr: 't.document_id' }, group: FIELD_GROUPS.IDENTITY },
    { key: 'ruleName', label: 'Rule', type: 'text', expr: 't.rule_name', starter: true, group: FIELD_GROUPS.CLASSIFICATION },
    enumField('basis', 'Calculated on', 't.basis', ['gross_profit', 'turnover'], {
      hint: 'Whether the rule paid on profit or on turnover — two rules on one report are not comparable without this.',
    }),
    {
      key: 'baseAmount',
      label: 'Base amount',
      type: 'currency',
      expr: 't.base_amount',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'The profit or turnover the rate was applied to.',
    },
    {
      key: 'ratePct',
      label: 'Rate %',
      type: 'percent',
      expr: 't.rate_pct',
      numeric: true,
      noTotal: true,
      /* Weighted: a 10% rule on R100 and a 2% rule on R100,000 do not average
         to 6%. Summing commission over base is the rate actually paid. */
      ratio: { numerator: 'amount', denominator: 'baseAmount' },
      group: FIELD_GROUPS.MONEY,
    },
    { key: 'productCode', label: 'Product code', type: 'text', expr: 't.product_code', group: FIELD_GROUPS.PRODUCT },
    { key: 'description', label: 'Description', type: 'text', expr: 't.description', group: FIELD_GROUPS.PRODUCT },
    { key: 'docType', label: 'Document type', type: 'text', expr: 't.doc_type', group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'runPeriodStart', label: 'Run period from', type: 'date', expr: 'cr.period_start', needs: ['run'], group: FIELD_GROUPS.DATES },
    { key: 'runPeriodEnd', label: 'Run period to', type: 'date', expr: 'cr.period_end', needs: ['run'], group: FIELD_GROUPS.DATES },
    {
      key: 'runStatus',
      label: 'Run status',
      type: 'text',
      /* Labelled rather than blank: an entry whose run was deleted is still
         money somebody earned, and an unnamed group reads as a broken report. */
      expr: "COALESCE(cr.status, 'No run')",
      needs: ['run'],
      group: FIELD_GROUPS.CLASSIFICATION,
      options: [
        { value: 'open', label: 'Open' },
        { value: 'locked', label: 'Locked' },
        { value: 'No run', label: 'No run' },
      ],
      hint: 'A locked run is settled. An open one can still change.',
    },
    ...timeBuckets('document_date'),
  ],
}

/* ── stock transfers ───────────────────────────────────────────────────────── */

/*
 * Stock in motion, between locations or between stores. Two sources: the
 * document says what left and whether it arrived; the LINE says what was in it,
 * and that is where "what did we actually receive" lives.
 */
const TRANSFER_STATUSES = ['draft', 'posted', 'in_transit', 'received', 'cancelled']

const STOCK_TRANSFERS_SOURCE: CatalogSource = {
  key: 'stockTransfers',
  label: 'Stock transfers',
  description: 'One row per transfer — what moved, between where, and whether it has landed.',
  category: 'Stock',
  permission: 'stock.view',
  shape: 'timeline',
  table: 'stock_transfers',
  dateColumn: 'document_date',
  joins: [
    { name: 'fromLoc', sql: 'LEFT JOIN stock_locations sfl ON sfl.id = t.from_location_id' },
    { name: 'toLoc', sql: 'LEFT JOIN stock_locations stl ON stl.id = t.to_location_id' },
  ],
  fields: [
    { key: 'documentNumber', label: 'Transfer number', type: 'text', expr: 't.document_number', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'documentDate', label: 'Date', type: 'date', expr: 't.document_date', starter: true, group: FIELD_GROUPS.DATES },
    enumField('status', 'Status', 't.status', TRANSFER_STATUSES, { starter: true }),
    enumField('direction', 'Direction', 't.direction', ['internal', 'out', 'in'], {
      hint: 'Between our own locations, or to and from another store.',
    }),
    { key: 'fromLocation', label: 'From', type: 'text', expr: 'sfl.name', needs: ['fromLoc'], starter: true, group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'toLocation', label: 'To', type: 'text', expr: 'stl.name', needs: ['toLoc'], starter: true, group: FIELD_GROUPS.CLASSIFICATION },
    {
      key: 'peerDocumentNumber',
      label: 'Their transfer number',
      type: 'text',
      expr: 't.peer_document_number',
      group: FIELD_GROUPS.IDENTITY,
      hint: 'What the other store calls the same movement — the number to quote when chasing it.',
    },
    { key: 'postedAt', label: 'Posted at', type: 'datetime', expr: 't.posted_at', group: FIELD_GROUPS.DATES },
    { key: 'peerSiteName', label: 'Other store', type: 'text', expr: 't.peer_site_name', group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'dispatchedAt', label: 'Dispatched at', type: 'datetime', expr: 't.dispatched_at', group: FIELD_GROUPS.DATES },
    { key: 'receivedAt', label: 'Received at', type: 'datetime', expr: 't.received_at', group: FIELD_GROUPS.DATES },
    {
      key: 'daysInTransit',
      label: 'Days in transit',
      type: 'number',
      /* Open-ended on purpose: a transfer that never arrived is the one worth
         finding, so an un-received one measures to TODAY rather than reading
         blank and dropping out of the report. */
      expr:
        '(CASE WHEN t.dispatched_at IS NULL THEN NULL ' +
        'ELSE DATEDIFF(COALESCE(t.received_at, NOW()), t.dispatched_at) END)',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.OTHER,
      hint: 'Still counting on a transfer that has not been received.',
    },
    { key: 'reference', label: 'Reference', type: 'text', expr: 't.reference', group: FIELD_GROUPS.IDENTITY },
    { key: 'note', label: 'Note', type: 'text', expr: 't.note', group: FIELD_GROUPS.OTHER },
    { key: 'cancelReason', label: 'Cancel reason', type: 'text', expr: 't.cancel_reason', group: FIELD_GROUPS.OTHER },
    { key: 'cancelledAt', label: 'Cancelled at', type: 'datetime', expr: 't.cancelled_at', group: FIELD_GROUPS.DATES },
    { key: 'userName', label: 'Raised by', type: 'text', expr: 't.user_name', group: FIELD_GROUPS.PEOPLE },
    ...timeBuckets('document_date'),
  ],
}

const TRANSFER_LINES_SOURCE: CatalogSource = {
  key: 'stockTransferLines',
  label: 'Stock transfer lines',
  description: 'One row per product moved — what was sent, what arrived, and the difference.',
  category: 'Stock',
  permission: 'stock.view',
  shape: 'timeline',
  table: 'stock_transfer_lines',
  dateColumn: 'document_date',
  dateJoin: 'transfer',
  joins: [
    { name: 'transfer', sql: 'INNER JOIN stock_transfers tr ON tr.id = t.transfer_id', always: true },
    PRODUCT_JOIN,
    PRODUCT_DEPT_JOIN,
    PRODUCT_BRAND_JOIN,
    /* PRODUCT_LOOKUP_FIELDS carries reorder-level fields that read this join —
       spreading those fields without it leaves them unresolvable. */
    PRODUCT_LEVELS_JOIN,
  ],
  fields: [
    { key: 'transferNumber', label: 'Transfer number', type: 'text', expr: 'tr.document_number', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'documentDate', label: 'Date', type: 'date', expr: 'tr.document_date', starter: true, group: FIELD_GROUPS.DATES },
    enumField('status', 'Transfer status', 'tr.status', TRANSFER_STATUSES),
    { key: 'productCode', label: 'Product code', type: 'text', expr: 't.product_code', starter: true, group: FIELD_GROUPS.PRODUCT },
    { key: 'description', label: 'Description', type: 'text', expr: 't.description', starter: true, group: FIELD_GROUPS.PRODUCT },
    { key: 'qty', label: 'Qty sent', type: 'number', expr: 't.qty', numeric: true, starter: true, group: FIELD_GROUPS.QUANTITIES },
    { key: 'qtyReceived', label: 'Qty received', type: 'number', expr: 't.qty_received', numeric: true, starter: true, group: FIELD_GROUPS.QUANTITIES },
    {
      key: 'qtyShort',
      label: 'Short',
      type: 'number',
      /* What went missing between the two stores. Clamped: receiving MORE than
         was sent is a counting error at the far end, not a negative shortage,
         and letting it net off would hide a real loss on another line. */
      expr: '(GREATEST(t.qty - t.qty_received, 0))',
      numeric: true,
      group: FIELD_GROUPS.QUANTITIES,
      hint: 'Sent but not received. Only meaningful once the transfer has been received.',
    },
    {
      key: 'valueSent',
      label: 'Value sent',
      type: 'currency',
      expr: '(t.qty * t.unit_cost_excl)',
      numeric: true,
      permission: 'products.cost',
      group: FIELD_GROUPS.COST,
    },
    {
      key: 'valueShort',
      label: 'Value short',
      type: 'currency',
      expr: '(GREATEST(t.qty - t.qty_received, 0) * t.unit_cost_excl)',
      numeric: true,
      permission: 'products.cost',
      group: FIELD_GROUPS.COST,
      hint: 'What the shortfall cost — the number that decides whether it is worth chasing.',
    },
    { key: 'unitCostExcl', label: 'Unit cost', type: 'currency', expr: 't.unit_cost_excl', numeric: true, noTotal: true, permission: 'products.cost', group: FIELD_GROUPS.COST },
    ...PRODUCT_LOOKUP_FIELDS,
    ...timeBuckets('document_date').map((f) => ({
      ...f,
      expr: f.expr.replace(/t\.`document_date`/g, 'tr.`document_date`'),
    })),
  ],
}

/* ── online orders ─────────────────────────────────────────────────────────── */

/*
 * A whole sales channel that had no source. An online order becomes a sales
 * document once accepted, so turnover is already reportable through `sales` —
 * what is NOT is everything the channel knows and the invoice does not: which
 * orders were declined and why, how long they waited, collect versus deliver,
 * and what delivery is costing.
 */
const ONLINE_ORDERS_SOURCE: CatalogSource = {
  key: 'onlineOrders',
  label: 'Online orders',
  description: 'One row per web order — what was asked for, how it was fulfilled, and whether it was accepted.',
  category: 'Sales',
  permission: 'online.view',
  shape: 'timeline',
  table: 'online_orders',
  dateColumn: 'placed_at',
  joins: [
    { name: 'status', sql: 'LEFT JOIN online_order_statuses oos ON oos.id = t.status_id' },
    { name: 'customer', sql: 'LEFT JOIN {C}customers c ON c.id = t.customer_id' },
    { name: 'zone', sql: 'LEFT JOIN online_delivery_zones odz ON odz.id = t.zone_id' },
  ],
  fields: [
    { key: 'orderNumber', label: 'Order number', type: 'text', expr: 't.order_number', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'placedAt', label: 'Placed at', type: 'datetime', expr: 't.placed_at', starter: true, group: FIELD_GROUPS.DATES },
    {
      key: 'statusName',
      label: 'Status',
      type: 'text',
      /* Labelled rather than blank — a status row can be retired while the
         orders that used it remain, and those orders still count. */
      expr: "COALESCE(oos.name, 'Not set')",
      needs: ['status'],
      starter: true,
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    enumField('fulfilment', 'Fulfilment', 't.fulfilment', ['collect', 'deliver'], { starter: true }),
    { key: 'totalIncl', label: 'Total', type: 'currency', expr: 't.total_incl', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    {
      key: 'deliveryFeeIncl',
      label: 'Delivery fee',
      type: 'currency',
      expr: 't.delivery_fee_incl',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'What was charged for delivery — not what it cost to deliver.',
    },
    { key: 'discountIncl', label: 'Discount', type: 'currency', expr: 't.discount_incl', numeric: true, group: FIELD_GROUPS.MONEY },
    { key: 'discountCode', label: 'Discount code', type: 'text', expr: 't.discount_code', group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'voucherCode', label: 'Voucher code', type: 'text', expr: 't.voucher_code', group: FIELD_GROUPS.CLASSIFICATION },
    enumField('paymentStatus', 'Payment', 't.payment_status', ['unpaid', 'pending', 'paid'], { starter: true }),
    yesNo('payOnAccount', 'On account', 't.pay_on_account'),
    { key: 'paidAt', label: 'Paid at', type: 'datetime', expr: 't.paid_at', group: FIELD_GROUPS.DATES },
    { key: 'requestedFor', label: 'Wanted for', type: 'datetime', expr: 't.requested_for', group: FIELD_GROUPS.DATES },
    {
      key: 'declineReason',
      label: 'Declined because',
      type: 'text',
      expr: 't.decline_reason',
      group: FIELD_GROUPS.OTHER,
      hint: 'Why an order was turned away. A pattern here is lost revenue with a cause attached.',
    },
    { key: 'contactName', label: 'Ordered by', type: 'text', expr: 't.contact_name', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'contactPhone', label: 'Phone', type: 'text', expr: 't.contact_phone', group: FIELD_GROUPS.IDENTITY },
    { key: 'contactEmail', label: 'Email', type: 'text', expr: 't.contact_email', group: FIELD_GROUPS.IDENTITY },
    { key: 'customerName', label: 'Account', type: 'text', expr: 'c.name', needs: ['customer'], group: FIELD_GROUPS.IDENTITY },
    { key: 'deliveryLine1', label: 'Delivery address 1', type: 'text', expr: 't.delivery_line1', group: FIELD_GROUPS.IDENTITY },
    { key: 'deliveryLine2', label: 'Delivery address 2', type: 'text', expr: 't.delivery_line2', group: FIELD_GROUPS.IDENTITY },
    { key: 'deliverySuburb', label: 'Suburb', type: 'text', expr: 't.delivery_suburb', group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'deliveryPostcode', label: 'Postal code', type: 'text', expr: 't.delivery_postcode', group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'zoneName', label: 'Delivery zone', type: 'text', expr: 'odz.name', needs: ['zone'], group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'customerNote', label: 'Customer note', type: 'text', expr: 't.customer_note', group: FIELD_GROUPS.OTHER },
    { key: 'internalNote', label: 'Internal note', type: 'text', expr: 't.internal_note', group: FIELD_GROUPS.OTHER },
    { key: 'deliveryNotes', label: 'Delivery instructions', type: 'text', expr: 't.delivery_notes', group: FIELD_GROUPS.OTHER },
    yesNo('isArchived', 'Archived', 't.is_archived'),
    ...timeBuckets('placed_at', { hours: true }),
  ],
}

const ONLINE_ORDER_LINES_SOURCE: CatalogSource = {
  key: 'onlineOrderLines',
  label: 'Online order lines',
  description: 'One row per product ordered online — what the web channel actually sells.',
  category: 'Sales',
  permission: 'online.view',
  shape: 'timeline',
  table: 'online_order_lines',
  dateColumn: 'placed_at',
  dateJoin: 'order',
  joins: [
    { name: 'order', sql: 'INNER JOIN online_orders oo ON oo.id = t.order_id', always: true },
    PRODUCT_JOIN,
    PRODUCT_DEPT_JOIN,
    PRODUCT_BRAND_JOIN,
    PRODUCT_LEVELS_JOIN,
  ],
  fields: [
    { key: 'orderNumber', label: 'Order number', type: 'text', expr: 'oo.order_number', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'placedAt', label: 'Placed at', type: 'datetime', expr: 'oo.placed_at', starter: true, group: FIELD_GROUPS.DATES },
    { key: 'productCode', label: 'Product code', type: 'text', expr: 't.product_code', starter: true, group: FIELD_GROUPS.PRODUCT },
    { key: 'description', label: 'Description', type: 'text', expr: 't.description', starter: true, group: FIELD_GROUPS.PRODUCT },
    { key: 'qty', label: 'Qty', type: 'number', expr: 't.qty', numeric: true, starter: true, group: FIELD_GROUPS.QUANTITIES },
    { key: 'unitPriceIncl', label: 'Unit price', type: 'currency', expr: 't.unit_price_incl', numeric: true, noTotal: true, group: FIELD_GROUPS.MONEY },
    { key: 'lineTotalIncl', label: 'Line total', type: 'currency', expr: 't.line_total_incl', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    { key: 'lineNote', label: 'Line note', type: 'text', expr: 't.line_note', group: FIELD_GROUPS.OTHER },
    enumField('fulfilment', 'Fulfilment', 'oo.fulfilment', ['collect', 'deliver']),
    ...PRODUCT_LOOKUP_FIELDS,
    ...timeBuckets('placed_at', { hours: true }).map((f) => ({
      ...f,
      expr: f.expr.replace(/t\.`placed_at`/g, 'oo.`placed_at`'),
    })),
  ],
}

/* ── specials ──────────────────────────────────────────────────────────────── */

/*
 * "Did the promotion work" — the question a shop asks after every campaign and
 * could not answer. The redemption row is thin by design (056); everything worth
 * grouping by comes off the special it points at.
 */
const SPECIAL_REDEMPTIONS_SOURCE: CatalogSource = {
  key: 'specialRedemptions',
  label: 'Promotion redemptions',
  description: 'Every time a special was taken up — what it was given away on, and what it cost.',
  category: 'Sales',
  permission: 'sales.view',
  shape: 'timeline',
  table: 'special_redemptions',
  dateColumn: 'used_at',
  joins: [
    { name: 'special', sql: 'LEFT JOIN specials sp ON sp.id = t.special_id' },
    { name: 'customer', sql: 'LEFT JOIN {C}customers c ON c.id = t.customer_id' },
  ],
  fields: [
    { key: 'usedAt', label: 'When', type: 'datetime', expr: 't.used_at', starter: true, group: FIELD_GROUPS.DATES },
    {
      key: 'specialName',
      label: 'Promotion',
      type: 'text',
      expr: "COALESCE(sp.name, 'Deleted promotion')",
      needs: ['special'],
      starter: true,
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    {
      key: 'amountIncl',
      label: 'Given away',
      type: 'currency',
      expr: 't.amount_incl',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'What the discount came to — summed, this is what the promotion cost.',
    },
    { key: 'customerName', label: 'Customer', type: 'text', expr: 'c.name', needs: ['customer'], group: FIELD_GROUPS.IDENTITY },
    ...timeBuckets('used_at', { hours: true }),
  ],
}

/* ── loyalty vouchers ──────────────────────────────────────────────────────── */

const LOYALTY_VOUCHERS_SOURCE: CatalogSource = {
  key: 'loyaltyVouchers',
  label: 'Loyalty vouchers',
  description: 'Rewards issued to members — what is still outstanding and what has been spent.',
  category: 'Customers',
  permission: 'loyalty.view',
  shape: 'snapshot',
  table: 'loyalty_vouchers',
  ownedBy: 'loyalty',
  joins: [{ name: 'member', sql: 'LEFT JOIN {L}loyalty_members m ON m.id = t.member_id' }],
  fields: [
    { key: 'code', label: 'Voucher code', type: 'text', expr: 't.code', starter: true, group: FIELD_GROUPS.IDENTITY },
    enumField('status', 'Status', 't.status', ['issued', 'redeemed', 'expired', 'void'], { starter: true }),
    { key: 'memberName', label: 'Member', type: 'text', expr: 'm.name', needs: ['member'], starter: true, group: FIELD_GROUPS.IDENTITY },
    enumField('rewardType', 'Reward', 't.reward_type', ['free_item', 'value'], { starter: true }),
    {
      key: 'rewardValue',
      label: 'Value',
      type: 'currency',
      expr: 't.reward_value',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Zero on a free-item voucher, whose cost is the item rather than an amount.',
    },
    { key: 'description', label: 'Description', type: 'text', expr: 't.description', group: FIELD_GROUPS.IDENTITY },
    enumField('issuedBy', 'Issued by', 't.issued_by', ['card', 'manual', 'birthday', 'tier'], {
      hint: 'Which mechanism produced it — a full card, a birthday, a tier promotion, or somebody deciding.',
    }),
    {
      key: 'rewardProductCode',
      label: 'Free item',
      type: 'text',
      expr: 't.reward_product_code',
      group: FIELD_GROUPS.PRODUCT,
      hint: 'Which product a free-item voucher is good for. Blank on a value voucher.',
    },
    { key: 'expiresOn', label: 'Expires on', type: 'date', expr: 't.expires_on', group: FIELD_GROUPS.DATES },
    { key: 'redeemedAt', label: 'Redeemed at', type: 'datetime', expr: 't.redeemed_at', group: FIELD_GROUPS.DATES },
    { key: 'redeemedDocNumber', label: 'Redeemed on', type: 'document', expr: 't.redeemed_doc_number', group: FIELD_GROUPS.IDENTITY },
    { key: 'issuedAt', label: 'Issued at', type: 'datetime', expr: 't.created_at', group: FIELD_GROUPS.DATES },
    { key: 'userName', label: 'Issued by (person)', type: 'text', expr: 't.user_name', group: FIELD_GROUPS.PEOPLE },
  ],
}

/* ── reservations ──────────────────────────────────────────────────────────── */

/*
 * Bookings, and — the point of reporting on them — the ones that did not turn
 * up. `party_size` is the covers figure BEFORE the table is opened, so a
 * restaurant can compare what it booked against what it seated.
 */
const RESERVATIONS_SOURCE: CatalogSource = {
  key: 'reservations',
  label: 'Reservations',
  description: 'Bookings taken — party size, where they came from, and who never arrived.',
  category: 'Sales',
  permission: 'reservations.view',
  shape: 'timeline',
  table: 'reservations',
  dateColumn: 'reserved_for',
  fields: [
    { key: 'reference', label: 'Reference', type: 'text', expr: 't.reference', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'reservedFor', label: 'Booked for', type: 'datetime', expr: 't.reserved_for', starter: true, group: FIELD_GROUPS.DATES },
    enumField('status', 'Status', 't.status', ['pending', 'confirmed', 'seated', 'completed', 'no_show', 'cancelled'], { starter: true }),
    enumField('source', 'Booked via', 't.source', ['online', 'phone', 'walk_in'], { starter: true }),
    {
      key: 'partySize',
      label: 'Party size',
      type: 'number',
      expr: 't.party_size',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.QUANTITIES,
      hint: 'Covers BOOKED. What was actually seated is the covers figure on the sale.',
    },
    { key: 'contactName', label: 'Name', type: 'text', expr: 't.contact_name', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'contactPhone', label: 'Phone', type: 'text', expr: 't.contact_phone', group: FIELD_GROUPS.IDENTITY },
    { key: 'contactEmail', label: 'Email', type: 'text', expr: 't.contact_email', group: FIELD_GROUPS.IDENTITY },
    { key: 'tableName', label: 'Table', type: 'text', expr: 't.table_name', group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'durationMinutes', label: 'Booked for (minutes)', type: 'number', expr: 't.duration_minutes', numeric: true, noTotal: true, group: FIELD_GROUPS.OTHER },
    { key: 'seatedAt', label: 'Seated at', type: 'datetime', expr: 't.seated_at', group: FIELD_GROUPS.DATES },
    {
      key: 'minutesLate',
      label: 'Minutes late',
      type: 'number',
      /* Signed: arriving EARLY is as much a fact as arriving late, and clamping
         it at zero would make the average meaningless. */
      expr: '(CASE WHEN t.seated_at IS NULL THEN NULL ELSE TIMESTAMPDIFF(MINUTE, t.reserved_for, t.seated_at) END)',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.OTHER,
      hint: 'Negative where the party arrived early. Blank where they were never seated.',
    },
    { key: 'customerNote', label: 'Customer note', type: 'text', expr: 't.customer_note', group: FIELD_GROUPS.OTHER },
    { key: 'cancelReason', label: 'Cancel reason', type: 'text', expr: 't.cancel_reason', group: FIELD_GROUPS.OTHER },
    { key: 'userName', label: 'Taken by', type: 'text', expr: 't.user_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'createdAt', label: 'Booked at', type: 'datetime', expr: 't.created_at', group: FIELD_GROUPS.DATES },
    ...timeBuckets('reserved_for', { hours: true }),
  ],
}

/* ── kitchen ───────────────────────────────────────────────────────────────── */

/*
 * When food was fired, to which printer, and by whom — the restaurant
 * counterpart to covers. The SEND is the docket; the SEND LINE is what was on
 * it. Only the send gets a source: a docket's lines are already reportable
 * through sales lines, and `ordered_at` there answers "when was this fired".
 *
 * The value here is the DOCKET: how many go to each section, at what hour, and
 * how long after the table was opened. That is a staffing question and it had
 * no source at all.
 */
const KITCHEN_SENDS_SOURCE: CatalogSource = {
  key: 'kitchenSends',
  label: 'Kitchen dockets',
  description: 'Every docket fired to a kitchen printer — when, to which section, and from which till.',
  category: 'Operations',
  permission: 'sales.view',
  shape: 'timeline',
  table: 'kitchen_sends',
  dateColumn: 'sent_at',
  joins: [
    { name: 'printer', sql: 'LEFT JOIN kitchen_printers kp ON kp.id = t.printer_id' },
    /* NOT named 'doc'. run.ts treats a join called 'doc' as the parent that
       carries the date range's column (dateColumnExpr), so naming it that made
       every kitchen report filter on 'd.sent_at' — a column sales_documents
       does not have. This source dates from its OWN table; the bill is just a
       lookup. */
    { name: 'sale', sql: 'LEFT JOIN sales_documents d ON d.id = t.document_id' },
    { name: 'terminal', sql: 'LEFT JOIN terminals ktrm ON ktrm.id = t.terminal_id' },
  ],
  fields: [
    { key: 'sentAt', label: 'Fired at', type: 'datetime', expr: 't.sent_at', starter: true, group: FIELD_GROUPS.DATES },
    {
      key: 'printerName',
      label: 'Kitchen section',
      type: 'text',
      /* Labelled rather than blank: a printer can be decommissioned while its
         dockets remain, and those dockets are still work the kitchen did. */
      expr: "COALESCE(kp.name, 'Removed printer')",
      needs: ['printer'],
      starter: true,
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    {
      key: 'documentNumber',
      label: 'Bill',
      type: 'document',
      expr: 'd.document_number',
      link: { kind: 'sale', idExpr: 't.document_id' },
      needs: ['sale'],
      starter: true,
      group: FIELD_GROUPS.IDENTITY,
    },
    { key: 'sentByName', label: 'Fired by', type: 'text', expr: 't.sent_by_name', starter: true, group: FIELD_GROUPS.PEOPLE },
    { key: 'terminalName', label: 'Till', type: 'text', expr: 'ktrm.name', needs: ['terminal'], group: FIELD_GROUPS.PEOPLE },
    {
      key: 'source',
      label: 'Fired from',
      type: 'text',
      expr: 't.source',
      group: FIELD_GROUPS.CLASSIFICATION,
      hint: 'Which action sent the docket — a course being fired, a bill being parked, a re-send.',
    },
    {
      key: 'personCount',
      label: 'Covers on the bill',
      type: 'number',
      expr: 'd.person_count',
      numeric: true,
      needs: ['sale'],
      /* Repeated on every docket for the same bill, so it must NOT be totalled:
         a table of four fired three courses would report twelve covers. */
      noTotal: true,
      group: FIELD_GROUPS.QUANTITIES,
    },
    ...timeBuckets('sent_at', { hours: true }),
  ],
}

/* ── fixed assets ──────────────────────────────────────────────────────────── */

const FIXED_ASSETS_SOURCE: CatalogSource = {
  key: 'fixedAssets',
  label: 'Fixed assets',
  description: 'The asset register — what was bought, what it is worth now, and what has been written off.',
  category: 'Money',
  permission: 'reports.financial',
  /* A SNAPSHOT: "what is on the register" has no date range. Acquisition and
     disposal dates stay filterable as ordinary fields. */
  shape: 'snapshot',
  table: 'fixed_assets',
  joins: [
    { name: 'category', sql: 'LEFT JOIN asset_categories ac ON ac.id = t.category_id' },
    { name: 'supplier', sql: 'LEFT JOIN {S}suppliers s ON s.id = t.supplier_id' },
  ],
  fields: [
    { key: 'assetCode', label: 'Asset code', type: 'text', expr: 't.asset_code', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'name', label: 'Asset', type: 'text', expr: 't.name', starter: true, group: FIELD_GROUPS.IDENTITY },
    enumField('status', 'Status', 't.status', ['pending', 'active', 'disposed'], { starter: true }),
    {
      key: 'categoryName',
      label: 'Category',
      type: 'text',
      expr: "COALESCE(ac.name, 'Uncategorised')",
      needs: ['category'],
      starter: true,
      group: FIELD_GROUPS.CLASSIFICATION,
    },
    { key: 'cost', label: 'Cost', type: 'currency', expr: 't.cost', numeric: true, starter: true, group: FIELD_GROUPS.MONEY },
    {
      key: 'accumulatedDepreciation',
      label: 'Depreciation to date',
      type: 'currency',
      expr: 't.accumulated_depreciation',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'bookValue',
      label: 'Book value',
      type: 'currency',
      /* Derived, because the register stores cost and accumulated depreciation
         separately and the figure everyone actually wants is the difference. */
      expr: '(t.cost - t.accumulated_depreciation)',
      numeric: true,
      starter: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Cost less depreciation to date — what the asset still stands at on the books.',
    },
    { key: 'residualValue', label: 'Residual value', type: 'currency', expr: 't.residual_value', numeric: true, group: FIELD_GROUPS.MONEY },
    { key: 'acquiredOn', label: 'Acquired on', type: 'date', expr: 't.acquired_on', starter: true, group: FIELD_GROUPS.DATES },
    { key: 'lifeMonths', label: 'Life (months)', type: 'number', expr: 't.life_months', numeric: true, noTotal: true, group: FIELD_GROUPS.OTHER },
    { key: 'depreciationStart', label: 'Depreciation from', type: 'date', expr: 't.depreciation_start', group: FIELD_GROUPS.DATES },
    { key: 'lastDepreciatedTo', label: 'Depreciated to', type: 'date', expr: 't.last_depreciated_to', group: FIELD_GROUPS.DATES },
    { key: 'disposedOn', label: 'Disposed on', type: 'date', expr: 't.disposed_on', group: FIELD_GROUPS.DATES },
    { key: 'disposalProceeds', label: 'Disposal proceeds', type: 'currency', expr: 't.disposal_proceeds', numeric: true, group: FIELD_GROUPS.MONEY },
    {
      key: 'disposalResult',
      label: 'Profit / loss on disposal',
      type: 'currency',
      expr: 't.disposal_result',
      numeric: true,
      group: FIELD_GROUPS.MONEY,
      hint: 'Negative where the asset was sold for less than it stood at.',
    },
    { key: 'userName', label: 'Added by', type: 'text', expr: 't.user_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'disposalReason', label: 'Disposal reason', type: 'text', expr: 't.disposal_reason', group: FIELD_GROUPS.OTHER },
    { key: 'serialNumber', label: 'Serial number', type: 'text', expr: 't.serial_number', group: FIELD_GROUPS.IDENTITY },
    { key: 'location', label: 'Location', type: 'text', expr: 't.location', group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'supplierName', label: 'Bought from', type: 'text', expr: 's.name', needs: ['supplier'], group: FIELD_GROUPS.IDENTITY },
    { key: 'invoiceNumber', label: 'Their invoice', type: 'text', expr: 't.invoice_number', group: FIELD_GROUPS.IDENTITY },
    { key: 'description', label: 'Description', type: 'text', expr: 't.description', group: FIELD_GROUPS.OTHER },
    { key: 'notes', label: 'Notes', type: 'text', expr: 't.notes', group: FIELD_GROUPS.OTHER },
  ],
}

/* ── contracts ─────────────────────────────────────────────────────────────── */

/*
 * Recurring billing agreements. Two sources: the AGREEMENT is what is on the
 * books and what it escalates by; the INVOICE RUN is what actually went out and
 * whether the email landed. The second is the one that catches a contract
 * quietly failing to bill.
 */
const CONTRACTS_SOURCE: CatalogSource = {
  key: 'contracts',
  label: 'Contracts',
  description: 'Recurring billing agreements — who is on one, how often they bill, and what they escalate by.',
  category: 'Customers',
  permission: 'contracts.view',
  shape: 'snapshot',
  table: 'contracts',
  joins: [{ name: 'customer', sql: 'LEFT JOIN {C}customers c ON c.id = t.customer_id' }],
  fields: [
    { key: 'contractNumber', label: 'Contract number', type: 'text', expr: 't.contract_number', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'name', label: 'Contract', type: 'text', expr: 't.name', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'customerName', label: 'Customer', type: 'text', expr: 'c.name', needs: ['customer'], starter: true, group: FIELD_GROUPS.IDENTITY },
    enumField('frequency', 'Bills', 't.frequency', ['monthly', 'quarterly', 'annually'], { starter: true }),
    yesNo('isActive', 'Active', 't.is_active'),
    { key: 'startsOn', label: 'Starts on', type: 'date', expr: 't.starts_on', starter: true, group: FIELD_GROUPS.DATES },
    { key: 'endsOn', label: 'Ends on', type: 'date', expr: 't.ends_on', group: FIELD_GROUPS.DATES },
    {
      key: 'lastGeneratedFor',
      label: 'Last billed for',
      type: 'date',
      expr: 't.last_generated_for',
      group: FIELD_GROUPS.DATES,
      hint: 'The period last invoiced. A date well in the past on an active contract is one that has stopped billing.',
    },
    {
      key: 'escalationPct',
      label: 'Escalation %',
      type: 'percent',
      expr: 't.escalation_pct',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.MONEY,
    },
    {
      key: 'billingDay',
      label: 'Bills on day',
      type: 'number',
      expr: 't.billing_day',
      numeric: true,
      /* A day-of-month, not a quantity: summing the 1st and the 15th is not a
         number anybody wants. */
      noTotal: true,
      group: FIELD_GROUPS.ACCOUNT,
    },
    {
      key: 'escalationMonth',
      label: 'Escalates in month',
      type: 'number',
      expr: 't.escalation_month',
      numeric: true,
      noTotal: true,
      group: FIELD_GROUPS.ACCOUNT,
      hint: 'The month number the annual increase falls in. Blank where the contract never escalates.',
    },
    { key: 'lastEscalatedFor', label: 'Last escalated', type: 'date', expr: 't.last_escalated_for', group: FIELD_GROUPS.DATES },
    { key: 'paymentTermsDays', label: 'Payment terms (days)', type: 'number', expr: 't.payment_terms_days', numeric: true, noTotal: true, group: FIELD_GROUPS.ACCOUNT },
    yesNo('autoSend', 'Emails automatically', 't.auto_send'),
    yesNo('offerPaymentLink', 'Offers a payment link', 't.offer_payment_link'),
    { key: 'reference', label: 'Their reference', type: 'text', expr: 't.reference', group: FIELD_GROUPS.IDENTITY },
    { key: 'notes', label: 'Notes', type: 'text', expr: 't.notes', group: FIELD_GROUPS.OTHER },
    { key: 'internalNote', label: 'Internal note', type: 'text', expr: 't.internal_note', group: FIELD_GROUPS.OTHER },
    { key: 'userName', label: 'Set up by', type: 'text', expr: 't.user_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'createdAt', label: 'Created', type: 'datetime', expr: 't.created_at', group: FIELD_GROUPS.DATES },
  ],
}

const CONTRACT_INVOICES_SOURCE: CatalogSource = {
  key: 'contractInvoices',
  label: 'Contract billing runs',
  description: 'Every invoice a contract raised — and every one that failed to raise or failed to send.',
  category: 'Customers',
  permission: 'contracts.view',
  shape: 'timeline',
  table: 'contract_invoices',
  dateColumn: 'for_date',
  joins: [
    { name: 'contract', sql: 'LEFT JOIN contracts ct ON ct.id = t.contract_id' },
    { name: 'customer', sql: 'LEFT JOIN {C}customers c ON c.id = ct.customer_id', needs: ['contract'] },
    /* NOT 'doc' — see the note on the kitchen source. This dates from its own
       for_date; the invoice is a lookup. */
    { name: 'sale', sql: 'LEFT JOIN sales_documents d ON d.id = t.document_id' },
  ],
  fields: [
    { key: 'forDate', label: 'Billing period', type: 'date', expr: 't.for_date', starter: true, group: FIELD_GROUPS.DATES },
    { key: 'contractName', label: 'Contract', type: 'text', expr: 'ct.name', needs: ['contract'], starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'customerName', label: 'Customer', type: 'text', expr: 'c.name', needs: ['customer'], starter: true, group: FIELD_GROUPS.IDENTITY },
    enumField('status', 'Status', 't.status', ['draft', 'posted', 'failed'], { starter: true }),
    enumField('emailStatus', 'Email', 't.email_status', ['pending', 'sent', 'failed', 'skipped'], { starter: true }),
    {
      key: 'documentNumber',
      label: 'Invoice',
      type: 'document',
      expr: 'd.document_number',
      link: { kind: 'sale', idExpr: 't.document_id' },
      needs: ['sale'],
      group: FIELD_GROUPS.IDENTITY,
    },
    { key: 'totalIncl', label: 'Invoiced', type: 'currency', expr: 'd.total_incl', numeric: true, needs: ['sale'], group: FIELD_GROUPS.MONEY },
    { key: 'emailedTo', label: 'Emailed to', type: 'text', expr: 't.emailed_to', group: FIELD_GROUPS.IDENTITY },
    { key: 'emailedAt', label: 'Emailed at', type: 'datetime', expr: 't.emailed_at', group: FIELD_GROUPS.DATES },
    { key: 'emailAttempts', label: 'Email attempts', type: 'number', expr: 't.email_attempts', numeric: true, noTotal: true, group: FIELD_GROUPS.OTHER },
    {
      key: 'error',
      label: 'Error',
      type: 'text',
      expr: 't.error',
      group: FIELD_GROUPS.OTHER,
      hint: 'Why a run failed. The reason a contract silently stopped billing is usually here.',
    },
    ...timeBuckets('for_date'),
  ],
}

export const SOURCES: CatalogSource[] = [
  SALES_SOURCE,
  GIFT_CARDS_SOURCE,
  GIFT_CARD_EVENTS_SOURCE,
  LAYBYS_SOURCE,
  LAYBY_PAYMENTS_SOURCE,
  COMMISSION_SOURCE,
  STOCK_TRANSFERS_SOURCE,
  TRANSFER_LINES_SOURCE,
  ONLINE_ORDERS_SOURCE,
  ONLINE_ORDER_LINES_SOURCE,
  SPECIAL_REDEMPTIONS_SOURCE,
  LOYALTY_VOUCHERS_SOURCE,
  RESERVATIONS_SOURCE,
  KITCHEN_SENDS_SOURCE,
  FIXED_ASSETS_SOURCE,
  CONTRACTS_SOURCE,
  CONTRACT_INVOICES_SOURCE,
  SALE_LINES_SOURCE,
  SALE_MODIFIERS_SOURCE,
  TENDERS_SOURCE,
  PRODUCTS_SOURCE,
  STOCK_MOVEMENTS_SOURCE,
  CUSTOMERS_SOURCE,
  CUSTOMER_TXN_SOURCE,
  SUPPLIERS_SOURCE,
  PURCHASES_SOURCE,
  PURCHASE_LINES_SOURCE,
  EXPENSE_LINES_SOURCE,
  SHIFTS_SOURCE,
  SHIFT_COUNTS_SOURCE,
  SHIFT_MOVEMENTS_SOURCE,
  TIPS_SOURCE,
  POS_VOIDS_SOURCE,
  STOCK_TAKE_LINES_SOURCE,
  ADJUSTMENT_LINES_SOURCE,
  PRODUCT_SUPPLIERS_SOURCE,
  BATCHES_SOURCE,
  SUPPLIER_TXN_SOURCE,
  LOYALTY_LEDGER_SOURCE,
  LOYALTY_MEMBERS_SOURCE,
  JOB_CARDS_SOURCE,
  JOB_LINES_SOURCE,
  JOB_TIME_SOURCE,
  JOB_TRAVEL_SOURCE,
  JOB_VISITS_SOURCE,
  ACTIVITY_SOURCE,
  JOURNAL_LINES_SOURCE,
  GL_ACCOUNTS_SOURCE,
]

const SOURCE_BY_KEY = new Map(SOURCES.map((s) => [s.key, s]))

export function getSource(key: string): CatalogSource | undefined {
  return SOURCE_BY_KEY.get(key)
}

/**
 * A field within a source. Built lazily per source and cached, because
 * validateSpec and the SQL builder both look up every key on every run.
 */
const FIELD_INDEX = new Map<string, Map<string, CatalogField>>()

export function getField(source: CatalogSource, key: string): CatalogField | undefined {
  let index = FIELD_INDEX.get(source.key)
  if (!index) {
    index = new Map(source.fields.map((f) => [f.key, f]))
    FIELD_INDEX.set(source.key, index)
  }
  return index.get(key)
}

/** The sources a given capability set may query at all. */
export function sourcesFor(can: (c: Capability) => boolean): CatalogSource[] {
  return SOURCES.filter((s) => can(s.permission))
}

/** The fields of a source a given capability set may see. */
export function fieldsFor(source: CatalogSource, can: (c: Capability) => boolean): CatalogField[] {
  return source.fields.filter((f) => !f.permission || can(f.permission))
}

/** Whether a field is visible to a capability set. */
export function canSeeField(field: CatalogField, can: (c: Capability) => boolean): boolean {
  return !field.permission || can(field.permission)
}
