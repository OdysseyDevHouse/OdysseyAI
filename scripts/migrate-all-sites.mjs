// Applies sql/site/*.sql to EVERY active site, by driving site-migrate.mjs once
// per site.
//
//   node --env-file=.env scripts/migrate-all-sites.mjs [--probe] [--only=1,2,3]
//
// ── WHY THIS SPAWNS RATHER THAN LOOPS ───────────────────────────────────────
//
// site-migrate.mjs does more than call applyMigrations(). It picks the site's
// MASTER database while excluding the `hybrid` record — a distinction that
// already cost one site its schema, applied to an in-store spool box — then
// decrypts that site's own password, creates the database if it is new, and
// reconciles the control users afterwards. Reimplementing any of that here
// would give the platform two ideas of what "migrated" means, which is the
// exact thing electron/siteMigrate.js was extracted to prevent.
//
// So this file knows nothing about migrating. It answers one question — which
// sites — and runs the existing runner against each, which also buys per-site
// failure isolation for free: a site that blows up takes its own child process
// down and nothing else.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
//
// It does not apply sql/tickets/. Those run against odyssey_tickets, which is
// SHARED with the live Odyssey_Bind backend, and two of them drop indexes on
// cp2_devices — a change to that application, made from here. It reports them
// as pending and stops there; applying them stays a decision somebody makes
// with a backup open. See deploy/README-SERVER.md.
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createDecipheriv, scryptSync } from 'node:crypto'
import mysql from 'mysql2/promise'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const siteMigrate = path.join(here, 'site-migrate.mjs')

const probe = process.argv.includes('--probe')
const onlyArg = process.argv.find((a) => a.startsWith('--only='))
const only = onlyArg
  ? new Set(
      onlyArg
        .slice('--only='.length)
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    )
  : null

// Mirrors src/lib/crypto/secrets.ts, carried rather than imported from
// scripts/lib/controlDb.mjs for the reason that file states: the runners also
// run from the deployed app folder, which ships them and no others.
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
  // DB_PASSWORD may itself be an enc:v1 envelope — sending the ciphertext raw
  // gets "Access denied ... (using password: YES)", which reads as a wrong
  // password and is not one.
  password: decryptSecret(process.env.DB_PASSWORD),
  database: process.env.DB_NAME,
})

console.log(`control database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`)

/* ── Is the CONTROL database behind? ───────────────────────────────────────
 *
 * Read-only, and reported before anything else, because this is the failure
 * that hurts: a build whose new screen reads a cp2_* table nobody applied
 * fails at runtime with a 500, and no amount of site migrating fixes it. The
 * ledger is tickets-migrate.mjs's own; absent, everything is pending. */
const ticketFiles = (await readdir(path.join(root, 'sql', 'tickets')))
  .filter((f) => f.endsWith('.sql'))
  .sort()

const [ledger] = await control.query(
  `SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cp2_ai_migrations'`,
)
let appliedTickets = new Set()
if (ledger.length) {
  const [rows] = await control.query('SELECT name FROM cp2_ai_migrations')
  appliedTickets = new Set(rows.map((r) => r.name))
}
const pendingTickets = ticketFiles.filter((f) => !appliedTickets.has(f))

if (pendingTickets.length) {
  console.log(
    `\n!! ${pendingTickets.length} CONTROL migration(s) pending — NOT applied by this script:`,
  )
  for (const f of pendingTickets) console.log(`     ${f}`)
  console.log('   Review them, then: node --env-file=.env scripts/tickets-migrate.mjs --dry-run')
}

/* ── Which sites ──────────────────────────────────────────────────────────
 *
 * An active site with no database record is not a failure — it is a site that
 * was never provisioned. Filtering it out here rather than letting the runner
 * exit 1 on it keeps the summary's FAILED lines meaning something. The same
 * `purpose <> 'hybrid'` the runner uses, so the two agree on what counts as a
 * site having a database. */
