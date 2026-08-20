// Builds the in-store box's database for a hybrid site.
//
//   node --env-file=.env scripts/box-migrate.mjs <siteId> [--probe]
//
// Two halves, and the split matters:
//
//   1. sql/box/*.sql — the box's OWN tables: the outbox, the lease, its
//      identity. Ordinary migrations, applied once each.
//   2. The shop's tab tables — sales_documents, sales_document_lines,
//      pos_tables — DERIVED from the site's own database rather than written
//      out here. See below.
//
// ── WHY THE TAB TABLES ARE DERIVED ──────────────────────────────────────────
//
// 25 migrations in sql/site/ have altered those three tables since they were
// created, and the live shape already differs from 015_sales_core.sql in ways
// that matter (`credit_sale` not `credit_note`, `saved` not `parked`, the
// offline_* columns). A frozen copy would be wrong within a release — and wrong
// silently, because the box would accept a tab the cloud then refuses.
//
// Reading SHOW CREATE TABLE from the site's master means the box's tab tables
// are that shape by construction. There is one definition of a sale.
//
// ── AND WHY THE FOREIGN KEYS COME OFF ───────────────────────────────────────
//
// Those three tables carry 18 foreign keys. Following the closure pulls in 32
// tables — customers, products, suppliers, job cards, stock locations — measured
// against a live site. That is a shop, not a spool.
//
// So the columns stay and the constraints go. A tab still records customer_id;
// there is simply no customers table here to point at, exactly as
// sales_documents.user_id already works for cp2_users in another database.
//
// The cloud recomputes every figure when the sale arrives (lib/site/
// offlineSync.ts), so nothing about money depends on the box enforcing this.
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createDecipheriv, scryptSync } from 'node:crypto'
import mysql from 'mysql2/promise'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = path.join(root, 'sql', 'box')

/**
 * The shop tables a tab needs. Nothing else comes across.
 *
 * Ordered so a table is created after anything it references — a kept foreign
 * key is a real constraint, so its target must already exist.
 *
 * `pos_visit_types` and `pos_floor_rooms` are here because listTables and
 * getTable LEFT JOIN them on every read of the floor: without them the box
 * cannot answer the one question it exists to answer. They are small, FK-free
 * lookups (three rows and one on a live site) whose contents the cloud owns —
 * see MIRRORED_TABLES, which copies their rows rather than leaving a waiter
 * looking at a floor with no rooms and no visit types.
 */
const TAB_TABLES = [
  'pos_visit_types',
  'pos_floor_rooms',
  /* Joined by the document reads a tab goes through, not by the floor:
     getDocument LEFT JOINs sales_reps for the line stamp, and documentClaim
     LEFT JOINs terminals and users to say WHO holds a bill — which is the
     whole point of the claim on a floor with ten tills. All small (2, 5 and 4
     rows on a live site) and cloud-mastered, so their rows are mirrored. */
  'sales_reps',
  'users',
  'terminals',
  'sales_documents',
  'sales_document_lines',
  /* The answers a waiter gave when the till asked its questions — "no onions",
     "well done". getDocument reads them back with every line, and a recalled
     tab without them would silently strip every modifier off the order and
     reprice it. Its FKs to instruction_groups, instruction_options and products
     are stripped like any other reach into the shop: the rows here snapshot the
     names and prices, so nothing is lost by the targets being absent. */
  'sales_document_line_instructions',
  'pos_tables',
  /* Walls, doors and the rest of the floor plan. FK to pos_floor_rooms, which
     is already here, so it brings nothing new with it — and posFloor reads it
     alongside the rooms on every render of the plan. */
  'pos_floor_features',
  /* The trail a tab leaves. transferTableBill writes it INSIDE the routed
     transaction (posSplit.ts), so without it every transfer on a hybrid site
     fails — and it would fail after the pointer had already moved.
     Shape only, never rows: the box records what happens on the box. The
     shop's own 878 rows of history stay in the cloud where the back office
     reads them. */
  'document_audit',
  /* The licence lease — the SAME table the local backend uses, derived like
     every other rather than a second shape meaning the same thing.
     lib/licence/lease.ts reads `licence_lease WHERE id = 1`, so giving the box
     its own would have meant two lease shapes, two readers, and two places for
     the seven-day rule to drift.

     Rows are never mirrored: a lease belongs to the machine holding it, and
     readLease already refuses one whose site_id is not its own. */
  'licence_lease',
]

