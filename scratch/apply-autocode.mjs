// Turns the three master-data autocode settings ON for every active site.
// 062_master_data_codes.sql now seeds '1', but INSERT IGNORE leaves the rows
// already present on a migrated site untouched — so those need this.
import { createDecipheriv, scryptSync } from 'node:crypto'
import mysql from 'mysql2/promise'

const PREFIX = 'enc:v1:'
function decryptSecret(stored) {
  if (!stored) return ''
  if (!stored.startsWith(PREFIX)) return stored
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':').map((s) => Buffer.from(s, 'base64'))
  const key = scryptSync(process.env.ENCRYPTION_KEY, 'odyssey-secret-v1', 32)
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

const control = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
})

const [sites] = await control.query(
  `SELECT site_id, server_host, server_port, database_name, db_username, db_password_enc
     FROM cp2_site_databases
    WHERE status = 'active' AND purpose <> 'hybrid'
    ORDER BY site_id, purpose = 'master' DESC`,
)
await control.end()

const seen = new Set()
const KEYS = ['autocode_customer', 'autocode_supplier', 'autocode_product']

for (const s of sites) {
  if (seen.has(s.site_id)) continue
  seen.add(s.site_id)
  const conn = await mysql.createConnection({
    host: s.server_host,
    port: Number(s.server_port || 3306),
    user: s.db_username,
    password: decryptSecret(s.db_password_enc),
    database: s.database_name,
  })
  const before = {}
  for (const k of KEYS) {
    const [r] = await conn.query('SELECT setting_value FROM settings WHERE setting_key = ?', [k])
    before[k] = r[0]?.setting_value ?? '(absent)'
  }
  for (const k of KEYS) {
    await conn.query(
      `INSERT INTO settings (setting_key, setting_value) VALUES (?, '1')
       ON DUPLICATE KEY UPDATE setting_value = '1'`,
      [k],
    )
  }
  const after = {}
  for (const k of KEYS) {
    const [r] = await conn.query('SELECT setting_value FROM settings WHERE setting_key = ?', [k])
    after[k] = r[0]?.setting_value ?? '(absent)'
  }
  console.log(`site ${s.site_id} (${s.database_name})`)
  for (const k of KEYS) console.log(`   ${k}: ${before[k]} -> ${after[k]}`)
  await conn.end()
}
console.log(`\n${seen.size} site(s) updated.`)
