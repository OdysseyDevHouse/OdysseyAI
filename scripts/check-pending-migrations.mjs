// Read-only check: are sql/tickets/019 and 020 actually applied to the control DB?
//
// Both are untracked in git and neither has an obvious runner, so it is easy for
// a build to ship code that depends on them while the database has never seen
// them. This asks information_schema and changes nothing.
//
//   node --env-file=.env scripts/check-pending-migrations.mjs
import mysql from 'mysql2/promise'

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectTimeout: 10000,
})

console.log(`control database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`)

const [cols] = await conn.execute(
  `SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'cp2_sites'
      AND COLUMN_NAME IN ('connection_type', 'backoffice_type')`,
  [process.env.DB_NAME],
)
const names = cols.map((r) => r.COLUMN_NAME)
const has019 = names.includes('connection_type')
console.log(`019_site_connection_type : ${has019 ? 'APPLIED' : 'NOT APPLIED'}`)
console.log(`   cp2_sites has: ${names.join(', ') || '(neither column)'}`)

const [tbls] = await conn.execute(
  `SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'cp2_device_trials'`,
  [process.env.DB_NAME],
)
const has020 = tbls.length > 0
console.log(`\n020_device_trials        : ${has020 ? 'APPLIED' : 'NOT APPLIED'}`)
console.log(`   cp2_device_trials table ${has020 ? 'exists' : 'is missing'}`)

if (!has019 || !has020) {
  console.log('\nA build that expects these will fail at runtime against this database.')
}

await conn.end()
