// Odyssey Demo Database — creates the site, its database, and applies the schema.
//
//   node --env-file=.env scripts/tmp-migrate/01-create-site.mjs [--drop]
//
// Mirrors scripts/seed-odyssey-cafe.mjs: writes only through the same control
// tables the app reads, with the password encrypted exactly as
// src/lib/crypto/secrets.ts does it, then defers the schema to site-migrate.mjs
// so the database ends up recorded in schema_migrations like every other site.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { randomBytes, createCipheriv, scryptSync } from 'node:crypto'
import mysql from 'mysql2/promise'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DROP = process.argv.includes('--drop')

const SITE_CODE = 'ODY-DEMO-01'
const DB_NAME = 'ody27995_demo_master'
const COMPANY = 'Odyssey Demo Database'

const PREFIX = 'enc:v1:'
function encryptSecret(plain) {
  const key = scryptSync(process.env.ENCRYPTION_KEY, 'odyssey-secret-v1', 32)
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `${PREFIX}${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`
}

if (!process.env.ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY is not set. Run with --env-file=.env')
  process.exit(1)
}

const DB = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
}

const control = await mysql.createConnection({ ...DB, database: process.env.DB_NAME })

if (DROP) {
  const [sites] = await control.query('SELECT id FROM cp2_sites WHERE site_code = ?', [SITE_CODE])
  if (!sites.length) {
    console.log('Nothing to drop.')
    await control.end()
    process.exit(0)
  }
  const ids = sites.map((s) => s.id)
  const holes = ids.map(() => '?').join(',')
  const server = await mysql.createConnection(DB)
  // Guarded by name as well as the join: a wrong registry row must not be able
  // to point this at another site's master.
  await server.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``)
  await server.end()
  for (const t of ['cp2_site_modules', 'cp2_user_sites', 'cp2_site_databases', 'cp2_billing_account_sites']) {
    await control.query(`DELETE FROM ${t} WHERE site_id IN (${holes})`, ids)
  }
  await control.query(`DELETE FROM cp2_sites WHERE id IN (${holes})`, ids)
  console.log(`Dropped site ${ids.join(', ')} and ${DB_NAME}.`)
  await control.end()
  process.exit(0)
}

const [existing] = await control.query('SELECT id FROM cp2_sites WHERE site_code = ?', [SITE_CODE])
if (existing.length) {
  console.error(`${SITE_CODE} already exists (site ${existing[0].id}). Run with --drop first.`)
  await control.end()
  process.exit(1)
}

const [[owner]] = await control.query('SELECT id FROM cp2_users ORDER BY id LIMIT 1')
if (!owner) {
  console.error('No user in cp2_users to grant access to.')
  await control.end()
  process.exit(1)
}

// The same set sites 1 and 2 hold, so every screen in the back office is
// reachable on this data rather than reporting "not licensed".
const MODULES = [
  'starter', 'customers', 'accounting', 'inventory_advanced',
  'job_cards', 'loyalty', 'online_store', 'multi_branch',
]

// 'Supermarket' — the catalogue is groceries, butchery, bakery and produce.
const [[siteType]] = await control.query(
  "SELECT id FROM cp2_site_types WHERE name = 'Supermarket' LIMIT 1",
)

const [res] = await control.query(
  `INSERT INTO cp2_sites
     (site_code, company_name, trading_name, address1, address2, postal_code,
      phone, email, contact_name, connection_type, site_type_id, status, created_by, updated_by)
   VALUES (?,?,?,?,?,?,?,?,?, 'cloud', ?, 'active', ?, ?)`,
  [
    SITE_CODE, COMPANY, COMPANY, '1 Demo Street', 'Cape Town', '8001',
    '0210000000', 'demo@odyssey.co.za', 'Odyssey Demo',
    siteType ? siteType.id : null, owner.id, owner.id,
  ],
)
const siteId = res.insertId

const server = await mysql.createConnection(DB)
await server.query(
  `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
)
await server.end()

await control.query(
  `INSERT INTO cp2_site_databases
     (site_id, purpose, location_name, server_host, server_port, database_name,
      db_username, db_password_enc, db_engine, is_managed, status, created_by, updated_by)
   VALUES (?, 'master', 'Main', ?, ?, ?, ?, ?, 'mysql', 0, 'active', ?, ?)`,
  [siteId, DB.host, DB.port, DB_NAME, DB.user, encryptSecret(DB.password), owner.id, owner.id],
)

await control.query(
  `INSERT INTO cp2_user_sites (user_id, site_id, site_role, is_default, status, created_by)
   VALUES (?, ?, 'owner', 0, 'active', ?)`,
  [owner.id, siteId, owner.id],
)

for (const key of MODULES) {
  await control.query(
    `INSERT INTO cp2_site_modules (site_id, module_key, quantity, starts_on, created_by)
     VALUES (?, ?, 1, CURDATE(), 'odyssey demo import')`,
    [siteId, key],
  )
}

const [[billing]] = await control.query(
  "SELECT id FROM cp2_billing_accounts WHERE status = 'active' ORDER BY id LIMIT 1",
)
if (billing) {
  await control.query(
    'INSERT IGNORE INTO cp2_billing_account_sites (account_id, site_id) VALUES (?, ?)',
    [billing.id, siteId],
  )
}

await control.end()

console.log(`Created ${SITE_CODE} — site ${siteId}, database ${DB_NAME}.`)
console.log('Applying schema…')

const out = spawnSync(
  process.execPath,
  ['--env-file=.env', path.join(root, 'scripts', 'site-migrate.mjs'), String(siteId)],
  { cwd: root, encoding: 'utf8' },
)
if (out.status !== 0) {
  console.error((out.stdout || '').split('\n').slice(-15).join('\n'))
  console.error(out.stderr)
  process.exit(1)
}
const applied = (out.stdout || '').match(/(\d+) migration\(s\) applied/)
console.log(`  ${applied ? applied[1] : '?'} migration(s) applied.`)
console.log(`\nSite ${siteId} ready. Next: node --env-file=.env scripts/tmp-migrate/02-import.mjs ${siteId}`)
