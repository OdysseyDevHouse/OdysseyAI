// Throwaway: seeds the offline site_profile mirror that Setup failed to write.
// Delete after running.
import mysql from 'mysql2/promise'

const SITE_ID = 4

const ctl = await mysql.createConnection({
  host: '105.30.57.88',
  port: 3306,
  user: 'tiaan_vs_code_user',
  password: 'p55HBTL9YdSCaS2RIAFy',
  database: 'odyssey_tickets',
  connectTimeout: 10000,
})
const [rows] = await ctl.query(
  `SELECT id, site_code, company_name, trading_name, registration_number, vat_number,
          address1, address2, address3, postal_code, phone, email, contact_name,
          connection_type, site_type_id, is_paid, status
     FROM cp2_sites WHERE id = ? LIMIT 1`,
  [SITE_ID],
)
await ctl.end()
const s = rows[0]
if (!s) throw new Error('no cp2_sites row for ' + SITE_ID)

const site = await mysql.createConnection({
  host: '127.0.0.1',
  port: 33359,
  user: 'ody10003',
  password: 'WHLOo6ZmKvO3Lqom4Fi7yWZfs2OtDsB5',
  database: 'ODY10003_master',
  connectTimeout: 8000,
})
await site.query(
  `REPLACE INTO site_profile
     (id, site_id, site_code, company_name, trading_name, registration_number, vat_number,
      address1, address2, address3, postal_code, phone, email, contact_name,
      connection_type, site_type_id, is_paid, status, mirrored_at)
   VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
  [
    s.id, s.site_code, s.company_name, s.trading_name, s.registration_number, s.vat_number,
    s.address1, s.address2, s.address3, s.postal_code, s.phone, s.email, s.contact_name,
    s.connection_type, s.site_type_id, s.is_paid ? 1 : 0, s.status,
  ],
)
const [check] = await site.query(
  'SELECT site_id, site_code, company_name, connection_type, mirrored_at FROM site_profile',
)
console.log('seeded:', JSON.stringify(check, null, 2))
await site.end()
