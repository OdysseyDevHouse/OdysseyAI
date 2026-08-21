// Drops the loyalty tables on every active site and re-runs 052.
//
//   node --env-file=.env scripts/reset-loyalty-schema.mjs [--yes]
//
// 052 was rewritten in place (member-centric), and migrations are recorded BY
// NAME — so a site that already ran the old 052 keeps the old shape for ever
// and editing the file does nothing. This is the catch-up.
//
// Only ever run with no live sites. It DELETES loyalty data.
import { readFileSync } from 'node:fs'
import { createDecipheriv, scryptSync } from 'node:crypto'
import mysql from 'mysql2/promise'

const PREFIX = 'enc:v1:'
function decryptSecret(stored) {
  if (!stored) return ''
  if (!stored.startsWith(PREFIX)) return stored
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':').map((s) => Buffer.from(s, 'base64'))
  const key = scryptSync(process.env.ENCRYPTION_KEY, 'odyssey-secret-v1', 32)
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

// Children before parents: every FK inside the cluster points at members or
// cards, so those go last.
const TABLES = [
  'loyalty_stamps', 'loyalty_vouchers', 'loyalty_card_items',
  'loyalty_ledger', 'loyalty_wallet', 'loyalty_cards',
  'loyalty_members', 'loyalty_tiers',
]

const control = await mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: 'odyssey_tickets',
})

const [sites] = await control.query(
  `SELECT d.site_id, d.server_host, d.server_port, d.database_name, d.db_username, d.db_password_enc,
          s.site_code
     FROM cp2_site_databases d
     JOIN cp2_sites s ON s.id = d.site_id
    WHERE d.purpose = 'master' AND d.status = 'active'
    ORDER BY d.site_id`,
)
await control.end()

if (!process.argv.includes('--yes')) {
  console.log(`Would reset loyalty on ${sites.length} site(s):`)
  for (const s of sites) console.log(`  ${s.site_code}  ${s.database_name}`)
  console.log('\nThis DELETES all loyalty data. Re-run with --yes to do it.')
  process.exit(0)
}

const sql = readFileSync('sql/site/052_loyalty.sql', 'utf8')
let done = 0

for (const s of sites) {
  const db = await mysql.createConnection({
    host: s.server_host, port: s.server_port, user: s.db_username,
    password: decryptSecret(s.db_password_enc), database: s.database_name,
    multipleStatements: true,
  })
  try {
    await db.query('SET FOREIGN_KEY_CHECKS = 0')
    for (const t of TABLES) await db.query(`DROP TABLE IF EXISTS \`${t}\``)
    await db.query('SET FOREIGN_KEY_CHECKS = 1')

    // The rewritten 052 also drops customers.loyalty_number, which is guarded
    // by IF EXISTS and so is safe to re-run.
    await db.query(sql)

    const [[m]] = await db.query(
      "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loyalty_members' AND COLUMN_NAME = 'member_number'",
    )
    if (Number(m.n) !== 1) throw new Error('loyalty_members has no member_number after re-run')

    console.log(`  ${s.site_code}  reset`)
    done++
  } catch (e) {
    console.error(`  ${s.site_code}  FAILED: ${e.message}`)
    await db.end()
    process.exit(1)
  }
  await db.end()
}

console.log(`\n${done} site(s) reset.`)
