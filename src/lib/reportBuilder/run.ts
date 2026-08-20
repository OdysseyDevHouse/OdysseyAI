import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../siteDb'
import { customerDbPrefix, branchDbPrefix } from '../site/customerDb'
import type { Capability } from '../site/permissions'
// The grand total and a band subtotal have to be the same arithmetic, so the
// function lives with the banding rather than here. See shape.ts.
import { computeTotals } from './shape'
import {
  canSeeField,
  getField,
  getSource,
  type CatalogField,
  type CatalogSource,
} from './catalog'
import {
  defaultAgg,
  isRatioCalc,
  isSummarised,
  isWeightedPercent,
  outputKey,
  ratioKeys,
  resolveCalc,
  resolvePeriod,
  specColumns,
  validateSpec,
  valueCount,
  MAX_ROWS,
  ROW_COUNT_FIELD,
  type AggFn,
  type CustomReportSpec,
  type FilterOp,
  type ReportColumn,
  type SpecColumn,
  type SpecFilter,
  type SpecTotalFilter,
} from './spec'

/**
 * Runs a report someone built (see ./spec.ts) against the site database.
 *
 * This is the ONLY module that composes SQL for a built report, and it composes
 * it exclusively from catalog `expr` strings a developer authored. The spec
 * contributes field KEYS (looked up in the catalog, never interpolated) and
 * filter VALUES (bound as `?` parameters, never interpolated). If a key is not
 * in the catalog the column simply does not exist — validateSpec dropped it.
 *
 * ── WHY THIS IS SIMPLER THAN THE POS VERSION ─────────────────────────────────
 *
 * The build this was modelled on had to sweep monthly history partitions and
 * merge partial aggregates in TypeScript, which forced averages to be fetched
 * as sum+count and made "filter on a total" a post-processing step. Here there
 * is one table per source in one database, so a summarised report is a single
 * GROUP BY that the database completes itself.
 *
 * Two things are still done in TypeScript rather than SQL, deliberately:
 *
 *   TOTAL FILTERS — a HAVING cannot reference a derived column like a weighted
 *   percentage, which is assembled from two summed parts. Filtering after the
 *   fact means every column is filterable on the same terms, including the ones
 *   SQL never saw as a single value.
 *
 *   TOP N PER GROUP — expressing this in MySQL means a window function and a
 *   subquery, and the row set is already capped and in memory by this point.
 *
 * ── PERMISSIONS ──────────────────────────────────────────────────────────────
 *
 * The caller's capabilities are passed in and applied HERE, not at the UI:
 * a source the caller may not read is refused outright, and a field they may
 * not see is dropped from the select list. A saved report built by an owner and
 * opened by a junior therefore returns the same rows without the cost columns,
 * rather than leaking them or failing.
 */

/** Per-statement ceiling. Long enough for a real report, not forever. */
const STATEMENT_TIMEOUT_SECONDS = 45

export interface RunOptions {
  /** Overrides the spec's own row cap — the preview asks for far fewer. */
  limit?: number
  /** Resolve relative periods against this instant (a scheduled send uses its due time). */
  now?: Date
  /**
   * Where to read the rows from. Defaults to the site's own database.
   *
   * A local-backend site keeps its data on the shop's machine, so head-office
   * reporting has nothing to read there. Passing a reader that points at that
   * site's cloud REPLICA runs the identical SQL against the identical schema —
   * the replica is a byte-for-byte copy — without this engine knowing anything
   * about replication.
   *
   * A FUNCTION rather than a purpose string, deliberately: it keeps replicas
   * unreachable through siteDb.ts. Reporting supplies its own reader; nothing
   * here can resolve one by name, so no existing caller can land on a replica
   * by accident.
   *
   * It must be READ-ONLY. The engine only ever SELECTs, and a replica that
   * could be written to would silently diverge from the shop.
   */
  reader?: (siteId: number, sql: string, params: unknown[]) => Promise<RowDataPacket[]>
}

export interface ReportResult {
  columns: ReportColumn[]
  rows: Record<string, unknown>[]
  /** Column totals, keyed the same as the rows. Only for columns that total. */
  totals: Record<string, number>
  /** The dates the period resolved to, for the header. */
  range: { from: string; to: string }
  /** True when the row cap truncated the result. */
  truncated: boolean
  /** Columns dropped because the caller may not see them. */
  hiddenColumns: string[]
}

export class ReportAccessError extends Error {}

