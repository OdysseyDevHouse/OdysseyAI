/**
 * POS device licensing — the entitlement rules, against the real control DB.
 *
 * Every case a till can be in, including the two that decide whether a shop
 * trades: an unpaid device inside its trial, and the same device the day after.
 * Seeds its own rows, asserts, and removes them — a leaked scratch row here
 * would consume a licence on a real site.
 */
import {
  licenceForSerial,
  freeSpots,
  claimSpot,
  releaseSpot,
  listLicences,
} from '../src/lib/control/devices'
import { execute, query } from '../src/lib/db'

const SITE = 1
const TAG = 'LICTEST'
let fails = 0

const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

function isoDaysFromNow(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

async function seed(
  name: string,
  opts: { serial?: string | null; paid?: boolean; expiry?: string | null; status?: string },
): Promise<number> {
  const res = await execute(
    `INSERT INTO cp2_devices (site_id, device_name, serial_number, status, is_paid, expiry_date)
     VALUES (?,?,?,?,?,?)`,
    [
      SITE,
      `${TAG} ${name}`,
      opts.serial ?? null,
      opts.status ?? 'active',
      opts.paid ? 1 : 0,
      opts.expiry ?? null,
    ],
  )
  return res.insertId
}

async function sweep() {
  const rows = await query<{ id: number }>(
    `SELECT id FROM cp2_devices WHERE site_id = ? AND device_name LIKE ?`,
    [SITE, `${TAG}%`],
  )
  for (const r of rows) await execute('DELETE FROM cp2_devices WHERE id = ?', [r.id])
  return rows.length
}

async function main() {
  const swept = await sweep()
  if (swept) console.log(`(swept ${swept} row(s) from an earlier run)\n`)

  // ── Entitlement ─────────────────────────────────────────────────────────
  await seed('paid', { serial: `${TAG}-PAID`, paid: true })
  await seed('unpaid', { serial: `${TAG}-UNPAID`, paid: false })
  await seed('trial-live', { serial: `${TAG}-TRIAL`, paid: false, expiry: isoDaysFromNow(7) })
  await seed('trial-dead', { serial: `${TAG}-LAPSED`, paid: false, expiry: isoDaysFromNow(-1) })
  await seed('trial-today', { serial: `${TAG}-TODAY`, paid: false, expiry: isoDaysFromNow(0) })
  await seed('retired', { serial: `${TAG}-RETIRED`, paid: true, status: 'inactive' })

  const paid = await licenceForSerial(SITE, `${TAG}-PAID`)
  ok('a paid device trades', paid.ok === true)

  const unknown = await licenceForSerial(SITE, `${TAG}-NOSUCHTHING`)
  ok('an unregistered serial is refused', !unknown.ok && unknown.reason === 'unregistered')

  const unpaid = await licenceForSerial(SITE, `${TAG}-UNPAID`)
  ok('unpaid with no trial is refused', !unpaid.ok && unpaid.reason === 'unpaid')

  const trial = await licenceForSerial(SITE, `${TAG}-TRIAL`)
  ok('*** an unpaid device inside its trial TRADES ***', trial.ok === true)
  ok('  and reports when the trial ends', trial.ok === true && trial.trialEndsOn !== null)

  const lapsed = await licenceForSerial(SITE, `${TAG}-LAPSED`)
  ok('*** a lapsed trial is refused ***', !lapsed.ok && lapsed.reason === 'expired')

  const today = await licenceForSerial(SITE, `${TAG}-TODAY`)
  ok('a trial expiring TODAY still trades (inclusive)', today.ok === true)

  const retired = await licenceForSerial(SITE, `${TAG}-RETIRED`)
  ok('an inactive device is refused even though paid', !retired.ok && retired.reason === 'inactive')

  // Another site's device must not resolve here.
  const otherSite = await licenceForSerial(SITE + 1, `${TAG}-PAID`)
  ok('*** a device registered to another site does not resolve ***', !otherSite.ok)

  // ── Free spots and claiming ─────────────────────────────────────────────
  const freeId = await seed('free-spot', { serial: null, paid: true })
  await seed('free-but-lapsed', { serial: null, paid: false, expiry: isoDaysFromNow(-5) })

  const free = await freeSpots(SITE)
  const mine = free.filter((s) => s.name.startsWith(TAG))
  ok('an unclaimed paid licence shows as a free spot', mine.some((s) => s.deviceRowId === freeId))
  ok(
    '  but an unclaimed LAPSED one does not',
    !mine.some((s) => s.name.includes('free-but-lapsed')),
    `${mine.length} free`,
  )

  const claimed = await claimSpot(SITE, freeId, `${TAG}-BROWSER-1`, 'Browser')
  ok('a browser can claim a free spot', claimed.ok === true)

  const nowLicensed = await licenceForSerial(SITE, `${TAG}-BROWSER-1`)
  ok('  and then trades on it', nowLicensed.ok === true)

  const stillFree = (await freeSpots(SITE)).filter((s) => s.deviceRowId === freeId)
  ok('  the spot is no longer free', stillFree.length === 0)

  // The serial is taken; a second row must not be able to grab it.
  const secondSpot = await seed('second-spot', { serial: null, paid: true })
  const stolen = await claimSpot(SITE, secondSpot, `${TAG}-BROWSER-1`, 'Browser')
  ok('*** the same machine cannot claim a second licence ***', stolen.ok === false)

  // Re-claiming the SAME spot with the same serial is harmless.
  const again = await claimSpot(SITE, freeId, `${TAG}-BROWSER-1`, 'Browser')
  ok('re-claiming the same spot with the same machine is allowed', again.ok === true)

  // ── Release ─────────────────────────────────────────────────────────────
  await releaseSpot(SITE, freeId)
  const afterRelease = await licenceForSerial(SITE, `${TAG}-BROWSER-1`)
  ok('*** a released machine stops trading ***', afterRelease.ok === false)
  const freeAgain = (await freeSpots(SITE)).filter((s) => s.deviceRowId === freeId)
  ok('  and the spot is free again', freeAgain.length === 1)

  const replacement = await claimSpot(SITE, freeId, `${TAG}-BROWSER-2`, 'Browser')
  ok('  a replacement machine can take it', replacement.ok === true)

  const all = (await listLicences(SITE)).filter((s) => s.name.startsWith(TAG))
  ok('listLicences returns every row, claimed or not', all.length >= 8, `${all.length}`)

  const removed = await sweep()
  console.log(`\ncleaned up ${removed} row(s)`)

  const leftovers = await query<{ n: number }>(
    `SELECT COUNT(*) n FROM cp2_devices WHERE device_name LIKE ?`,
    [`${TAG}%`],
  )
  ok('*** no scratch rows left behind ***', Number(leftovers[0]?.n ?? 0) === 0)

  console.log(fails === 0 ? '\nAll licensing checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
