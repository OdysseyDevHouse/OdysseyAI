/**
 * What a department tap costs, server-side.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-browse-cost.ts
 *
 * The till fetches a department's products with browseProductsAction on EVERY
 * tap while online (PosShell's browse effect), even though the same rows are
 * already in this device's IndexedDB. This measures the query that costs — so
 * the local-first change can be argued from numbers rather than from reading.
 *
 * Every figure here is a FLOOR for what a tablet waits on: it excludes auth,
 * RSC serialisation and the network hop, which are the parts a remote tablet
 * over shop wifi feels most.
 */
import { siteQuery } from '../src/lib/siteDb'
import { browseForTill } from '../src/lib/site/tillSearch'

async function main() {
  const site = Number(process.env.SITE || 1)

  const total = await siteQuery<any>(site, `SELECT COUNT(*) AS n FROM products`)
  console.log(`site ${site}: ${total[0].n} products total`)

  const depts = await siteQuery<any>(
    site,
    `SELECT d.id, d.name, COUNT(p.id) AS products
       FROM departments d LEFT JOIN products p ON p.department_id = d.id
      GROUP BY d.id, d.name
      ORDER BY products DESC
      LIMIT 6`,
  )
  if (depts.length === 0) return console.log('no departments on this site')

  console.log('\ndepartment                         products   browseForTill')
  for (const d of depts) {
    const t0 = performance.now()
    let rows: any[] = []
    let err = ''
    try {
      rows = await browseForTill(site, { departmentId: d.id, limit: 200, includeVariantParents: true })
    } catch (e: any) {
      err = e.message
    }
    const ms = performance.now() - t0
    const name = String(d.name).slice(0, 32).padEnd(32)
    const cnt = String(d.products).padStart(8)
    console.log(`${name} ${cnt}   ${err ? 'ERR ' + err : ms.toFixed(1) + 'ms → ' + rows.length + ' rows, ' + (JSON.stringify(rows).length / 1024).toFixed(1) + ' KB'}`)
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
