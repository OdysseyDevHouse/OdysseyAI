// Applies sql/migrations/*.sql in filename order, once each.
//
// Run with:  npm run db:migrate     (loads .env via node --env-file)
//
// Creates the database if it doesn't exist, so a fresh clone needs only a
// running MySQL/MariaDB and DB_* credentials.
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import mysql from 'mysql2/promise'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = path.join(root, 'sql', 'migrations')

const {
  DB_HOST = 'localhost',
  DB_PORT = '3306',
  DB_NAME = 'odysseyai',
  DB_USER = 'root',
  DB_PASSWORD = '',
} = process.env

const base = {
  host: DB_HOST,
  port: Number(DB_PORT),
  user: DB_USER,
  password: DB_PASSWORD,
  multipleStatements: true,
}

// Identifier, not a value — it can't be parameterised, so constrain the charset.
if (!/^[A-Za-z0-9_]+$/.test(DB_NAME)) {
  throw new Error(`DB_NAME must be alphanumeric/underscore, got: ${DB_NAME}`)
}

const server = await mysql.createConnection(base)
await server.query(
  `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
)
await server.end()

const db = await mysql.createConnection({ ...base, database: DB_NAME })

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
  process.stdout.write(`[migrate] applying ${file} ... `)
  try {
    // DDL in MySQL/MariaDB auto-commits, so a wrapping transaction wouldn't
    // roll a failed migration back. Each file must therefore be safe to fix
    // and re-run by hand; we record it only once it fully succeeds.
    await db.query(sql)
    await db.query('INSERT INTO schema_migrations (name) VALUES (?)', [file])
    console.log('ok')
    ran++
  } catch (err) {
    console.log('FAILED')
    console.error(err.message)
    await db.end()
    process.exit(1)
  }
}

console.log(ran ? `[migrate] ${ran} migration(s) applied` : '[migrate] already up to date')
await db.end()
