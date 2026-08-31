// Lists active site ids from the control database, one per line.
import mysql from 'mysql2/promise'

const control = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
})
const [rows] = await control.query(
  `SELECT DISTINCT d.site_id
     FROM cp2_site_databases d
    WHERE d.status = 'active'
    ORDER BY d.site_id`,
)
for (const r of rows) console.log(r.site_id)
await control.end()
