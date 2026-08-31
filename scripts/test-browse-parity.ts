/**
 * The offline department grid must match the online one, product for product.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-browse-parity.ts
 *
 * PosShell now browses from IndexedDB instead of calling browseProductsAction,
 * so `browseOffline`'s own subtree walk has become the definition of "what is in
 * this department" on every till. tillSearch.ts warned about exactly this — "a
 * second definition of what beneath means" — so the walk is checked against the
 * recursive CTE it mirrors, on every department of a real site.
 *
 * A mismatch is a till whose grid disagrees with the desktop's, which is the one
 * thing a shop running mixed devices must never see.
 */
import { siteQuery } from '../src/lib/siteDb'
import { browseForTill } from '../src/lib/site/tillSearch'

const SITE = Number(process.env.SITE || 33)
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** The walk from catalog.ts, over the same department rows the till stores. */
function subtree(departments: { id: number; parentId: number | null }[], departmentId: number): number[] {
  if (departments.length === 0) return [departmentId]
  const childrenOf = new Map<number, number[]>()
  for (const d of departments) {
    if (d.parentId === null || d.parentId === undefined) continue
    const kids = childrenOf.get(d.parentId)
    if (kids) kids.push(d.id)
    else childrenOf.set(d.parentId, [d.id])
  }
  const seen = new Set<number>([departmentId])
  const queue = [departmentId]
  while (queue.length > 0) {
    const next = queue.pop()!
    for (const child of childrenOf.get(next) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  return [...seen]
}

async function main() {
  const rows = await siteQuery<any>(SITE, `SELECT id, parent_id FROM departments`)
  const departments = rows.map((r) => ({ id: Number(r.id), parentId: r.parent_id === null ? null : Number(r.parent_id) }))
  console.log(`site ${SITE}: ${departments.length} departments\n`)

  let nested = 0
  for (const d of departments) {
    // The server's own answer for "which departments are beneath this one".
    const cte = await siteQuery<any>(
      SITE,
      `WITH RECURSIVE tree (id) AS (
         SELECT ? UNION ALL
         SELECT c.id FROM departments c JOIN tree t ON c.parent_id = t.id
       ) SELECT id FROM tree`,
      [d.id],
    )
    const server = [...new Set(cte.map((r: any) => Number(r.id)))].sort((a, b) => a - b)
    const local = subtree(departments, d.id).sort((a, b) => a - b)
    if (server.length > 1) nested++
    if (JSON.stringify(server) !== JSON.stringify(local)) {
      ok(`dept ${d.id} subtree`, false, `server ${server.join(',')} vs local ${local.join(',')}`)
    }
  }
  ok(`every department's subtree matches the server CTE`, fails === 0)
  ok(`the site actually HAS nested departments (else this proves nothing)`, nested > 0, `${nested} departments have children`)

  /* The walk is only half of it — the grid is what a cashier sees. Compare the
     product ids browseForTill returns against the ids the subtree scope yields,
     filtered the way browseOffline filters (groups, not their members). */
  const sample = departments.slice(0, 6)
  for (const d of sample) {
    const online = await browseForTill(SITE, { departmentId: d.id, limit: 200, includeVariantParents: true })
    const scope = subtree(departments, d.id)
    const localRows = await siteQuery<any>(
      SITE,
      `SELECT id FROM products
        WHERE department_id IN (${scope.map(() => '?').join(',')})
          AND is_archived = 0 AND visible_in_pos = 1 AND parent_id IS NULL`,
      scope,
    )
    const onlineIds = new Set(online.map((p) => p.id))
    const localIds = new Set(localRows.map((r: any) => Number(r.id)))
    const missing = [...onlineIds].filter((i) => !localIds.has(i))
    ok(
      `dept ${String(d.id).padStart(4)} grid: ${onlineIds.size} online vs ${localIds.size} in local scope`,
      missing.length === 0,
      missing.length ? `online has ${missing.length} the local scope misses` : '',
    )
  }

  console.log(fails === 0 ? '\nAll parity checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
