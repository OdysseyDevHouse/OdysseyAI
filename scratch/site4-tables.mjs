import mysql from 'mysql2/promise'
const conn = await mysql.createConnection({
  host: process.env.ODYSSEY_SITE_DB_HOST, port: Number(process.env.ODYSSEY_SITE_DB_PORT),
  user: process.env.ODYSSEY_SITE_DB_USER, password: process.env.ODYSSEY_SITE_DB_PASSWORD,
  database: process.env.ODYSSEY_SITE_DB_NAME, connectTimeout: 10000,
})
const [[{ db }]] = await conn.query('SELECT DATABASE() AS db')
console.log('connected to', db)
const [tables] = await conn.query(
  `SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [db])
console.log(tables.length, 'tables')
console.log(tables.map(t => `${t.TABLE_NAME}(${t.TABLE_ROWS})`).join('\n'))
await conn.end()