/* ── public entry point ────────────────────────────────────────────────────── */

export async function runBuilderSpec(
  siteId: number,
  input: CustomReportSpec,
  can: (c: Capability) => boolean,
  options: RunOptions = {},
): Promise<ReportResult> {
  const checked = validateSpec(input)
  if (!checked.ok) throw new Error(checked.error)
  const { spec, source } = checked

  if (!can(source.permission)) {
    throw new ReportAccessError('You do not have access to this data.')
  }

  // Drop what the caller may not see BEFORE anything is built, so a hidden
  // field cannot leak through a filter, a grouping or a calculation operand.
  const { spec: visible, hidden } = stripHiddenFields(spec, source, can)

  const summarised = isSummarised(visible)
  const limit = Math.min(options.limit ?? visible.limit, MAX_ROWS)
  const range = resolvePeriod(visible.period, options.now)

  const select = buildSelect(visible, source)

  const joins = joinsFor(source, referencedFields(visible))
  const where = buildWhere(visible, source, range)

  // Derived items (a weighted percentage, a ratio calc) are assembled AFTER the
  // query from their summed parts, so they carry no SQL of their own. Including
  // them here would emit an empty entry — `SELECT a, , b` — which is a syntax
  // error, not a harmless blank.
  const selectSql = select.filter((s) => s.sql)

  // Nothing left to ask the database for — every column the spec named was
  // stripped by the caller's permissions. An empty SELECT is a syntax error, so
  // this returns the empty report and lets the screen explain what is hidden.
  if (selectSql.length === 0) {
    return { columns: [], rows: [], totals: {}, range, truncated: false, hiddenColumns: hidden }
  }

  /*
   * ── WHERE THE CUSTOMER FILE IS, AND HOW IT IS NAMED ──────────────────────
   *
   * A store group may share one customer file, in which case the debtors book
   * and the loyalty balances live in the group primary's database while sales,
   * jobs and products stay in the branch. A report routinely spans both.
   *
   * The engine cannot route the whole query the way lib/site modules do — half
   * of it belongs to each side. So it QUALIFIES instead: MariaDB resolves a
   * cross-database join in one pass on the same instance, including filters and
   * sorts against the remote table (measured in
   * scripts/probe-shared-customer-file.ts). No two-phase fetch is needed.
   *
   *   ownedBy: 'customer'  the source's own table is on the OWNER, so its FROM
   *                        is qualified too
   *   otherwise            the source's table is this branch's own
   *
   * `{C}` and `{B}` in the catalogue mark which side each joined table is on.
   * Both resolve to '' for a store that owns its own customers, so a single-shop
   * site's SQL — and its query plan — are exactly what they always were.
   */
  const ownerSide = source.ownedBy === 'customer'
  const [customerPrefix, branchPrefix] = await Promise.all([
    customerDbPrefix(siteId),
    branchDbPrefix(siteId),
  ])

  /*
   * The query always runs on the CALLER's connection — a report is a read, and
   * opening it against the owner would strand every branch table in it. So
   * `{C}` is qualified whichever side the source sits on, and an owner-side
   * source qualifies its FROM as well.
   *
   * `{B}` is the mirror, and it is only ever non-empty on an owner-side source:
   * a branch-side query is already in the branch's own database, so a branch
   * table there needs no prefix at all.
   */
  const qualify = (text: string) =>
    text.split('{C}').join(customerPrefix).split('{B}').join(ownerSide ? branchPrefix : '')

  const sql = [
    `SELECT ${selectSql.map((s) => s.sql).join(', ')}`,
    `FROM ${ownerSide ? customerPrefix : ''}\`${source.table}\` t`,
    ...joins.map(qualify),
    where.sql ? `WHERE ${where.sql}` : '',
    summarised
      ? `GROUP BY ${visible.groupFields
          .map((k) => getField(source, k)?.expr)
          .filter(Boolean)
          .join(', ')}`
      : '',
    // A summarised set is small and gets sorted, filtered and capped below, so
    // the SQL cap only needs to stop a runaway grouping. A detail report is
    // capped exactly.
    `LIMIT ${summarised ? MAX_ROWS : limit + 1}`,
  ]
    .filter(Boolean)
    .join('\n')

  /* WHERE the rows come from.
   *
   * A cloud site has one database and this reads it. A local-backend site keeps
   * its data on the shop's machine, which head office cannot reach — so it
   * reads that site's cloud REPLICA instead. The SQL above is identical either
   * way, because the replica is a byte-for-byte copy of the same schema.
   *
   * Resolved HERE rather than at the six places that call this engine, so no
   * caller has to remember. A caller that already knows better may still pass
   * `reader` — the multi-site path does, to avoid re-resolving per store.
   *
   * The resolver is imported lazily so this module keeps working in a script
   * or a test that has no control database to ask. */
  const read =
    options.reader ??
    (await import('../reporting/reportSource')
      .then((m) => m.reportSourceFor(siteId))
      .then((s) => s.reader)
      .catch(() => (s: number, q: string, p: unknown[]) => siteQuery<RowDataPacket>(s, q, p)))

  const raw = await read(
    siteId,
    `SET STATEMENT max_statement_time=${STATEMENT_TIMEOUT_SECONDS} FOR ${sql}`,
    where.params,
  ).catch(async (err: unknown) => {
    // MariaDB understands SET STATEMENT; MySQL does not. Fall back rather than
    // making the whole feature depend on which one the site runs.
    if (isSyntaxError(err)) return read(siteId, sql, where.params)
    throw err
  })

  let rows = raw.map((r) => coerceRow(r as Record<string, unknown>, select))
  rows = rows.map((r) => finaliseDerived(r, select))

  const columns = specColumns(visible, source)

  if (visible.totalFilters.length > 0) {
    rows = rows.filter((row) => visible.totalFilters.every((f) => passesTotal(row, f)))
  }

  sortRows(rows, visible.sort, columns)

  if (visible.topPerGroup && visible.groupFields.length >= 2) {
    rows = keepTopPerGroup(rows, visible.groupFields[0], visible.topPerGroup)
  }

  const truncated = rows.length > limit
  rows = rows.slice(0, limit)

  return {
    columns,
    rows,
    totals: computeTotals(rows, columns),
    range,
    truncated,
    hiddenColumns: hidden,
  }
}

