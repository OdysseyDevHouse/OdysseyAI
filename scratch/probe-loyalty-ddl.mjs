// Read-only: the full DDL of the OLD loyalty tables on one site, plus what
// migrations that site has recorded.
//
//   node --env-file=.env scratch/probe-loyalty-ddl.mjs <siteId>
import { createDecipheriv, scryptSync } from 'node:crypto'
import mysql from 'mysql2/promise'

const PREFIX = 'enc:v1:'
function dec(s) {
  if (!s) return ''
  if (!s.startsWith(PREFIX)) return s
  const [iv, tag, ct] = s.slice(PREFIX.length).split(':').map((x) => Buffer.from(x, 'base64'))
  const k = scryptSync(process.env.ENCRYPTION_KEY, 'odyssey-secret-v1', 32)
  const d = createDecipheriv('aes-256-gcm', k, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

const siteId = Number(process.argv[2] || 5)

const c = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: +(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: dec(process.env.DB_PASSWORD),
  database: process.env.DB_NAME,
  connectTimeout: 15000,
})

const [[db]] = await c.query(
  `SELECT database_name FROM cp2_site_databases
    WHERE site_id = ? AND purpose = 'master' AND status = 'active' LIMIT 1`,
  [siteId],
)
console.log('database:', db.database_name)

const [tabs] = await c.query(
  `SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE 'loyalty%' ORDER BY TABLE_NAME`,
  [db.database_name],
)
for (const t of tabs) {
  const [[row]] = await c.query(`SHOW CREATE TABLE \`${db.database_name}\`.\`${t.TABLE_NAME}\``)
  console.log('\n' + row['Create Table'] + ';')
  const [[n]] = await c.query(`SELECT COUNT(*) n FROM \`${db.database_name}\`.\`${t.TABLE_NAME}\``)
  console.log(`-- rows: ${n.n}`)
}

const [mig] = await c.query(
  `SELECT name, COALESCE(applied_at, '') applied_at FROM \`${db.database_name}\`.schema_migrations
    ORDER BY name DESC LIMIT 8`,
)
console.log('\nlast migrations recorded:')
for (const m of mig) console.log(' ', m.name, m.applied_at)

await c.end()
