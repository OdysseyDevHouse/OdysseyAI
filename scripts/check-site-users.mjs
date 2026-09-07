// Read-only: does a site's own `users` table agree with the control panel?
//
// Two databases decide who may sign in — cp2_users/cp2_user_sites upstream, and
// the site's own `users` rows — and nothing joins them at write time. This
// prints both sides for one site so a mismatch is visible: a control account
// with no local row (invisible on the Users screen), a local row whose
// control_user_id points at somebody else's account (the wrong name in the top
// corner), or two local rows for one person.
//
//   node --env-file=.env scripts/check-site-users.mjs ODY-10004
import mysql from 'mysql2/promise'
import { decryptSecret } from './lib/controlDb.mjs'

const code = process.argv[2]
if (!code) {
  console.error('Usage: node --env-file=.env scripts/check-site-users.mjs <SITE-CODE>')
  process.exit(1)
}

const control = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: decryptSecret(process.env.DB_PASSWORD),
  database: process.env.DB_NAME,
})

const [[site]] = await control.query(
  'SELECT id, site_code, company_name FROM cp2_sites WHERE site_code = ?',
  [code],
)
if (!site) {
  console.error(`No site ${code}`)
  process.exit(1)
}
console.log(`\n${site.site_code} — ${site.company_name} (site #${site.id})\n`)

const [grants] = await control.query(
  `SELECT u.id, u.email, u.full_name, u.status, g.site_role, g.is_default, g.status AS grant_status
     FROM cp2_user_sites g INNER JOIN cp2_users u ON u.id = g.user_id
    WHERE g.site_id = ? ORDER BY u.id`,
  [site.id],
)
console.log('CONTROL PANEL — cp2_user_sites')
console.table(grants)

const [[dbRow]] = await control.query(
  `SELECT server_host, server_port, database_name, db_username, db_password_enc
     FROM cp2_site_databases
    WHERE site_id = ? AND status <> 'disabled'
    ORDER BY purpose = 'stock_file' DESC, id ASC LIMIT 1`,
  [site.id],
)
const siteConn = await mysql.createConnection({
  host: process.env.SITE_DB_HOST_OVERRIDE || dbRow.server_host,
  port: Number(dbRow.server_port) || 3306,
  user: dbRow.db_username,
  password: decryptSecret(dbRow.db_password_enc),
  database: dbRow.database_name,
})

const [locals] = await siteConn.query(
  `SELECT u.id, u.name, u.email, u.control_user_id, u.user_type, r.name AS role,
          u.pin_hash IS NOT NULL AS has_pin, u.is_active, u.created_at
     FROM users u LEFT JOIN roles r ON r.id = u.role_id ORDER BY u.id`,
)
console.log(`\nSITE DATABASE — ${dbRow.db_name}.users`)
console.table(locals)

console.log('\nMISMATCHES')
const byControl = new Map(locals.filter((u) => u.control_user_id).map((u) => [u.control_user_id, u]))
for (const g of grants.filter((g) => g.grant_status === 'active')) {
  const local = byControl.get(g.id)
  if (!local) console.log(`  · ${g.email} may open this store but has no local row`)
  else if ((local.email || '').toLowerCase() !== g.email.toLowerCase()) {
    console.log(
      `  · control account ${g.id} (${g.email}) is linked to local user #${local.id} "${local.name}" <${local.email}>`,
    )
  }
}
const seen = new Map()
for (const u of locals) {
  const key = (u.email || '').toLowerCase()
  if (!key) continue
  if (seen.has(key)) console.log(`  · ${key} appears twice: local #${seen.get(key)} and #${u.id}`)
  else seen.set(key, u.id)
}
for (const u of locals) {
  if (u.user_type === 'back_office' && !u.control_user_id) {
    console.log(`  · local #${u.id} "${u.name}" is back office with no control account — cannot sign in`)
  }
}

await control.end()
await siteConn.end()
