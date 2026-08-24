import {
  getField,
  getSource,
  type CatalogField,
  type CatalogSource,
  type DocumentLinkKind,
} from './catalog'

/**
 * The SPEC — what a report someone builds actually IS, and the rules for
 * turning one into columns.
 *
 * A spec is plain JSON: a source key, field keys, filter values, and how to
 * summarise. It is what the browser sends, what gets saved, what a schedule
 * points at, and the only input the SQL builder accepts. It deliberately cannot
 * express a table name, a column name, or an operator that is not in the
 * catalog / the enums below — see the header of ./catalog.ts for why that
 * boundary is the whole security model of this feature.
 *
 * This module is CLIENT-SAFE: pure data and pure functions, no database
 * imports. The builder UI runs the very same validation and column derivation
 * the server runs, so the live preview cannot disagree with the real report.
 */

/* ── periods ───────────────────────────────────────────────────────────────── */

/**
 * A saved report has to mean "last month" rather than a pair of dates frozen on
 * the day it was built, so the PERIOD is part of the spec and resolved at run
 * time. `custom` is the escape hatch and the only variant carrying dates.
 */
export type PeriodKey =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'thisWeek'
  | 'lastWeek'
  | 'thisMonth'
  | 'lastMonth'
  | 'last30'
  | 'last90'
  | 'thisYear'
  | 'lastYear'
  /**
   * This year and the four before it.
   *
   * The only period spanning more than one year, and it exists because a
   * year-by-year report has nothing to say inside one: grouping by year over
   * "this year" is a single row. Bounded at five rather than unbounded, because
   * "everything on file" over a shop trading since 2009 is a table scan to
   * render a chart nobody reads past the recent end of.
   */
  | 'last5Years'
  | 'custom'

export interface SpecPeriod {
  key: PeriodKey
  /** `custom` only: yyyy-mm-dd bounds. */
  from?: string
  to?: string
}

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Last 7 days',
  thisWeek: 'This week',
  lastWeek: 'Last week',
  thisMonth: 'This month',
  lastMonth: 'Last month',
  last30: 'Last 30 days',
  last90: 'Last 90 days',
  thisYear: 'This year',
  lastYear: 'Last year',
  last5Years: 'Last 5 years',
  custom: 'Specific dates',
}

/** Display order in the period selector. */
export const PERIOD_KEYS: PeriodKey[] = [
  'today',
  'yesterday',
  'last7',
  'thisWeek',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'last30',
  'last90',
  'thisYear',
  'lastYear',
  'last5Years',
  'custom',
]

/** Local-calendar yyyy-mm-dd, matching how the date pickers write their dates. */
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

function shiftDays(d: Date, days: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + days)
  return out
}

/** Monday of the week `d` falls in — the trading week starts Monday. */
function startOfWeek(d: Date): Date {
  const out = new Date(d)
  const dow = (out.getDay() + 6) % 7 // Mon = 0
  return shiftDays(out, -dow)
}

/**
 * Resolve a spec's period to concrete dates. `now` is injectable so the same
 * function is testable, and so a scheduled send can resolve against the store's
 * wall clock rather than the server's.
 */