/* ── permission filtering ──────────────────────────────────────────────────── */

/**
 * Remove every reference to a field the caller may not see. A calculated column
 * whose operand is hidden goes too — otherwise "gross profit ÷ quantity" would
 * hand back a cost figure to someone denied cost.
 */
function stripHiddenFields(
  spec: CustomReportSpec,
  source: CatalogSource,
  can: (c: Capability) => boolean,
): { spec: CustomReportSpec; hidden: string[] } {
  const hidden: string[] = []
  const visible = (key: string): boolean => {
    const f = getField(source, key)
    if (!f) return true // synthetic keys (row count, calc aliases)
    if (canSeeField(f, can)) return true
    if (!hidden.includes(f.label)) hidden.push(f.label)
    return false
  }

  const columns = spec.columns.filter((c) => {
    if (c.calc) {
      const leftOk = visible(c.calc.left)
      const rightOk = typeof c.calc.right === 'number' || visible(c.calc.right)
      return leftOk && rightOk
    }
    return c.field === ROW_COUNT_FIELD || visible(c.field)
  })

  const groupFields = spec.groupFields.filter(visible)
  const filters = spec.filters.filter((f) => visible(f.field))

  // A total filter naming a column that is gone would silently empty the
  // report, so those are dropped with it.
  const keys = new Set(specColumns({ ...spec, columns, groupFields, filters }, source).map((c) => c.key))
  const totalFilters = spec.totalFilters.filter((f) => keys.has(f.key))

  return { spec: { ...spec, columns, groupFields, filters, totalFilters }, hidden }
}

/* ── select list ───────────────────────────────────────────────────────────── */

interface SelectItem {
  key: string
  sql: string
  numeric: boolean
  /** Assembled after the query from `__num`/`__den` parts. */
  derived?: { num: string; den: string; scale: number }
}

function buildSelect(spec: CustomReportSpec, source: CatalogSource): SelectItem[] {
  const summarised = isSummarised(spec)
  const items: SelectItem[] = []

  if (summarised) {
    for (const key of spec.groupFields) {
      const f = getField(source, key)
      if (!f) continue
      items.push({ key: f.key, sql: `${f.expr} AS \`${f.key}\``, numeric: false })
    }
  }

  for (const col of spec.columns) {
    if (summarised && spec.groupFields.includes(col.field)) continue

    if (col.calc) {
      items.push(...calcSelect(source, col, summarised))
      continue
    }

    if (col.field === ROW_COUNT_FIELD) {
      items.push({
        key: 'rowCount',
        sql: summarised ? 'COUNT(*) AS `rowCount`' : '1 AS `rowCount`',
        numeric: true,
      })
      continue
    }

    const f = getField(source, col.field)
    if (!f) continue

    if (!summarised) {
      items.push({
        key: f.key,
        sql: `${f.expr} AS \`${f.key}\``,
        numeric: f.numeric === true,
      })
      continue
    }

    items.push(...aggregateSelect(source, f, col.agg ?? defaultAgg(f), outputKey(col, true)))
  }

  return items
}

