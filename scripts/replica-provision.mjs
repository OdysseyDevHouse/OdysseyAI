// Stands up the cloud replica for a local-backend site.
//
//   node --env-file=.env scripts/replica-provision.mjs <siteId> [--device <serial>] [--dry-run]
//
// A site with a LOCAL backend keeps its trading data on the shop's machine, so
// head office has nothing to read and support cannot see a customer's figures
// without asking somebody to read them down the telephone. This creates the
// read-only copy that fixes that: a database on our server, a SELECT-only
// account for the app, and the cp2_reporting_replicas row that points at both.
//
// It does NOT start replication. Seeding a replica needs a dump of the shop's
// database taken at a known binlog position, and that dump has to travel from
// the shop — over the tunnel, on the shop's line, at whatever hour suits them.
// This prepares the destination and prints exactly what to run once the seed
// arrives; it never pretends to have done the half that needs the shop.
//
// ── WHY THE APP'S ACCOUNT CAN ONLY SELECT ───────────────────────────────────
//
// A replica that could be written to would silently diverge from the shop: a
// write is either lost at the next replication event or it is not, and neither
// outcome is one anybody would notice. src/lib/reporting/replicaDb.ts refuses
// to export a write helper for the same reason. Three layers say read-only —
// the module, the grant, and the table this row lives in — so that adding a
// write means noticing three times that it is wrong.
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import mysql from 'mysql2/promise'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const siteId = Number(process.argv[2])
const dryRun = process.argv.includes('--dry-run')
const deviceSerial = process.argv.includes('--device')
  ? String(process.argv[process.argv.indexOf('--device') + 1] || '').trim()
  : null

if (!Number.isFinite(siteId) || siteId <= 0) {
  console.error(
    'Usage: node --env-file=.env scripts/replica-provision.mjs <siteId> [--device <serial>] [--dry-run]',
  )
  process.exit(1)
}

// Mirrors src/lib/crypto/secrets.ts — scripts cannot import a server-only module.
const PREFIX = 'enc:v1:'
function secretKey() {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) {
    console.error('ENCRYPTION_KEY is not set — the stored password could not be written.')
    process.exit(1)
  }
  return scryptSync(raw, 'odyssey-secret-v1', 32)
}
function encryptSecret(plain) {
  if (plain === '') return ''
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', secretKey(), iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return PREFIX + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join(':')
}
function decryptSecret(stored) {
  if (!stored) return ''
  if (!stored.startsWith(PREFIX)) return stored
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':').map((s) => Buffer.from(s, 'base64'))
  const d = createDecipheriv('aes-256-gcm', secretKey(), iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

/**
 * Tables the replica must NOT carry.
 *
 * Credentials, and state that is only meaningful on the machine that wrote it.
 * Copying either would be worse than useless: a device-bound verifier verifies
 * nothing elsewhere, and a replicated document_sequences row hands two machines
 * the same next invoice number.
 *
 * Filtered at the REPLICA rather than at the shop, deliberately — the shop's
 * own binary log must stay complete, because it is also what a point-in-time
 * restore replays.
 */
const IGNORED_TABLES = [
  // Credentials and secrets.
  'offline_signin',
  'user_offline_verifiers',
  'api_keys',
  'customer_logins',
  'customer_password_resets',
  'customer_login_links',
  'webhook_endpoints',
  'tender_integrations',
  'payment_gateways',
  // Machine-bound state. Replicating these actively breaks things.
  'licence_lease',
  'document_sequences',
  'terminals',
  'offline_sync_claims',
  'offline_return_claims',
  // Not real trading data.
  'training_sessions',
  // Ephemeral per-user or per-session UI state.
  'online_stock_holds',
  'online_saved_baskets',
  'notification_reads',
]

/** A password for the replica's own accounts. No quotes or backslashes. */
function generatePassword() {
  return randomBytes(24).toString('base64').replace(/[+/=]/g, '').slice(0, 28)
}

/** Identifiers are interpolated, never bound — so they must be provably safe. */
function safeIdent(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    console.error(`Refusing to use "${name}" as an identifier.`)
    process.exit(1)
  }
  return name
}

const control = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
})

const [siteRows] = await control.query(
  `SELECT id, site_code, company_name, trading_name, backoffice_type
     FROM cp2_sites WHERE id = ? LIMIT 1`,
  [siteId],
)
if (siteRows.length === 0) {
  console.error(`Site ${siteId} does not exist.`)
  await control.end()
  process.exit(1)
}
const site = siteRows[0]

/* A cloud site's data is already on our servers and reports read it directly.
   Provisioning a replica for one would create a second copy nothing reads, and
   an operator would later have to work out which was authoritative. */
if (String(site.backoffice_type) !== 'windows') {
  console.error(
    `Site ${siteId} (${site.company_name}) is a CLOUD site — its data is already here, so it has no replica.`,
  )
  await control.end()
  process.exit(1)
}

/* Which machine is the master. Taken from what actually escrowed itself rather
   than from an operator's memory: cp2_local_backends is written by the machine
   on first contact, so a row there is proof a real install exists. */
const [backends] = await control.query(
  `SELECT device_serial, db_port, db_name, escrowed_at
     FROM cp2_local_backends
    WHERE site_id = ? AND status = 'active'
    ORDER BY escrowed_at DESC`,
  [siteId],
)

if (backends.length === 0) {
  console.error(
    `Site ${siteId} has no local installation on record yet. Install and sign in on the shop's machine first.`,
  )
  await control.end()
  process.exit(1)
}

const backend = deviceSerial
  ? backends.find((b) => String(b.device_serial) === deviceSerial)
  : backends[0]

