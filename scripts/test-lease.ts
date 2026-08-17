/**
 * The lease decides whether a shop can trade. Its rules are pure by design —
 * leaseRules.ts has no database attached — so every boundary can be pinned
 * down here without a MySQL server. Each of these is a way a machine could
 * wrongly lock, or wrongly stay open forever.
 *
 *   npx tsx scripts/test-lease.ts
 */
import {
  leaseState,
  daysRemaining,
  daysSinceCheck,
  shouldWarn,
  parseModules,
  parseEndingOn,
  leaseExpiryFrom,
  unlockExpiryFrom,
  LEASE_DAYS,
  UNLOCK_GRANT_DAYS,
  WARN_WITHIN_DAYS,
  type Lease,
} from '../src/lib/licence/leaseRules'
import type { ModuleKey } from '../src/lib/control/modules'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const NOW = new Date('2026-08-17T10:00:00Z')
const day = 86_400_000

function lease(over: Partial<Lease> = {}): Lease {
  return {
    siteId: 1,
    deviceSerial: 'TILL-1',
    licenceStatus: 'licensed',
    held: new Set<ModuleKey>(['starter', 'loyalty']),
    endingOn: new Map(),
    accountStatus: 'active',
    checkedAt: NOW,
    expiresAt: new Date(NOW.getTime() + LEASE_DAYS * day),
    unlockCounter: 0,
    lastUnlockAt: null,
    ...over,
  }
}

console.log('\nThe boundary')
check('a fresh lease is current', leaseState(lease(), NOW).status === 'current')
check(
  'one second before expiry is still current',
  leaseState(lease({ expiresAt: new Date(NOW.getTime() + 1000) }), NOW).status === 'current',
)
check('the moment of expiry locks', leaseState(lease({ expiresAt: NOW }), NOW).status === 'expired')
check(
  'a long-dead lease locks',
  leaseState(lease({ expiresAt: new Date(NOW.getTime() - 30 * day) }), NOW).status === 'expired',
)

console.log('\nNo lease at all is not a lock')
check('a machine that has never checked in is "none"', leaseState(null, NOW).status === 'none')

console.log('\nThe lease travels with what it knew')
const expired = leaseState(
  lease({ licenceStatus: 'unpaid', expiresAt: new Date(NOW.getTime() - day) }),
  NOW,
)
check(
  'an expired state still carries why it was refused',
  expired.status === 'expired' && expired.lease.licenceStatus === 'unpaid',
)

console.log('\nDays remaining')
check('a full lease reads as 7 days', daysRemaining(lease(), NOW) === LEASE_DAYS)
check(
  'a part day floors down',
  daysRemaining(lease({ expiresAt: new Date(NOW.getTime() + 2.9 * day) }), NOW) === 2,
)
check(
  'an expired lease never reads negative',
  daysRemaining(lease({ expiresAt: new Date(NOW.getTime() - 5 * day) }), NOW) === 0,
)
check(
  'the last few hours read as 0, not 1',
  daysRemaining(lease({ expiresAt: new Date(NOW.getTime() + 3600_000) }), NOW) === 0,
)

console.log('\nHow long the machine has been silent')
check('a just-checked lease reads 0 days silent', daysSinceCheck(lease(), NOW) === 0)
check(
  'three weeks of silence reads as 21',
  daysSinceCheck(lease({ checkedAt: new Date(NOW.getTime() - 21 * day) }), NOW) === 21,
)
check(
  'a clock that went backwards does not read negative',
  daysSinceCheck(lease({ checkedAt: new Date(NOW.getTime() + 5 * day) }), NOW) === 0,
)

console.log('\nNobody should be surprised by a locked till')
check('a fresh lease does not warn', !shouldWarn(leaseState(lease(), NOW), NOW))
check(
  'the last two days warn',
  shouldWarn(leaseState(lease({ expiresAt: new Date(NOW.getTime() + 1.5 * day) }), NOW), NOW),
)
check(
  'an already-locked machine does not warn (it blocks)',
  !shouldWarn(leaseState(lease({ expiresAt: new Date(NOW.getTime() - day) }), NOW), NOW),
)
check('a machine with no lease does not warn', !shouldWarn(leaseState(null, NOW), NOW))
check('the warning window is short enough to mean something', WARN_WITHIN_DAYS <= 3)

console.log('\nThe windows')
check('a check buys exactly seven days', LEASE_DAYS === 7)
check('an unlock buys longer than a check', UNLOCK_GRANT_DAYS > LEASE_DAYS)
check('an unlock is still time-boxed', UNLOCK_GRANT_DAYS <= 30)
check('a check now expires seven days out', leaseExpiryFrom(NOW).getTime() === NOW.getTime() + 7 * day)
check(
  'an unlock now expires fourteen days out',
  unlockExpiryFrom(NOW).getTime() === NOW.getTime() + 14 * day,
)

console.log('\nAn unlock extends without claiming a conversation')
const unlocked = lease({
  checkedAt: new Date(NOW.getTime() - 21 * day), // silent for three weeks
  expiresAt: new Date(NOW.getTime() + 14 * day), // but granted a fortnight
  unlockCounter: 1,
})
const st = leaseState(unlocked, NOW)
check('an unlocked machine trades', st.status === 'current')
check('and is still recorded as three weeks silent', daysSinceCheck(unlocked, NOW) === 21)

console.log('\nParsing what was stored')
check('a normal module list round-trips', [...parseModules('["starter","loyalty"]')].join(',') === 'starter,loyalty')
check('an unknown module key is not granted', parseModules('["starter","time_travel"]').has('time_travel' as ModuleKey) === false)
check('a known key alongside an unknown one survives', parseModules('["starter","time_travel"]').has('starter'))
check('malformed JSON grants nothing', parseModules('{not json').size === 0)
check('a JSON object rather than an array grants nothing', parseModules('{"starter":true}').size === 0)
check('null grants nothing', parseModules(null).size === 0)
check('an empty array grants nothing', parseModules('[]').size === 0)

console.log('\nParsing the ending-on chips')
check('a date is kept to ten characters', parseEndingOn('{"loyalty":"2026-08-31T00:00:00Z"}').get('loyalty') === '2026-08-31')
check('an unknown module is dropped', parseEndingOn('{"time_travel":"2026-08-31"}').size === 0)
check('malformed JSON yields no chips', parseEndingOn('{{{').size === 0)
check('an array rather than an object yields no chips', parseEndingOn('["loyalty"]').size === 0)

console.log(failures === 0 ? '\nLease rules hold.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
