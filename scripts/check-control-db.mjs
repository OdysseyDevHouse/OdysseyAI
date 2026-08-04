// Read-only sanity check of the control database wiring.
//
//   node --env-file=.env scripts/check-control-db.mjs
//
// Confirms the app can reach odyssey_tickets, that cp2_users hashes are a
// format we can verify, and that the cp2_user_sites -> cp2_sites ->
// cp2_site_databases chain resolves. Writes nothing.
import mysql from 'mysql2/promise'
import bcrypt from 'bcryptjs'

const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
})

console.log(`control db: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}\n`)

// 1. bcrypt round-trip on a hash we generate ourselves. This proves the
//    verification mechanism without needing anyone's real password.
const probe = await bcrypt.hash('correct-horse', 10)
const good = await bcrypt.compare('correct-horse', probe)
const bad = await bcrypt.compare('wrong-horse', probe)
console.log(`bcrypt mechanism: match=${good} mismatch-rejected=${!bad}`)

// 2. Users, and whether their stored hash is a shape we can check.
const [users] = await db.query(
  `SELECT id, email, full_name, status, must_change_password, password_hash FROM cp2_users`,
)
console.log(`\ncp2_users: ${users.length} row(s)`)
for (const u of users) {
  const shape = /^\$2[aby]\$\d{2}\$.{53}$/.test(u.password_hash)
  console.log(
    `  #${u.id} ${u.email} — status=${u.status} must_change=${u.must_change_password} verifiable_hash=${shape}`,
  )
}

// 3. The access chain, exactly as lib/sites.ts resolves it.
const [links] = await db.query(
  `SELECT us.user_id, u.email, s.id AS site_id, s.site_code, s.company_name,
          us.site_role, us.is_default, us.status AS link_status, s.status AS site_status
     FROM cp2_user_sites us
     INNER JOIN cp2_users u ON u.id = us.user_id
     INNER JOIN cp2_sites s ON s.id = us.site_id
    WHERE us.status = 'active' AND s.status IN ('active','suspended')
    ORDER BY us.user_id, us.is_default DESC`,
)
console.log(`\naccessible site links: ${links.length}`)
for (const l of links) {
  console.log(
    `  ${l.email} -> ${l.site_code} "${l.company_name}" role=${l.site_role}${l.is_default ? ' (default)' : ''}`,
  )
}

// 4. Where each site's data actually lives.
const [dbs] = await db.query(
  `SELECT site_id, purpose, server_host, server_port, database_name, db_username, status
     FROM cp2_site_databases ORDER BY site_id, purpose`,
)
console.log(`\ncp2_site_databases: ${dbs.length} row(s)`)
for (const d of dbs) {
  console.log(
    `  site=${d.site_id} ${d.purpose} -> ${d.server_host}:${d.server_port}/${d.database_name} as ${d.db_username} [${d.status}]`,
  )
}

const siteIds = [...new Set(links.map((l) => l.site_id))]
const withDb = new Set(dbs.map((d) => d.site_id))
const missing = siteIds.filter((id) => !withDb.has(id))
if (missing.length) {
  console.log(`\n  NOTE: site id(s) ${missing.join(', ')} have no database row yet.`)
}

await db.end()
