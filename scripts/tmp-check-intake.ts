import { siteQuery } from '../src/lib/siteDb'
async function main() {
  const j = await siteQuery<any>(1,
    `SELECT id, document_number, source, customer_name, description
       FROM job_cards WHERE title LIKE 'BROWSER PROBE%'`)
  console.log('job:', JSON.stringify(j, null, 1))
  const r = await siteQuery<any>(1,
    `SELECT reference, status, job_card_id, customer_id, decided_by_name
       FROM job_requests WHERE title LIKE 'BROWSER PROBE%'`)
  console.log('request:', JSON.stringify(r))
}
main().then(() => process.exit(0))
