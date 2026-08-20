/*
 * Can a customer live in ANOTHER site's database?
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-shared-customer-file.ts
 *
 * Stage 1 of the shared customer file (Option B). Two questions decide the
 * shape of the whole project, and both are cheap to answer now and expensive to
 * discover after forty files have been routed:
 *
 *   1. THE REPORT BUILDER. Its joins are composed into ONE SQL string by a
 *      planner, with no seam to split at. If MariaDB can join `db_a.customers`
 *      to `db_b.sales_documents` in a single statement, the engine needs a
 *      qualifier rather than a rewrite — the difference between a day and a
 *      month of work.
 *
 *   2. cashbook_links. It holds a real CASCADE foreign key into
 *      customer_transactions. A foreign key cannot span databases, so this
 *      proves what MariaDB actually does when asked.
 *
 * Reads the live control database for real site databases and probes them.
 * WRITES NOTHING except inside a scratch database it creates and drops.
 */
import { query } from '../src/lib/db'
import { sitePool } from '../src/lib/siteDb'
import type { RowDataPacket } from 'mysql2'
import mysql from 'mysql2/promise'

type DbRow = RowDataPacket & {
  site_id: number
  database_name: string
  server_host: string
  server_port: number
  db_username: string | null
  db_password_enc: string | null
}

const SCRATCH_A = 'odyssey_probe_xdb_a'
const SCRATCH_B = 'odyssey_probe_xdb_b'

