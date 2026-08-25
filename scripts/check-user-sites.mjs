// Read-only: which site does each user land on, and what kind of site is it?
//
// After a forced password change the app sends a user to /select-site or
// /dashboard (see src/app/change-password/actions.ts). Both then need that
// site's TRADING database. Whether that database is reachable depends entirely
// on the site's connection_type — cloud sites answer from the cloud server,
// local sites from a MariaDB on the shop's own machine.
//
// So a tester who cannot get past sign-in is really asking: which site am I on,
// and is that site's database anywhere this machine can reach?
//
//   node --env-file=.env scripts/check-user-sites.mjs
import mysql from 'mysql2/promise'

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectTimeout: 10000,
})

const [rows] = await conn.query(
  `SELECT u.id, u.email, u.must_change_password, u.last_login_at,
          us.site_id, us.site_role, us.is_default, us.status AS link_status,
          s.connection_type
     FROM cp2_users u
     LEFT JOIN cp2_user_sites us ON us.user_id = u.id
     LEFT JOIN cp2_sites s ON s.id = us.site_id
    ORDER BY u.last_login_at IS NULL, u.last_login_at DESC, u.id`,
)

console.log('users, most recently signed in first')
console.log('')
for (const r of rows) {
  const last = r.last_login_at ? new Date(r.last_login_at).toISOString().slice(0, 16).replace('T', ' ') : 'never'
  const site = r.site_id === null
    ? 'NO SITE ASSIGNED  <-- lands on /select-site with nothing to pick'
    : `site #${r.site_id} (${r.connection_type}, role ${r.site_role}${r.is_default ? ', default' : ''})`
  console.log(`  ${r.email}`)
  console.log(`     last login : ${last}`)
  console.log(`     must change password : ${r.must_change_password ? 'YES' : 'no'}`)
  console.log(`     ${site}`)
  console.log('')
}

await conn.end()