/**
 * The select entries for one aggregated column.
 *
 * A weighted percentage is fetched as the SUM of the two amounts it is a ratio
 * of, and divided afterwards. Averaging the percentage column directly would
 * weight a R5 line the same as a R5,000 one — see CatalogField.ratio.
 */
function aggregateSelect(
  source: CatalogSource,
  field: CatalogField,
  agg: AggFn,
  key: string,
): SelectItem[] {
  if (isWeightedPercent(field, agg) && field.ratio) {
    const num = getField(source, field.ratio.numerator)
    const den = getField(source, field.ratio.denominator)
    if (num && den) {
      const k = ratioKeys(key)
      return [
        { key: k.num, sql: `SUM(${num.expr}) AS \`${k.num}\``, numeric: true },
        { key: k.den, sql: `SUM(${den.expr}) AS \`${k.den}\``, numeric: true },
        { key, sql: '', numeric: true, derived: { ...k, scale: 100 } },
      ]
    }
  }

  const fn = agg.toUpperCase()
  return [{ key, sql: `${fn}(${field.expr}) AS \`${key}\``, numeric: true }]
}

/**
 * A calculated column.
 *
 * + − × and ÷-by-a-constant are ROW-LEVEL and then aggregated, because
 * SUM(price) × SUM(qty) is not the value of anything. A ÷ between two fields is
 * a RATIO OF TOTALS: the two sides are summed and divided afterwards, so
 * "sales per basket" is total sales over total baskets rather than the mean of
 * per-row ratios.
 */
function calcSelect(source: CatalogSource, col: SpecColumn, summarised: boolean): SelectItem[] {
  const calc = col.calc!
  const resolved = resolveCalc(source, calc)
  if (!resolved) return []

  const leftExpr = resolved.left.expr
  const rightExpr =
    typeof resolved.right === 'number' ? String(resolved.right) : resolved.right.expr

  if (summarised && isRatioCalc(calc)) {
    const k = ratioKeys(col.field)
    return [
      { key: k.num, sql: `SUM(${leftExpr}) AS \`${k.num}\``, numeric: true },
      { key: k.den, sql: `SUM(${rightExpr}) AS \`${k.den}\``, numeric: true },
      {
        key: col.field,
        sql: '',
        numeric: true,
        derived: { ...k, scale: calc.format === 'percent' ? 100 : 1 },
      },
    ]
  }

  const rowExpr = rowLevelCalc(leftExpr, calc.op, rightExpr, calc.format)

  if (!summarised) {
    return [{ key: col.field, sql: `${rowExpr} AS \`${col.field}\``, numeric: true }]
  }

  const agg = (col.agg ?? 'sum').toUpperCase()
  const key = `${col.field}_${col.agg ?? 'sum'}`
  return [{ key, sql: `${agg}(${rowExpr}) AS \`${key}\``, numeric: true }]
}

function rowLevelCalc(left: string, op: string, right: string, format: string): string {
  switch (op) {
    case 'add':
      return `(${left} + ${right})`
    case 'sub':
      return `(${left} - ${right})`
    case 'mul':
      return `(${left} * ${right})`
    case 'div':
    default:
      // NULLIF keeps a zero denominator from turning the whole row into an error.
      return `(${left} / NULLIF(${right}, 0)${format === 'percent' ? ' * 100' : ''})`
  }
}

/* ── where clause ──────────────────────────────────────────────────────────── */

function buildWhere(
  spec: CustomReportSpec,
  source: CatalogSource,
  range: { from: string; to: string },
): { sql: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []

  // A timeline source is always bounded by the period. A snapshot has no date
  // to bound — "stock on hand last March" is not a question this data can
  // answer, and silently filtering on created_at would answer a different one.
  if (source.shape === 'timeline' && source.dateColumn) {
    const dateExpr = dateColumnExpr(source)
    parts.push(`${dateExpr} >= ? AND ${dateExpr} < DATE_ADD(?, INTERVAL 1 DAY)`)
    params.push(range.from, range.to)
  }

  for (const f of spec.filters) {
    const field = getField(source, f.field)
    if (!field) continue
    const clause = filterClause(field.expr, f)
    if (!clause) continue
    parts.push(clause.sql)
    params.push(...clause.params)
  }

  return { sql: parts.join(' AND '), params }
}

