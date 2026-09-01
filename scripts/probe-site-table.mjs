// Read-only: does the SITE connection actually see a table?
//
//   node --env-file=.env scripts/probe-site-table.mjs <siteId|dbName> [table]
//   node --env-file=.env scripts/probe-site-table.mjs ody10004_master users
//
// ── WHY THIS EXISTS RATHER THAN check-trading-dbs.mjs ──────────────────────
//
// That script answers "does the database exist", and it asks with the CONTROL
// credentials (DB_HOST/DB_USER). Every query that actually fails in the app
// goes somewhere else entirely: siteDb.ts reads host, port, database, user and
// an encrypted password out of cp2_site_databases, puts SITE_DB_HOST_OVERRIDE
// in front of the stored host, and opens a pool with THOSE. A database that is
// present and correct when the control user looks at it can still be the wrong
// machine, the wrong copy, or unreadable when the site user does.
//
// So this connects the way the app connects, and then reports what that
// connection can see. It is the difference between "the table exists" and "the
// table exists where the app is looking".
//
// ── AND WHY NOT site-migrate.mjs --probe ──────────────────────────────────
//
// The migration ledger is not evidence. On 2026-08-11 ody10000_master answered
// every query with "Table ody10000_master.products doesn't exist" while
// 001_products.sql sat in schema_migrations marked applied, so the runner
// reported "already up to date" — see the note at the top of
// sql/site/098_restore_products.sql. A table can be gone with its migration
// still recorded. Only information_schema knows.
import mysql from 'mysql2/promise'
import { createDecipheriv, scryptSync } from 'node:crypto'

const [target, table = 'users'] = process.argv.slice(2)
if (!target) {
  console.error('usage: probe-site-table.mjs <siteId|dbName> [table]')
  process.exit(1)
}

// Byte-identical to src/lib/crypto/secrets.ts. Duplicated rather than imported
// because the deployed app folder ships no TypeScript and no build of src/.
const PREFIX = 'enc:v1:'
function decryptSecret(stored) {
  if (!stored) return ''
  if (!stored.startsWith(PREFIX)) return stored
  const parts = stored.slice(PREFIX.length).split(':')
  if (parts.length !== 3) throw new Error('malformed secret')
  const [iv, tag, ct] = parts.map((s) => Buffer.from(s, 'base64'))
  const d = createDecipheriv('aes-256-gcm', scryptSync(process.env.ENCRYPTION_KEY, 'odyssey-secret-v1', 32), iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

// DB_PASSWORD may itself be an enc:v1 envelope - see the note at src/lib/db.ts
// createPool(). Sending the ciphertext raw gets "Access denied ... (using
// password: YES)", which reads as a wrong password and is not one. Plaintext
// passes through decryptSecret unchanged, so both kinds of .env work.
const control = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: decryptSecret(process.env.DB_PASSWORD),
  database: process.env.DB_NAME,
  connectTimeout: 10000,
})

const isId = /^\d+$/.test(target)
const [rows] = await control.query(
  `SELECT id, site_id, purpose, location_name, server_host, server_port,
          database_name, db_username, db_password_enc, status
     FROM cp2_site_databases
    WHERE ${isId ? 'site_id = ?' : 'database_name = ?'}
    ORDER BY purpose`,
  [isId ? Number(target) : target],
)
await control.end()

if (!rows.length) {
  console.log(`No cp2_site_databases row matches ${target}.`)
  process.exit(0)
}

const override = process.env.SITE_DB_HOST_OVERRIDE?.trim()
console.log(`SITE_DB_HOST_OVERRIDE = ${override || '(not set - stored host used as-is)'}\n`)

for (const r of rows) {
  const host = override || r.server_host
  console.log(`── site #${r.site_id} "${r.purpose}" (${r.location_name}, ${r.status})`)
  console.log(`   stored host   : ${r.server_host}:${r.server_port || 3306}`)
  console.log(`   connecting to : ${host}:${r.server_port || 3306}`)
  console.log(`   database      : ${r.database_name}`)
  console.log(`   as user       : ${r.db_username || '(none)'}`)

  let pw
  try {
    pw = decryptSecret(r.db_password_enc)
  } catch (e) {
    console.log(`   PASSWORD      : COULD NOT DECRYPT - ${e.message}`)
    console.log(`   (ENCRYPTION_KEY does not match the backend that wrote this row.)\n`)
    continue
  }

  let conn
  try {
    conn = await mysql.createConnection({
      host,
      port: r.server_port || 3306,
      user: r.db_username || '',
      password: pw,
      database: r.database_name,
      connectTimeout: 10000,
    })
  } catch (e) {
    console.log(`   CONNECT FAILED: ${e.code} ${e.message}\n`)
    continue
  }

  // Which server did we actually land on? A stored host of "localhost" plus an
  // override pointing somewhere unexpected is exactly how two people end up
  // looking at two different databases with the same name.
  const [[who]] = await conn.query(
    'SELECT @@hostname AS server, @@port AS port, DATABASE() AS db, CURRENT_USER() AS who, VERSION() AS version',
  )
  console.log(`   landed on     : ${who.server}:${who.port}  db=${who.db}  as ${who.who}`)
  console.log(`   version       : ${who.version}`)

  // information_schema is the authority. Matched case-insensitively so a table
  // that exists under a different case is reported as found-but-misnamed
  // rather than missing - on a Linux server those are two different tables.
  const [found] = await conn.query(
    `SELECT TABLE_NAME, TABLE_ROWS, ENGINE
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND LOWER(TABLE_NAME) = LOWER(?)`,
    [r.database_name, table],
  )

  if (!found.length) {
    console.log(`   ${table}: NOT IN information_schema for ${r.database_name}`)
    const [all] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [r.database_name],
    )
    console.log(`   this database holds ${all.length} table(s)`)
    const near = all.map((t) => t.TABLE_NAME).filter((n) => n.toLowerCase().includes(table.toLowerCase().slice(0, 4)))
    if (near.length) console.log(`   similar names : ${near.join(', ')}`)
  } else {
    for (const f of found) {
      const exact = f.TABLE_NAME === table ? '' : `   <-- DIFFERENT CASE (looked for "${table}")`
      console.log(`   ${f.TABLE_NAME}: PRESENT (engine ${f.ENGINE}, ~${f.TABLE_ROWS} rows)${exact}`)
    }
  }

  // The real thing. information_schema can list a table the connection still
  // cannot read - a missing grant and a missing table do not always surface as
  // different errors, so ask the question the app asks.
  try {
    const [[c]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${table}\``)
    console.log(`   SELECT COUNT(*): ${c.n} row(s) - readable by this user`)
  } catch (e) {
    console.log(`   SELECT FAILED : ${e.code} (errno ${e.errno}) ${e.sqlMessage || e.message}`)
    const [grants] = await conn.query('SHOW GRANTS FOR CURRENT_USER()')
    console.log('   grants held by this user:')
    for (const g of grants) console.log(`     ${Object.values(g)[0]}`)
  }

  console.log('')
  await conn.end()
}
