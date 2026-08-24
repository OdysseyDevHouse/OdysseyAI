/**
 * What the departments screen actually renders from: nesting depth and colour,
 * plus which store each site is, so a screenshot can be pointed at the site
 * that has a tree.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-department-tree.ts
 *
 * The list restyle leans on both — the Sub N badge and the indent need a nested
 * row to be visible at all, and the colour cell needs a stored value to be
 * anything but the fallback swatch. A screenshot of a flat, uncoloured site
 * proves neither works.
 */
import { siteQuery } from '../src/lib/siteDb'
import { query as controlQuery } from '../src/lib/db'

async function main() {
  try {
    const sites = await controlQuery<any>(
      `SELECT id, company_name, trading_name FROM cp2_sites ORDER BY id`,
    )
    console.log('sites:')
    for (const s of sites) console.log(`   #${s.id} ${s.trading_name ?? s.company_name}`)
  } catch (e: any) {
    console.log('sites: ' + e.message)
  }

  for (const site of [1, 2, 3]) {
    try {
      const rows = await siteQuery<any>(
        site,
        `SELECT id, parent_id, name, color, pos_image_id, is_active
           FROM departments ORDER BY sort_order, name`,
      )
      const nested = rows.filter((r: any) => r.parent_id !== null).length
      const coloured = rows.filter((r: any) => r.color !== null && r.color !== '').length
      const pics = rows.filter((r: any) => r.pos_image_id).length
      const depth2 = rows.filter((r: any) => {
        const p = rows.find((x: any) => x.id === r.parent_id)
        return p && p.parent_id !== null
      }).length
      console.log(
        `site ${site}: ${rows.length} departments, ${nested} nested (${depth2} at depth 2+), ${coloured} coloured, ${pics} with a picture`,
      )
    } catch (e: any) {
      console.log(`site ${site}: ${e.message}`)
    }
  }
  process.exit(0)
}
void main()
