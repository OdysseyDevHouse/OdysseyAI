/**
 * The local mirror of the shop's own profile — the thing that lets an adopted
 * local install open a screen with no internet.
 *
 * Two decisions live in profileRowToSite() and both are worth pinning:
 *
 *   · A row whose site_id disagrees with the machine is REFUSED. That is what
 *     stops a backup taken at one shop and restored at another from presenting
 *     itself as the shop it came from — and it is a check that would be very
 *     easy to drop as "redundant" in a refactor.
 *   · The type coercions. mysql2 hands TINYINT and nullable INT back as strings
 *     under some driver configurations, and a shop whose siteTypeId is quietly
 *     the string "5" shows the wrong picture on its till PIN screen.
 *
 * Pure — no database, no server. The I/O around it is one REPLACE and one
 * SELECT, which a round trip would test no better than reading them.
 *
 *   npx tsx --conditions=react-server scripts/test-site-profile.ts
 */
import { profileRowToSite } from '../src/lib/site/siteProfile'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** What a freshly mirrored row looks like coming back out of MariaDB. */
const row = {
  site_id: 318,
  site_code: 'ODY-10247',
  company_name: 'Corner Shop Trading (Pty) Ltd',
  trading_name: 'Corner Shop Mowbray',
  registration_number: '2014/112233/07',
  vat_number: '4123456789',
  address1: '12 Main Road',
  address2: 'Mowbray',
  address3: 'Cape Town',
  postal_code: '7700',
  phone: '0216851234',
  email: 'accounts@cornershop.co.za',
  contact_name: 'Thandi Mokoena',
  connection_type: 'local',
  site_type_id: 5,
  is_paid: 1,
  status: 'active',
}

console.log('\nThe ordinary case')
const site = profileRowToSite(row, 318)!
check('a matching row maps to a site', !!site)
check('the id is the one that was asked for', site.id === 318)
check('the code survives', site.code === 'ODY-10247')
check('the trading name wins as the display name', site.displayName === 'Corner Shop Mowbray')
check('the address is carried whole', site.address1 === '12 Main Road' && site.postalCode === '7700')
check('the VAT number is carried — it goes on every invoice', site.vatNumber === '4123456789')
check('the connection type is carried', site.connectionType === 'local')

console.log('\nA DATABASE RESTORED ONTO THE WRONG MACHINE')
check('a row for another shop is refused', profileRowToSite(row, 999) === null)
check('a refusal is null, not a half-built site', profileRowToSite({ ...row, site_id: 1 }, 318) === null)
check(
  'the id is compared as a NUMBER, so a string 318 still matches',
  profileRowToSite({ ...row, site_id: '318' as unknown as number }, 318)?.id === 318,
)

console.log('\nThe display name falls back the way mapSite does')
check(
  'no trading name falls back to the company name',
  profileRowToSite({ ...row, trading_name: null }, 318)?.displayName === 'Corner Shop Trading (Pty) Ltd',
)
check(
  'a whitespace-only trading name falls back too',
  profileRowToSite({ ...row, trading_name: '   ' }, 318)?.displayName === 'Corner Shop Trading (Pty) Ltd',
)

console.log('\nDriver coercions — the quiet ones')
check(
  'site_type_id arriving as a string is a number',
  profileRowToSite({ ...row, site_type_id: '5' }, 318)?.siteTypeId === 5,
)
check(
  'a null site_type_id stays null rather than becoming 0',
  profileRowToSite({ ...row, site_type_id: null }, 318)?.siteTypeId === null,
)
check(
  'is_paid arriving as a string is still a boolean',
  profileRowToSite({ ...row, is_paid: '1' }, 318)?.isPaid === true &&
    profileRowToSite({ ...row, is_paid: '0' }, 318)?.isPaid === false,
)

console.log('\nThe membership half is deliberately absent')
// This copy answers "which shop is this machine", never "which shops may this
// person open". If role ever came back populated, the mirror would start to
// look like an access decision — which is exactly what it must not be.
check('role is null, as getSite already returns for a local install', site.role === null)
check('isDefault is true — one machine, one shop', site.isDefault === true)

console.log('\nMissing columns degrade rather than throw')
check(
  'an empty-ish row still yields a site rather than blowing up',
  profileRowToSite({ site_id: 318 }, 318)?.connectionType === 'cloud',
)

console.log(failures === 0 ? '\nAll site-profile checks passed.' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