/**
 * Lookups whose ROWS are copied down, not just their shape.
 *
 * These are cloud-mastered reference data that the floor reads on every render.
 * Copying them is a cache, exactly as the till's product catalog is: losing it
 * costs a re-copy and nothing else, and the cloud stays the only place they are
 * edited.
 *
 * NOT in this list, and deliberately: pos_tables. The floor plan itself is
 * cloud-mastered too, but its rows carry `document_id` — live state the box
 * owns while a service is running. Copying them down would overwrite open tabs
 * with the cloud's stale view of which tables are occupied.
 */
const MIRRORED_TABLES = [
  'pos_visit_types',
  'pos_floor_rooms',
  'sales_reps',
  'users',
  'terminals',
]

const siteId = Number(process.argv[2])
const probeOnly = process.argv.includes('--probe')

if (!Number.isFinite(siteId) || siteId <= 0) {
  console.error('Usage: node --env-file=.env scripts/box-migrate.mjs <siteId> [--probe]')
  process.exit(1)
}

// Mirrors src/lib/crypto/secrets.ts, as site-migrate.mjs does.
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

const [[site]] = await control.query(
  'SELECT site_code, company_name, connection_type FROM cp2_sites WHERE id = ? LIMIT 1',
  [siteId],
)

if (!site) {
  console.error(`No site ${siteId}.`)
  process.exit(1)
}

/* Only a hybrid site has a box. Refusing here rather than later means a
   mistyped site id cannot create a spool nothing will ever connect to. */
if (site.connection_type !== 'hybrid') {
  console.error(
    `Site ${siteId} (${site.site_code}) is "${site.connection_type}", not hybrid. ` +
      `Only a hybrid site has an in-store box.`,
  )
  process.exit(1)
}

const [records] = await control.query(
  `SELECT purpose, server_host, server_port, database_name, db_username, db_password_enc
     FROM cp2_site_databases
    WHERE site_id = ? AND status = 'active' AND purpose IN ('hybrid','master')`,
  [siteId],
)
await control.end()

const box = records.find((r) => r.purpose === 'hybrid')
const master = records.find((r) => r.purpose === 'master')

if (!box) {
  console.error(
    `Site ${siteId} has no "hybrid" database record. The control panel creates it when a ` +
      `site is set to Hybrid — this runner must not invent one.`,
  )
  process.exit(1)
}
if (!master) {
  console.error(`Site ${siteId} has no "master" database record to read the tab tables from.`)
  process.exit(1)
}

function connectionFor(cfg) {
  return {
    host: process.env.SITE_DB_HOST_OVERRIDE?.trim() || cfg.server_host,
    port: cfg.server_port || 3306,
    user: cfg.db_username || '',
    password: decryptSecret(cfg.db_password_enc),
    database: cfg.database_name,
    multipleStatements: true,
  }
}

const boxCfg = connectionFor(box)
const masterCfg = connectionFor(master)

console.log(
  `site ${siteId} "${site.site_code}" box -> ${boxCfg.user}@${boxCfg.host}:${boxCfg.port}/${boxCfg.database}`,
)
console.log(`                 reading tab tables from ${masterCfg.database}`)

const boxConn = await mysql.createConnection(boxCfg)
const masterConn = await mysql.createConnection(masterCfg)

if (probeOnly) {
  const [[v]] = await boxConn.query('SELECT VERSION() AS v')
  const [tables] = await boxConn.query(
    'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
    [boxCfg.database],
  )
  console.log(`connected OK — ${v.v}, ${tables.length} table(s) present`)
  for (const t of tables) console.log(`  ${t.t}`)
  await boxConn.end()
  await masterConn.end()
  process.exit(0)
}

/* ── 1. The box's own tables ──────────────────────────────────────────────── */

await boxConn.query(`
  CREATE TABLE IF NOT EXISTS box_migrations (
    filename   VARCHAR(190) NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (filename)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`)

const [applied] = await boxConn.query('SELECT filename FROM box_migrations')
const done = new Set(applied.map((r) => r.filename))

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()

for (const file of files) {
  if (done.has(file)) continue
  const sql = await readFile(path.join(migrationsDir, file), 'utf8')
  process.stdout.write(`  ${file} … `)
  await boxConn.query(sql)
  await boxConn.execute('INSERT INTO box_migrations (filename) VALUES (?)', [file])
  console.log('applied')
}

/* ── 2. The tab tables, derived from the master ───────────────────────────── */

