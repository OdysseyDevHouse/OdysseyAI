// Read-only: do the site TRADING databases exist on the cloud server?
//
// cp2_site_databases stores `localhost` as the host, meaning "localhost of the
// database server" (see siteDb.ts resolveHost). On a developer machine that
// silently means the developer's own MariaDB. A desktop install on any other
// machine has to reach them over the network instead — so they have to actually
// be on the server the app connects to.
//
//   node --env-file=.env scripts/check-trading-dbs.mjs
import mysql from 'mysql2/promise'

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectTimeout: 10000,
})

const [wanted] = await conn.query(
  `SELECT DISTINCT database_name FROM cp2_site_databases ORDER BY database_name`,
)
const [present] = await conn.query(`SHOW DATABASES`)
const have = new Set(present.map((r) => Object.values(r)[0]))

console.log(`server ${process.env.DB_HOST} holds ${have.size} database(s)`)
console.log('')
for (const row of wanted) {
  const name = row.database_name
  console.log(`  ${have.has(name) ? 'PRESENT' : 'MISSING'}  ${name}`)
}

console.log('')
console.log('all databases on that server:')
for (const n of [...have].sort()) console.log(`  ${n}`)

await conn.end()
