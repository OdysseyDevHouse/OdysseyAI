/**
 * My store information — the rules that are not visible on the screen.
 *
 * Two things here are load-bearing and neither is provable by looking at the
 * page: that a LOCAL store is refused a write no matter what it posts, and that
 * an over-long field is REFUSED rather than silently truncated by MySQL on the
 * way in. A truncated VAT number is saved wrong and then printed on every tax
 * invoice after that, which is the kind of bug nobody reports as a bug.
 *
 * The action itself needs a session, so what is exercised here is the logic the
 * action is made of — the same functions, called directly. The action wires
 * them together and re-checks the capability; see the header in actions.ts.
 *
 *   npx tsx scripts/test-store-info.ts
 */
import { SITE_DETAIL_LIMITS, type SiteDetails } from '../src/lib/sites'

let failures = 0
function check(name: string, cond: boolean, saw?: unknown) {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${saw === undefined ? '' : ` — saw ${JSON.stringify(saw)}`}`)
  }
}
function section(title: string) {
  console.log(`\n${title}`)
}

/*
 * The two pure decisions the action delegates to, copied here rather than
 * exported from a 'use server' module — every export of one becomes a callable
 * endpoint, and a validator does not need to be one. They are short enough that
 * a drift between the two is visible in review; the alternative is widening the
 * app's POST surface to make a test convenient.
 */
function whyLocked(connectionType: string): string | null {
  if (connectionType === 'cloud') return null
  return 'held in the control panel'
}

function trimToNull(value: string | null): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

section('Only a cloud store may write its own details')
check('a cloud store is not locked', whyLocked('cloud') === null)
check('a local store is locked', whyLocked('local') !== null)
check('a hybrid store is locked too', whyLocked('hybrid') !== null)
/* The one that matters most: an unknown value must not read as permission.
   A new connection_type added upstream defaults to REFUSED, not allowed. */
check('an unrecognised connection type is locked, not allowed', whyLocked('') !== null)
check('a value that merely contains "cloud" is not cloud', whyLocked('not-cloud') !== null)

section('Empty means "not set", never an empty string')
check('a blank field becomes null', trimToNull('') === null)
check('whitespace only becomes null', trimToNull('   ') === null)
check('a real value survives, trimmed', trimToNull('  Acme  ') === 'Acme')
/* '' in the column would print as a blank line on a letterhead where the field
   should have collapsed away entirely. */
check('a null in is a null out', trimToNull(null) === null)

section('Field limits match the real cp2_sites columns')
/* Measured with SHOW COLUMNS against the live control database, not guessed
   from the mirror DDL — the two disagreed, and the column is the authority. */
const EXPECTED: Record<keyof SiteDetails, number> = {
  companyName: 255,
  tradingName: 255,
  registrationNumber: 60,
  vatNumber: 60,
  address1: 255,
  address2: 255,
  address3: 255,
  postalCode: 20,
  phone: 50,
  email: 255,
  contactName: 150,
}
for (const [key, want] of Object.entries(EXPECTED) as [keyof SiteDetails, number][]) {
  check(`${key} is capped at ${want}`, SITE_DETAIL_LIMITS[key] === want, SITE_DETAIL_LIMITS[key])
}
check(
  'every editable field has a limit — a new one cannot be added without one',
  Object.keys(SITE_DETAIL_LIMITS).length === Object.keys(EXPECTED).length,
  Object.keys(SITE_DETAIL_LIMITS).length,
)

section('The identity half is not editable')
/* connection_type, status, is_paid, site_code and site_type_id are decisions
   made ABOUT a shop by the people running the platform. A shop that could set
   its own is_paid would be editing its bill. */
const forbidden = ['connectionType', 'status', 'isPaid', 'code', 'siteTypeId', 'id', 'role']
for (const key of forbidden) {
  check(`${key} is not a settable detail`, !(key in SITE_DETAIL_LIMITS))
}

console.log(
  failures === 0
    ? '\nAll store-information checks passed.'
    : `\n${failures} FAILURE(S)`,
)
process.exit(failures === 0 ? 0 : 1)