if (!backend) {
  console.error(`Site ${siteId} has no machine with serial "${deviceSerial}".`)
  console.error(`Known: ${backends.map((b) => b.device_serial).join(', ')}`)
  await control.end()
  process.exit(1)
}

const serial = String(backend.device_serial)

/* Named for the site, so an operator looking at a list of databases on the
   replica host can tell whose is whose without a lookup. */
const dbName = safeIdent(`odyssey_replica_${siteId}`)
const readerUser = safeIdent(`odyssey_rpt_${siteId}`)
const applierUser = safeIdent(`odyssey_apply_${siteId}`)

const replicaHost = process.env.REPLICA_DB_HOST || '127.0.0.1'
const replicaPort = Number(process.env.REPLICA_DB_PORT || 3306)
const replicaAdminUser = process.env.REPLICA_DB_ADMIN_USER || 'root'
const replicaAdminPassword = process.env.REPLICA_DB_ADMIN_PASSWORD || ''

console.log(`Site ${siteId} — ${site.company_name} (${site.site_code})`)
console.log(`Machine     ${serial}`)
console.log(`Replica     ${replicaHost}:${replicaPort} / ${dbName}`)
console.log(`Reader      ${readerUser} (SELECT only)`)
console.log()

/* Is there one already? Re-provisioning must not mint a second set of
   credentials for a database that is already replicating — the running applier
   would keep the old password and the app would take the new one. */
const [existing] = await control.query(
  `SELECT id, database_name, status FROM cp2_reporting_replicas
    WHERE site_id = ? AND device_serial = ? LIMIT 1`,
  [siteId, serial],
)
if (existing.length > 0) {
  console.log(`A replica is already recorded for this machine (${existing[0].database_name}, ${existing[0].status}).`)
  console.log('Nothing to do. Delete the row first if you really mean to re-provision.')
  await control.end()
  process.exit(0)
}

const readerPassword = generatePassword()
const applierPassword = generatePassword()

const ddl = [
  `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
  /* The APPLIER: the account replication itself runs as. It writes, because
     applying a binary log is writing. Scoped to this one database. */
  `CREATE USER IF NOT EXISTS '${applierUser}'@'%' IDENTIFIED BY '${applierPassword}';`,
  `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${applierUser}'@'%';`,
  /* The READER: what the app connects as. SELECT, and nothing else, ever. */
  `CREATE USER IF NOT EXISTS '${readerUser}'@'%' IDENTIFIED BY '${readerPassword}';`,
  `GRANT SELECT ON \`${dbName}\`.* TO '${readerUser}'@'%';`,
  `FLUSH PRIVILEGES;`,
].join('\n')

if (dryRun) {
  console.log('--- would run on the replica host ---')
  console.log(ddl.replace(readerPassword, '<reader password>').replace(applierPassword, '<applier password>'))
  console.log('\n--- would record in cp2_reporting_replicas ---')
  console.log(JSON.stringify({ siteId, deviceSerial: serial, host: replicaHost, port: replicaPort, database: dbName, reader: readerUser }, null, 2))
  console.log('\n--- ignored tables ---')
  console.log(IGNORED_TABLES.join(', '))
  await control.end()
  process.exit(0)
}

let replica
try {
  replica = await mysql.createConnection({
    host: replicaHost,
    port: replicaPort,
    user: replicaAdminUser,
    password: replicaAdminPassword,
    multipleStatements: true,
  })
} catch (err) {
  console.error(`Could not reach the replica host at ${replicaHost}:${replicaPort} — ${err.message}`)
  console.error('Set REPLICA_DB_HOST / REPLICA_DB_PORT / REPLICA_DB_ADMIN_USER / REPLICA_DB_ADMIN_PASSWORD.')
  await control.end()
  process.exit(1)
}

try {
  await replica.query(ddl)
  console.log('  ok   database and accounts created')
} catch (err) {
  console.error(`Could not create the replica database — ${err.message}`)
  await replica.end()
  await control.end()
  process.exit(1)
}

/* Recorded only after the database exists. A row pointing at nothing would let
   reportSourceFor() route reports to a database that cannot answer, and the
   error a reader sees would name a connection rather than the real problem. */
await control.query(
  `INSERT INTO cp2_reporting_replicas
     (site_id, device_serial, server_host, server_port, database_name,
      db_username, db_password_enc, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
  [siteId, serial, replicaHost, replicaPort, dbName, readerUser, encryptSecret(readerPassword)],
)
console.log('  ok   recorded in cp2_reporting_replicas (status: pending)')

await replica.end()
await control.end()

console.log(`
Destination ready. Replication is NOT running yet — it needs a seed from the shop.

  1. On the shop's machine, with the tunnel up, take a dump at a known position:

       mariadb-dump --single-transaction --master-data=2 --routines --triggers \\
         --databases <the shop's database> | gzip > seed.sql.gz

  2. Load it into ${dbName} on ${replicaHost}, as ${applierUser}.

  3. Read the CHANGE MASTER line from the head of the dump, then start the
     applier against the tunnel with these ignore rules:

${IGNORED_TABLES.map((t) => `       --replicate-ignore-table=${dbName}.${t}`).join('\n')}

  4. Set the row to 'running':

       UPDATE cp2_reporting_replicas SET status = 'running'
        WHERE site_id = ${siteId} AND device_serial = '${serial}';

The applier's password is printed ONCE, now. It is not stored anywhere:

       ${applierUser} / ${applierPassword}

The reader's password is stored encrypted for the app and needs no copy.
`)
