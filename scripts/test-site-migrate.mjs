/**
 * electron/siteMigrate.js — does it actually build a site database?
 *
 * The interesting failure is not a broken SQL file; it is the module reporting
 * success against a database it never touched. That is what the setup wizard
 * would have done before sql/ was packaged, and it looks exactly like a good
 * install until somebody opens the products screen.
 *
 * So this creates a scratch database, migrates it, and asserts that real tables
 * exist afterwards — then migrates it AGAIN and asserts nothing ran the second
 * time, because a technician re-running Setup on a live shop must not reapply a
 * schema to data.
 *
 *   node --env-file=.env scripts/test-site-migrate.mjs
 *
 * Needs a server it may CREATE DATABASE on. The control-panel credentials are
 * deliberately scoped and usually cannot, so point it somewhere it can:
 *
 *   MIGRATE_TEST_HOST=127.0.0.1 MIGRATE_TEST_USER=root MIGRATE_TEST_PASSWORD=...
 *
 * Falling back to DB_* when those are unset. It creates one scratch database,
 * drops it at the end, and never touches a real site's data.
 *
 * Without such a server it SKIPS rather than fails — a developer without a
 * local MariaDB should not see a red test they cannot act on. It says so
 * loudly, because a test that quietly passes without running is the exact
 * failure this file exists to catch.
 */
import mysql from 'mysql2/promise'
import { applyMigrations, ensureDatabase, migrationsDir } from '../electron/siteMigrate.js'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const SCRATCH = 'odyssey_migrate_selftest'

console.log('\nSite migrations\n')
console.log(`  reading ${migrationsDir('site')}\n`)

const base = {
  host: process.env.MIGRATE_TEST_HOST || process.env.DB_HOST,
  port: Number(process.env.MIGRATE_TEST_PORT || process.env.DB_PORT || 3306),
  user: process.env.MIGRATE_TEST_USER || process.env.DB_USER,
  password: process.env.MIGRATE_TEST_PASSWORD ?? process.env.DB_PASSWORD,
  multipleStatements: true,
}

function skip(why) {
  console.log(`  SKIPPED — ${why}`)
  console.log(`  Set MIGRATE_TEST_HOST / _USER / _PASSWORD to a server you may`)
  console.log(`  create a database on, and this becomes a real test.
`)
  process.exit(0)
}

let server
try {
  server = await mysql.createConnection(base)
  await server.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``)
  await ensureDatabase(server, SCRATCH)
} catch (err) {
  await server?.end().catch(() => {})
  if (err.code === 'ER_DBACCESS_DENIED_ERROR' || err.code === 'ER_SPECIFIC_ACCESS_DENIED_ERROR') {
    skip(`${base.user}@${base.host} may not create databases`)
  }
  if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
    skip(`nothing answering at ${base.host}:${base.port}`)
  }
  throw err
}
await server.end()

const db = await mysql.createConnection({ ...base, database: SCRATCH })

try {
  const ran = await applyMigrations(db)
  check('a fresh database applies every migration', ran > 200, `applied ${ran}`)

  const [tables] = await db.query('SHOW TABLES')
  check('it has tables afterwards', tables.length > 100, `${tables.length} tables`)

  /* The two this plan actually depends on: sign-in reads `users`, and every
     screen behind it reads something the schema created. */
  const names = new Set(tables.map((t) => Object.values(t)[0]))
  check('the users table exists', names.has('users'))
  check('the roles table exists', names.has('roles'))

  const [cols] = await db.query(`SHOW COLUMNS FROM users`)
  const colNames = new Set(cols.map((c) => c.Field))
  check('users carries the PIN credential', colNames.has('pin_hash'))
  check('users carries a name to sign in with', colNames.has('name'))

  const again = await applyMigrations(db)
  check('a second run applies nothing', again === 0, `applied ${again}`)
} catch (err) {
  check('migrations ran without throwing', false, err.message)
} finally {
  await db.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``).catch(() => {})
  await db.end().catch(() => {})
}

console.log(`\n${failures === 0 ? 'All site-migrate checks passed.' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
