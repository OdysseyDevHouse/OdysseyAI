// Read-only: the loyalty shape in the LOCAL install's own database — the one
// .env.local points `npm run dev:desktop` at.
//
//   node --env-file=.env --env-file=.env.local scratch/probe-local-loyalty.mjs
import mysql from 'mysql2/promise'

const c = await mysql.createConnection({
  host: process.env.ODYSSEY_SITE_DB_HOST,
  port: +(process.env.ODYSSEY_SITE_DB_PORT || 3306),
  user: process.env.ODYSSEY_SITE_DB_USER,
  password: process.env.ODYSSEY_SITE_DB_PASSWORD,
  database: process.env.ODYSSEY_SITE_DB_NAME,
  connectTimeout: 8000,
})

const [cols] = await c.query(
  `SELECT TABLE_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) cols
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'loyalty%'
    GROUP BY TABLE_NAME ORDER BY TABLE_NAME`,
)
console.log('database:', process.env.ODYSSEY_SITE_DB_NAME)
for (const t of cols) {
  const [[n]] = await c.query(`SELECT COUNT(*) n FROM \`${t.TABLE_NAME}\``)
  console.log(`\n${t.TABLE_NAME}  (${n.n} rows)\n  ${t.cols}`)
}

const [mig] = await c.query(
  `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 5`,
)
console.log('\nlatest migrations:', mig.map((m) => m.name).join(', '))

const [[has052]] = await c.query(
  `SELECT COUNT(*) n FROM schema_migrations WHERE name = '052_loyalty.sql'`,
)
console.log('052_loyalty.sql recorded:', has052.n)

await c.end()
