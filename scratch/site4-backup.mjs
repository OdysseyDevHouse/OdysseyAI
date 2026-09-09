import mysql from 'mysql2/promise'
import { writeFileSync } from 'node:fs'

const OUT = process.argv[2]
const conn = await mysql.createConnection({
  host: process.env.ODYSSEY_SITE_DB_HOST, port: Number(process.env.ODYSSEY_SITE_DB_PORT),
  user: process.env.ODYSSEY_SITE_DB_USER, password: process.env.ODYSSEY_SITE_DB_PASSWORD,
  database: process.env.ODYSSEY_SITE_DB_NAME, connectTimeout: 10000,
})
const db = process.env.ODYSSEY_SITE_DB_NAME

// Every table that references products or departments, plus the two themselves.
const [refs] = await conn.query(
  `SELECT DISTINCT TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE
   WHERE CONSTRAINT_SCHEMA = ? AND REFERENCED_TABLE_NAME IN ('products','departments')`, [db])
const tables = [...new Set(['products', 'departments', ...refs.map(r => r.TABLE_NAME)])].sort()

const dump = { database: db, takenAt: new Date().toISOString(), tables: {} }
let total = 0
for (const t of tables) {
  const [rows] = await conn.query(`SELECT * FROM \`${t}\``)
  dump.tables[t] = rows
  total += rows.length
  if (rows.length) console.log(`  ${t}: ${rows.length}`)
}
writeFileSync(OUT, JSON.stringify(dump, null, 1))
console.log(`\n${tables.length} tables, ${total} rows -> ${OUT}`)
await conn.end()
