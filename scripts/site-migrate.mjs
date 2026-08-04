// Applies sql/site/*.sql to a site's own database, once each.
//
//   node --env-file=.env scripts/site-migrate.mjs <siteId> [--probe]
//
// Connection details come from cp2_site_databases in the control database, with
// the password decrypted exactly as the app does — so this runner and the
// running app can never disagree about where a site's data lives.
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createDecipheriv, scryptSync } from 'node:crypto'
import mysql from 'mysql2/promise'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = path.join(root, 'sql', 'site')

const siteId = Number(process.argv[2])
const probeOnly = process.argv.includes('--probe')

if (!Number.isFinite(siteId) || siteId <= 0) {
  console.error('Usage: node --env-file=.env scripts/site-migrate.mjs <siteId> [--probe]')
  process.exit(1)
}

// Mirrors src/lib/crypto/secrets.ts.
const PREFIX = 'enc:v1:'
function decryptSecret(stored) {
  if (!stored) return ''
  if (!stored.startsWith(PREFIX)) return stored
  const [iv, tag, ct] = stored
    .slice(PREFIX.length)
    .split(':')
    .map((s) => Buffer.from(s, 'base64'))
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

const [rows] = await control.query(
  `SELECT purpose, server_host, server_port, database_name, db_username, db_password_enc
     FROM cp2_site_databases
    WHERE site_id = ? AND status = 'active'
    ORDER BY purpose LIMIT 1`,
  [siteId],
)
await control.end()

if (!rows.length) {
  console.error(`No active database configured for site ${siteId}.`)
  process.exit(1)
}

const cfg = rows[0]
const host = process.env.SITE_DB_HOST_OVERRIDE?.trim() || cfg.server_host

let password
try {
  password = decryptSecret(cfg.db_password_enc)
} catch (e) {
  console.error(`Could not decrypt stored password — check ENCRYPTION_KEY. (${e.message})`)
  process.exit(1)
}

console.log(`site ${siteId} "${cfg.purpose}" -> ${cfg.db_username}@${host}:${cfg.server_port}/${cfg.database_name}`)

const base = {
  host,
  port: cfg.server_port || 3306,
  user: cfg.db_username || '',
  password,
  multipleStatements: true,
}

// Create the database if it isn't there yet, so a brand-new site works.
if (!/^[A-Za-z0-9_]+$/.test(cfg.database_name)) {
  console.error(`Refusing to use database name with unexpected characters: ${cfg.database_name}`)
  process.exit(1)
}

const server = await mysql.createConnection(base)
await server.query(
  `CREATE DATABASE IF NOT EXISTS \`${cfg.database_name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
)
await server.end()

const db = await mysql.createConnection({ ...base, database: cfg.database_name })

if (probeOnly) {
  const [[{ v }]] = await db.query('SELECT VERSION() AS v')
  const [tables] = await db.query('SHOW TABLES')
  console.log(`connected OK — MySQL ${v}, ${tables.length} table(s) present`)
  for (const t of tables) console.log('  ' + Object.values(t)[0])
  await db.end()
  process.exit(0)
}

await db.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name       VARCHAR(190) NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`)

const [applied] = await db.query('SELECT name FROM schema_migrations')
const done = new Set(applied.map((r) => r.name))
const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()

let ran = 0
for (const file of files) {
  if (done.has(file)) continue
  const sql = await readFile(path.join(migrationsDir, file), 'utf8')
  process.stdout.write(`  applying ${file} ... `)
  try {
    // DDL auto-commits in MySQL, so a wrapping transaction would not roll a
    // failed migration back. Each file must be safe to fix and re-run by hand;
    // it is recorded only once it fully succeeds.
    await db.query(sql)
    await db.query('INSERT INTO schema_migrations (name) VALUES (?)', [file])
    console.log('ok')
    ran++
  } catch (err) {
    console.log('FAILED')
    console.error('  ' + err.message)
    await db.end()
    process.exit(1)
  }
}

console.log(ran ? `${ran} migration(s) applied` : 'already up to date')
await db.end()
