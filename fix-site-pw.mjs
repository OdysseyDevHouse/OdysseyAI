// One-off: re-encrypt site 1 "master" credentials with the current ENCRYPTION_KEY.
//
//   node --env-file=.env fix-site-pw.mjs
//
// The stored db_password_enc decrypts to a stale password the server rejects.
// This rewrites that single column using DB_PASSWORD from .env, encrypted with
// the same enc:v1 envelope the v2 backend uses, so both apps can still read it.
import mysql from 'mysql2/promise'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const SITE_ID = 1
const PURPOSE = 'master'

const PREFIX = 'enc:v1:'
const SALT = 'odyssey-secret-v1'

function key() {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw || !raw.trim()) throw new Error('ENCRYPTION_KEY is not set.')
  return scryptSync(raw, SALT, 32) // raw, untrimmed — must match the backend
}

function encryptSecret(plain) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(), iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return PREFIX + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join(':')
}

function decryptSecret(stored) {
  if (!stored || !stored.startsWith(PREFIX)) return stored ?? ''
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':').map((s) => Buffer.from(s, 'base64'))
  const d = createDecipheriv('aes-256-gcm', key(), iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

const password = process.env.DB_PASSWORD
if (!password) throw new Error('DB_PASSWORD is not set in .env — nothing to store.')

const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
})

const [[row]] = await db.query(
  `SELECT server_host, server_port, database_name, db_username, db_password_enc
     FROM cp2_site_databases WHERE site_id = ? AND purpose = ?`,
  [SITE_ID, PURPOSE],
)
if (!row) throw new Error(`No cp2_site_databases row for site ${SITE_ID} "${PURPOSE}".`)

const host = process.env.SITE_DB_HOST_OVERRIDE?.trim() || row.server_host
const port = row.server_port || 3306

// Prove the new password works against the real target BEFORE writing it.
const probe = await mysql.createConnection({
  host,
  port,
  user: row.db_username || '',
  password,
  database: row.database_name,
})
const [[who]] = await probe.query('SELECT DATABASE() d, CURRENT_USER() u')
await probe.end()
console.log(`verified: ${host}:${port}/${who.d} connects as ${who.u}`)

console.log(`old stored value: ${row.db_password_enc}`)

const [res] = await db.execute(
  `UPDATE cp2_site_databases SET db_password_enc = ?
    WHERE site_id = ? AND purpose = ?`,
  [encryptSecret(password), SITE_ID, PURPOSE],
)
console.log(`rows affected: ${res.affectedRows}`)

// Read back and round-trip through decrypt, then connect with what we stored.
const [[after]] = await db.query(
  `SELECT db_password_enc FROM cp2_site_databases WHERE site_id = ? AND purpose = ?`,
  [SITE_ID, PURPOSE],
)
const roundTripped = decryptSecret(after.db_password_enc)
console.log(`round-trip decrypt matches DB_PASSWORD: ${roundTripped === password}`)

const final = await mysql.createConnection({
  host,
  port,
  user: row.db_username || '',
  password: roundTripped,
  database: row.database_name,
})
const [[ok]] = await final.query('SELECT DATABASE() d, CURRENT_USER() u')
console.log(`reconnect with stored credential: OK -> db=${ok.d} as=${ok.u}`)
await final.end()

await db.end()
