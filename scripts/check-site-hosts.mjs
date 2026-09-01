// Read-only: where does each site's TRADING database actually live?
//
// Sign-in only proves the CONTROL database is reachable. Every screen that shows
// stock, sales or customers connects somewhere else again — siteDb.ts resolves
// that host from the site's own row. A desktop install on a machine that cannot
// reach that host signs in perfectly and then dies on the first real page.
//
//   node --env-file=.env scripts/check-site-hosts.mjs
import mysql from 'mysql2/promise'
import { decryptSecret } from './lib/controlDb.mjs'

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: decryptSecret(process.env.DB_PASSWORD),
  database: process.env.DB_NAME,
  connectTimeout: 10000,
})

const [rows] = await conn.query(
  `SELECT d.id, d.site_id, d.purpose, d.location_name, d.server_host,
          d.server_port, d.database_name, d.db_username, d.status, s.connection_type,
          CASE WHEN d.db_password_enc IS NULL OR d.db_password_enc = '' THEN 0 ELSE 1 END AS has_pw
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
  const reserved = ['root','mysql','mariadb.sys','mariadb'].includes(String(r.db_username||'').toLowerCase())
  console.log(`     db_username     : ${r.db_username || '(none)'}${reserved ? '   <-- RESERVED, setup will refuse' : ''}`)
  console.log(`     password stored : ${r.has_pw ? 'yes' : 'NO'}`)
  console.log('')
}

await conn.end()
