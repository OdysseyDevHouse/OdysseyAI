/** Which site looks like the tablet's shop: product and department counts per site. */
import { query as controlQuery } from '../src/lib/db'
import { siteQuery } from '../src/lib/siteDb'

async function main() {
  const sites = await controlQuery<any>(`SELECT id, trading_name, company_name FROM cp2_sites ORDER BY id`)
  for (const s of sites) {
    try {
      const p = await siteQuery<any>(s.id, `SELECT COUNT(*) AS n FROM products`)
      const d = await siteQuery<any>(s.id, `SELECT COUNT(*) AS n FROM departments`)
      console.log(`#${String(s.id).padStart(3)} ${String(s.trading_name ?? s.company_name).slice(0, 28).padEnd(28)} ${String(p[0].n).padStart(7)} products  ${String(d[0].n).padStart(4)} depts`)
    } catch (e: any) {
      console.log(`#${String(s.id).padStart(3)} ${String(s.trading_name ?? s.company_name).slice(0, 28).padEnd(28)} — ${e.message.slice(0, 40)}`)
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