/**
 * The expression the date range filters on. For a line-level source the date
 * lives on the parent document, so the catalog's `dateColumn` is qualified with
 * the joined alias rather than `t`.
 *
 * Which join is the parent is DECLARED (`dateJoin`) rather than guessed from a
 * hardcoded pair of names. It used to look only for 'doc' or 'exp', so a source
 * whose parent join was called anything else silently qualified the date with
 * `t` and every one of its fields failed with "Unknown column 't.<date>'" — the
 * whole source unusable, for a naming convention nothing stated.
 */
function dateColumnExpr(source: CatalogSource): string {
  const parentAlias = source.joins?.find((j) =>
    source.dateJoin ? j.name === source.dateJoin : j.name === 'doc' || j.name === 'exp',
  )
  if (parentAlias) {
    const m = /JOIN\s+\S+\s+(\w+)\s+ON/.exec(parentAlias.sql)
    if (m) return `${m[1]}.\`${source.dateColumn}\``
  }
  return `t.\`${source.dateColumn}\``
}

function filterClause(expr: string, f: SpecFilter): { sql: string; params: unknown[] } | null {
  const need = valueCount(f.op)
  const value = f.value ?? ''
  const value2 = f.value2 ?? ''

  switch (f.op) {
    case 'eq':
      return { sql: `${expr} = ?`, params: [value] }
    case 'ne':
      // A NULL never equals anything, so a plain <> would silently drop empty
      // rows from a "is not X" filter — which is not what "is not" means.
      return { sql: `(${expr} <> ? OR ${expr} IS NULL)`, params: [value] }
    case 'contains':
      return { sql: `${expr} LIKE ?`, params: [`%${escapeLike(value)}%`] }
    case 'notContains':
      return { sql: `(${expr} NOT LIKE ? OR ${expr} IS NULL)`, params: [`%${escapeLike(value)}%`] }
    case 'startsWith':
      return { sql: `${expr} LIKE ?`, params: [`${escapeLike(value)}%`] }
    case 'endsWith':
      return { sql: `${expr} LIKE ?`, params: [`%${escapeLike(value)}`] }
    case 'in': {
      const items = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 200)
      if (items.length === 0) return null
      return { sql: `${expr} IN (${items.map(() => '?').join(', ')})`, params: items }
    }
    case 'gt':
      return { sql: `${expr} > ?`, params: [value] }
    case 'gte':
      return { sql: `${expr} >= ?`, params: [value] }
    case 'lt':
      return { sql: `${expr} < ?`, params: [value] }
    case 'lte':
      return { sql: `${expr} <= ?`, params: [value] }
    case 'between':
      if (need === 2 && !value2) return null
      return { sql: `${expr} BETWEEN ? AND ?`, params: [value, value2] }
    case 'isEmpty':
      return { sql: `(${expr} IS NULL OR ${expr} = '')`, params: [] }
    case 'notEmpty':
      return { sql: `(${expr} IS NOT NULL AND ${expr} <> '')`, params: [] }
    default:
      return null
  }
}

/** A user's `%` or `_` must match itself, not act as a wildcard. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/* ── joins ─────────────────────────────────────────────────────────────────── */

/** Every catalog field key the spec references, for resolving needed joins. */
function referencedFields(spec: CustomReportSpec): string[] {
  const keys = [
    ...spec.groupFields,
    ...spec.columns.map((c) => c.field),
    ...spec.filters.map((f) => f.field),
  ]
  for (const c of spec.columns) {
    if (c.calc) {
      keys.push(c.calc.left)
      if (typeof c.calc.right === 'string') keys.push(c.calc.right)
    }
  }
  return keys
}

/**
 * Only the joins something actually references. A source's mandatory parent
 * join (`doc`, `exp`) is always emitted, because the date range filters through
 * it.
 */
