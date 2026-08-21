// Odyssey Cafe — a twenty-store group, provisioned from nothing.
//
//   node --env-file=.env scripts/seed-odyssey-cafe.mjs [--stores 20] [--drop]
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// Everything about the shared customer and supplier files has been proven on a
// TWO-site dev group. docs/shared-customer-file-origin-site.md flags that as
// the standing risk in so many words: "things that hold at two sometimes do not
// at ten". The group reconciliation fans out one query per member and the
// resolver caches per request — neither behaviour is visible at two.
//
// So this builds twenty. It writes only through the same paths the app uses:
// cp2_sites for the site, cp2_site_databases for the connection (with the
// password encrypted exactly as src/lib/crypto/secrets.ts does it),
// cp2_user_sites for access, cp2_site_modules for entitlements, and then
// site-migrate.mjs for the schema. Nothing here invents a shortcut the app
// would not recognise.
//
// ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
//
// It never touches sites 1 and 2. Those are the existing dev sites with real
// test data and every earlier probe written against them; a seeding script that
// could clobber them is a script nobody should run twice.
//
// --drop removes only what this script created, identified by the ODY-CAFE site
// code prefix and the ody2xxxx database names. It asks for the prefix rather
// than a site id range so a half-finished run can be cleaned up safely.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { randomBytes, createCipheriv, scryptSync } from 'node:crypto'
import mysql from 'mysql2/promise'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const STORES = Math.min(Math.max(Number(arg('stores', 20)), 1), 40)
const DROP = process.argv.includes('--drop')

/** Site codes and databases this script owns. Nothing else is ever touched. */
const CODE_PREFIX = 'ODY-CAFE-'
const DB_PREFIX = 'ody2'
const GROUP_NAME = 'Odyssey Cafe'

/* ── Encryption, mirroring src/lib/crypto/secrets.ts ─────────────────────── */

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

const control = await mysql.createConnection({ ...DB, database: 'odyssey_tickets' })

/* ── The twenty branches ─────────────────────────────────────────────────── */

const TOWNS = [
  ['Sea Point', 'Cape Town'], ['Claremont', 'Cape Town'], ['Stellenbosch', 'Western Cape'],
  ['Somerset West', 'Western Cape'], ['Paarl', 'Western Cape'], ['George', 'Western Cape'],
  ['Knysna', 'Western Cape'], ['Plettenberg Bay', 'Western Cape'], ['Mossel Bay', 'Western Cape'],
  ['Port Elizabeth', 'Eastern Cape'], ['East London', 'Eastern Cape'], ['Durban North', 'KwaZulu-Natal'],
  ['Umhlanga', 'KwaZulu-Natal'], ['Pietermaritzburg', 'KwaZulu-Natal'], ['Sandton', 'Gauteng'],
  ['Rosebank', 'Gauteng'], ['Pretoria East', 'Gauteng'], ['Centurion', 'Gauteng'],
  ['Bloemfontein', 'Free State'], ['Nelspruit', 'Mpumalanga'],
]

/* ── Drop ────────────────────────────────────────────────────────────────── */

if (DROP) {
  const [sites] = await control.query(
    'SELECT id, site_code FROM cp2_sites WHERE site_code LIKE ?',
    [`${CODE_PREFIX}%`],
  )
  if (!sites.length) {
    console.log('Nothing to drop — no sites with that prefix.')
    await control.end()
    process.exit(0)
  }
  console.log(`Dropping ${sites.length} site(s)…`)

  const ids = sites.map((s) => s.id)
  const holes = ids.map(() => '?').join(',')

  const [dbs] = await control.query(
    `SELECT database_name FROM cp2_site_databases WHERE site_id IN (${holes})`,
    ids,
  )
  const server = await mysql.createConnection(DB)
  for (const d of dbs) {
    // Guarded by the prefix as well as the join: a wrong row in the registry
    // must not be able to point this at ody10000_master.
    if (!d.database_name.startsWith(DB_PREFIX)) {
      console.log(`  skipping ${d.database_name} — not ours`)
      continue
    }
    await server.query(`DROP DATABASE IF EXISTS \`${d.database_name}\``)
    console.log(`  dropped ${d.database_name}`)
  }
  await server.end()

  const [[grp]] = await control.query('SELECT id FROM cp2_store_groups WHERE name = ? LIMIT 1', [
    GROUP_NAME,
  ])
  if (grp) {
    await control.query('DELETE FROM cp2_store_group_members WHERE group_id = ?', [grp.id])
    await control.query('DELETE FROM cp2_store_groups WHERE id = ?', [grp.id])
  }
  for (const t of ['cp2_site_modules', 'cp2_user_sites', 'cp2_site_databases', 'cp2_billing_account_sites']) {
    await control.query(`DELETE FROM ${t} WHERE site_id IN (${holes})`, ids)
  }
  await control.query(`DELETE FROM cp2_sites WHERE id IN (${holes})`, ids)
  console.log('Done.')
  await control.end()
  process.exit(0)
}

/* ── Guard: never touch what is already there ────────────────────────────── */

const [existing] = await control.query('SELECT id FROM cp2_sites WHERE site_code LIKE ?', [
  `${CODE_PREFIX}%`,
])
if (existing.length) {
  console.error(
    `${existing.length} Odyssey Cafe site(s) already exist. Run with --drop first, or leave them.`,
  )
  await control.end()
  process.exit(1)
}

