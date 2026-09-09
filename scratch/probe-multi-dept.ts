/**
 * Checks the two SQL paths widened for the multi-select department filter:
 * browseForTill's recursive CTE and listProducts' departmentIds.
 *
 * Asks each for one department, then the other, then both — the union has to
 * equal the two singles put together, and picking a PARENT has to include its
 * children. Scratch, not a suite: it prints what it saw so a vacuous pass on an
 * empty catalogue cannot read as a green tick.
 */
import { listDepartments } from '../src/lib/site/departments'
import { browseForTill } from '../src/lib/site/tillSearch'
import { listProducts } from '../src/lib/site/products'
import { departmentFilterIds, parseDepartmentParam } from '../src/lib/site/departments'

async function main() {
  const SITE = Number(process.env.PROBE_SITE ?? 33)

  const departments = await listDepartments(SITE, true)
  console.log(`site ${SITE}: ${departments.length} departments`)

  // Two departments that actually hold products, so the counts mean something.
  const counts = new Map<number, number>()
  for (const d of departments) {
    const { total } = await listProducts(SITE, { departmentIds: [d.id], limit: 1 })
    if (total > 0) counts.set(d.id, total)
  }
  const stocked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  console.log('departments holding products:', stocked.length)
  if (stocked.length < 2) {
    console.log('SKIP — need two stocked departments to test a union')
    process.exit(0)
  }

  const [a, an] = stocked[0]
  const [b, bn] = stocked[1]
  const nameOf = (id: number) => departments.find((d) => d.id === id)?.name ?? String(id)
  console.log(`A = ${nameOf(a)} (${an})   B = ${nameOf(b)} (${bn})`)

  let failures = 0
  const check = (label: string, ok: boolean, saw: string) => {
    console.log(`${ok ? 'PASS' : '**FAIL**'}  ${label} -- ${saw}`)
    if (!ok) failures++
  }

  // ── listProducts with several ids ────────────────────────────────────────
  const both = await listProducts(SITE, { departmentIds: [a, b], limit: 500 })
  check(
    'listProducts A+B is the two singles unioned',
    both.total === an + bn,
    `${an} + ${bn} = ${an + bn}, got ${both.total}`,
  )

  // ── browseForTill's recursive CTE, one seed then two ─────────────────────
  const tillA = await browseForTill(SITE, { departmentIds: [a], limit: 5000 })
  const tillB = await browseForTill(SITE, { departmentIds: [b], limit: 5000 })
  const tillBoth = await browseForTill(SITE, { departmentIds: [a, b], limit: 5000 })
  const union = new Set([...tillA.map((p) => p.id), ...tillB.map((p) => p.id)])
  check(
    'browseForTill A+B is the two singles unioned',
    tillBoth.length === union.size,
    `A=${tillA.length} B=${tillB.length} union=${union.size} both=${tillBoth.length}`,
  )

  // The legacy single-id argument must still work, and agree with the new one.
  const legacy = await browseForTill(SITE, { departmentId: a, limit: 5000 })
  check(
    'browseForTill still honours the single departmentId',
    legacy.length === tillA.length,
    `single=${legacy.length} vs list=${tillA.length}`,
  )

  // Duplicated ids must not double-count.
  const doubled = await browseForTill(SITE, { departmentIds: [a, a], departmentId: a, limit: 5000 })
  check(
    'a repeated department does not duplicate rows',
    doubled.length === tillA.length,
    `${doubled.length} vs ${tillA.length}`,
  )

  // No department at all must not filter.
  const unfiltered = await browseForTill(SITE, { departmentIds: [], limit: 5000 })
  check(
    'an empty department list does not filter',
    unfiltered.length >= tillBoth.length,
    `all=${unfiltered.length} >= both=${tillBoth.length}`,
  )

  // ── A PARENT covers its children ─────────────────────────────────────────
  const parent = departments.find((d) => departments.some((c) => c.parentId === d.id))
  if (!parent) {
    console.log('note: no nested departments on this site — parent widening not exercised here')
  } else {
    const kids = departments.filter((d) => d.parentId === parent.id)
    const viaParent = departmentFilterIds(departments, [parent.id]) ?? []
    check(
      'picking a parent covers its children',
      kids.every((k) => viaParent.includes(k.id)),
      `${parent.name} -> ${viaParent.length} ids, ${kids.length} direct children`,
    )
    const p = await listProducts(SITE, { departmentIds: viaParent, limit: 1 })
    const own = await listProducts(SITE, { departmentIds: [parent.id], limit: 1 })
    check(
      'a parent branch holds at least what the parent alone holds',
      p.total >= own.total,
      `branch=${p.total} parent-only=${own.total}`,
    )
  }

  // ── The URL parameter ────────────────────────────────────────────────────
  check('parses a comma list', parseDepartmentParam('3,8,12').join(',') === '3,8,12', 'ok')
  check('parses one bare id (old links)', parseDepartmentParam('7').join(',') === '7', 'ok')
  check('drops junk and dedupes', parseDepartmentParam('3,,x,3,-1,0,8').join(',') === '3,8', 'ok')
  check('empty means no filter', parseDepartmentParam(undefined).length === 0, 'ok')
  check('nothing picked means null, not []', departmentFilterIds(departments, []) === null, 'ok')

  console.log(failures ? `\n${failures} FAILED` : '\nAll passed')
  process.exit(failures ? 1 : 0)

}

main()
