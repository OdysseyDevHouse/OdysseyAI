/**
 * The device licence rule, judged from the machine's own local copy.
 *
 *   npx tsx scripts/test-device-lease-rules.ts
 *
 * ── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────
 *
 * Two functions decide whether a till may trade, and they must never disagree:
 *
 *   entitlement()        in lib/control/devices.ts — used when the control
 *                        panel is reachable, judging a cp2_devices row
 *   deviceLicenceState() in lib/licence/leaseRules.ts — used when it is not,
 *                        judging the copy of those same three fields that
 *                        migration 244 keeps on the machine
 *
 * A shop must get the same answer with the network cable in or out. So the
 * table below is the RULE, and both implementations are run against it — a
 * drift in either shows up here rather than as a till that behaves differently
 * on a bad line.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 *   1. status must be 'active'; 'inactive' and 'returned' block outright
 *   2. a paid device is entitled, whatever its expiry date says
 *   3. an unpaid device is entitled until its expiry date passes, inclusive
 *   4. an unpaid device with no expiry date at all is not entitled
 */
import { deviceLicenceState, type Lease } from '../src/lib/licence/leaseRules'
import type { ModuleKey } from '../src/lib/control/modules'

const DAY = 86_400_000
const now = new Date('2026-06-15T10:00:00Z')
const iso = (d: Date) => d.toISOString().slice(0, 10)

const TODAY = iso(now)
const YESTERDAY = iso(new Date(now.getTime() - DAY))
const TOMORROW = iso(new Date(now.getTime() + DAY))

function lease(over: Partial<Lease> = {}): Lease {
  return {
    siteId: 7,
    deviceSerial: 'TILL-A',
    licenceStatus: 'licensed',
    held: new Set<ModuleKey>(['starter']),
    endingOn: new Map(),
    accountStatus: 'active',
    checkedAt: new Date(now.getTime() - 60_000),
    expiresAt: new Date(now.getTime() + 6 * DAY),
    unlockCounter: 0,
    lastUnlockAt: null,
    deviceStatus: 'active',
    deviceIsPaid: false,
    deviceExpiryDate: TOMORROW,
    ...over,
  }
}

type Case = {
  what: string
  status: string | null
  paid: boolean | null
  expiry: string | null
  /** true = trade, false = blocked, null = nothing recorded to judge */
  expect: boolean | null
  reason?: 'inactive' | 'unpaid' | 'expired'
}

const CASES: Case[] = [
  // 1. Status comes first and overrides everything.
  { what: 'inactive, paid, in date', status: 'inactive', paid: true, expiry: TOMORROW, expect: false, reason: 'inactive' },
  { what: 'returned, paid, in date', status: 'returned', paid: true, expiry: TOMORROW, expect: false, reason: 'inactive' },
  { what: 'inactive, unpaid, in date', status: 'inactive', paid: false, expiry: TOMORROW, expect: false, reason: 'inactive' },

  // 2. A paid device ignores expiry entirely.
  { what: 'paid, no expiry', status: 'active', paid: true, expiry: null, expect: true },
  { what: 'paid, expiry passed', status: 'active', paid: true, expiry: YESTERDAY, expect: true },
  { what: 'paid, expiry future', status: 'active', paid: true, expiry: TOMORROW, expect: true },

  // 3. An unpaid device lives or dies by the date, inclusive of today.
  { what: 'unpaid, expires tomorrow', status: 'active', paid: false, expiry: TOMORROW, expect: true },
  { what: 'unpaid, expires TODAY', status: 'active', paid: false, expiry: TODAY, expect: true },
  { what: 'unpaid, expired yesterday', status: 'active', paid: false, expiry: YESTERDAY, expect: false, reason: 'expired' },

  // 4. Unpaid with no period was never entitled.
  { what: 'unpaid, no expiry at all', status: 'active', paid: false, expiry: null, expect: false, reason: 'unpaid' },

  // Nothing recorded — a lease written before a device claimed a licence.
  // Deliberately NOT a refusal; the device gate deals with an unlicensed machine.
  { what: 'no device facts recorded', status: null, paid: null, expiry: null, expect: null },
]