async function main() {
  console.log('── Shared customer file: stage 1 probe ───────────────────\n')

  /* ── The real sites, and whether they share one server ───────────────── */

  const dbs = await query<DbRow>(
    `SELECT site_id, database_name, server_host, server_port, db_username
       FROM cp2_site_databases
      WHERE purpose = 'master' AND status = 'active'
      ORDER BY site_id`,
  )

  console.log(`Active master databases: ${dbs.length}`)
  for (const d of dbs) {
    console.log(
      `  site ${d.site_id}  ${d.database_name}  @ ${d.server_host}:${d.server_port}` +
        `  as ${d.db_username ?? '(none)'}`,
    )
  }

  const hosts = new Set(dbs.map((d) => `${d.server_host}:${d.server_port}`))
  console.log(
    hosts.size <= 1
      ? '\n  ✓ All on ONE server — a cross-database join is at least possible.'
      : `\n  ✗ ${hosts.size} distinct servers. Cross-database joins are impossible ` +
          'between sites on different hosts; the plan\'s same-instance precondition ' +
          'must be enforced at the switch.',
  )

  /* ── Q1: can MariaDB join across two databases? ──────────────────────── */

  console.log('\n── Q1. Cross-database JOIN in one statement ──────────────\n')

  // Own connection, no database selected: creating and dropping scratch
  // schemas must not run through a pooled site connection.
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: false,
  })

  try {
    for (const db of [SCRATCH_A, SCRATCH_B]) {
      await admin.query(`DROP DATABASE IF EXISTS \`${db}\``)
      await admin.query(`CREATE DATABASE \`${db}\``)
    }

    // A stand-in for the shared customer file (lives in A) and a branch's own
    // sales documents (live in B) — the exact shape the report builder joins.
    await admin.query(`
      CREATE TABLE \`${SCRATCH_A}\`.customers (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        code VARCHAR(32) NOT NULL,
        name VARCHAR(160) NOT NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB`)
    await admin.query(`
      CREATE TABLE \`${SCRATCH_B}\`.sales_documents (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        customer_id INT UNSIGNED NULL,
        total DECIMAL(12,4) NOT NULL DEFAULT 0,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB`)

    await admin.query(
      `INSERT INTO \`${SCRATCH_A}\`.customers (id, code, name) VALUES (1,'CUST0001','Botha'),(2,'CUST0002','Naidoo')`,
    )
    await admin.query(
      `INSERT INTO \`${SCRATCH_B}\`.sales_documents (customer_id, total) VALUES (1,100),(1,250),(2,75)`,
    )

    // THE QUESTION. Not just a join — a join that FILTERS and SORTS on the
    // remote table, which is the case the plan flagged as unsplittable.
    const [rows] = await admin.query<RowDataPacket[]>(
      `SELECT c.code, c.name, SUM(d.total) AS spend
         FROM \`${SCRATCH_B}\`.sales_documents d
         LEFT JOIN \`${SCRATCH_A}\`.customers c ON c.id = d.customer_id
        WHERE c.name LIKE ?
        GROUP BY c.code, c.name
        ORDER BY c.name`,
      ['%o%'],
    )

    console.log('  Query: JOIN across two databases, filtered and sorted on the REMOTE table')
    console.log('  Result:', JSON.stringify(rows))
    console.log(
      rows.length > 0
        ? '\n  ✓ WORKS. MariaDB joins across databases on one instance, including\n' +
            '    WHERE and ORDER BY on the remote table. The report builder needs a\n' +
            '    database QUALIFIER, not a two-phase split.'
        : '\n  ✗ Returned nothing — investigate before relying on this.',
    )

    /* ── Q2: can a foreign key span databases? ─────────────────────────── */

    console.log('\n── Q2. Cross-database FOREIGN KEY (cashbook_links) ───────\n')

    let fkOk = false
    let fkErr = ''
    try {
      await admin.query(`
        CREATE TABLE \`${SCRATCH_B}\`.cashbook_links (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT,
          customer_id INT UNSIGNED NULL,
          PRIMARY KEY (id),
          CONSTRAINT fk_probe_x FOREIGN KEY (customer_id)
            REFERENCES \`${SCRATCH_A}\`.customers (id) ON DELETE CASCADE
        ) ENGINE=InnoDB`)
      fkOk = true
    } catch (e) {
      fkErr = e instanceof Error ? e.message : String(e)
    }

    console.log(
      fkOk
        ? '  ✓ ACCEPTED. A cross-database FK is possible — cashbook_links may keep\n' +
            '    its cascade. Verify the cascade actually FIRES before relying on it.'
        : `  ✗ REFUSED, as the plan assumed.\n    ${fkErr}\n\n` +
            '    So cashbook_links.customer_txn_id must become a code-validated\n' +
            '    reference, and the reversal path takes over what the cascade did.',
    )

    // If the FK was accepted, does the cascade actually delete? An accepted
    // constraint that silently does nothing would be worse than a refusal.
    if (fkOk) {
      await admin.query(`INSERT INTO \`${SCRATCH_B}\`.cashbook_links (customer_id) VALUES (1)`)
      await admin.query(`DELETE FROM \`${SCRATCH_A}\`.customers WHERE id = 1`)
      const [left] = await admin.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM \`${SCRATCH_B}\`.cashbook_links`,
      )
      const n = Number((left[0] as { n: number }).n)
      console.log(
        n === 0
          ? '  ✓ The cascade fires across databases too.'
          : `  ✗ The constraint exists but the cascade did NOT fire (${n} row(s) left).`,
      )
    }
  } finally {
    for (const db of [SCRATCH_A, SCRATCH_B]) {
      await admin.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {})
    }
    await admin.end()
  }

  /* ── Q3: the same join, against the REAL databases ───────────────────── */

  if (dbs.length >= 2 && hosts.size === 1) {
    console.log('\n── Q3. The same join across two REAL site databases ──────\n')
    const [a, b] = dbs
    try {
      const pool = await sitePool(a.site_id, 'master')
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n
           FROM \`${b.database_name}\`.sales_documents d
           LEFT JOIN \`${a.database_name}\`.customers c ON c.id = d.customer_id`,
      )
      console.log(
        `  Joined ${b.database_name}.sales_documents to ${a.database_name}.customers`,
      )
      console.log('  Rows visible:', JSON.stringify(rows))
      const [who] = await pool.query<RowDataPacket[]>('SELECT CURRENT_USER() AS u')
      const asUser = String((who[0] as { u: string }).u)
      console.log('  Connected as:', asUser)

      const privileged = /^root@/.test(asUser)
      console.log(
        privileged
          ? '\n  ⚠ It worked, but this connection is ROOT — which can read every\n' +
              '    schema by definition. That proves MariaDB allows the join, NOT that\n' +
              '    a production per-site user would be allowed to run it.\n\n' +
              '    Production sites must grant each site user SELECT on the primary\n' +
              "    store's schema. Add it to the switch's preconditions."
          : '\n  ✓ And this is a per-site user, not root — so the grant genuinely\n' +
              '    carries across schemas in this deployment.',
      )
    } catch (e) {
      console.log(
        `  ✗ Failed: ${e instanceof Error ? e.message : String(e)}\n\n` +
          '    Most likely a GRANT problem rather than a MariaDB limitation: each\n' +
          "    site's user may only be granted its own schema. Fixable, but it must\n" +
          '    be fixed deliberately.',
      )
    }
  } else {
    console.log('\n── Q3 skipped: needs two site databases on one server.')
  }

  console.log('\n── Done ─────────────────────────────────────────────────')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
