// Read-only: run the exact statements the Loyalty screen issues against the
// local install database, so the fix is proved by the queries that failed.
//
//   node --env-file=.env --env-file=.env.local scratch/probe-loyalty-page-sql.mjs
import mysql from 'mysql2/promise'

const c = await mysql.createConnection({
  host: process.env.ODYSSEY_SITE_DB_HOST,
  port: +(process.env.ODYSSEY_SITE_DB_PORT || 3306),
  user: process.env.ODYSSEY_SITE_DB_USER,
  password: process.env.ODYSSEY_SITE_DB_PASSWORD,
  database: process.env.ODYSSEY_SITE_DB_NAME,
})

// listMembers(), from src/lib/site/loyalty.ts
const members = `
  SELECT m.id, m.member_number, m.customer_id, m.name, m.phone,
         COALESCE(l.points, 0) AS points,
         COALESCE(w.wallet, 0) AS wallet,
         COALESCE(s.spend, 0) AS spend,
         COALESCE(v.ready, 0) AS vouchers_ready,
         m.last_activity_at,
         t.name AS tier_name, t.color AS tier_color
    FROM loyalty_members m
    LEFT JOIN loyalty_tiers t ON t.id = m.tier_id
    LEFT JOIN (
      SELECT member_id, SUM(points) AS points FROM loyalty_ledger GROUP BY member_id
    ) l ON l.member_id = m.id
    LEFT JOIN (
      SELECT member_id, SUM(amount) AS wallet FROM loyalty_wallet GROUP BY member_id
    ) w ON w.member_id = m.id
    LEFT JOIN (
      SELECT member_id, SUM(basis_amount) AS spend
        FROM loyalty_ledger
       WHERE entry_type = 'earn'
       GROUP BY member_id
    ) s ON s.member_id = m.id
    LEFT JOIN (
      SELECT member_id, COUNT(*) AS ready
        FROM loyalty_vouchers
       WHERE status = 'issued' AND (expires_on IS NULL OR expires_on >= CURDATE())
       GROUP BY member_id
    ) v ON v.member_id = m.id
   ORDER BY points DESC, m.name ASC
   LIMIT 501`

// getLiability()
const liability = `
  SELECT COUNT(*) AS members, COALESCE(SUM(points),0) AS points FROM (
    SELECT member_id, SUM(points) AS points
      FROM loyalty_ledger GROUP BY member_id HAVING SUM(points) > 0
  ) t`

// listTiers() and the punch-card screen
const tiers = `SELECT id, name, step, qualifying_spend, multiplier, discount_pct, color, is_active
                 FROM loyalty_tiers ORDER BY step`
const cards = `SELECT c.id, c.name, c.required_stamps, c.reward_type, c.reward_product_code,
                      COUNT(i.id) AS scope_rows
                 FROM loyalty_cards c
                 LEFT JOIN loyalty_card_items i ON i.card_id = c.id
                GROUP BY c.id`
// memberSummaries(), which the till calls on every sale
const summaries = `SELECT m.id AS member_id, m.points_balance, COALESCE(t.name,'') AS tier_name
                     FROM loyalty_members m
                     LEFT JOIN loyalty_tiers t ON t.id = m.tier_id`

for (const [label, sql] of [
  ['listMembers', members],
  ['getLiability', liability],
  ['listTiers', tiers],
  ['punch cards', cards],
  ['memberSummaries', summaries],
]) {
  try {
    const [rows] = await c.query(sql)
    console.log(`ok    ${label}  (${rows.length} row(s))`)
  } catch (err) {
    console.log(`FAIL  ${label}: ${err.message}`)
  }
}

const [tenders] = await c.query(
  `SELECT code, requires_customer, is_active FROM tender_types WHERE integration_key = 'loyalty'`,
)
console.log('\nloyalty tenders:')
for (const t of tenders) {
  console.log(`  ${t.code}  requires_customer=${t.requires_customer}  is_active=${t.is_active}`)
}

await c.end()
