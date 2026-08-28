/**
 * Does an advanced filter actually narrow the product list correctly?
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-list-filter-sql.ts
 *
 * Runs the compiled WHERE against a real site and cross-checks every count
 * against a hand-written query for the same question. A filter that compiles is
 * not the claim; a filter that returns the RIGHT rows is.
 *
 * Also proves the two guarantees that matter: an unknown field key is dropped
 * rather than reaching SQL, and a value carrying SQL syntax is bound, not
 * concatenated.
 */
import { siteQuery } from '../src/lib/siteDb'
import { compileListFilters, filterableFields } from '../src/lib/site/listFilterSql'
import { decodeFilters, encodeFilters } from '../src/lib/listFilters'

const SITE = Number(process.argv[2] ?? 33)
const allowAll = () => true

let failures = 0
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

/** Count products through the compiled filter path. */
async function countVia(encoded: string): Promise<{ n: number; dropped: string[] }> {
  const filters = decodeFilters(encoded)
  const allowed = new Set(filterableFields('products', allowAll).map((f) => f.key))
  const c = compileListFilters('products', filters, allowAll, allowed, 'p')
  const where = c.where.length ? `WHERE ${c.where.join(' AND ')}` : ''
  const rows = await siteQuery<any>(
    SITE,
    `SELECT COUNT(*) AS n FROM products p ${where}`,
    c.params,
  )
  return { n: Number(rows[0].n), dropped: c.dropped }
}

/** The same question, written by hand. */
async function countRaw(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await siteQuery<any>(SITE, `SELECT COUNT(*) AS n FROM products p ${sql}`, params)
  return Number(rows[0].n)
}

async function main() {
  console.log(`--- site ${SITE} ---`)

  const total = await countRaw('')
  console.log(`products on file: ${total}`)
  if (total === 0) {
    console.error('ABORT: no products; every assertion below would be vacuous')
    process.exit(1)
  }

  // 1. The literal question that started this feature.
  const posWanted = await countRaw('WHERE p.visible_in_pos = 1')
  const pos = await countVia('visibleInPos:eq:Yes')
  console.log(`"visible on the till" -> ${pos.n} of ${total}`)
  check('visibleInPos:eq:Yes matches hand-written count', pos.n, posWanted)

  // 2. The other one: product type.
  const normalWanted = await countRaw("WHERE p.product_type = 'normal'")
  const normal = await countVia('productType:eq:normal')
  check('productType:eq:normal matches', normal.n, normalWanted)

  // 3. Two conditions AND together.
  const bothWanted = await countRaw(
    "WHERE p.visible_in_pos = 1 AND p.product_type = 'normal'",
  )
  const both = await countVia('visibleInPos:eq:Yes~productType:eq:normal')
  check('two filters AND correctly', both.n, bothWanted)
  if (both.n > pos.n) { failures++; console.log('FAIL  AND widened the result') }

  // 4. A numeric comparison.
  const sohWanted = await countRaw('WHERE p.stock_on_hand > ?', ['0'])
  const soh = await countVia('stockOnHand:gt:0')
  check('stockOnHand:gt:0 matches', soh.n, sohWanted)

  // 5. contains, with LIKE wildcards escaped.
  const likeWanted = await countRaw('WHERE p.description LIKE ?', ['%a%'])
  const like = await countVia('description:contains:a')
  check('description:contains:a matches', like.n, likeWanted)

  // 6. An unknown field must be DROPPED, not compiled.
  const bogus = await countVia('notARealField:eq:x')
  check('unknown field dropped', bogus.dropped, ['notARealField'])
  check('unknown field does not narrow', bogus.n, total)

  // 7. Injection: the value is bound, so this matches nothing and harms nothing.
  const evil = await countVia(
    `description:eq:${encodeURIComponent("' OR 1=1 --")}`,
  )
  console.log(`injection attempt returned ${evil.n} row(s) (want 0, and the table intact)`)
  check('injected value is bound, not executed', evil.n, 0)
  check('table still intact after injection attempt', await countRaw(''), total)

  // 8. The codec round-trips, including a value containing its own separators.
  const tricky = [{ field: 'description', op: 'contains' as const, value: 'a:b~c' }]
  check('encode/decode round trip', decodeFilters(encodeFilters(tricky)), tricky)

  // Both separators, a percent sign, a space and a two-value comparison —
  // everything that could be mistaken for structure.
  const nasty = [
    { field: 'description', op: 'between' as const, value: '10%~x', value2: 'a:b c' },
    { field: 'code', op: 'eq' as const, value: 'A~B:C' },
  ]
  check('separators inside values survive', decodeFilters(encodeFilters(nasty)), nasty)

  // A malformed escape must not throw — a hand-edited URL shows a list.
  check('malformed escape is survivable', Array.isArray(decodeFilters('description:eq:%ZZ')), true)

  // The cap holds.
  const many = Array.from({ length: 30 }, () => ({
    field: 'code',
    op: 'eq' as const,
    value: 'x',
  }))
  check('filter count capped', decodeFilters(encodeFilters(many)).length, 12)

  // 9. A half-built row must not narrow anything.
  const partial = await countVia('description:contains:')
  check('incomplete filter ignored', partial.n, total)

  // 10. A field needing a join this list lacks is not offered.
  const offered = new Set(filterableFields('products', allowAll).map((f) => f.key))
  check('joinless list is not offered department (needs a join)', offered.has('department'), false)
  check('...but is offered visibleInPos', offered.has('visibleInPos'), true)
  console.log(`filterable fields without joins: ${offered.size}`)

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
