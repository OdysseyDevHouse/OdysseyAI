/**
 * The in-store box's database.
 *
 * A hybrid site's box is a SPOOL: open tabs and an outbox, and nothing else.
 * These checks are about the two ways that goes wrong — carrying too much, and
 * carrying too little.
 *
 * Requires a provisioned box. Run scripts/box-migrate.mjs first; the suite
 * skips rather than fails when there is none, because a developer checkout with
 * no hybrid site is a normal state, not a broken one.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-box-schema.ts
 */
import mysql from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2/promise'

import { query, queryOne } from '../src/lib/db'
import { decryptSecret } from '../src/lib/crypto/secrets'

/**
 * What the box is allowed to hold. Anything else is the shop leaking in.
 *
 * `pos_visit_types` and `pos_floor_rooms` are here because listTables and
 * getTable LEFT JOIN them on every read of the floor — without them the box
 * cannot answer the question it exists to answer. Their ROWS are mirrored down
 * by box-migrate too, since a floor with no rooms and no visit types is not a
 * floor a waiter can use.
 *
 * Adding to this list should feel like a decision. The site schema is ~250
 * tables and the tab tables' own foreign keys reach 32 of them; every addition
 * is a step back towards the box being a second shop, with a second stock
 * ledger nobody can reconcile.
 */
const EXPECTED = [
  'box_identity',
  'box_migrations',
  'box_outbox',
  /* The floor a waiter looks at: rooms, the furniture in them, and how a table
     is being served. All read on every render of the plan. */
  'pos_floor_features',
  'pos_floor_rooms',
  'pos_tables',
  'pos_visit_types',
  'sales_documents',
  'sales_document_lines',
  /* The modifiers on a line — 'no onions'. Read back with every tab. */
  'sales_document_line_instructions',
  /* Joined by the document reads a tab goes through: the rep stamped on a line,
     and who holds the claim on a bill. */
  'sales_reps',
  'terminals',
  'users',
  /* Written INSIDE the routed transaction when a tab moves table, so a hybrid
     site's transfers fail without it — after the pointer has already moved. */
  'document_audit',
  /* The licence lease — the SAME table the local backend uses, not a second
     shape meaning the same thing. Read from the box because a till with the
     line down can reach exactly one thing. */
  'licence_lease',
]

/**
 * Lookups whose ROWS are copied down, not just their shape.
 *
 * document_audit is deliberately NOT here: the box records what happens on the
 * box, and the shop's own history stays in the cloud where the back office
 * reads it.
 */
const MIRRORED = ['pos_visit_types', 'pos_floor_rooms', 'sales_reps', 'users', 'terminals']

const TAB_TABLES = ['sales_documents', 'sales_document_lines', 'pos_tables']

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function skip(why: string) {
  console.log(`\n**SKIPPED**  ${why}\n`)
  process.exit(0)
}

type DbRow = RowDataPacket & {
  purpose: string
  server_host: string
  server_port: number
  database_name: string
  db_username: string | null
  db_password_enc: string | null
}

