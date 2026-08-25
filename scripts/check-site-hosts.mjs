// Read-only: where does each site's TRADING database actually live?
//
// Sign-in only proves the CONTROL database is reachable. Every screen that shows
// stock, sales or customers connects somewhere else again — siteDb.ts resolves
// that host from the site's own row. A desktop install on a machine that cannot
// reach that host signs in perfectly and then dies on the first real page.
//
//   node --env-file=.env scripts/check-site-hosts.mjs
import mysql from 'mysql2/promise'

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectTimeout: 10000,
})

const [rows] = await conn.query(
  `SELECT d.id, d.site_id, d.purpose, d.location_name, d.server_host,
          d.server_port, d.database_name, d.status, s.connection_type
     FROM cp2_site_databases d
     JOIN cp2_sites s ON s.id = d.site_id
    ORDER BY d.site_id, d.id`,
)

console.log(`${rows.length} site(s) in ${process.env.DB_NAME}\n`)
for (const r of rows) {
  const host = String(r.server_host || '')
  const isPrivate =
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === 'localhost' ||
    host === ''
  const flag = isPrivate ? '   <-- NOT REACHABLE from another machine' : ''
  console.log(`  site #${r.site_id} - ${r.location_name} (${r.purpose}, ${r.status})`)
  console.log(`     connection_type : ${r.connection_type}`)
  console.log(`     server_host     : ${host || '(empty)'}:${r.server_port}${flag}`)
  console.log(`     database_name   : ${r.database_name}`)
  console.log('')
}

await conn.end()
