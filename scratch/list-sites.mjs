import mysql from 'mysql2/promise'
import { decryptSecret } from '../scripts/lib/controlDb.mjs'

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: decryptSecret(process.env.DB_PASSWORD),
  database: process.env.DB_NAME,
  connectTimeout: 15000,
})

const [cols] = await conn.query(`SHOW COLUMNS FROM cp2_sites`)
console.log('cp2_sites columns:', cols.map(c => c.Field).join(', '))
const [sites] = await conn.query(`SELECT * FROM cp2_sites ORDER BY id`)
console.table(sites)
await conn.end()