function joinsFor(source: CatalogSource, referenced: string[]): string[] {
  if (!source.joins) return []

  const needed = new Set<string>()
  for (const key of referenced) {
    const f = getField(source, key)
    for (const n of f?.needs ?? []) needed.add(n)
  }
  // A weighted percentage reads its numerator and denominator, which may join.
  for (const key of referenced) {
    const f = getField(source, key)
    if (!f?.ratio) continue
    for (const part of [f.ratio.numerator, f.ratio.denominator]) {
      for (const n of getField(source, part)?.needs ?? []) needed.add(n)
    }
  }

  /*
   * A join may read another join's alias — saleModifiers' `product` is written
   * against the `sl` its `line` join introduces. Pulling the dependency in is
   * what stops "Unknown column 'sl.product_id'" when a product field is picked
   * without a line field beside it.
   *
   * Iterated to a fixed point rather than resolved in one pass, so a chain of
   * three holds. Bounded by the join count: each pass either adds a name or
   * stops.
   */
  for (let pass = 0; pass < source.joins.length; pass++) {
    const before = needed.size
    for (const join of source.joins) {
      if (!needed.has(join.name) && !join.always) continue
      for (const dep of join.needs ?? []) needed.add(dep)
    }
    if (needed.size === before) break
  }

  return source.joins
    .filter((j) => j.always || j.name === 'doc' || j.name === 'exp' || needed.has(j.name))
    .map((j) => j.sql)
}

/* ── result shaping ────────────────────────────────────────────────────────── */

/**
 * MySQL returns DECIMAL and BIGINT as strings. Only NUMERIC columns are
 * coerced — a product code like "003400" is text and must keep its leading
 * zeros.
 */
function coerceRow(row: Record<string, unknown>, select: SelectItem[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const item of select) {
    if (!item.sql) continue // derived, assembled below
    const v = row[item.key]
    out[item.key] = item.numeric ? (v == null ? null : Number(v)) : v
  }
  return out
}

/** Assemble the num/den pairs into their finished value. */
function finaliseDerived(
  row: Record<string, unknown>,
  select: SelectItem[],
): Record<string, unknown> {
  for (const item of select) {
    if (!item.derived) continue
    const num = Number(row[item.derived.num] ?? 0)
    const den = Number(row[item.derived.den] ?? 0)
    row[item.key] = den === 0 ? 0 : (num / den) * item.derived.scale
  }
  return row
}

function passesTotal(row: Record<string, unknown>, f: SpecTotalFilter): boolean {
  const v = Number(row[f.key] ?? 0)
  const a = Number(f.value)
  const b = Number(f.value2 ?? 0)
  if (!Number.isFinite(a)) return true
  switch (f.op) {
    case 'eq':
      return v === a
    case 'ne':
      return v !== a
    case 'gt':
      return v > a
    case 'gte':
      return v >= a
    case 'lt':
      return v < a
    case 'lte':
      return v <= a
    case 'between':
      return v >= a && v <= b
    default:
      return true
  }
}

function sortRows(
  rows: Record<string, unknown>[],
  sort: CustomReportSpec['sort'],
  columns: ReportColumn[],
): void {
  if (!sort) return
  const col = columns.find((c) => c.key === sort.key)
  const dir = sort.dir === 'asc' ? 1 : -1
  rows.sort((a, b) => {
    const x = a[sort.key]
    const y = b[sort.key]
    if (x == null && y == null) return 0
    // Nulls sort last in both directions — an empty cell is never "the top
    // result", whichever way the column is pointing.
    if (x == null) return 1
    if (y == null) return -1
    if (col?.numeric) return (Number(x) - Number(y)) * dir
    return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir
  })
}

/** "Top 10 products per department" — rows are already sorted. */
function keepTopPerGroup(
  rows: Record<string, unknown>[],
  groupKey: string,
  n: number,
): Record<string, unknown>[] {
  const seen = new Map<string, number>()
  const out: Record<string, unknown>[] = []
  for (const row of rows) {
    const k = String(row[groupKey] ?? '')
    const count = seen.get(k) ?? 0
    if (count >= n) continue
    seen.set(k, count + 1)
    out.push(row)
  }
  return out
}

function isSyntaxError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === 'ER_PARSE_ERROR' || code === 'ER_SYNTAX_ERROR'
}

/* ── convenience ───────────────────────────────────────────────────────────── */

/** Run a stored spec string. Used by saved reports and by schedules. */
export async function runSavedSpec(
  siteId: number,
  json: string,
  can: (c: Capability) => boolean,
  options: RunOptions = {},
): Promise<ReportResult> {
  const spec = JSON.parse(json) as CustomReportSpec
  return runBuilderSpec(siteId, spec, can, options)
}

export { getSource, type CustomReportSpec }
