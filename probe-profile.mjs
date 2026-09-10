// Throwaway read-only probe. Delete after running.
import mysql from 'mysql2/promise'

const c = await mysql.createConnection({
  host: '127.0.0.1',
  port: 33359,
  user: 'ody10003',
  password: 'WHLOo6ZmKvO3Lqom4Fi7yWZfs2OtDsB5',
  database: 'ODY10003_master',
  connectTimeout: 8000,
})
const [rows] = await c.query('SELECT * FROM site_profile')
console.log('site_profile rows:', JSON.stringify(rows, null, 2))
await c.end()
