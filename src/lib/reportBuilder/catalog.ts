import type { ColumnType } from './spec'
import type { Capability } from '../site/permissions'

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
}

export type SourceShape = 'snapshot' | 'timeline'

/** A named, optional JOIN. Only added when something asks for it. */
export interface JoinUnit {
  /** The name fields reference in `needs`. */
  name: string
  sql: string
}

/** A pre-filled filter a source starts with (removable by the user). */
export interface DefaultFilter {
  field: string
  op: 'eq' | 'ne'
  value: string
}

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
  /** TIMELINE only: the column the date range filters on. */
  dateColumn?: string
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

const SALE_DOC_TYPES = ['quote', 'sales_order', 'invoice', 'credit_note']
const SALE_STATUSES = ['draft', 'parked', 'issued', 'finalised', 'void', 'cancelled']

const CUSTOMER_JOIN: JoinUnit = {
  name: 'customer',
  sql: 'LEFT JOIN customers c ON c.id = t.customer_id',
}
const CUSTOMER_GROUP_JOIN: JoinUnit = {
  name: 'customerGroup',
  sql: 'LEFT JOIN customer_groups cg ON cg.id = c.group_id',
}
const CUSTOMER_REP_JOIN: JoinUnit = {
  name: 'customerRep',
  sql: 'LEFT JOIN sales_reps cr ON cr.id = c.rep_id',
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
    expr: 'cr.name',
    needs: ['customer', 'customerRep'],
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
  joins: [CUSTOMER_JOIN, CUSTOMER_GROUP_JOIN, CUSTOMER_REP_JOIN],
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
      // 029 renamed the column to cancel_reason and 022 the status value to
      // cancelled. The field KEY is left alone: it is stored in saved reports
      // and schedules, and renaming it would break them for a label change.
      label: 'Cancel reason',
      type: 'text',
      expr: 't.cancel_reason',
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
    { name: 'customer', sql: 'LEFT JOIN customers c ON c.id = d.customer_id' },
    CUSTOMER_GROUP_JOIN,
    CUSTOMER_REP_JOIN,
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
  joins: [
    { name: 'group', sql: 'LEFT JOIN customer_groups g ON g.id = t.group_id' },
    { name: 'rep', sql: 'LEFT JOIN sales_reps r ON r.id = t.rep_id' },
  ],
  note: 'A snapshot of today. Balances are the current figure, not the balance on any past date.',
  fields: [
    { key: 'code', label: 'Account code', type: 'text', expr: 't.code', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'name', label: 'Name', type: 'text', expr: 't.name', starter: true, group: FIELD_GROUPS.IDENTITY },
    enumField('status', 'Status', 't.status', ['active', 'on_hold', 'inactive', 'closed'], { starter: true }),
    { key: 'group', label: 'Customer group', type: 'text', expr: 'g.name', needs: ['group'], group: FIELD_GROUPS.CLASSIFICATION },
    { key: 'rep', label: 'Sales rep', type: 'text', expr: 'r.name', needs: ['rep'], group: FIELD_GROUPS.PEOPLE },
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
    yesNo('isCashOnly', 'Cash only', 't.is_cash_only'),
    { key: 'loyaltyNumber', label: 'Loyalty number', type: 'text', expr: 't.loyalty_number', group: FIELD_GROUPS.OTHER },
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
  dateColumn: 'doc_date',
  joins: [
    { name: 'customer', sql: 'LEFT JOIN customers c ON c.id = t.customer_id' },
    CUSTOMER_GROUP_JOIN,
    CUSTOMER_REP_JOIN,
  ],
  fields: [
    { key: 'docNumber', label: 'Document number', type: 'document', expr: 't.doc_number', starter: true, group: FIELD_GROUPS.IDENTITY },
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
    { key: 'accountRep', label: 'Sales rep', type: 'text', expr: 'cr.name', needs: ['customer', 'customerRep'], group: FIELD_GROUPS.PEOPLE },
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
    { key: 'createdAt', label: 'Added', type: 'datetime', expr: 't.created_at', group: FIELD_GROUPS.DATES },
  ],
}

const PURCHASE_DOC_TYPES = ['purchase_order', 'grv', 'supplier_return']
const PURCHASE_STATUSES = ['draft', 'issued', 'finalised', 'void', 'cancelled']

const PURCHASES_SOURCE: CatalogSource = {
  key: 'purchases',
  label: 'Purchase documents',
  description: 'One row per order, GRV or return — what was bought and from whom.',
  category: 'Suppliers',
  permission: 'purchasing.view',
  shape: 'timeline',
  table: 'purchase_documents',
  dateColumn: 'document_date',
  joins: [{ name: 'supplier', sql: 'LEFT JOIN suppliers s ON s.id = t.supplier_id' }],
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
    enumField('status', 'Status', 'e.status', ['draft', 'finalised', 'void']),
    enumField('paymentType', 'Payment type', 'e.payment_type', ['on_account', 'direct']),
    { key: 'supplierInvoiceNo', label: 'Supplier invoice no.', type: 'text', expr: 'e.supplier_invoice_no', group: FIELD_GROUPS.IDENTITY },
    { key: 'reference', label: 'Reference', type: 'text', expr: 'e.reference', group: FIELD_GROUPS.OTHER },
    { key: 'userName', label: 'Captured by', type: 'text', expr: 'e.user_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'dueDate', label: 'Due date', type: 'date', expr: 'e.due_date', group: FIELD_GROUPS.DATES },
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
    { key: 'terminalCode', label: 'Till', type: 'text', expr: 't.terminal_code', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'userName', label: 'Opened by', type: 'text', expr: 't.user_name', starter: true, group: FIELD_GROUPS.PEOPLE },
    { key: 'closedByName', label: 'Closed by', type: 'text', expr: 't.closed_by_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'openedAt', label: 'Opened at', type: 'datetime', expr: 't.opened_at', starter: true, group: FIELD_GROUPS.DATES },
    { key: 'closedAt', label: 'Closed at', type: 'datetime', expr: 't.closed_at', group: FIELD_GROUPS.DATES },
    { key: 'openingFloat', label: 'Opening float', type: 'currency', expr: 't.opening_float', numeric: true, group: FIELD_GROUPS.MONEY },
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
    ...timeBuckets('opened_at', { hours: true }),
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
    // be answered. Also not optional: it is the most obvious grouping.
    { name: 'line', sql: 'INNER JOIN sales_document_lines sl ON sl.id = t.line_id' },
    { name: 'product', sql: 'LEFT JOIN products pm ON pm.id = sl.product_id' },
    PRODUCT_DEPT_JOIN,
    { name: 'customer', sql: 'LEFT JOIN customers c ON c.id = d.customer_id' },
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

/* ── the catalog ───────────────────────────────────────────────────────────── */

export const SOURCES: CatalogSource[] = [
  SALES_SOURCE,
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
  ACTIVITY_SOURCE,
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
