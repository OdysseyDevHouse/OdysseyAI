// Apply pending sql/site migrations to the LOCAL install database — the same
// applyMigrations() the desktop app runs at startup, against the connection
// .env.local describes.
//
//   node --env-file=.env --env-file=.env.local scratch/migrate-local.mjs
import mysql from 'mysql2/promise'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { applyMigrations } = require('../electron/siteMigrate.js')

const c = await mysql.createConnection({
  host: process.env.ODYSSEY_SITE_DB_HOST,
  port: +(process.env.ODYSSEY_SITE_DB_PORT || 3306),
  user: process.env.ODYSSEY_SITE_DB_USER,
  password: process.env.ODYSSEY_SITE_DB_PASSWORD,
  database: process.env.ODYSSEY_SITE_DB_NAME,
  multipleStatements: true,
})

const ran = await applyMigrations(c, { onProgress: (m) => console.log(m) })
console.log(`applied ${ran} migration(s)`)

await c.end()
