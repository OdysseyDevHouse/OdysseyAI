// One-time repair: compact layby document numbers after years of test litter
// (suites deleted laybys without winding the sequence back). Renumbers the
// surviving rows contiguously in id order and resets the sequence to match, so
// verifySequence('layby') starts from a truthful zero. Dev sites only — the
// system has no live customers yet; on a live site this would be forbidden
// (a document number, once issued, is issued).
import mysql from 'mysql2/promise'
import { createDecipheriv, scryptSync } from 'node:crypto'

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
     FROM cp2_site_databases WHERE status = 'active' ORDER BY site_id`,
)
await control.end()

for (const s of sites) {
  const db = await mysql.createConnection({
    host: s.server_host,
    port: Number(s.server_port || 3306),
    user: s.db_username,
    password: decryptSecret(s.db_password_enc),
    database: s.database_name,
  })
  const [rows] = await db.query(
    'SELECT id FROM laybys WHERE document_number IS NOT NULL ORDER BY id',
  )
  const [[seqRow]] = await db.query(
    "SELECT prefix, padding FROM document_sequences WHERE doc_type = 'layby' AND terminal_id = 0",
  )
  if (!seqRow) { console.log(`site ${s.site_id}: no layby sequence, skipped`); await db.end(); continue }
  let n = 0
  for (const r of rows) {
    n += 1
    const num = `${seqRow.prefix}${String(n).padStart(Number(seqRow.padding), '0')}`
    await db.query('UPDATE laybys SET document_number = ? WHERE id = ?', [num, r.id])
  }
  await db.query(
    `UPDATE document_sequences SET next_number = ?, last_issued_number = ?
      WHERE doc_type = 'layby' AND terminal_id = 0`,
    [n + 1, n === 0 ? null : n],
  )
  console.log(`site ${s.site_id}: ${n} layby number(s) compacted, sequence reset to ${n + 1}`)
  await db.end()
}
