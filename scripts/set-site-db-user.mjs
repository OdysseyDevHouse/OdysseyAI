/**
 * Give a site its own database user, instead of root.
 *
 * ── WHY THIS IS NEEDED ──────────────────────────────────────────────────────
 *
 * OdysseyAI Database Setup refuses to provision a site whose `db_username` is
 * `root`, and it is right to: provisioning runs `CREATE USER ... IDENTIFIED BY`
 * and `ALTER USER`, so pointing that at root would set the password of the
 * account that administers the whole MariaDB server. The machine would be
 * locked out of its own data, by us, during an install.
 *
 * A site's user should own that site's database and nothing else — which is
 * exactly the GRANT the wizard writes: `GRANT ALL ON <db>.* TO <user>@<host>`.
 *
 * ── WHAT THIS WRITES, AND WHERE ─────────────────────────────────────────────
 *
 * Two columns on ONE row of cp2_site_databases in the CONTROL database:
 * `db_username` and `db_password_enc`. Nothing else, and no other site.
 *
 * It does NOT touch any MariaDB server. The user it names does not have to
 * exist yet — OdysseyAI Database Setup creates it from these very credentials,
 * which is the whole point of storing them here first.
 *
 * ── DRY RUN BY DEFAULT ──────────────────────────────────────────────────────
 *
 * This edits a production control panel, so it prints what it would do and
 * changes nothing unless you pass --apply.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/set-site-db-user.mjs --site 4
 *   npx tsx --conditions=react-server --env-file=.env scripts/set-site-db-user.mjs --site 4 --apply
 *
 * tsx and the react-server condition are both needed: this imports the app's own
 * encryptSecret so the stored value is byte-identical to what the app writes,
 * and secrets.ts is TypeScript that imports 'server-only'.
 *
 * Optional: --user <name> to choose the username rather than deriving it.
 *
 * ── ONE WARNING WORTH READING ───────────────────────────────────────────────
 *
 * Only do this for a site whose database has NOT been created yet, or whose
 * server you are about to (re)provision. Changing the stored credentials for a
 * database that already exists and is being reached as root means the app then
 * connects as a user that server has never heard of — until Setup is re-run
 * against it and creates them.
 */
import mysql from 'mysql2/promise'
import { randomBytes } from 'node:crypto'
import { encryptSecret } from '../src/lib/crypto/secrets.ts'

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const apply = argv.includes('--apply')
const siteId = Number(arg('site'))

if (!Number.isFinite(siteId) || siteId <= 0) {
  console.error('Usage: node --env-file=.env scripts/set-site-db-user.mjs --site <id> [--user <name>] [--apply]')
  process.exit(1)
}

const RESERVED = new Set(['root', 'mysql', 'mariadb.sys', 'mariadb', 'sys', 'admin'])
const plausible = (v) => /^[A-Za-z0-9_$-]{1,64}$/.test(v)

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectTimeout: 10000,
})

const [rows] = await conn.execute(
  `SELECT d.id, d.site_id, d.purpose, d.database_name, d.db_username, d.server_host, d.server_port,
          s.site_code AS code, s.company_name, s.connection_type
     FROM cp2_site_databases d
     JOIN cp2_sites s ON s.id = d.site_id
    WHERE d.site_id = ? AND d.purpose = 'master' AND d.status = 'active'
    LIMIT 1`,
  [siteId],
)

if (!rows.length) {
  console.error(`No active master database record for site ${siteId}.`)
  await conn.end()
  process.exit(1)
}

const row = rows[0]

/* Derived from the site CODE rather than the database name: the code is the
   thing support says out loud, and a username somebody can recognise on sight
   is worth more than one that merely looks tidy. */
const derived = String(row.code || `site${siteId}`).toLowerCase().replace(/[^a-z0-9_]/g, '')
const username = arg('user') || derived

if (!plausible(username)) {
  console.error(`"${username}" is not a usable MySQL username.`)
  await conn.end()
  process.exit(1)
}
if (RESERVED.has(username.toLowerCase())) {
  console.error(`"${username}" is reserved — that is the problem this script exists to fix.`)
  await conn.end()
  process.exit(1)
}

/* Base64url of 24 random bytes: no quoting hazards, and long enough that the
   shop owner reading it off a screen is not the threat model. Nobody ever types
   this — the control panel stores it and the installer hands it to MariaDB. */
const password = randomBytes(24).toString('base64url')

console.log('')
console.log(`  site #${row.site_id} ${row.code} — ${row.company_name} (${row.connection_type})`)
console.log(`  database  : ${row.database_name} on ${row.server_host}:${row.server_port}`)
console.log(`  username  : ${row.db_username}  ->  ${username}`)
console.log(`  password  : (regenerated, ${password.length} characters, not shown)`)
console.log('')

if (!apply) {
  console.log('  Dry run. Nothing was written. Add --apply to make the change.')
  console.log('')
  await conn.end()
  process.exit(0)
}

await conn.execute(
  `UPDATE cp2_site_databases SET db_username = ?, db_password_enc = ? WHERE id = ?`,
  [username, encryptSecret(password), row.id],
)

console.log('  Written. Run OdysseyAI Database Setup on that machine to create the user.')
console.log('')
await conn.end()
