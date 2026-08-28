/**
 * The compiled filter, cross-checked against hand-written SQL, for all three
 * master lists.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-list-filter-all.ts
 *
 * Products was proved when it was built; this adds customers and suppliers,
 * whose tables carry different aliases and — for customers — may be the shared
 * file of another site. A filter that compiles is not the claim; one that
 * returns the RIGHT rows is.
 */
import { siteQuery } from '../src/lib/siteDb'
import { customerQuery, supplierQuery } from '../src/lib/site/customerDb'
import { compileListFilters, filterableFields } from '../src/lib/site/listFilterSql'
import { decodeFilters } from '../src/lib/listFilters'

const SITE = Number(process.argv[2] ?? 33)
const allowAll = () => true

let failures = 0
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

type Runner = (sql: string, params: unknown[]) => Promise<number>

async function suite(
  sourceKey: string,
  table: string,
  alias: string,
  run: Runner,
  cases: { encoded: string; rawWhere: string; rawParams?: unknown[]; label: string }[],
) {
  console.log(`\n── ${sourceKey} ──`)
  const fields = filterableFields(sourceKey, allowAll)
  const allowed = new Set(fields.map((f) => f.key))
  console.log(`filterable fields: ${fields.length}`)

  const total = await run(`SELECT COUNT(*) n FROM ${table} ${alias}`, [])
  console.log(`rows on file: ${total}`)
  if (total === 0) {
    console.log('SKIP: nothing on file, every assertion here would be vacuous')
    return
  }

  for (const c of cases) {
    const compiled = compileListFilters(sourceKey, decodeFilters(c.encoded), allowAll, allowed, alias)
    if (compiled.dropped.length) {
      failures++
      console.log(`FAIL  ${c.label} — dropped ${JSON.stringify(compiled.dropped)}`)
      continue
    }
    const where = compiled.where.length ? `WHERE ${compiled.where.join(' AND ')}` : ''
    const got = await run(`SELECT COUNT(*) n FROM ${table} ${alias} ${where}`, compiled.params)
    const want = await run(
      `SELECT COUNT(*) n FROM ${table} ${alias} ${c.rawWhere}`,
      c.rawParams ?? [],
    )
    check(`${c.label} (${got} rows)`, got, want)
  }

  // An unknown field must be dropped, never compiled.
  const bogus = compileListFilters(sourceKey, decodeFilters('noSuchField:eq:x'), allowAll, allowed, alias)
  check('unknown field dropped', bogus.dropped, ['noSuchField'])
  check('unknown field adds no clause', bogus.where.length, 0)

  /* A value carrying SQL syntax is bound, not executed.
     Filtered on a field this source actually HAS — `code` is on all three.
     Using one it lacks would drop the condition and prove nothing, which is
     exactly the vacuous pass this check exists to avoid. */
  const injectField = allowed.has('code') ? 'code' : [...allowed][0]
  const evil = compileListFilters(
    sourceKey,
    decodeFilters(`${injectField}:eq:${encodeURIComponent("' OR 1=1 --")}`),
    allowAll,
    allowed,
    alias,
  )
  check('injection filter was actually applied', evil.where.length, 1)
  const evilWhere = evil.where.length ? `WHERE ${evil.where.join(' AND ')}` : ''
  const evilCount = await run(`SELECT COUNT(*) n FROM ${table} ${alias} ${evilWhere}`, evil.params)
  check('injected value matches nothing', evilCount, 0)
  check('table intact after injection', await run(`SELECT COUNT(*) n FROM ${table} ${alias}`, []), total)
}

async function main() {
  const site: Runner = async (sql, params) =>
    Number((await siteQuery<any>(SITE, sql, params))[0].n)
  const cust: Runner = async (sql, params) =>
    Number((await customerQuery<any>(SITE, sql, params))[0].n)
  const supp: Runner = async (sql, params) =>
    Number((await supplierQuery<any>(SITE, sql, params))[0].n)

  await suite('products', 'products', 'p', site, [
    { label: 'visibleInPos is Yes', encoded: 'visibleInPos:eq:Yes', rawWhere: 'WHERE p.visible_in_pos = 1' },
    { label: 'productType is normal', encoded: 'productType:eq:normal', rawWhere: "WHERE p.product_type = 'normal'" },
  ])

  await suite('customers', 'customers', 'c', cust, [
    { label: 'status is active', encoded: 'status:eq:active', rawWhere: "WHERE c.status = 'active'" },
    { label: 'balance > 0', encoded: 'balance:gt:0', rawWhere: 'WHERE c.balance > 0' },
    { label: 'name contains a', encoded: 'name:contains:a', rawWhere: 'WHERE c.name LIKE ?', rawParams: ['%a%'] },
    { label: 'email is empty', encoded: 'email:isEmpty', rawWhere: "WHERE (c.email IS NULL OR c.email = '')" },
  ])

  await suite('suppliers', 'suppliers', 's', supp, [
    { label: 'status is active', encoded: 'status:eq:active', rawWhere: "WHERE s.status = 'active'" },
    { label: 'termsDays >= 30', encoded: 'termsDays:gte:30', rawWhere: 'WHERE s.payment_terms_days >= 30' },
    { label: 'city is not empty', encoded: 'city:notEmpty', rawWhere: "WHERE (s.city IS NOT NULL AND s.city <> '')" },
  ])

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
