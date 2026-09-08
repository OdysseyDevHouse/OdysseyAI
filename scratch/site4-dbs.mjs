import mysql from 'mysql2/promise'
import { decryptSecret } from '../scripts/lib/controlDb.mjs'
const conn = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
  user: process.env.DB_USER, password: decryptSecret(process.env.DB_PASSWORD),
  database: process.env.DB_NAME, connectTimeout: 15000,
})
const [rows] = await conn.query(
  `SELECT id, site_id, purpose, location_name, server_host, server_port, database_name, db_username, db_engine, status
   FROM cp2_site_databases WHERE site_id = 4`)
console.table(rows)
await conn.end()
