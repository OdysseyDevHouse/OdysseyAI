import type { Mapping } from './map'
import type {
  Cell, ExistingMode, ImportField, ImportSpec, LookupTables,
} from './spec'

/**
 * Checking a file without writing anything.
 *
 * Pure, and that is the whole point of the module. The same function runs in
 * the browser to show the review screen and on the server before each batch is
 * written, so what the user approved and what gets written are checked by
 * identical code rather than by two implementations that agree today.
 *
 * Every row lands in exactly one of `ready`, `skipped` or `problems`. Nothing
 * is dropped: a row the import will not act on is a row the user needs to see,
 * because "18,000 imported" over a file of 20,000 is a number nobody can act
 * on. Opening balances makes the same argument and it is the right one.
 */

export type PlannedRow = {
  /** Source file line, so a problem names a row the user can go and look at. */
  line: number
  /** The match key's value — a product code, a customer code. */
  code: string
  draft: Record<string, unknown>
  /** The record this row matched, if any. */
  existingId: number | null
}

export type PlanProblem = {
  line: number
  code: string
  /** The heading the trouble is in, where it belongs to one column. */
  column?: string
  /** What the cell actually said, so the message can be checked against it. */
  value?: string
  reason: string
}

/**
 * Values a lookup field could not resolve, grouped.
 *
 * One unknown brand across 340 rows is one thing to fix, not 340 problems, and
 * a review screen that lists it 340 times buries everything else. Grouping is
 * what makes "create these 6 brands" an offer the screen can make.
 */
export type UnresolvedGroup = {
  kind: string
  /** The column the values came from. */
  column: string
  values: { value: string; rows: number }[]
}

export type ImportPlan = {
  ready: PlannedRow[]
  /** Matched an existing record, and the run is in 'skip' mode. */
  skipped: PlannedRow[]
  problems: PlanProblem[]
  unresolved: UnresolvedGroup[]
  counts: { total: number; create: number; update: number; skip: number; problem: number }
}

export function planImport<T>(
  spec: ImportSpec<T>,
  fields: readonly ImportField<T>[],
  lookups: LookupTables,
  mapping: Mapping,
  rows: readonly string[][],
  headers: readonly string[],
  mode: ExistingMode,
  /** Line of the header row, so reported lines match the source file. */
  headerLine = 1,
): ImportPlan {
  const ready: PlannedRow[] = []
  const skipped: PlannedRow[] = []
  const problems: PlanProblem[] = []
  const unresolved = new Map<string, Map<string, { column: string; rows: number }>>()

  // Two rows claiming the same code would race: the first creates it, the
  // second finds it existing and either skips or overwrites what the first just
  // wrote. Either way the file contradicts itself, so it is reported.
  const seen = new Map<string, number>()

  rows.forEach((row, index) => {
    const line = headerLine + 1 + index
    const draft: Record<string, unknown> = {}
    const rowProblems: PlanProblem[] = []
    let code = ''

    for (const field of fields) {
      const column = mapping[field.key]
      if (column == null) continue

      const text = row[column] ?? ''
      const cell: Cell = { text, line }

      if (!text) {
        // A required field left blank is caught HERE rather than at apply time.
        // Both refuse the row, but only this one refuses it before anything has
        // been written and while the review screen can still show it next to
        // the rows that would have gone in.
        if (field.required) {
          rowProblems.push({
            line,
            code: '',
            column: headers[column] ?? field.label,
            reason: `${field.label} is empty, and it is needed.`,
          })
          continue
        }
        // Otherwise a blank clears only where the field says so. The default
        // protects a sheet where some rows carry a value and some simply do not.
        if (field.blankClears) draft[field.key] = null
        continue
      }

      const outcome = field.parse(cell, lookups)
      if (outcome.kind === 'problem') {
        rowProblems.push({
          line,
          code: '',
          column: headers[column] ?? field.label,
          value: text,
          reason: outcome.reason,
        })
        if (field.lookup) {
          const byKind = unresolved.get(field.lookup) ?? new Map()
          const entry = byKind.get(text) ?? { column: headers[column] ?? field.label, rows: 0 }
          entry.rows += 1
          byKind.set(text, entry)
          unresolved.set(field.lookup, byKind)
        }
      } else if (outcome.kind === 'value') {
        draft[field.key] = outcome.value
        if (field.key === spec.matchKey) code = String(outcome.value ?? '')
      }
    }

    if (rowProblems.length > 0) {
      problems.push(...rowProblems.map((p) => ({ ...p, code })))
      return
    }

    // Columns become a record here, so validateRow and applyRow both see the
    // nested shape and neither has to know how the mapping was spelled.
    const nested = spec.nest ? spec.nest(draft) : draft

    const crossField = spec.validateRow?.(nested, lookups)
    if (crossField) {
      problems.push({ line, code, reason: crossField })
      return
    }

    const key = code.trim().toUpperCase()

    if (key) {
      const firstLine = seen.get(key)
      if (firstLine !== undefined) {
        problems.push({
          line,
          code,
          reason: `The same ${spec.matchKey} is on line ${firstLine} of this file as well. Remove one of them.`,
        })
        return
      }
      seen.set(key, line)
    }

    // A blank match key can match nothing, so it is always a create — the code
    // is generated on save. Worth being explicit about, because a file with an
    // empty code column would otherwise quietly create 20,000 auto-coded rows.
    const existingId = key ? (lookups.existingIdByCode.get(key) ?? null) : null
    const planned: PlannedRow = { line, code, draft: nested, existingId }

    if (existingId !== null && mode === 'skip') skipped.push(planned)
    else ready.push(planned)
  })

  return {
    ready,
    skipped,
    problems,
    unresolved: [...unresolved.entries()].map(([kind, values]) => ({
      kind,
      column: [...values.values()][0]?.column ?? '',
      values: [...values.entries()]
        .map(([value, { rows: count }]) => ({ value, rows: count }))
        .sort((a, b) => b.rows - a.rows),
    })),
    counts: {
      total: rows.length,
      create: ready.filter((r) => r.existingId === null).length,
      update: ready.filter((r) => r.existingId !== null).length,
      skip: skipped.length,
      problem: problems.length,
    },
  }
}
