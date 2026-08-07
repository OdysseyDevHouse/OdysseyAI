import type { AggFn, ColumnType, FilterOp } from './spec'

/**
 * The catalog as the BROWSER sees it.
 *
 * Identical to the server's CatalogField minus `expr` and `needs` — the SQL and
 * the join graph never leave the server. The builder UI reasons about types,
 * labels and groups, which is everything it needs to offer the right operators
 * and aggregates, and nothing it needs to compose a query.
 *
 * Keeping this a separate type (rather than exporting CatalogField and hoping
 * nobody serialises it) is what makes that guarantee checkable: if a field's
 * expression is ever needed on the client, it will not compile.
 */

export type ClientField = {
  key: string
  label: string
  type: ColumnType
  numeric: boolean
  starter: boolean
  noTotal: boolean
  /** True when summarising this percentage weights it properly. */
  hasRatio: boolean
  group: string
  hint: string
  options: { value: string; label: string }[]
}

export type ClientSource = {
  key: string
  label: string
  description: string
  category: string
  shape: 'snapshot' | 'timeline'
  note?: string
  defaultFilters: { field: string; op: 'eq' | 'ne'; value: string }[]
  fields: ClientField[]
}

/* ── the same rules as the server, over the client shape ───────────────────── */

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
const NUMBER_OPS: FilterOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between']
const DATE_OPS: FilterOp[] = ['gte', 'lte', 'between', 'isEmpty', 'notEmpty']

/** Mirrors opsForField in ./spec — same order, same rules, client shape. */
export function opsForClientField(f: ClientField): FilterOp[] {
  if (f.type === 'date' || f.type === 'datetime') return DATE_OPS
  if (f.options.length > 0) return ['eq', 'ne', 'in', 'isEmpty', 'notEmpty']
  if (f.numeric) return NUMBER_OPS
  return TEXT_OPS
}

/** Mirrors aggsForField in ./spec. */
export function aggsForClientField(f: ClientField): AggFn[] {
  if (f.numeric) return ['sum', 'avg', 'min', 'max', 'count']
  if (f.type === 'date' || f.type === 'datetime') return ['min', 'max', 'count']
  return ['count']
}

/** Mirrors defaultAgg in ./spec. */
export function defaultAggForClientField(f: ClientField): AggFn {
  if (!f.numeric) return 'count'
  return f.type === 'percent' ? 'avg' : 'sum'
}

/** Whether a field can be an operand in a calculated column. */
export function isClientCalcOperand(f: ClientField): boolean {
  return f.numeric && f.type !== 'date' && f.type !== 'datetime'
}

export function findField(source: ClientSource, key: string): ClientField | undefined {
  return source.fields.find((f) => f.key === key)
}

/**
 * The OUTPUT columns a spec produces, derived from the client catalog.
 *
 * A deliberate mirror of specColumns() in ./spec, which needs the server's
 * CatalogSource. The builder needs the same answer to populate "filter on a
 * total" and the sort picker, and faking a CatalogSource to reuse that function
 * meant inventing empty `expr` strings — which is exactly the sort of cast that
 * silently rots when the real one changes.
 *
 * Only the parts the builder actually asks for are computed: key, label and
 * whether the column is numeric.
 */
export function clientOutputColumns(
  source: ClientSource,
  spec: {
    columns: { field: string; agg?: AggFn; calc?: { label: string; format: ColumnType } }[]
    groupFields: string[]
  },
): { key: string; label: string; numeric: boolean }[] {
  const summarised = spec.groupFields.length > 0
  const out: { key: string; label: string; numeric: boolean }[] = []

  if (summarised) {
    for (const key of spec.groupFields) {
      const f = findField(source, key)
      if (f) out.push({ key: f.key, label: f.label, numeric: false })
    }
  }

  for (const col of spec.columns) {
    if (summarised && spec.groupFields.includes(col.field)) continue

    if (col.calc) {
      const ratio = false
      out.push({
        key: summarised && col.agg ? `${col.field}_${col.agg}` : col.field,
        label:
          summarised && col.agg
            ? `${AGG_LABEL[col.agg]} ${col.calc.label.toLowerCase()}`
            : col.calc.label,
        numeric: true,
      })
      continue
    }

    if (col.field === ROW_COUNT_KEY) {
      out.push({ key: 'rowCount', label: summarised ? 'Rows' : 'Row', numeric: true })
      continue
    }

    const f = findField(source, col.field)
    if (!f) continue

    if (!summarised) {
      out.push({ key: f.key, label: f.label, numeric: f.numeric })
      continue
    }

    const agg = col.agg ?? defaultAggForClientField(f)
    out.push({
      key: `${f.key}_${agg}`,
      label: `${AGG_LABEL[agg]} ${f.label.toLowerCase()}`,
      numeric: true,
    })
  }

  return out
}

/** Kept in step with AGG_LABELS in ./spec. */
const AGG_LABEL: Record<AggFn, string> = {
  sum: 'Total',
  avg: 'Average',
  min: 'Lowest',
  max: 'Highest',
  count: 'Count of',
}

const ROW_COUNT_KEY = '__rows'

/** Fields bucketed by their picker section, in catalog order. */
export function groupedFields(source: ClientSource): [string, ClientField[]][] {
  const out = new Map<string, ClientField[]>()
  for (const f of source.fields) {
    const g = f.group || 'Other'
    const list = out.get(g) ?? []
    list.push(f)
    out.set(g, list)
  }
  return [...out.entries()]
}
