/**
 * A fifth till on site 53, for the Android tablet.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/one-off/add-till05-site53.ts
 *
 * Site 53's four terminals are each claimed by a different machine, so the
 * tablet — which has its own device id — is refused at the unlock screen with
 * "not registered as a till". This adds the row it can claim.
 *
 * Left UNCLAIMED deliberately. The claim carries the device id, and the honest
 * way to get that is to read it off the tablet (the unlock screen now shows it
 * on an unclaimed machine) rather than to guess one here — a wrong id would
 * register a till nothing can unlock and look identical to this problem.
 */
import { siteQuery } from '../../src/lib/siteDb'

async function main() {
  const SITE = 53
  const existing = await siteQuery<any>(SITE, `SELECT id, code FROM terminals WHERE code = 'TILL05'`)
  if (existing.length > 0) {
    console.log(`TILL05 already exists (#${existing[0].id}) — nothing to do.`)
    return
  }

  await siteQuery(
    SITE,
    `INSERT INTO terminals (code, name, till_number) VALUES ('TILL05', 'Android Tablet', '05')`,
  )
  const [row] = await siteQuery<any>(SITE, `SELECT id, code, name, till_number FROM terminals WHERE code = 'TILL05'`)
  console.log(`created #${row.id} ${row.code} "${row.name}" till ${row.till_number}, unclaimed`)
  console.log('\nClaim it to the tablet under Setup → Terminals, using the id the')
  console.log('tablet now shows on its locked screen.')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1) })
