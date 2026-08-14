import { siteQuery } from '../src/lib/siteDb'
async function main() {
  const s = await siteQuery<any>(1,
    `SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'job_feedback%'`)
  console.log('settings:', JSON.stringify(s))
  const f = await siteQuery<any>(1, `SELECT COUNT(*) AS n FROM job_feedback`)
  const j = await siteQuery<any>(1, `SELECT id, customer_email FROM job_cards WHERE id = 12`)
  console.log('feedback rows:', f[0].n, ' job 12 email:', JSON.stringify(j))
}
main().then(() => process.exit(0))