const [sites] = await control.query(
  `SELECT s.id, s.company_name
     FROM cp2_sites s
    WHERE s.status = 'active'
      AND EXISTS (SELECT 1 FROM cp2_site_databases d
                   WHERE d.site_id = s.id AND d.status = 'active' AND d.purpose <> 'hybrid')
    ORDER BY s.id`,
)
const [unprovisioned] = await control.query(
  `SELECT s.id, s.company_name
     FROM cp2_sites s
    WHERE s.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM cp2_site_databases d
                       WHERE d.site_id = s.id AND d.status = 'active' AND d.purpose <> 'hybrid')
    ORDER BY s.id`,
)
await control.end()

const targets = only ? sites.filter((s) => only.has(s.id)) : sites

if (only) {
  const missing = [...only].filter((id) => !targets.some((s) => s.id === id))
  if (missing.length) {
    console.log(
      `\n--only named ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} not an active site with a database. Skipped.`,
    )
  }
}

if (!targets.length) {
  console.log('\nNo sites to migrate.')
  process.exitCode = pendingTickets.length ? 1 : 0
} else {
  console.log(
    `\n${targets.length} site(s) to ${probe ? 'probe' : 'migrate'}` +
      `${unprovisioned.length ? `, ${unprovisioned.length} without a database (skipped)` : ''}`,
  )

  /**
   * One site, in its own process.
   *
   * Output is relayed line by line rather than buffered: a brand-new site
   * applies the whole of sql/site/, and a run that prints nothing for two
   * minutes looks hung. Never rejects — a site that cannot even be spawned is
   * a result like any other, so one bad site cannot end the run.
   */
  function runSite(id) {
    return new Promise((resolve) => {
      const args = [siteMigrate, String(id)]
      if (probe) args.push('--probe')
      /* No --env-file: this process was started with one, so the child
         inherits the whole environment already resolved. */
      const child = spawn(process.execPath, args, {
        cwd: root,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      // The last non-empty line is the runner's verdict — "N migration(s)
      // applied", "already up to date", or whatever it failed with.
      let last = ''
      const relay = (stream) => {
        let buf = ''
        stream.setEncoding('utf8')
        stream.on('data', (chunk) => {
          buf += chunk
          const lines = buf.split('\n')
          buf = lines.pop()
          for (const line of lines) {
            if (line.trim()) last = line.trim()
            console.log('    ' + line)
          }
        })
        stream.on('end', () => {
          if (buf.trim()) {
            last = buf.trim()
            console.log('    ' + buf)
          }
        })
      }
      relay(child.stdout)
      relay(child.stderr)

      child.on('close', (code) => resolve({ code, last }))
      child.on('error', (err) => resolve({ code: -1, last: err.message }))
    })
  }

  const results = []
  for (const site of targets) {
    console.log(`\n── site ${site.id}${site.company_name ? ` · ${site.company_name}` : ''}`)
    const { code, last } = await runSite(site.id)
    results.push({ ...site, code, last })
  }

  const failed = results.filter((r) => r.code !== 0)

  console.log('\n' + '='.repeat(72))
  for (const r of results) {
    console.log(
      `  ${r.code === 0 ? 'ok    ' : 'FAILED'}  site ${String(r.id).padStart(4)}  ${r.last}`,
    )
  }
  for (const s of unprovisioned) {
    console.log(`  skip    site ${String(s.id).padStart(4)}  no active database configured`)
  }
  console.log(`\n${results.length} site(s): ${results.length - failed.length} ok, ${failed.length} failed`)

  if (pendingTickets.length) {
    console.log(
      `\n!! ${pendingTickets.length} control migration(s) are still pending — see the top of this run.`,
    )
  }

  /* exitCode rather than exit(): the relayed output is still draining, and
     exit() on Windows can cut it off mid-summary. */
  process.exitCode = failed.length || pendingTickets.length ? 1 : 0
}
