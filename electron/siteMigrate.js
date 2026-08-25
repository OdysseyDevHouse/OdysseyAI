// Applying a schema to a database that has just been created.
//
// ── WHY THIS IS NOT scripts/site-migrate.mjs ────────────────────────────────
//
// It was, and the logic below is that script's, unchanged in behaviour. What
// could not be reused was its SHAPE: it reads argv, prints to stdout and calls
// process.exit on failure. None of those exist inside Electron, where the
// caller is a wizard that has to put a failure on screen rather than take the
// process down with it.
//
// So the applying half moved here and both callers share it. The script keeps
// the parts that are genuinely its own — parsing arguments, reading the control
// database, adopting users — because the setup wizard needs none of them: it
// already holds the connection details, having just been handed them by
// dbSetup/plan.ts.
//
// ── WHY THE MIGRATIONS ARE FILES BESIDE THE APP ─────────────────────────────
//
// 254 of them, and they are read once on a machine that will never see them
// again. Packed into the asar they would be read through Electron's fs shim for
// no benefit; as extraResources they sit next to the binaries the same install
// already unpacks, and a technician can look at one when a migration fails.
const fs = require('node:fs')
const path = require('node:path')
const { readdir, readFile } = require('node:fs/promises')

/**
 * Where the schema lives, dev checkout or packaged install.
 *
 * Mirrors localDb.binDir(): the repository in development, resourcesPath once
 * packaged. Same reasoning, and deliberately the same shape so the two do not
 * drift into different ideas of where the app's own files are.
 */
function migrationsDir(kind = 'site') {
  const packaged = path.join(process.resourcesPath || '', 'sql', kind)
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged
  return path.join(__dirname, '..', 'sql', kind)
}

/**
 * Apply every migration this database has not seen, in filename order.
 *
 * `connection` is an open mysql2 connection to the site's OWN database — the
 * caller owns it and closes it, because the caller usually has more to do with
 * it afterwards.
 *
 * Returns the count applied. Throws on the first failure, naming the file:
 * a wizard showing "migration 137 failed" is telling a technician something
 * they can act on, where "the schema failed" is not.
 */
async function applyMigrations(connection, { kind = 'site', onProgress } = {}) {
  const dir = migrationsDir(kind)

  /* A packaged build that shipped without its schema would otherwise report
     "already up to date" against an empty database — the worst possible
     outcome, because it looks like success. */
  if (!fs.existsSync(dir)) {
    throw new Error(
      `No ${kind} schema found at ${dir}. This build shipped without its migrations.`,
    )
  }

  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       VARCHAR(190) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  const [rows] = await connection.query('SELECT name FROM schema_migrations')
  const done = new Set(rows.map((r) => r.name))
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const pending = files.filter((f) => !done.has(f))

  let ran = 0
  for (const file of pending) {
    const sql = await readFile(path.join(dir, file), 'utf8')
    /* Counted against the pending total rather than the whole set: on a fresh
       database those are the same number, and on a re-run the technician wants
       to know how much is left, not how much history there is. */
    onProgress?.(`Applying ${file} (${ran + 1} of ${pending.length})…`)
    try {
      /* DDL auto-commits in MySQL, so a wrapping transaction would not roll a
         failed migration back. Each file must be safe to fix and re-run by
         hand; it is recorded only once it fully succeeds. */
      await connection.query(sql)
      await connection.query('INSERT INTO schema_migrations (name) VALUES (?)', [file])
      ran++
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${err.message}`)
    }
  }

  return ran
}

/**
 * Create the database itself, if this is the first time.
 *
 * Separate from applying the schema because it runs against the SERVER rather
 * than the database — you cannot connect to something that does not exist yet.
 * The name is checked rather than escaped: it arrives from the control panel,
 * and an identifier that needs quoting is a sign something is wrong upstream,
 * not something to work around here.
 */
async function ensureDatabase(serverConnection, databaseName) {
  if (!/^[A-Za-z0-9_]+$/.test(databaseName)) {
    throw new Error(`Refusing to use database name with unexpected characters: ${databaseName}`)
  }
  await serverConnection.query(
    `CREATE DATABASE IF NOT EXISTS \`${databaseName}\` ` +
      `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  )
}

module.exports = { applyMigrations, ensureDatabase, migrationsDir }
