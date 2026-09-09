import mysql from 'mysql2/promise'
const conn = await mysql.createConnection({
  host: process.env.ODYSSEY_SITE_DB_HOST, port: Number(process.env.ODYSSEY_SITE_DB_PORT),
  user: process.env.ODYSSEY_SITE_DB_USER, password: process.env.ODYSSEY_SITE_DB_PASSWORD,
  database: process.env.ODYSSEY_SITE_DB_NAME, connectTimeout: 10000,
})
const db = process.env.ODYSSEY_SITE_DB_NAME
for (const target of ['products', 'departments']) {
  const [rows] = await conn.query(
    `SELECT k.TABLE_NAME, k.COLUMN_NAME, k.CONSTRAINT_NAME, r.DELETE_RULE
     FROM information_schema.KEY_COLUMN_USAGE k
     JOIN information_schema.REFERENTIAL_CONSTRAINTS r
       ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
     WHERE k.CONSTRAINT_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ?
     ORDER BY k.TABLE_NAME`, [db, target])
  console.log(`\n=== FKs -> ${target} (${rows.length}) ===`)
  for (const r of rows) console.log(`  ${r.TABLE_NAME}.${r.COLUMN_NAME}  ON DELETE ${r.DELETE_RULE}`)
}
// columns that look like product/department references but have no FK
const [loose] = await conn.query(
  `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = ? AND (COLUMN_NAME LIKE '%product_id%' OR COLUMN_NAME LIKE '%department_id%')
   ORDER BY TABLE_NAME`, [db])
console.log(`\n=== all product_id/department_id columns (${loose.length}) ===`)
for (const r of loose) console.log(`  ${r.TABLE_NAME}.${r.COLUMN_NAME}`)
await conn.end()
