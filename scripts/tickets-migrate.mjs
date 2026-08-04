// Applies sql/tickets/*.sql to the ticketing database (odyssey_tickets), once each.
//
//   node --env-file=.env scripts/tickets-migrate.mjs [--dry-run]
//
// That database holds cp2_sites / cp2_site_databases / cp2_user_sites and is
// SHARED WITH THE v2 BACKEND. Every migration here must therefore be additive:
// create new cp2_* tables, never alter or drop what is already there. --dry-run
// prints what would run and touches nothing.
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import mysql from 'mysql2/promise'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = path.join(root, 'sql', 'tickets')
const dryRun = process.argv.includes('--dry-run')

const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  multipleStatements: true,
})

const [[{ d }]] = await db.query('SELECT DATABASE() AS d')
console.log(`ticketing db: ${process.env.DB_HOST}:${process.env.DB_PORT}/${d}`)

// Own migration ledger, named apart from anything the v2 backend may keep.
await db.query(`
  CREATE TABLE IF NOT EXISTS cp2_ai_migrations (
    name       VARCHAR(190) NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`)

const [applied] = await db.query('SELECT name FROM cp2_ai_migrations')
const done = new Set(applied.map((r) => r.name))
const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()

let ran = 0
for (const file of files) {
  if (done.has(file)) continue

  if (dryRun) {
    console.log(`  would apply ${file}`)
    ran++
    continue
  }

  const sql = await readFile(path.join(migrationsDir, file), 'utf8')
  process.stdout.write(`  applying ${file} ... `)
  try {
    // DDL auto-commits in MySQL, so a wrapping transaction would not roll a
    // failed migration back. Each file must be safe to fix and re-run by hand;
    // it is recorded only once it fully succeeds.
    await db.query(sql)
    await db.query('INSERT INTO cp2_ai_migrations (name) VALUES (?)', [file])
    console.log('ok')
    ran++
  } catch (err) {
    console.log('FAILED')
    console.error('  ' + err.message)
    await db.end()
    process.exit(1)
  }
}

console.log(ran ? `${ran} migration(s) ${dryRun ? 'pending' : 'applied'}` : 'already up to date')
await db.end()
