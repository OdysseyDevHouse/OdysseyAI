// Applies sql/site/*.sql to a site's own database, once each.
//
//   node --env-file=.env scripts/site-migrate.mjs <siteId> [--probe]
//
// Connection details come from cp2_site_databases in the control database, with
// the password decrypted exactly as the app does — so this runner and the
// running app can never disagree about where a site's data lives.
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createDecipheriv, scryptSync } from 'node:crypto'
import mysql from 'mysql2/promise'

/* The applying half lives beside the app rather than here, so the setup wizard
   and this script cannot drift into two ideas of what "migrated" means. See
   electron/siteMigrate.js for why it moved. */
import { applyMigrations, ensureDatabase } from '../electron/siteMigrate.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

/*
 * The site's OWN database — its master.
 *
 * `ORDER BY purpose LIMIT 1` used to decide this, which was harmless while
 * every site had exactly one record. A HYBRID site has two, and 'hybrid' sorts
 * before 'master': this runner would have applied the full site schema to the
 * in-store spool box and never touched the site's real database. Both halves of
 * that are silent — the migrations succeed, against the wrong server.
 *
 * So the master is named rather than sorted to. The `hybrid` record is
 * deliberately excluded: that box holds open tabs and an outbox, not a shop.
 * It is provisioned by Odyssey Database Setup and migrated by
 * scripts/box-migrate.mjs, which applies sql/box/ instead.
 */
const [rows] = await control.query(
  `SELECT purpose, server_host, server_port, database_name, db_username, db_password_enc
     FROM cp2_site_databases
    WHERE site_id = ? AND status = 'active' AND purpose <> 'hybrid'
    ORDER BY purpose = 'master' DESC, purpose ASC
    LIMIT 1`,
  [siteId],
)

// Everyone with access to this site, for the user-adoption step after the
// migrations run. Read now, while the control connection is still open.
const [controlUsers] = await control.query(
  `SELECT u.id, u.email, u.full_name, us.site_role
     FROM cp2_user_sites us
     INNER JOIN cp2_users u ON u.id = us.user_id
    WHERE us.site_id = ? AND us.status = 'active'`,
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
const server = await mysql.createConnection(base)
try {
  await ensureDatabase(server, cfg.database_name)
} catch (e) {
  console.error(e.message)
  await server.end()
  process.exit(1)
}
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

let ran
try {
  ran = await applyMigrations(db, { onProgress: (m) => console.log('  ' + m) })
} catch (err) {
  console.error(err.message)
  await db.end()
  process.exit(1)
}

console.log(ran ? `${ran} migration(s) applied` : 'already up to date')

// ── Reconcile the site's users with the control database ────────────────
//
// 041 creates a local `users` row for every control id that appears in this
// site's history, naming them from the audit trail because a site database
// cannot join across to odyssey_tickets. Here we CAN see both, so the names
// and emails get corrected, and anyone with access to the site who never
// wrote an audit row gets the row they are missing.
//
// Runs on every invocation, not only when a migration was applied: access
// granted in the control panel after the migration still has to land, and the
// statements below are idempotent.
const [hasUsers] = await db.query(`SHOW TABLES LIKE 'users'`)
if (hasUsers.length && controlUsers.length) {
  const [[owner]] = await db.query('SELECT id FROM roles WHERE is_owner = 1 LIMIT 1')
  let added = 0
  let updated = 0
  for (const u of controlUsers) {
    const name = (u.full_name || '').trim() || u.email
    // The role only seeds a NEW row. Overwriting it on every run would undo
    // whatever the shop set on its own Users screen the next time anyone
    // migrates — the control panel's three-value role is a starting point
    // here, not the authority.
    const [res] = await db.query(
      `INSERT INTO users (id, name, email, control_user_id, user_type, role_id, is_active)
       VALUES (?, ?, ?, ?, 'back_office',
               COALESCE((SELECT id FROM roles WHERE name = ? AND is_system = 1 LIMIT 1), ?), 1)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         email = VALUES(email),
         user_type = 'back_office'`,
      [
        u.id,
        name,
        u.email,
        u.id,
        u.site_role === 'owner' ? 'Owner' : u.site_role === 'manager' ? 'Manager' : 'Cashier',
        owner?.id ?? null,
      ],
    )
    if (res.affectedRows === 1) added++
    else if (res.affectedRows === 2) updated++
  }
  console.log(`control users: ${added} added, ${updated} refreshed`)
}

await db.end()