export function resolvePeriod(
  period: SpecPeriod | undefined,
  now: Date = new Date(),
): { from: string; to: string } {
  const key = period?.key ?? 'thisMonth'
  const today = iso(now)
  switch (key) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday': {
      const y = iso(shiftDays(now, -1))
      return { from: y, to: y }
    }
    case 'last7':
      return { from: iso(shiftDays(now, -6)), to: today }
    case 'last30':
      return { from: iso(shiftDays(now, -29)), to: today }
    case 'last90':
      return { from: iso(shiftDays(now, -89)), to: today }
    case 'thisWeek':
      return { from: iso(startOfWeek(now)), to: today }
    case 'lastWeek': {
      const thisMonday = startOfWeek(now)
      const lastSunday = shiftDays(thisMonday, -1)
      return { from: iso(shiftDays(lastSunday, -6)), to: iso(lastSunday) }
    }
    case 'thisMonth':
      return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: today }
    case 'lastMonth': {
      const firstThis = new Date(now.getFullYear(), now.getMonth(), 1)
      const lastEnd = shiftDays(firstThis, -1)
      return {
        from: iso(new Date(lastEnd.getFullYear(), lastEnd.getMonth(), 1)),
        to: iso(lastEnd),
      }
    }
    case 'thisYear':
      return { from: iso(new Date(now.getFullYear(), 0, 1)), to: today }
    case 'lastYear': {
      const y = now.getFullYear() - 1
      return { from: iso(new Date(y, 0, 1)), to: iso(new Date(y, 11, 31)) }
    }
    /* Runs to TODAY, not to the end of the current year: every other period
       stops at today, and a range ending in the future would make the report
       claim a span it has no data for. */
    case 'last5Years':
      return { from: iso(new Date(now.getFullYear() - 4, 0, 1)), to: today }
    case 'custom':
      return {
        from: validIso(period?.from) ?? iso(new Date(now.getFullYear(), now.getMonth(), 1)),
        to: validIso(period?.to) ?? today,
      }
  }
}