/**
 * Strip the foreign keys the box cannot satisfy — and ONLY those.
 *
 * ── WHY NOT SIMPLY DROP THEM ALL ────────────────────────────────────────────
 *
 * The first version of this did, and it silently broke a rule the tab path
 * depends on: `fk_line_document` is ON DELETE CASCADE, so deleting a document
 * takes its lines with it. Both tables are ON THE BOX, so nothing forced that
 * FK to go — and without it, deleting a tab leaves its lines behind forever.
 * Caught by deleting a probe document and finding two orphans.
 *
 * So the test is where the FK POINTS, not that it exists. A reference to a
 * table the box also has is kept, with its ON DELETE behaviour intact. A
 * reference to `customers`, `products`, `terminals` and the rest is dropped,
 * because following that closure means 32 tables.
 *
 * AUTO_INCREMENT=n is stripped too: the box starts empty and carrying the
 * master's next id would only mislead.
 *
 * Everything else — every column, type, default, index and CHECK — is kept
 * exactly as the master has it. This function must never be where a shape
 * decision is made.
 */
function stripConstraints(createSql, tablesOnBox) {
  const lines = createSql.split('\n')
  const kept = []

  for (const line of lines) {
    const trimmed = line.trim()
    const fk =
      /^CONSTRAINT\s+`[^`]+`\s+FOREIGN KEY.*?REFERENCES\s+`([^`]+)`/i.exec(trimmed) ||
      /^FOREIGN KEY.*?REFERENCES\s+`([^`]+)`/i.exec(trimmed)

    if (fk) {
      const target = fk[1]
      if (!tablesOnBox.has(target)) continue
      /* Points at a table the box has. Keeping it keeps its ON DELETE rule,
         which for fk_line_document is the cascade the tab path relies on. */
    }
    kept.push(line)
  }

  /* Dropping a middle line can leave the one before it ending in a comma that
     now dangles before the closing paren. Repair rather than re-parse. */
  let sql = kept.join('\n').replace(/,(\s*\n\s*\))/g, '$1')

  sql = sql.replace(/\bAUTO_INCREMENT=\d+\s*/gi, '')
  return sql
}

const onBox = new Set(TAB_TABLES)

for (const table of TAB_TABLES) {
  const [[row]] = await masterConn.query('SHOW CREATE TABLE ??', [table])
  const create = stripConstraints(row['Create Table'], onBox)

  /* IF NOT EXISTS: this runner is re-runnable, and a box already holding open
     tabs must never have its tables recreated. Reshaping an existing table is
     deliberately NOT attempted — a schema change lands on the box the same way
     it lands anywhere, by adding a migration. */
  const guarded = create.replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ')
  process.stdout.write(`  ${table} … `)
  await boxConn.query(guarded)
  console.log('ready')
}

/* ── 3. Mirror the lookups the floor reads ────────────────────────────────── */

/*
 * REPLACE, not INSERT IGNORE. These rows are cloud-mastered, so the cloud's
 * version wins outright — a row edited there must reach the box, and a row this
 * runner left behind from an earlier copy must be corrected rather than kept.
 *
 * Deleting what the cloud no longer has is deliberately NOT done. A visit type
 * removed in the cloud may still be referenced by a tab open on the box right
 * now, and dropping it under a live service would blank the label on a waiter's
 * screen mid-sitting. A stale extra row is harmless; the FK from pos_tables is
 * ON DELETE SET NULL anyway.
 */
for (const table of MIRRORED_TABLES) {
  const [rows] = await masterConn.query(`SELECT * FROM \`${table}\``)
  if (!rows.length) {
    console.log(`  ${table} … no rows to mirror`)
    continue
  }
  const columns = Object.keys(rows[0])
  const collist = columns.map((c) => `\`${c}\``).join(', ')
  const placeholders = `(${columns.map(() => '?').join(', ')})`
  for (const row of rows) {
    await boxConn.execute(
      `REPLACE INTO \`${table}\` (${collist}) VALUES ${placeholders}`,
      columns.map((c) => row[c]),
    )
  }
  console.log(`  ${table} … ${rows.length} row(s) mirrored`)
}

/* ── 4. Say what this box is ──────────────────────────────────────────────── */

await boxConn.execute(
  `INSERT INTO box_identity (id, site_id, site_code, schema_version)
   VALUES (1, ?, ?, ?)
   ON DUPLICATE KEY UPDATE site_id = VALUES(site_id), site_code = VALUES(site_code),
                           schema_version = VALUES(schema_version)`,
  [siteId, site.site_code, files.length],
)

const [tables] = await boxConn.query(
  'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
  [boxCfg.database],
)
console.log(`\nbox ready — ${tables.length} tables: ${tables.map((t) => t.t).join(', ')}`)

await boxConn.end()
await masterConn.end()
