/**
 * The refresh cadence, and the two files that have to agree about it.
 *
 * ── WHY THIS TEST EXISTS ────────────────────────────────────────────────────
 *
 * `REFRESH_HOURS` is stated twice: in src/lib/licence/leaseRules.ts, which the
 * app uses to decide whether a lease is still worth serving, and in
 * electron/licenceRefreshRules.js, which the shell uses to decide how often to
 * renew it. They cannot import each other — a packaged build carries two
 * dependency trees on purpose (see electron/appModules.js) — so the agreement is
 * a stated contract rather than a shared constant.
 *
 * Same posture as scripts/test-portal-signing.ts, which pins a signing string
 * this repository shares with the portal's own.
 *
 * Run: npx tsx --conditions=react-server scripts/test-licence-refresh.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LEASE_DAYS, REFRESH_HOURS, leaseIsFresh } from '../src/lib/licence/leaseRules'
import type { Lease } from '../src/lib/licence/leaseRules'

let failures = 0

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** A lease whose only interesting field is when it was last checked. */
function leaseCheckedAt(checkedAt: Date): Lease {
  return {
    siteId: 1,
    deviceSerial: null,
    licenceStatus: 'licensed',
    held: new Set(),
    endingOn: new Map(),
    accountStatus: 'active',
    checkedAt,
    expiresAt: new Date(checkedAt.getTime() + LEASE_DAYS * 86_400_000),
    unlockCounter: 0,
    lastUnlockAt: null,
  }
}

console.log('\nLicence refresh cadence\n')

/* ── THE CONTRACT ───────────────────────────────────────────────────────── */

const shellSource = readFileSync(
  join(import.meta.dirname, '..', 'electron', 'licenceRefreshRules.js'),
  'utf8',
)
const shellMatch = shellSource.match(/const REFRESH_HOURS = (\d+)/)

check('the shell states a REFRESH_HOURS', shellMatch !== null)

if (shellMatch) {
  const shellHours = Number(shellMatch[1])
  check(
    'the shell and the app agree on REFRESH_HOURS',
    shellHours === REFRESH_HOURS,
    `shell says ${shellHours}, app says ${REFRESH_HOURS}`,
  )
}

/* ── THE TWO CLOCKS ARE INDEPENDENT ─────────────────────────────────────────
 *
 * The point of the whole design: refreshing often does not shorten the lease,
 * and a lease that lasts a week does not stop the machine asking every five
 * hours. If these ever collapse into one number, the lock stops being the thing
 * that decides when an unpaid machine stops trading. */

check(
  'the refresh window is well inside the lease',
  REFRESH_HOURS * 3600_000 < LEASE_DAYS * 86_400_000,
  `${REFRESH_HOURS}h vs ${LEASE_DAYS}d`,
)

const attempts = Math.floor((LEASE_DAYS * 24) / REFRESH_HOURS)
check(
  'a machine gets many chances to reconnect before locking',
  attempts >= 10,
  `only ${attempts} attempts`,
)

/* ── FRESHNESS ──────────────────────────────────────────────────────────── */

const now = new Date('2026-03-10T12:00:00Z')

check('a lease checked just now is fresh', leaseIsFresh(leaseCheckedAt(now), now))

check(
  'a lease checked an hour ago is fresh',
  leaseIsFresh(leaseCheckedAt(new Date(now.getTime() - 3_600_000)), now),
)

check(
  'a lease checked just inside the window is fresh',
  leaseIsFresh(leaseCheckedAt(new Date(now.getTime() - (REFRESH_HOURS * 3600_000 - 1000))), now),
)

check(
  'a lease checked just outside the window is stale',
  !leaseIsFresh(leaseCheckedAt(new Date(now.getTime() - (REFRESH_HOURS * 3600_000 + 1000))), now),
)

check(
  'a lease checked days ago is stale',
  !leaseIsFresh(leaseCheckedAt(new Date(now.getTime() - 3 * 86_400_000)), now),
)

/* A machine whose clock was corrected forwards, or a lease written by one whose
   clock was wrong. Stale rather than fresh: the safe direction is to go and ask,
   and a lease dated in the future would otherwise read as fresh for as long as
   the error lasts. */
check(
  'a lease dated in the future is stale, not fresh',
  !leaseIsFresh(leaseCheckedAt(new Date(now.getTime() + 3_600_000)), now),
)

/* Being stale must NOT mean being locked. A machine four days offline still
   trades — it simply asks the control panel on every entitlement read, which is
   the behaviour that existed before the lease became the primary path. */
const fourDaysAgo = leaseCheckedAt(new Date(now.getTime() - 4 * 86_400_000))
check(
  'a stale lease is still within its seven days',
  !leaseIsFresh(fourDaysAgo, now) && fourDaysAgo.expiresAt.getTime() > now.getTime(),
)

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
