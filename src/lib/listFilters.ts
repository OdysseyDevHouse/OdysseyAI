/**
 * Advanced filters on a LIST screen.
 *
 * The three master lists — products, customers, suppliers — each answer a
 * handful of built-in questions through their toolbar: a search box, a slice,
 * a department. Anything else used to mean building a report, which is a
 * different screen, a different mental model, and no help at all when the
 * answer is "now go and edit these ten products".
 *
 * This module is what lets a list answer an arbitrary question and then BE a
 * worklist. It deliberately owns none of the vocabulary:
 *
 *   - The FIELDS come from the report builder's catalog. `visibleInPos`,
 *     `productType`, `stockOnHand` and every other filterable column are
 *     already defined there, with their labels, types and value lists.
 *   - The OPERATORS are the report builder's FilterOp.
 *   - The SQL is compiled by the report builder's own clause builder.
 *
 * A second filter vocabulary would drift from the first within a release, and
 * the report one is already hardened: user text reaches SQL only as a bound
 * parameter, and a field key that is not in the catalog compiles to nothing.
 *
 * ── WHAT THIS FILE IS ──────────────────────────────────────────────────────
 *
 * Only the URL codec and the shape. Compiling to SQL is server-side and lives
 * in lib/site/listFilterSql.ts; this module is imported by client components
 * and must stay free of database code.
 */

import type { FilterOp } from './reportBuilder/spec'
import { FILTER_OPS } from './reportBuilder/spec'

/**
 * One condition. Structurally the report builder's SpecFilter, and deliberately
 * assignable to it — the SQL compiler takes that type, and a separate-but-equal
 * interface here would be a cast waiting to happen.
 */
export interface ListFilter {
  field: string
  op: FilterOp
  value?: string
  value2?: string
}

/**
 * How many conditions one list may carry.
 *
 * Lower than the report builder's 20 on purpose. This rides in a URL that gets
 * mailed and bookmarked, and a list narrowed by twelve conditions is a report,
 * not a worklist — at that point the builder is the better screen and says so.
 */
export const MAX_LIST_FILTERS = 12

/** The query-string key. One parameter holds the whole filter set. */
export const FILTER_PARAM = 'f'

/**
 * ── THE WIRE FORMAT ────────────────────────────────────────────────────────
 *
 * `field:op:value:value2`, conditions joined by `~`.
 *
 * Chosen over JSON because this is a URL a person may look at and a support
 * agent may read down the phone. `?f=visibleInPos:eq:Yes` says what it does;
 * the JSON equivalent is forty percent punctuation once encoded.
 *
 * Values are percent-encoded individually, so a value containing `:` or `~`
 * survives the round trip. Everything else about the format is fixed-position,
 * which is what keeps parsing total: a malformed condition is DROPPED rather
 * than throwing, because a hand-edited URL should show a list, not an error.
 */
const CONDITION_SEP = '~'
const PART_SEP = ':'

/**
 * Percent-encode a part, INCLUDING the two separators.
 *
 * encodeURIComponent leaves `~` alone — it is an unreserved character in
 * RFC 3986 — so a value containing one would split into two conditions and the
 * tail would be read as a second filter. `:` it does escape inside a component,
 * but both are spelled out here rather than relying on that: the separators are
 * this format's business, and the day one of them changes, this is the only
 * place that has to know.
 */
function encodePart(value: string): string {
  return encodeURIComponent(value)
    .replace(/~/g, '%7E')
    .replace(/:/g, '%3A')
}

export function encodeFilters(filters: readonly ListFilter[]): string {
  return filters
    .slice(0, MAX_LIST_FILTERS)
    .map((f) =>
      [
        encodePart(f.field),
        encodePart(f.op),
        encodePart(f.value ?? ''),
        encodePart(f.value2 ?? ''),
      ]
        // A trailing empty value2 (and value) is noise on the common case of
        // "is not empty" or a one-value comparison.
        .join(PART_SEP)
        .replace(/:+$/, ''),
    )
    .join(CONDITION_SEP)
}

/**
 * Parse what the URL carried.
 *
 * Total by construction: anything unrecognised is skipped. The op is checked
 * against the known list HERE so that a junk operator never reaches the SQL
 * compiler's switch — that switch returns null on an unknown op, but relying on
 * that would make this function's output a lie about what it contains.
 *
 * The FIELD is deliberately NOT checked here: this module has no catalog, and
 * validating a key against the wrong source's fields would be worse than not
 * validating at all. The server resolves each field against the source it is
 * actually querying, and drops what it cannot find. See listFilterSql.ts.
 */
export function decodeFilters(raw: string | null | undefined): ListFilter[] {
  if (!raw) return []
  const out: ListFilter[] = []

  for (const chunk of raw.split(CONDITION_SEP)) {
    if (!chunk) continue
    const parts = chunk.split(PART_SEP)
    if (parts.length < 2) continue

    const field = safeDecode(parts[0])
    const op = safeDecode(parts[1]) as FilterOp
    if (!field || !FILTER_OPS.includes(op)) continue

    const filter: ListFilter = { field, op }
    const value = parts.length > 2 ? safeDecode(parts[2]) : ''
    const value2 = parts.length > 3 ? safeDecode(parts[3]) : ''
    if (value) filter.value = value
    if (value2) filter.value2 = value2

    out.push(filter)
    if (out.length >= MAX_LIST_FILTERS) break
  }

  return out
}

/** decodeURIComponent throws on a malformed escape; a bad chunk is not fatal. */
function safeDecode(part: string | undefined): string {
  if (!part) return ''
  try {
    return decodeURIComponent(part)
  } catch {
    return ''
  }
}

/**
 * Is this condition complete enough to mean anything?
 *
 * A half-built row — a field chosen, no value typed yet — must not narrow the
 * list, or the results jump around while someone is still composing. The panel
 * keeps such rows on screen; the query ignores them.
 */
export function isComplete(f: ListFilter): boolean {
  if (f.op === 'isEmpty' || f.op === 'notEmpty') return true
  if (f.op === 'between') return !!f.value && !!f.value2
  return !!f.value
}

/** Only the conditions worth sending to SQL. */
export function completeFilters(filters: readonly ListFilter[]): ListFilter[] {
  return filters.filter(isComplete)
}
