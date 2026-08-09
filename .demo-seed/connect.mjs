// Connects to a site's own database exactly as scripts/site-migrate.mjs does.
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

export async function siteConnection(siteId) {
  const control = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  })
  const [rows] = await control.query(
    `SELECT server_host, server_port, database_name, db_username, db_password_enc
       FROM cp2_site_databases WHERE site_id = ? AND status = 'active' ORDER BY purpose LIMIT 1`,
    [siteId],
  )
  await control.end()
  if (!rows.length) throw new Error(`no active database row for site ${siteId}`)
  const r = rows[0]
  const host = process.env.SITE_DB_HOST_OVERRIDE || r.server_host
  return mysql.createConnection({
    host,
    port: Number(r.server_port || 3306),
    user: r.db_username,
    password: decryptSecret(r.db_password_enc),
    database: r.database_name,
    multipleStatements: false,
  })
}
