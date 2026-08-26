/**
 * Give a site the modules it has been sold.
 *
 * ── WHY A SITE WITH NO MODULES LOOKS BROKEN ─────────────────────────────────
 *
 * The side menu is built from what the shop has bought — `entitlementsForSite`
 * reads cp2_site_modules — so a site with no rows there signs in successfully
 * and shows an empty frame. Worse, the one screen that could fix a licence,
 * Setup → Tills, checks a module too: the licence gate lets it through as the
 * bootstrap path and the screen itself then refuses, so the machine cannot
 * register itself and cannot be told why.
 *
 * Two guards, each correct alone, combining into a dead end.
 *
 * ── WHAT THIS WRITES ────────────────────────────────────────────────────────
 *
 * Rows in cp2_site_modules for ONE site, in the CONTROL database. Nothing else,
 * and nothing on any shop's own machine. Existing rows are left alone rather
 * than replaced — this grants, it does not reconcile.
 *
 *   npx tsx --env-file=.env scripts/set-site-modules.mjs --site 4
 *   npx tsx --env-file=.env scripts/set-site-modules.mjs --site 4 --like 1
 *   npx tsx --env-file=.env scripts/set-site-modules.mjs --site 4 --like 1 --apply
 *
 * --like <siteId>  copy whatever that site has, for a test site that should
 *                  look like a real one
 * --modules a,b,c  name them explicitly instead
 *
 * Dry run unless --apply. This edits a production control panel.
 */
import mysql from 'mysql2/promise'

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const apply = argv.includes('--apply')
const siteId = Number(arg('site'))
const like = arg('like') ? Number(arg('like')) : null
const explicit = arg('modules')
  ? String(arg('modules'))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : null

if (!Number.isFinite(siteId) || siteId <= 0) {
  console.error('Usage: npx tsx --env-file=.env scripts/set-site-modules.mjs --site <id> [--like <id>] [--modules a,b] [--apply]')
  process.exit(1)
}

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectTimeout: 10000,
})

const [site] = await conn.execute(
  'SELECT site_code, company_name, connection_type FROM cp2_sites WHERE id = ? LIMIT 1',
  [siteId],
)
if (!site.length) {
  console.error(`No site ${siteId}.`)
  await conn.end()
  process.exit(1)
}

const [current] = await conn.execute(
  'SELECT module_key FROM cp2_site_modules WHERE site_id = ?',
  [siteId],
)
const have = new Set(current.map((r) => r.module_key))

let wanted
if (explicit) {
  wanted = explicit
} else if (like !== null) {
  const [rows] = await conn.execute(
    'SELECT DISTINCT module_key FROM cp2_site_modules WHERE site_id = ?',
    [like],
  )
  wanted = rows.map((r) => r.module_key)
  if (!wanted.length) {
    console.error(`Site ${like} has no modules to copy.`)
    await conn.end()
    process.exit(1)
  }
} else {
  /* The floor. Without `starter` there is no menu at all, so a site with
     nothing is more useful with this than with an argument about what else it
     should have. */
  wanted = ['starter']
}

const missing = wanted.filter((m) => !have.has(m))

console.log('')
console.log(`  site #${siteId} ${site[0].site_code} — ${site[0].company_name} (${site[0].connection_type})`)
console.log(`  has    : ${have.size ? [...have].join(', ') : '(none)'}`)
console.log(`  adding : ${missing.length ? missing.join(', ') : '(nothing — already has them all)'}`)
console.log('')

if (!missing.length) {
  await conn.end()
  process.exit(0)
}

if (!apply) {
  console.log('  Dry run. Nothing was written. Add --apply to grant them.')
  console.log('')
  await conn.end()
  process.exit(0)
}

for (const key of missing) {
  await conn.execute(
    `INSERT INTO cp2_site_modules (site_id, module_key, quantity, starts_on, created_by)
     VALUES (?, ?, 1, CURDATE(), ?)`,
    [siteId, key, 'set-site-modules script'],
  )
}

console.log(`  Granted ${missing.length} module(s). Reopen Odyssey to see the menu.`)
console.log('')
await conn.end()
