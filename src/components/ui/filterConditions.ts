import type { FilterOp } from '@/lib/reportBuilder/spec'

/**
 * The pure half of the advanced filter: its types and the functions that
 * describe a condition in words.
 *
 * ── WHY THIS IS NOT IN AdvancedFilter.tsx ──────────────────────────────────
 *
 * That file is `'use client'`, and every export of a "use client" module is a
 * CLIENT REFERENCE — a stub the server may render or pass as a prop, never a
 * function it can call. A server component calling `summarise()` from there
 * fails at request time with "Attempted to call summarise() from the server",
 * and the page renders as an empty shell: 200 OK, no heading, no rows.
 *
 * The products list needs exactly that call, on the server, to label its filter
 * chips. So the pure logic lives here — a plain module both sides may import —
 * and the panel keeps only what genuinely needs hooks and handlers. This is the
 * same rule styles.ts follows, and for the same reason.
 */

/** The catalog subset the filter UI needs. Structurally a ClientField. */
export type FilterField = {
  key: string
  label: string
  type: string
  numeric: boolean
  group: string
  hint: string
  options: { value: string; label: string }[]
}

/**
 * One condition.
 *
 * `op` is the report builder's own FilterOp union rather than a loose string,
 * so an operator this panel offers and one the SQL compiler understands cannot
 * drift apart — a mismatch becomes a compile error instead of a condition that
 * silently compiles to nothing.
 */
export type FilterCondition = {
  field: string
  op: FilterOp
  value?: string
  value2?: string
}

/** Operator labels, in the report builder's words so the two screens agree. */
export const OP_LABELS: Record<FilterOp, string> = {
  eq: 'is',
  ne: 'is not',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  endsWith: 'ends with',
  in: 'is any of',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  between: 'is between',
  isEmpty: 'is empty',
  notEmpty: 'is not empty',
}

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
const CHOICE_OPS: FilterOp[] = ['eq', 'ne', 'in', 'isEmpty', 'notEmpty']

/** Which comparisons suit a field. Mirrors opsForClientField in the builder. */
export function opsFor(field: FilterField): FilterOp[] {
  if (field.type === 'date' || field.type === 'datetime') return DATE_OPS
  if (field.options.length > 0) return CHOICE_OPS
  if (field.numeric) return NUMBER_OPS
  return TEXT_OPS
}

/** How many values an operator needs typed in. */
export function valuesNeeded(op: FilterOp): 0 | 1 | 2 {
  if (op === 'isEmpty' || op === 'notEmpty') return 0
  return op === 'between' ? 2 : 1
}

/**
 * A condition in words — "Visible on the till is Yes".
 *
 * Used for the chips above the list, which is why it spells the field out
 * rather than assuming the reader knows which column is being constrained. A
 * chip reading just "Yes" is unreadable on a screen with four filters.
 */
export function summarise(condition: FilterCondition, fields: readonly FilterField[]): string {
  const field = fields.find((f) => f.key === condition.field)
  const label = field?.label ?? condition.field
  const op = OP_LABELS[condition.op] ?? condition.op

  if (valuesNeeded(condition.op) === 0) return `${label} ${op}`

  // A choice field stores the VALUE but reads as its label.
  const pretty = (raw: string) => field?.options.find((o) => o.value === raw)?.label ?? raw

  if (condition.op === 'between') {
    return `${label} ${op} ${pretty(condition.value ?? '')} and ${pretty(condition.value2 ?? '')}`
  }
  return `${label} ${op} ${pretty(condition.value ?? '')}`
}

/** Is this condition worth sending to the server? Mirrors isComplete in listFilters. */
export function isConditionComplete(c: FilterCondition): boolean {
  if (valuesNeeded(c.op) === 0) return true
  if (c.op === 'between') return !!c.value && !!c.value2
  return !!c.value
}