async function main() {
  console.log('\nThe in-store box\n')

  const site = await queryOne<RowDataPacket & { id: number; site_code: string }>(
    "SELECT id, site_code FROM cp2_sites WHERE connection_type = 'hybrid' LIMIT 1",
  )
  if (!site) skip('no hybrid site in the control panel.')

  const records = await query<DbRow>(
    `SELECT purpose, server_host, server_port, database_name, db_username, db_password_enc
       FROM cp2_site_databases
      WHERE site_id = ? AND status = 'active' AND purpose IN ('hybrid','master')`,
    [site!.id],
  )
  const box = records.find((r) => r.purpose === 'hybrid')
  const master = records.find((r) => r.purpose === 'master')
  if (!box || !master) skip(`site ${site!.site_code} has no hybrid/master pair.`)

  const conn = await mysql
    .createConnection({
      host: process.env.SITE_DB_HOST_OVERRIDE?.trim() || box!.server_host,
      port: box!.server_port || 3306,
      user: box!.db_username || '',
      password: decryptSecret(box!.db_password_enc),
      timezone: 'Z',
    })
    .catch(() => null)

  if (!conn) skip(`cannot reach the box for ${site!.site_code}. Run box-migrate.mjs.`)

  const [tables] = await conn!.query<RowDataPacket[]>(
    'SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
    [box!.database_name],
  )
  const present = tables.map((r) => r.t as string)
  if (present.length === 0) {
    await conn!.end()
    skip(`the box for ${site!.site_code} is empty. Run box-migrate.mjs.`)
  }

  /* ── It holds what a spool holds ───────────────────────────────────────── */

  for (const t of EXPECTED) check(`${t} is present`, present.includes(t))

  /* THE POINT OF THE WHOLE DESIGN. The site schema is ~250 tables; following
     the tab tables' foreign keys alone would pull in 32. A box that grows past
     this list has stopped being a spool and started being a second shop — with
     a second stock ledger nobody can reconcile. */
  const extra = present.filter((t) => !EXPECTED.includes(t))
  check('the box holds nothing else', extra.length === 0, extra.join(', '))

  /* ── The tab tables match the shop, column for column ──────────────────── */

  for (const t of TAB_TABLES) {
    const [diff] = await conn!.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          AND COLUMN_NAME NOT IN (
            SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?)`,
      [master!.database_name, t, box!.database_name, t],
    )
    /* Derived from SHOW CREATE TABLE on the master rather than hand-written,
       so this cannot drift. A miss here means box-migrate dropped a column it
       should have kept — and a tab the cloud would then refuse. */
    check(
      `${t} has every column the shop has`,
      diff.length === 0,
      diff.map((d) => d.c).join(', '),
    )
  }

  /* ── The mirrored lookups have ROWS, not just shape ────────────────────── */

  /* A shape-only check passes with an empty table, and an empty pos_visit_types
     renders a floor where every table is unlabelled — which looks like working
     software right up until a waiter needs to tell takeaway from sit-down. */
  /* The box user is scoped to its OWN database — it cannot read the master, and
     that grant is deliberate (see dbSetup/sql.ts: the box holds open tabs and
     never needs the shop). So the shop side is counted through siteQuery, which
     uses the site's own credentials. */
  const { siteQueryOne } = await import('../src/lib/siteDb')

  for (const t of MIRRORED) {
    const [[onBoxRow]] = await conn!.query<RowDataPacket[]>(
      `SELECT COUNT(*) n FROM \`${box!.database_name}\`.\`${t}\``,
    )
    const onCloudRow = await siteQueryOne<{ n: number }>(
      site!.id,
      `SELECT COUNT(*) AS n FROM \`${t}\``,
    )
    check(
      `${t} rows are mirrored from the shop`,
      Number(onBoxRow.n) === Number(onCloudRow?.n),
      `box ${onBoxRow.n} vs shop ${onCloudRow?.n}`,
    )
  }

  /* ── Foreign keys: internal kept, external dropped ─────────────────────── */

  const [fks] = await conn!.query<RowDataPacket[]>(
    `SELECT CONSTRAINT_NAME n, TABLE_NAME t, REFERENCED_TABLE_NAME r
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
    [box!.database_name],
  )

  /* Every surviving FK must point at a table the box actually has. One that
     does not would make an insert fail against a table that is not there. */
  const dangling = fks.filter((f) => !present.includes(f.r as string))
  check('no foreign key points at a missing table', dangling.length === 0,
    dangling.map((f) => `${f.n} -> ${f.r}`).join(', '))

  /* The cascade that was lost the first time this was built: deleting a
     document must take its lines. Both tables are on the box, so nothing
     forced this FK to go — and without it, closing a tab leaves its lines
     behind forever. */
  check(
    'a document still cascades to its lines',
    fks.some((f) => f.t === 'sales_document_lines' && f.r === 'sales_documents'),
  )
  check(
    'a table still points at its bill',
    fks.some((f) => f.t === 'pos_tables' && f.r === 'sales_documents'),
  )

  await conn!.end()
  console.log(`\n${failures === 0 ? 'The box holds.' : `${failures} FAILED`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`\n  ${err?.message || err}\n`)
  process.exit(1)
})