function validIso(s: string | undefined): string | null {
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

/**
 * The named period a pair of dates corresponds to, or null when they match
 * nothing named.
 *
 * This is what stops an AI-generated report freezing. Claude has no clock, so
 * it resolves "last month" to explicit dates; storing those would mean the
 * report still covers July when it is re-run in December. Matching them back to
 * a key here restores the intent. Only genuinely arbitrary dates stay literal.
 */
export function inferPeriodKey(
  from: string,
  to: string,
  now: Date = new Date(),
): PeriodKey | null {
  for (const key of PERIOD_KEYS) {
    if (key === 'custom') continue
    const r = resolvePeriod({ key }, now)
    if (r.from === from && r.to === to) return key
  }
  return null
}

/* ── aggregation ───────────────────────────────────────────────────────────── */

/** How a column is aggregated when the report is summarised. */
export type AggFn = 'sum' | 'avg' | 'min' | 'max' | 'count'

export const AGG_FNS: AggFn[] = ['sum', 'avg', 'min', 'max', 'count']

/** Label prefix for an aggregated column's header. */
export const AGG_LABELS: Record<AggFn, string> = {
  sum: 'Total',
  avg: 'Average',
  min: 'Lowest',
  max: 'Highest',
  count: 'Count of',
}

/**
 * The synthetic "how many rows" column. Not a catalog field — it compiles to
 * COUNT(*), which is what someone means by "number of invoices per cashier".
 */
export const ROW_COUNT_FIELD = '__rows'

/**
 * Prefix for the sidecar key carrying a linkable document's record id.
 *
 * A row that has a clickable document number gains `__link_<fieldKey>` holding
 * the id to open. It is deliberately NOT a column: it never appears in
 * `specColumns`, so the grid, the footer totals, the CSV export and the column
 * picker never see it — only the cell renderer, which knows to look.
 *
 * Underscored like ROW_COUNT_FIELD and for the same reason: catalog keys are
 * plain identifiers, so this cannot collide with one.
 */
export const LINK_KEY_PREFIX = '__link_'

/** The sidecar key a linkable field's id travels under. */
export function linkKeyFor(fieldKey: string): string {
  return `${LINK_KEY_PREFIX}${fieldKey}`
}

/** One chosen column: a catalog field key, optionally aggregated. */
export interface SpecColumn {
  field: string
  /** Only meaningful when the report is summarised (groupFields is non-empty). */
  agg?: AggFn
  /**
   * Present when this is a CALCULATED column. `field` is then a synthetic
   * `calcN` key — unique within the spec, never a catalog key — which doubles
   * as the output key and the SQL alias.
   */
  calc?: SpecCalc
}

/* ── calculated columns ────────────────────────────────────────────────────── */

export type CalcOp = 'add' | 'sub' | 'mul' | 'div'

/** Picker order: the common cases (× ÷) first. */
export const CALC_OPS: CalcOp[] = ['mul', 'div', 'add', 'sub']

export const CALC_OP_SYMBOLS: Record<CalcOp, string> = {
  add: '+',
  sub: '−',
  mul: '×',
  div: '÷',
}

export type CalcFormat = 'currency' | 'number' | 'percent'

export const CALC_FORMATS: CalcFormat[] = ['currency', 'number', 'percent']

export const CALC_FORMAT_LABELS: Record<CalcFormat, string> = {
  currency: 'Money',
  number: 'Number',
  percent: 'Percentage',
}

/**
 * A column computed from two operands: A (+ − × ÷) B, where B may be a typed-in
 * constant. Deliberately NOT a formula language — the operands are catalog field
 * keys and the operator is an enum, so the SQL is still composed entirely from
 * developer-authored expressions and the catalog boundary is untouched.
 *
 * The arithmetic happens in the right place for each operator:
 *   · + − × (and ÷ by a constant) are ROW-LEVEL — "price × quantity" must be
 *     computed per line and then summed, because SUM(A) × SUM(B) is nonsense;
 *   · ÷ between two FIELDS is a RATIO OF TOTALS when summarised — "average
 *     basket" is total sales over total baskets, never the mean of per-row
 *     ratios.
 */
export interface SpecCalc {
  /** User-given column name, e.g. "Line total" or "Sales per basket". */
  label: string
  /** Catalog key of the left operand (a numeric field of the source). */
  left: string
  op: CalcOp
  /** Catalog key of the right operand, or a constant applied to every row. */
  right: string | number
  /**
   * Grid formatting. `percent` on a ÷ also scales the result ×100; on other
   * operators it only formats the number.
   */
  format: CalcFormat
}

/** Calc keys double as SQL aliases, so their shape is enforced, not trusted. */
const CALC_KEY_PATTERN = /^calc\d+$/

/** The next free `calcN` key for a new calculated column. */
export function nextCalcKey(columns: SpecColumn[]): string {
  let n = 1
  for (const c of columns) {
    const m = /^calc(\d+)$/.exec(c.field)
    if (m) n = Math.max(n, Number(m[1]) + 1)
  }
  return `calc${n}`
}

/** Whether a field can be a calc operand — the genuinely numeric ones. */
export function isCalcOperand(f: CatalogField): boolean {
  return f.numeric === true && f.type !== 'date' && f.type !== 'datetime'
}

/** The fields of a source a calculation may use. */
export function calcOperands(source: CatalogSource): CatalogField[] {
  return source.fields.filter(isCalcOperand)
}

export interface ResolvedCalc {
  left: CatalogField
  right: CatalogField | number
}

/**
 * Resolve (and thereby validate) a calc's operands. Null when an operand is not
 * a numeric catalog field, the constant is not finite, or the calc divides by a
 * constant zero — the column is dropped rather than trusted.
 */
export function resolveCalc(source: CatalogSource, calc: SpecCalc): ResolvedCalc | null {
  const left = getField(source, calc.left)
  if (!left || !isCalcOperand(left)) return null
  if (typeof calc.right === 'number') {
    if (!Number.isFinite(calc.right)) return null
    if (calc.op === 'div' && calc.right === 0) return null
    return { left, right: calc.right }
  }
  const right = getField(source, calc.right)
  if (!right || !isCalcOperand(right)) return null
  return { left, right }
}

/**
 * A ÷ between two FIELDS — the case that is a ratio of totals when summarised,
 * and whose grid totals are re-derived from the summed operands rather than
 * added up (the same rule weighted percentages follow).
 */
export function isRatioCalc(calc: SpecCalc): boolean {
  return calc.op === 'div' && typeof calc.right === 'string'
}

/**
 * The aggregates offered for a calculated column. A ratio has none — it is
 * always total-over-total, which is the only truthful way to summarise it.
 */
export function calcAggs(calc: SpecCalc): AggFn[] {
  return isRatioCalc(calc) ? [] : ['sum', 'avg', 'min', 'max']
}

/** "Selling price × Quantity" — for the tooltip and the editor. */
export function calcFormula(source: CatalogSource, calc: SpecCalc): string {
  const left = getField(source, calc.left)?.label ?? calc.left
  const right =
    typeof calc.right === 'number'
      ? String(calc.right)
      : (getField(source, calc.right)?.label ?? calc.right)
  return `${left} ${CALC_OP_SYMBOLS[calc.op]} ${right}`
}

/* ── filters ───────────────────────────────────────────────────────────────── */

export type FilterOp =
  | 'eq'
  | 'ne'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'isEmpty'
  | 'notEmpty'

export const FILTER_OPS: FilterOp[] = [
  'eq',
  'ne',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'in',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'isEmpty',
  'notEmpty',
]

export const FILTER_OP_LABELS: Record<FilterOp, string> = {
  eq: 'is',
  ne: 'is not',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  endsWith: 'ends with',
  in: 'is any of',
  gt: 'is greater than',
  gte: 'is greater than or equal to',
  lt: 'is less than',
  lte: 'is less than or equal to',
  between: 'is between',
  isEmpty: 'is empty',
  notEmpty: 'is not empty',
}

/** Ops that need no value at all. */
const VALUELESS_OPS: FilterOp[] = ['isEmpty', 'notEmpty']

const TEXT_OPS: FilterOp[] = [
  'eq',
  'ne',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'in',
  'isEmpty',
  'notEmpty',
]

/** Also the ops a TOTAL can be filtered on. */
const NUMBER_OPS: FilterOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between']

const DATE_OPS: FilterOp[] = ['gte', 'lte', 'between', 'isEmpty', 'notEmpty']

export const TOTAL_FILTER_OPS: FilterOp[] = NUMBER_OPS

/** The comparisons that make sense for a given field. */
export function opsForField(field: CatalogField): FilterOp[] {
  if (field.type === 'date' || field.type === 'datetime') return DATE_OPS
  if (field.options && field.options.length > 0) return ['eq', 'ne', 'in', 'isEmpty', 'notEmpty']
  if (field.numeric) return NUMBER_OPS
  return TEXT_OPS
}

/** Whether an op needs a value typed in (and how many). */
export function valueCount(op: FilterOp): 0 | 1 | 2 {
  if (VALUELESS_OPS.includes(op)) return 0
  return op === 'between' ? 2 : 1
}

/** One filter row. `value`/`value2` are the ONLY user text that reaches SQL. */
export interface SpecFilter {
  field: string
  op: FilterOp
  value?: string
  value2?: string
}

/**
 * A filter on a TOTAL — "departments that took more than R10,000", "products
 * that sold nothing". It names an OUTPUT column (see outputKey), not a source
 * field, and is applied after aggregation in TypeScript rather than as a SQL
 * HAVING, so it always sees the finished figure including derived columns a
 * HAVING could not reference.
 */
export interface SpecTotalFilter {
  key: string
  op: FilterOp
  value: string
  value2?: string
}

/* ── the spec ──────────────────────────────────────────────────────────────── */

/** A report someone has composed. `version` guards future format changes. */
export interface CustomReportSpec {
  version: 1
  /** Report name — the page title and the export filename. */
  name: string
  /** Catalog source key. */
  source: string
  /** The period this report means, resolved fresh on every run. */
  period: SpecPeriod
  columns: SpecColumn[]
  filters: SpecFilter[]
  /**
   * When non-empty the report is SUMMARISED: these fields become the SQL GROUP
   * BY and every other column is aggregated. Empty = one row per record.
   */
  groupFields: string[]
  /** Filters applied to the summarised figures. */
  totalFilters: SpecTotalFilter[]
  /**
   * Keep only the best N rows within each value of the FIRST grouping — "top 10
   * products per department". Needs at least two groupings and a sort column.
   */
  topPerGroup?: number
  /** Output column key to sort by, plus direction. */
  sort?: { key: string; dir: 'asc' | 'desc' }
  /** How the chart view draws a summarised report. Defaults to bars. */
  chartType?: ChartType
  /** Row cap. Clamped to MAX_ROWS. */
  limit: number
}

export type ChartType = 'bar' | 'line' | 'pie'

export const CHART_TYPES: ChartType[] = ['bar', 'line', 'pie']

/* ── limits ────────────────────────────────────────────────────────────────── */

export const MAX_ROWS = 20000
export const DEFAULT_ROWS = 5000
export const MAX_COLUMNS = 40
export const MAX_FILTERS = 20
export const MAX_TOTAL_FILTERS = 10
export const MAX_GROUP_FIELDS = 4
/** Rows the live preview fetches while you are still building. */
export const PREVIEW_ROWS = 25

/* ── starter spec ──────────────────────────────────────────────────────────── */

/** A new report on a source: its starter fields and its default filters. */
export function emptySpec(sourceKey: string): CustomReportSpec {
  const source = getSource(sourceKey)
  const starters = source?.fields.filter((f) => f.starter) ?? []
  return {
    version: 1,
    name: source ? `New ${source.label.toLowerCase()} report` : 'New report',
    source: sourceKey,
    period: { key: 'thisMonth' },
    columns: starters.map((f) => ({ field: f.key })),
    filters:
      source?.defaultFilters?.map((d) => ({
        field: d.field,
        op: d.op,
        value: d.value,
      })) ?? [],
    groupFields: [],
    totalFilters: [],
    limit: DEFAULT_ROWS,
  }
}

/* ── output columns ────────────────────────────────────────────────────────── */

/** The default aggregate for a field when the report is first summarised. */
export function defaultAgg(field: CatalogField): AggFn {
  if (!field.numeric) return 'count'
  // Adding rates together is meaningless — two lines at 30% GP are not 60%.
  return field.type === 'percent' ? 'avg' : 'sum'
}

/** Which aggregates make sense for a field. */
export function aggsForField(field: CatalogField): AggFn[] {
  if (field.numeric) return ['sum', 'avg', 'min', 'max', 'count']
  if (field.type === 'date' || field.type === 'datetime') return ['min', 'max', 'count']
  return ['count']
}

/**
 * Whether summarising this field produces a properly WEIGHTED percentage rather
 * than a mean of the row-level percentages. True when the catalog declared which
 * two amounts the rate is really a ratio of — then the two amounts are summed
 * and divided, so a R5,000 line counts five hundred times more than a R10 one.
 *
 * Without this, "average margin %" on a mixed basket is simply wrong, and wrong
 * in a direction nobody notices: small cheap lines with fat percentages drag the
 * figure up.
 */
export function isWeightedPercent(field: CatalogField, agg: AggFn): boolean {
  return field.type === 'percent' && !!field.ratio && agg === 'avg'
}

/** Row fields holding a weighted percentage's merged numerator/denominator. */
export function ratioKeys(outKey: string): { num: string; den: string } {
  return { num: `${outKey}__num`, den: `${outKey}__den` }
}

/**
 * The key a column appears under in the result rows. Group fields and detail
 * columns keep their field key; an aggregate gets a suffix so the same field can
 * appear twice (total AND average sales value).
 */
export function outputKey(col: SpecColumn, summarised: boolean): string {
  if (col.field === ROW_COUNT_FIELD) return 'rowCount'
  if (!summarised || !col.agg) return col.field
  return `${col.field}_${col.agg}`
}

/** Is this spec a summary (SQL GROUP BY) rather than one row per record? */
export function isSummarised(spec: CustomReportSpec): boolean {
  return spec.groupFields.length > 0
}

/** How a report column is rendered and totalled in the grid. */
export interface ReportColumn {
  key: string
  label: string
  type: ColumnType
  numeric: boolean
  /** Show a column total in the footer. */
  total: boolean
  /** Re-derive the footer figure from summed parts instead of adding the column. */
  ratio?: { num: string; den: string; scale: number }
  hint?: string
  /**
   * What this column's cells open, for a `document` column whose catalog field
   * declares a `link`. Absent means the number renders as plain text.
   *
   * Only the KIND travels — the id per row rides on the row itself under
   * `linkKeyFor(key)`. A column carries one kind; a row carries one id.
   */
  link?: { kind: DocumentLinkKind }
  /**
   * Colour the cells by meaning — see `tone` on CatalogField. Cells only; the
   * footer stays plain, because a column of variances summing to zero has
   * cancelled out rather than balanced.
   */
  tone?: 'variance'
}

export type ColumnType =
  | 'text'
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'datetime'
  | 'document'

/**
 * The columns the grid renders, derived from the spec + catalog. Used by BOTH
 * the builder preview and the server run, so what you configure is exactly what
 * comes back.
 */
export function specColumns(spec: CustomReportSpec, source: CatalogSource): ReportColumn[] {
  const summarised = isSummarised(spec)
  const out: ReportColumn[] = []

  if (summarised) {
    for (const key of spec.groupFields) {
      const f = getField(source, key)
      if (!f) continue
      out.push({
        key: f.key,
        label: f.label,
        type: f.type,
        numeric: false,
        total: false,
        ...(f.hint ? { hint: f.hint } : {}),
      })
    }
  }

  for (const col of spec.columns) {
    if (summarised && spec.groupFields.includes(col.field)) continue

    if (col.calc) {
      const resolved = resolveCalc(source, col.calc)
      if (!resolved) continue
      const key = col.field
      const ratio = isRatioCalc(col.calc)
      out.push({
        key: summarised && col.agg && !ratio ? `${key}_${col.agg}` : key,
        label:
          summarised && col.agg && !ratio
            ? `${AGG_LABELS[col.agg]} ${col.calc.label.toLowerCase()}`
            : col.calc.label,
        type: col.calc.format,
        numeric: true,
        // A ratio must never be added down the column.
        total: !ratio,
        ...(ratio
          ? {
              ratio: {
                ...ratioKeys(key),
                scale: col.calc.format === 'percent' ? 100 : 1,
              },
            }
          : {}),
        hint: calcFormula(source, col.calc),
      })
      continue
    }

    if (col.field === ROW_COUNT_FIELD) {
      out.push({
        key: 'rowCount',
        label: summarised ? 'Rows' : 'Row',
        type: 'number',
        numeric: true,
        total: summarised,
      })
      continue
    }

    const f = getField(source, col.field)
    if (!f) continue

    if (!summarised) {
      out.push({
        key: f.key,
        label: f.label,
        type: f.type,
        numeric: f.numeric === true,
        total: f.numeric === true && !f.noTotal,
        ...(f.hint ? { hint: f.hint } : {}),
        ...(f.tone ? { tone: f.tone } : {}),
        /* Unsummarised only, matching buildSelect: a grouped row is many
           documents at once and has no single record to open. */
        ...(f.link ? { link: { kind: f.link.kind } } : {}),
      })
      continue
    }

    const agg: AggFn = col.agg ?? defaultAgg(f)
    const key = outputKey(col, true)
    const weighted = isWeightedPercent(f, agg)
    out.push({
      key,
      label: `${AGG_LABELS[agg]} ${f.label.toLowerCase()}`,
      // Counting anything yields a number, whatever the source field was.
      type: agg === 'count' ? 'number' : f.type,
      numeric: true,
      total: agg === 'sum' || agg === 'count' ? !f.noTotal : weighted,
      ...(weighted ? { ratio: { ...ratioKeys(key), scale: 100 } } : {}),
      ...(f.hint ? { hint: f.hint } : {}),
      /* Carried over SUM, MIN and MAX only — those still answer "was it short",
         so a summed variance of −R40 is still red. Dropped for COUNT (a count
         of variances is a tally, and a tally of 0 is not a balanced drawer) and
         for AVG, where an average of −R100 and +R100 is zero and would paint
         green over two drawers that were both wrong. */
      ...(f.tone && (agg === 'sum' || agg === 'min' || agg === 'max')
        ? { tone: f.tone }
        : {}),
    })
  }

  return out
}

/* ── validation ────────────────────────────────────────────────────────────── */

export type ValidationResult =
  | { ok: true; spec: CustomReportSpec; source: CatalogSource }
  | { ok: false; error: string }

/**
 * Check and NORMALISE a spec. Anything the catalog does not recognise is
 * DROPPED rather than rejected, so a saved report survives a field being
 * renamed instead of failing to open — but anything that would leave the report
 * meaningless (no source, no columns) is an error the caller must handle.
 *
 * This runs on the server for every run, not only in the builder. A spec
 * arriving over the wire is never trusted: the client is just another caller.
 */
export function validateSpec(input: CustomReportSpec): ValidationResult {
  if (!input || typeof input !== 'object') return { ok: false, error: 'No report definition.' }

  const source = getSource(input.source)
  if (!source) return { ok: false, error: 'That report reads data that is no longer available.' }

  const seen = new Set<string>()
  const columns: SpecColumn[] = []
  for (const col of Array.isArray(input.columns) ? input.columns : []) {
    if (columns.length >= MAX_COLUMNS) break
    if (!col || typeof col.field !== 'string') continue

    if (col.calc) {
      // A calc key doubles as a SQL alias, so its shape is enforced here.
      if (!CALC_KEY_PATTERN.test(col.field)) continue
      if (!resolveCalc(source, col.calc)) continue
      const label = String(col.calc.label ?? '').trim().slice(0, 60)
      if (!label) continue
      const format: CalcFormat = CALC_FORMATS.includes(col.calc.format)
        ? col.calc.format
        : 'number'
      const dedupe = `${col.field}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      const allowed = calcAggs(col.calc)
      columns.push({
        field: col.field,
        calc: { ...col.calc, label, format },
        ...(col.agg && allowed.includes(col.agg) ? { agg: col.agg } : {}),
      })
      continue
    }

    if (col.field === ROW_COUNT_FIELD) {
      if (seen.has(ROW_COUNT_FIELD)) continue
      seen.add(ROW_COUNT_FIELD)
      columns.push({ field: ROW_COUNT_FIELD })
      continue
    }

    const f = getField(source, col.field)
    if (!f) continue
    const agg = col.agg && aggsForField(f).includes(col.agg) ? col.agg : undefined
    // The same field twice is fine when the aggregates differ (total AND average).
    const dedupe = `${col.field}:${agg ?? ''}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    columns.push({ field: col.field, ...(agg ? { agg } : {}) })
  }

  const groupFields: string[] = []
  for (const key of Array.isArray(input.groupFields) ? input.groupFields : []) {
    if (groupFields.length >= MAX_GROUP_FIELDS) break
    if (typeof key !== 'string' || groupFields.includes(key)) continue
    if (!getField(source, key)) continue
    groupFields.push(key)
  }

  const filters: SpecFilter[] = []
  for (const f of Array.isArray(input.filters) ? input.filters : []) {
    if (filters.length >= MAX_FILTERS) break
    if (!f || typeof f.field !== 'string') continue
    const field = getField(source, f.field)
    if (!field) continue
    if (!opsForField(field).includes(f.op)) continue
    const need = valueCount(f.op)
    // A filter with no value would silently match everything, which reads as a
    // broken report rather than an unset one. Drop it instead.
    if (need >= 1 && !String(f.value ?? '').trim()) continue
    if (need === 2 && !String(f.value2 ?? '').trim()) continue
    filters.push({
      field: f.field,
      op: f.op,
      ...(need >= 1 ? { value: String(f.value).slice(0, 200) } : {}),
      ...(need === 2 ? { value2: String(f.value2).slice(0, 200) } : {}),
    })
  }

  const summarised = groupFields.length > 0

  // A summarised report needs every non-group column aggregated, or the SQL is
  // invalid. Fill in the sensible default rather than refusing the spec.
  const normalisedColumns = summarised
    ? columns.map((c) => {
        if (groupFields.includes(c.field)) return c
        if (c.calc) {
          if (isRatioCalc(c.calc)) return c
          return c.agg ? c : { ...c, agg: 'sum' as AggFn }
        }
        if (c.field === ROW_COUNT_FIELD) return c
        const f = getField(source, c.field)
        return c.agg || !f ? c : { ...c, agg: defaultAgg(f) }
      })
    : columns.map(({ agg: _agg, ...rest }) => rest)

  const validKeys = new Set(
    specColumns(
      { ...input, columns: normalisedColumns, groupFields, filters } as CustomReportSpec,
      source,
    ).map((c) => c.key),
  )

  const totalFilters: SpecTotalFilter[] = []
  if (summarised) {
    for (const tf of Array.isArray(input.totalFilters) ? input.totalFilters : []) {
      if (totalFilters.length >= MAX_TOTAL_FILTERS) break
      if (!tf || typeof tf.key !== 'string' || !validKeys.has(tf.key)) continue
      if (!TOTAL_FILTER_OPS.includes(tf.op)) continue
      if (!String(tf.value ?? '').trim()) continue
      if (valueCount(tf.op) === 2 && !String(tf.value2 ?? '').trim()) continue
      totalFilters.push({
        key: tf.key,
        op: tf.op,
        value: String(tf.value).slice(0, 60),
        ...(valueCount(tf.op) === 2 ? { value2: String(tf.value2).slice(0, 60) } : {}),
      })
    }
  }

  if (normalisedColumns.length === 0 && groupFields.length === 0) {
    return { ok: false, error: 'Pick at least one column to show.' }
  }

  const sort =
    input.sort && validKeys.has(input.sort.key)
      ? { key: input.sort.key, dir: input.sort.dir === 'asc' ? ('asc' as const) : ('desc' as const) }
      : undefined

  const period: SpecPeriod =
    input.period && PERIOD_KEYS.includes(input.period.key)
      ? input.period.key === 'custom'
        ? {
            key: 'custom',
            ...(validIso(input.period.from) ? { from: input.period.from } : {}),
            ...(validIso(input.period.to) ? { to: input.period.to } : {}),
          }
        : { key: input.period.key }
      : { key: 'thisMonth' }

  return {
    ok: true,
    source,
    spec: {
      version: 1,
      name: String(input.name ?? '').trim().slice(0, 120) || 'Untitled report',
      source: source.key,
      period,
      columns: normalisedColumns,
      filters,
      groupFields,
      totalFilters,
      ...(sort ? { sort } : {}),
      // "Top N per group" needs something to rank by and something to group
      // within; without both it would silently truncate the report.
      ...(input.topPerGroup && groupFields.length >= 2 && sort
        ? { topPerGroup: Math.max(1, Math.min(1000, Math.round(input.topPerGroup))) }
        : {}),
      ...(input.chartType && CHART_TYPES.includes(input.chartType)
        ? { chartType: input.chartType }
        : {}),
      limit: Math.max(1, Math.min(MAX_ROWS, Math.round(Number(input.limit) || DEFAULT_ROWS))),
    },
  }
}

/** Parse a stored spec string. Returns null when it is not usable at all. */
export function parseSpec(json: string): CustomReportSpec | null {
  try {
    const raw = JSON.parse(json) as CustomReportSpec
    const checked = validateSpec(raw)
    return checked.ok ? checked.spec : null
  } catch {
    return null
  }
}
