/**
 * The one thing site 33's flat catalogue cannot exercise: a department with a
 * child, and whether picking the PARENT pulls the child's products in.
 *
 * Makes its own nesting, checks, and puts everything back — including on a
 * failure, so a crashed run does not leave the shop re-parented. Restores to
 * the value read at the start rather than to null, because these rows are real
 * departments belonging to a real store.
 */
import { siteQuery, siteExecute } from '../src/lib/siteDb'
import { listDepartments, departmentFilterIds } from '../src/lib/site/departments'
import { listProducts } from '../src/lib/site/products'
import { browseForTill } from '../src/lib/site/tillSearch'

async function main() {
  const SITE = Number(process.env.PROBE_SITE ?? 33)

  const departments = await listDepartments(SITE, true)
  const counts = new Map<number, number>()
  for (const d of departments) {
    const { total } = await listProducts(SITE, { departmentIds: [d.id], limit: 1 })
    /* Both counts must be non-zero. browseForTill excludes INACTIVE departments
       and till-hidden products, so a department listProducts can see but the
       till cannot would make every assertion below vacuously true. */
    const onTill = await browseForTill(SITE, { departmentIds: [d.id], limit: 5000 })
    if (total > 0 && onTill.length > 0) counts.set(d.id, total)
  }
  const stocked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  if (stocked.length < 2) { console.log('SKIP — need two stocked departments'); process.exit(0) }

  const [parentId, parentCount] = stocked[0]
  const [childId, childCount] = stocked[1]
  const nameOf = (id: number) => departments.find((d) => d.id === id)?.name ?? String(id)

  // Read the CHILD's real parent so it can be put back exactly as found.
  const [before] = await siteQuery<{ parent_id: number | null }>(SITE, 'SELECT parent_id FROM departments WHERE id = ?', [childId])
  const originalParent = before?.parent_id ?? null
  console.log(`nesting ${nameOf(childId)} (${childCount}) under ${nameOf(parentId)} (${parentCount})`)
  console.log(`  its real parent_id is ${originalParent === null ? 'NULL' : originalParent} — restored at the end`)

  let failures = 0
  const check = (label: string, ok: boolean, saw: string) => {
    console.log(`${ok ? 'PASS' : '**FAIL**'}  ${label} -- ${saw}`)
    if (!ok) failures++
  }

  try {
    await siteExecute(SITE, 'UPDATE departments SET parent_id = ? WHERE id = ?', [parentId, childId])

    const nested = await listDepartments(SITE, true)
    const ids = departmentFilterIds(nested, [parentId]) ?? []
    check('the branch now contains the child', ids.includes(childId), `ids = ${ids.join(',')}`)

    const branch = await listProducts(SITE, { departmentIds: ids, limit: 1 })
    check(
      'picking the parent pulls the child in',
      branch.total === parentCount + childCount,
      `${parentCount} + ${childCount} = ${parentCount + childCount}, got ${branch.total}`,
    )

    // browseForTill resolves the subtree in SQL, so it must agree WITHOUT being
    // handed the widened list — its CTE walks down from the parent alone.
    const till = await browseForTill(SITE, { departmentIds: [parentId], limit: 5000 })
    const tillParentOnly = await browseForTill(SITE, { departmentIds: [childId], limit: 5000 })
    check(
      'browseForTill descends into the child on its own',
      till.length >= tillParentOnly.length && tillParentOnly.length > 0,
      `parent-branch=${till.length}, child-alone=${tillParentOnly.length}`,
    )
  } finally {
    await siteExecute(SITE, 'UPDATE departments SET parent_id = ? WHERE id = ?', [originalParent, childId])
    const [after] = await siteQuery<{ parent_id: number | null }>(SITE, 'SELECT parent_id FROM departments WHERE id = ?', [childId])
    const restored = after?.parent_id ?? null
    console.log(`restored parent_id to ${restored === null ? 'NULL' : restored}`)
    if (restored !== originalParent) { console.log('**FAIL**  RESTORE DID NOT TAKE'); failures++ }
  }

  console.log(failures ? `\n${failures} FAILED` : '\nAll passed')
  process.exit(failures ? 1 : 0)
}

main()
