import { siteQuery } from '../src/lib/siteDb'
import { query as controlQuery } from '../src/lib/db'

async function main() {
  const [site] = await controlQuery<any>(`SELECT id FROM cp2_sites ORDER BY id LIMIT 1`)
  const rows = await siteQuery<any>(
    site.id,
    `SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE ct FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE='decimal' AND NUMERIC_SCALE=3
      ORDER BY TABLE_NAME, COLUMN_NAME`,
  )
  const wide = rows.filter((r: any) => !/\(6,3\)/.test(r.ct))
  const narrow = rows.filter((r: any) => /\(6,3\)/.test(r.ct))

  // Does any (12,3)/(14,3) column look like a rate rather than a quantity?
  const suspicious = wide.filter((r: any) => /pct|percent|rate|multiplier|margin/i.test(r.c))
  console.log('wide (candidate quantity) columns: ' + wide.length)
  console.log('  suspicious (rate-like names): ' + JSON.stringify(suspicious.map((r: any) => `${r.t}.${r.c}`)))

  // Does any (6,3) column look like a quantity?
  const missed = narrow.filter((r: any) => /qty|quantity|stock|pack_size|factor/i.test(r.c))
  console.log('narrow (6,3) columns: ' + narrow.length)
  console.log('  quantity-like among them: ' + JSON.stringify(missed.map((r: any) => `${r.t}.${r.c}`)))
  process.exit(0)
}
main()
