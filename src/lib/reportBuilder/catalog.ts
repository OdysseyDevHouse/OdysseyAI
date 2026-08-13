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
  joins: [
    CUSTOMER_JOIN,
    CUSTOMER_GROUP_JOIN,
    CUSTOMER_REP_JOIN,
    VOID_REASON_JOIN,
    RETURN_REASON_JOIN,
    REVERSES_JOIN,
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
      needs: ['reverses'],
      group: FIELD_GROUPS.IDENTITY,
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
    /* Off the PARENT document, which on this source is `d` rather than `t` — so
       it cannot reuse RETURN_REASON_JOIN. A credit note line has no reason of
       its own; the whole document has one. */
    { name: 'returnReason', sql: 'LEFT JOIN sales_return_reasons rr ON rr.id = d.return_reason_id' },
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
    enumField('accountType', 'Account type', 't.account_type', [
      'open_item',
      'balance_fwd',
      'cash',
      'lay_by',
    ]),
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
      hint: 'Negative is short.',
    },
    { key: 'terminalCode', label: 'Till', type: 'text', expr: 'sh.terminal_code', starter: true, group: FIELD_GROUPS.PEOPLE },
    { key: 'userName', label: 'Opened by', type: 'text', expr: 'sh.user_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'closedByName', label: 'Closed by', type: 'text', expr: 'sh.closed_by_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'openedAt', label: 'Opened at', type: 'datetime', expr: 'sh.opened_at', group: FIELD_GROUPS.DATES },
    { key: 'closedAt', label: 'Closed at', type: 'datetime', expr: 'sh.closed_at', group: FIELD_GROUPS.DATES },
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
    { key: 'documentNumber', label: 'Document', type: 'document', expr: 'd.document_number', needs: ['doc'], group: FIELD_GROUPS.IDENTITY },
    { key: 'documentTotal', label: 'Sale total (incl.)', type: 'currency', expr: 'd.total_incl', numeric: true, noTotal: true, needs: ['doc'], group: FIELD_GROUPS.MONEY },
    /* Reassignment is an audit trail: a tip put on the wrong name and moved
       leaves both names and a reason, which is the whole point of recording it
       rather than editing the row. */
    { key: 'reassignedByName', label: 'Reassigned by', type: 'text', expr: 't.reassigned_by_name', group: FIELD_GROUPS.PEOPLE },
    { key: 'reassignedAt', label: 'Reassigned at', type: 'datetime', expr: 't.reassigned_at', group: FIELD_GROUPS.DATES },
    { key: 'reassignReason', label: 'Reassign reason', type: 'text', expr: 't.reassign_reason', group: FIELD_GROUPS.OTHER },
    ...timeBuckets('created_at', { hours: true }),
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
    enumField('status', 'Status', 'st.status', ['draft', 'counting', 'posted', 'cancelled']),
    enumField('scope', 'Scope', 'st.scope', ['full', 'department', 'brand', 'supplier', 'manual']),
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
    { name: 'supplier', sql: 'INNER JOIN suppliers s ON s.id = t.supplier_id', always: true },
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
   * CUSTOMER_REP_JOIN is here because CUSTOMER_LOOKUP_FIELDS includes accountRep,
   * whose `needs` names it. A spread field set brings its join requirements with
   * it, and omitting one fails only when somebody picks that single column —
   * which no template does, so it would have shipped broken.
   */
  joins: [
    JOB_STATUS_JOIN,
    JOB_SLA_JOIN,
    JOB_ADDRESS_JOIN,
    CUSTOMER_JOIN,
    CUSTOMER_GROUP_JOIN,
    CUSTOMER_REP_JOIN,
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
    enumField('lineKind', 'Kind', 't.line_kind', ['part', 'labour', 'travel', 'charge'], {
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
      group: FIELD_GROUPS.MONEY,
      hint: 'What was meant to be charged. The invoice is what the customer actually owes.',
    },
    {
      key: 'unitPriceIncl',
      label: 'Unit price (incl.)',
      type: 'currency',
      expr: 't.unit_price_incl',
      numeric: true,
      noTotal: true,
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
      permission: 'jobs.cost',
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
  dateColumn: 'doc_date',
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
    { key: 'supplierBalance', label: 'Account balance now', type: 'currency', expr: 's.balance', numeric: true, noTotal: true, needs: ['supplier'], group: FIELD_GROUPS.AGEING },
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
  dateColumn: 'created_at',
  joins: [{ name: 'customer', sql: 'LEFT JOIN customers c ON c.id = t.customer_id' }],
  fields: [
    { key: 'happenedAt', label: 'When', type: 'datetime', expr: 't.created_at', starter: true, group: FIELD_GROUPS.DATES },
    { key: 'customerName', label: 'Customer', type: 'text', expr: 'c.name', needs: ['customer'], starter: true, group: FIELD_GROUPS.IDENTITY },
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
  joins: [
    { name: 'customer', sql: 'INNER JOIN customers c ON c.id = t.customer_id', always: true },
    { name: 'tier', sql: 'LEFT JOIN loyalty_tiers lt ON lt.id = t.tier_id' },
  ],
  fields: [
    { key: 'customerName', label: 'Customer', type: 'text', expr: 'c.name', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'customerCode', label: 'Account code', type: 'text', expr: 'c.code', starter: true, group: FIELD_GROUPS.IDENTITY },
    { key: 'phone', label: 'Phone', type: 'text', expr: 'c.phone', group: FIELD_GROUPS.IDENTITY },
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
    yesNo('isActive', 'Active', 't.is_active'),
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
  SHIFT_COUNTS_SOURCE,
  SHIFT_MOVEMENTS_SOURCE,
  TIPS_SOURCE,
  STOCK_TAKE_LINES_SOURCE,
  ADJUSTMENT_LINES_SOURCE,
  PRODUCT_SUPPLIERS_SOURCE,
  SUPPLIER_TXN_SOURCE,
  LOYALTY_LEDGER_SOURCE,
  LOYALTY_MEMBERS_SOURCE,
  JOB_CARDS_SOURCE,
  JOB_LINES_SOURCE,
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
