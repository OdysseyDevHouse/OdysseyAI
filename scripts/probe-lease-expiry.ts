/**
 * Does the lock still fire when a machine has been away too long?
 *
 * ── THE ONE PROPERTY THAT MUST NOT HAVE REGRESSED ───────────────────────────
 *
 * Making the lease the primary answer means an offline machine now trades on it
 * routinely rather than exceptionally. That is the whole point — and it is also
 * exactly how a licence check gets accidentally defeated. If a stale lease kept
 * answering forever, unplugging the network cable would be a permanent free
 * licence.
 *
 * So this walks a lease backwards in time, in the site's own database, and
 * asserts the two verdicts stay separate:
 *
 *   · leaseIsFresh()  — "worth answering from without asking". Five hours.
 *   · leaseState()    — "may this machine trade at all". Seven days.
 *
 * A lease that is stale but not expired must still be `current`: the machine
 * keeps working and simply asks the control panel again. Only past LEASE_DAYS
 * does it become the lock screen's problem.
 *
 * ── IT PUTS THE LEASE BACK ──────────────────────────────────────────────────
 *
 * Restored to a genuine renewal at the end, not to whatever was read at the
 * start — a previous crashed run could have left a back-dated row, and faithfully
 * restoring that would preserve the damage.
 *
 * Run with the machine's own ODYSSEY_SITE_* environment:
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-lease-expiry.ts
 */
import { readLease, leaseState } from '../src/lib/licence/lease'
import { leaseIsFresh, LEASE_DAYS, REFRESH_HOURS } from '../src/lib/licence/leaseRules'
import { refreshEntitlements } from '../src/lib/control/modules'
import { siteExecute } from '../src/lib/siteDb'

const DAY_MS = 86_400_000
let failures = 0

function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Back-date checked_at, leaving expires_at derived from it as writeLease would. */
async function backdate(siteId: number, ageMs: number) {
  const checked = new Date(Date.now() - ageMs)
  const expires = new Date(checked.getTime() + LEASE_DAYS * DAY_MS)
  await siteExecute(
    siteId,
    `UPDATE licence_lease SET checked_at = ?, expires_at = ? WHERE id = 1`,
    [checked, expires],
  )
}

async function main() {
  const siteId = Number(process.env.ODYSSEY_SITE_ID)
  if (!Number.isFinite(siteId) || siteId <= 0) {
    console.error('Set ODYSSEY_SITE_ID (and the other ODYSSEY_SITE_DB_* values) first.')
    process.exit(1)
  }

  console.log(`\nLease expiry still locks — site ${siteId}\n`)

  /* A real renewal first, so the walk starts from a known-good lease rather
     than from whatever happened to be in the table. */
  const seeded = await refreshEntitlements(siteId)
  if (!seeded.reached) {
    console.error('  Could not reach the control database to seed a lease. Nothing proved.')
    process.exit(1)
  }

  try {
    await backdate(siteId, 1 * 3600_000)
    let lease = await readLease(siteId)
    check('an hour old: fresh, and trading', !!lease && leaseIsFresh(lease))
    check('an hour old: state is current', leaseState(lease).status === 'current')

    /* The new middle ground this change creates, and the one worth proving:
       past the refresh window, so every entitlement read asks the control panel
       again — but nowhere near the lock. */
    await backdate(siteId, (REFRESH_HOURS + 1) * 3600_000)
    lease = await readLease(siteId)
    check('past the refresh window: NOT fresh', !!lease && !leaseIsFresh(lease))
    check('past the refresh window: STILL current', leaseState(lease).status === 'current')

    await backdate(siteId, (LEASE_DAYS - 1) * DAY_MS)
    lease = await readLease(siteId)
    check(`${LEASE_DAYS - 1} days offline: still current`, leaseState(lease).status === 'current')

    /* THE ONE THAT MATTERS. Unplugging the cable must not buy a free licence. */
    await backdate(siteId, (LEASE_DAYS + 1) * DAY_MS)
    lease = await readLease(siteId)
    check(`${LEASE_DAYS + 1} days offline: NOT current`, leaseState(lease).status !== 'current')

    await backdate(siteId, 90 * DAY_MS)
    lease = await readLease(siteId)
    check('three months offline: still locked', leaseState(lease).status !== 'current')
    check('three months offline: not fresh either', !!lease && !leaseIsFresh(lease))
  } finally {
    /* A genuine renewal, not the value read at the start. See the header. */
    const restored = await refreshEntitlements(siteId)
    console.log(
      restored.reached
        ? '\n  lease restored by a real renewal'
        : '\n  WARNING: could not restore the lease — run probe-lease-renew.ts',
    )
  }

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