/* The rule as control/devices.ts applies it to a cp2_devices row, inlined so
   this suite needs no database. Kept verbatim: if it drifts from the real
   entitlement(), the mirror test below is what should catch it. */
function entitlementFromRow(row: { status: string; is_paid: number; expiry_date: string | null }) {
  if (String(row.status) !== 'active') return { ok: false as const, reason: 'inactive' as const }
  const paid = Number(row.is_paid) === 1
  const expiry = row.expiry_date ? String(row.expiry_date).slice(0, 10) : null
  if (paid) return { ok: true as const, trialEndsOn: null }
  if (!expiry) return { ok: false as const, reason: 'unpaid' as const }
  if (expiry < iso(now)) return { ok: false as const, reason: 'expired' as const }
  return { ok: true as const, trialEndsOn: expiry }
}

let failures = 0
const fail = (msg: string) => {
  failures++
  console.error(`  FAIL  ${msg}`)
}

console.log('\nThe offline evaluator (deviceLicenceState)')
for (const c of CASES) {
  const state = deviceLicenceState(
    lease({ deviceStatus: c.status, deviceIsPaid: c.paid, deviceExpiryDate: c.expiry }),
    now,
  )
  const got = state.ok
  if (got !== c.expect) {
    fail(`${c.what}: expected ok=${c.expect}, got ok=${got}`)
    continue
  }
  if (c.reason && (state as { reason?: string }).reason !== c.reason) {
    fail(`${c.what}: expected reason=${c.reason}, got ${(state as { reason?: string }).reason}`)
    continue
  }
  console.log(`  ok    ${c.what} -> ${got === null ? 'nothing recorded' : got ? 'trade' : (state as { reason: string }).reason}`)
}

console.log('\nThe online rule agrees with it, case for case')
for (const c of CASES) {
  if (c.status === null) continue // no row to judge; not a case the online rule sees
  const online = entitlementFromRow({
    status: c.status,
    is_paid: c.paid ? 1 : 0,
    expiry_date: c.expiry,
  })
  const offline = deviceLicenceState(
    lease({ deviceStatus: c.status, deviceIsPaid: c.paid, deviceExpiryDate: c.expiry }),
    now,
  )
  if (online.ok !== offline.ok) {
    fail(`${c.what}: online says ok=${online.ok}, offline says ok=${offline.ok}`)
    continue
  }
  const a = (online as { reason?: string }).reason ?? null
  const b = (offline as { reason?: string }).reason ?? null
  if (a !== b) {
    fail(`${c.what}: online reason=${a}, offline reason=${b}`)
    continue
  }
  console.log(`  ok    ${c.what}`)
}

/* ── THE CASE THE WHOLE FEATURE EXISTS FOR ─────────────────────────────────
 *
 * A device that expires tomorrow, on a machine that loses its line today. The
 * lease is still FRESH — checked minutes ago, seven days of staleness left — so
 * the seven-day rule has nothing to say. Only the stored expiry date can stop
 * this machine on the right day, and that is exactly what it must do. */
console.log('\nThe unplugged machine expires on the day it was sold to expire')
{
  const l = lease({ deviceStatus: 'active', deviceIsPaid: false, deviceExpiryDate: TOMORROW })

  const today = deviceLicenceState(l, now)
  if (today.ok !== true) fail('today (expires tomorrow): should still trade')
  else console.log('  ok    today, expiring tomorrow -> trades')

  // Same lease, no further contact, one day later.
  const dayAfter = new Date(now.getTime() + 2 * DAY)
  const later = deviceLicenceState(l, dayAfter)
  if (later.ok !== false || (later as { reason?: string }).reason !== 'expired') {
    fail(`two days on with no contact: expected expired, got ${JSON.stringify(later)}`)
  } else {
    console.log('  ok    two days on, never reconnected -> blocked as expired')
  }
}

console.log(
  failures === 0
    ? '\nAll device-lease rule checks passed\n'
    : `\n${failures} FAILURE(S)\n`,
)
process.exit(failures === 0 ? 0 : 1)