/* ── The owner, and the modules every store gets ─────────────────────────── */

const [[owner]] = await control.query('SELECT id FROM cp2_users ORDER BY id LIMIT 1')
if (!owner) {
  console.error('No user in cp2_users to grant access to.')
  await control.end()
  process.exit(1)
}

// The same set sites 1 and 2 hold. multi_branch is the one that matters — the
// resolver declines to route without it, so a group missing it would look like
// sharing was broken rather than unlicensed.
const MODULES = [
  'starter', 'customers', 'accounting', 'inventory_advanced',
  'job_cards', 'loyalty', 'online_store', 'multi_branch',
]

const [[billing]] = await control.query(
  "SELECT id FROM cp2_billing_accounts WHERE status = 'active' ORDER BY id LIMIT 1",
)

console.log(`\nCreating ${STORES} Odyssey Cafe stores…\n`)

const server = await mysql.createConnection(DB)
const created = []

for (let i = 0; i < STORES; i++) {
  const n = i + 1
  const [town, province] = TOWNS[i % TOWNS.length]
  const code = `${CODE_PREFIX}${String(n).padStart(2, '0')}`
  const dbName = `${DB_PREFIX}${String(20000 + n)}_master`

  const [res] = await control.query(
    `INSERT INTO cp2_sites
       (site_code, company_name, trading_name, address1, address2, postal_code,
        phone, email, contact_name, connection_type, status, created_by, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?, 'cloud', 'active', ?, ?)`,
    [
      code,
      'Odyssey Cafe (Pty) Ltd',
      `Odyssey Cafe ${town}`,
      `${n} Main Road`,
      town,
      String(6000 + n),
      '021' + String(4000000 + n),
      'accounts@odysseycafe.co.za',
      'Odyssey Cafe Head Office',
      owner.id,
      owner.id,
    ],
  )
  const siteId = res.insertId

  await server.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  )

  await control.query(
    `INSERT INTO cp2_site_databases
       (site_id, purpose, location_name, server_host, server_port, database_name,
        db_username, db_password_enc, db_engine, is_managed, status, created_by, updated_by)
     VALUES (?, 'master', ?, ?, ?, ?, ?, ?, 'mysql', 0, 'active', ?, ?)`,
    [
      siteId, town, DB.host, DB.port, dbName,
      DB.user, encryptSecret(DB.password), owner.id, owner.id,
    ],
  )

  await control.query(
    `INSERT INTO cp2_user_sites (user_id, site_id, site_role, is_default, status, created_by)
     VALUES (?, ?, 'owner', 0, 'active', ?)`,
    [owner.id, siteId, owner.id],
  )

  for (const key of MODULES) {
    await control.query(
      `INSERT INTO cp2_site_modules (site_id, module_key, quantity, starts_on, created_by)
       VALUES (?, ?, 1, CURDATE(), 'odyssey cafe seed')`,
      [siteId, key],
    )
  }

  if (billing) {
    await control.query(
      'INSERT IGNORE INTO cp2_billing_account_sites (account_id, site_id) VALUES (?, ?)',
      [billing.id, siteId],
    )
  }

  created.push({ siteId, code, town, dbName })
  console.log(`  ${code}  site ${String(siteId).padStart(3)}  ${dbName}  ${town}`)
}

await server.end()

/* ── The group ───────────────────────────────────────────────────────────── */
//
// legal_entity 'one' because it is one registered company with twenty branches,
// which is exactly the case 016 says balance sharing is FOR. The first store is
// head office and holds the shared files.

const [grpRes] = await control.query(
  `INSERT INTO cp2_store_groups (name, primary_site_id, legal_entity, status)
   VALUES (?, ?, 'one', 'active')`,
  [GROUP_NAME, created[0].siteId],
)
const groupId = grpRes.insertId

for (const [i, s] of created.entries()) {
  await control.query(
    `INSERT INTO cp2_store_group_members
       (group_id, site_id, position, shares_products, shares_departments,
        shares_cost, shares_selling, shares_customers, shares_suppliers)
     VALUES (?, ?, ?, 1, 1, 1, 1, 0, 0)`,
    [groupId, s.siteId, i],
  )
}

console.log(`\nGroup "${GROUP_NAME}" (${groupId}) — head office is ${created[0].code}.`)
console.log('Customer and supplier sharing are OFF; switch them on in Setup or with --share.\n')

await control.end()

/* ── Schema ──────────────────────────────────────────────────────────────── */
//
// Through site-migrate.mjs rather than by applying the SQL here, so these
// databases are migrated by exactly the runner every other site uses and end up
// recorded in schema_migrations the same way.

console.log('Applying schema (228 migrations per store, this takes a while)…\n')

for (const s of created) {
  const out = spawnSync(
    process.execPath,
    ['--env-file=.env', path.join(root, 'scripts', 'site-migrate.mjs'), String(s.siteId)],
    { cwd: root, encoding: 'utf8' },
  )
  const applied = (out.stdout || '').match(/(\d+) migration\(s\) applied/)
  if (out.status !== 0) {
    console.error(`  ${s.code}  FAILED`)
    console.error((out.stdout || '').split('\n').slice(-6).join('\n'))
    console.error(out.stderr)
    process.exit(1)
  }
  console.log(`  ${s.code}  ${applied ? applied[1] : '0'} migration(s)`)
}

console.log(`\n${created.length} stores ready. Next: node --env-file=.env scripts/seed-odyssey-cafe-data.mjs`)
