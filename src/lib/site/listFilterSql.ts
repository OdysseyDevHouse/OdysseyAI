import 'server-only'
import type { Capability } from './permissions'
import { getSource, canSeeField, type CatalogSource } from '../reportBuilder/catalog'
import { filterClause } from '../reportBuilder/run'
import { completeFilters, type ListFilter } from '../listFilters'

/**
 * Compiling a list screen's advanced filters into SQL.
 *
 * The list queries (listProducts and friends) build a `where[]` of fragments
 * and a matching `params[]`. This turns a filter set into more of exactly that,
 * so a screen gains arbitrary filtering without its query being restructured.
 *
 * ── WHY THIS IS SAFE ───────────────────────────────────────────────────────
 *
 * Two separate guarantees, and both matter:
 *
 *   1. The COLUMN is never user input. A filter names a catalog field KEY; the
 *      SQL expression it compiles to is authored in catalog.ts. A key that is
 *      not in the source is dropped, so a hand-edited URL cannot name a column,
 *      a table, or a subquery.
 *
 *   2. The VALUE is never concatenated. filterClause emits `?` placeholders and
 *      hands the values back as bound parameters, with LIKE wildcards escaped.
 *
 * The clause builder is the report engine's own, imported rather than copied —
 * see filterClause in reportBuilder/run.ts.
 *
 * ── THE JOIN PROBLEM ───────────────────────────────────────────────────────
 *
 * A catalog field's expression is written against that source's aliases: the
 * products source reads a department name as `pd.name`, which only resolves if
 * `LEFT JOIN departments pd` is in the query. The list screens do not have
 * those joins and should not grow them — listProducts is a hot query and
 * bolting six LEFT JOINs onto it to support an occasional filter would make
 * every unfiltered page load pay for the feature.
 *
 * So a field is only offered when it resolves against the list's OWN table.
 * `filterableFields` is the gate, and it is applied on both sides: the panel
 * only shows what can be filtered, and this compiler drops anything else. See
 * that function for what a screen has to state.
 */

/** Fragments to AND into a list query's WHERE, with their bound values. */
export interface CompiledFilters {
  where: string[]
  params: unknown[]
  /** Field keys that were asked for but could not be applied. */
  dropped: string[]
}

/**
 * Compile a filter set against a catalog source.
 *
 * `allowedFields` is the screen's own allowlist — the fields whose expressions
 * resolve against the table this list actually queries. Anything outside it is
 * dropped and reported, never silently ignored: a filter that vanishes without
 * a word makes a list look like it has the wrong data in it.
 */
export function compileListFilters(
  sourceKey: string,
  filters: readonly ListFilter[],
  allow: (c: Capability) => boolean,
  allowedFields: ReadonlySet<string>,
  /**
   * The alias the CALLING query gives the primary table.
   *
   * Catalog expressions are written against `t`, which is what the report
   * engine aliases every source to. The list queries predate that and use their
   * own — listProducts has been `FROM products p` since long before this
   * feature — so the expression has to be re-pointed on the way through.
   *
   * A rename rather than a rewrite: only a `t.` prefix is replaced, and the
   * value is an internal constant from the calling module, never user input.
   */
  primaryAlias = 't',
): CompiledFilters {
  const out: CompiledFilters = { where: [], params: [], dropped: [] }

  const source = getSource(sourceKey)
  if (!source) return out

  for (const filter of completeFilters(filters)) {
    const field = source.fields.find((f) => f.key === filter.field)

    // Unknown key, a column this user may not read, or one whose expression
    // needs a join this list does not have. All three are the same outcome.
    if (!field || !canSeeField(field, allow) || !allowedFields.has(field.key)) {
      out.dropped.push(filter.field)
      continue
    }

    const clause = filterClause(retarget(field.expr, primaryAlias), filter)
    if (!clause) {
      out.dropped.push(filter.field)
      continue
    }

    out.where.push(clause.sql)
    out.params.push(...clause.params)
  }

  return out
}

/**
 * Point a catalog expression at the calling query's table alias.
 *
 * `t.visible_in_pos` becomes `p.visible_in_pos` for listProducts. Matched on a
 * word boundary so `t.` is only replaced where it is genuinely the alias — a
 * column called `format.t` or a literal containing "t." is left alone.
 *
 * Both inputs are authored in this codebase: the expression comes from the
 * catalog and the alias from the calling module. Neither is ever user text, so
 * this is a readability concern rather than a safety one — but it is written
 * narrowly anyway, because the day someone passes a request value in here the
 * narrow version fails closed.
 */
function retarget(expr: string, alias: string): string {
  if (alias === 't') return expr
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) return expr
  return expr.replace(/\bt\./g, `${alias}.`)
}

/**
 * Which of a source's fields a list screen can actually filter on.
 *
 * A field qualifies when its expression needs no joins beyond the ones the list
 * query already has. `needs` is the catalog's own declaration of that, so this
 * is a question the catalog can answer rather than a list someone maintains by
 * hand and forgets to update when a field is added.
 *
 * `availableJoins` is what the calling screen already joins, by the catalog's
 * join names. A screen that joins nothing passes an empty set and gets the
 * fields that read straight off its own table — which for products is most of
 * them, including every column the two questions that started this feature
 * ask about ("visible on the till", "product type").
 */
export function filterableFields(
  sourceKey: string,
  allow: (c: Capability) => boolean,
  availableJoins: ReadonlySet<string> = new Set(),
): CatalogSource['fields'] {
  const source = getSource(sourceKey)
  if (!source) return []

  return source.fields.filter((f) => {
    if (!canSeeField(f, allow)) return false
    // No `needs` means it reads off the primary table alias, which every list
    // query has by definition.
    if (!f.needs?.length) return true
    return f.needs.every((join) => availableJoins.has(join))
  })
}
