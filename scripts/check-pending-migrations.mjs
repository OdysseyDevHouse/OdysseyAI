// Read-only check: are the sql/tickets/ migrations actually applied to the
// control DB?
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// sql/tickets/ is the CONTROL database (odyssey_tickets) — one of them for the
// whole platform, holding every cp2_* table. Unlike sql/site/, which has
// site-migrate.mjs, this directory has NO RUNNER: each file is applied by hand.
// So it is easy to ship a build that depends on one the database has never
// seen, and to find out from a 500 rather than from a deploy step.
//
// This asks information_schema and changes nothing.
//
//   node --env-file=.env scripts/check-pending-migrations.mjs
//
// Exits 1 when anything is missing, so a deploy can gate on it.
//
// ── HOW TO ADD ONE ──────────────────────────────────────────────────────────
//
// Append to CHECKS. Name the cheapest thing that PROVES the file ran — the
// table it creates, or a column it adds. A check that would pass against a
// half-applied migration is worse than no check, because it reports safety.
import mysql from 'mysql2/promise'

/**
 * What to look for, per migration.
 *
 * `table` alone asserts the table exists. Adding `columns` asserts those
 * columns exist ON it, which is what catches a file that was edited AFTER it
 * was applied — a real hazard here, since these are recorded by nothing and a
 * re-run of CREATE TABLE IF NOT EXISTS is a silent no-op.
 */
const CHECKS = [
  {
    file: '019_site_connection_type',
    table: 'cp2_sites',
    columns: ['connection_type'],
  },
  {
    file: '020_device_trials',
    table: 'cp2_device_trials',
  },
  {
    file: '021_ai_credits',
    table: 'cp2_ai_credit_ledger',
    // The wallet is a ledger plus its in-flight top-ups; both come from 021 and
    // the app reads both, so either alone is a half-applied file.
    also: ['cp2_ai_topup_pending'],
  },
  {
    file: '022_ai_usage_idempotency',
    table: 'cp2_ai_usage_keys',
    columns: ['idempotency_key', 'account_id', 'ledger_id'],
    // The UNIQUE index IS the migration. A table with the column and no unique
    // key would let a retried AI call charge twice while every column check
    // above passed — see the file's own header.
    unique: 'uq_auk_key',
  },
]

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectTimeout: 10000,
})

const db = process.env.DB_NAME
console.log(`control database: ${db} on ${process.env.DB_HOST}\n`)

async function tableExists(name) {
  const [rows] = await conn.execute(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [db, name],
  )
  return rows.length > 0
}

async function columnsOn(table, wanted) {
  const [rows] = await conn.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [db, table],
  )
  const have = new Set(rows.map((r) => r.COLUMN_NAME))
  return wanted.filter((c) => !have.has(c))
}

/** Is the named index present AND actually unique? */
async function uniqueIndex(table, indexName) {
  const [rows] = await conn.execute(
    `SELECT NON_UNIQUE FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [db, table, indexName],
  )
  if (rows.length === 0) return 'missing'
  // NON_UNIQUE = 0 means unique. A non-unique index of the right name would
  // look present and guard nothing.
  return Number(rows[0].NON_UNIQUE) === 0 ? 'ok' : 'not unique'
}

let missing = 0

for (const check of CHECKS) {
  const problems = []

  if (!(await tableExists(check.table))) {
    problems.push(`${check.table} is missing`)
  } else {
    if (check.columns) {
      const gone = await columnsOn(check.table, check.columns)
      if (gone.length) problems.push(`${check.table} lacks ${gone.join(', ')}`)
    }
    if (check.unique) {
      const state = await uniqueIndex(check.table, check.unique)
      if (state !== 'ok') problems.push(`index ${check.unique} is ${state}`)
    }
  }

  for (const t of check.also ?? []) {
    if (!(await tableExists(t))) problems.push(`${t} is missing`)
  }

  const ok = problems.length === 0
  if (!ok) missing++
  console.log(`${ok ? 'APPLIED    ' : 'NOT APPLIED'}  ${check.file}`)
  for (const p of problems) console.log(`               ${p}`)
}

if (missing) {
  console.log(
    `\n${missing} migration(s) missing. A build that expects these will fail at ` +
      `runtime against this database.\nsql/tickets/ has no runner — apply them by hand, ` +
      `then run this again.`,
  )
}

await conn.end()
process.exit(missing ? 1 : 0)
