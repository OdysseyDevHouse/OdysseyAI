/*
 * Can one machine be a till in two shops?
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/verify-multi-store-device.ts
 *
 * A customer invoicing for two stores from one PC is an ordinary arrangement,
 * and the licence layer has always sold a separate licence per store for it —
 * `claimSpot` says so in as many words. `claimTerminal` used to refuse it
 * anyway, which made the two halves of one action disagree.
 *
 * This exercises the REAL functions against the REAL databases: it claims a
 * till in each of two sites with the same device id, checks both claims stuck,
 * checks the unlock path can now see both and no longer silently picks one, and
 * then puts every row back exactly as it found it.
 *
 * ── IT WRITES, SO IT RESTORES ────────────────────────────────────────────
 *
 * Claims are real rows on a real shop's terminals. The original device_id and
 * label of every till it touches are captured first and written back in a
 * finally block, so a failed assertion mid-run does not leave a store's till
 * claimed by a machine that is not standing at it.
 */
import { claimTerminal, releaseTerminal, sitesForDevice, listTerminals } from '../src/lib/site/terminals'
import { siteQuery, siteExecute } from '../src/lib/siteDb'
import { activeSiteIds } from '../src/lib/sites'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* A device id that belongs to no real machine, so a half-finished run cannot
   leave a REAL till pointing at somebody's actual PC. */
const FAKE = 'zz-verify-multistore-0001'

type Snap = { siteId: number; id: number; device_id: string | null; device_label: string | null }

async function main() {
  const sites = (await activeSiteIds()).slice(0, 2)
  if (sites.length < 2) {
    console.log('Needs two active sites to prove anything. Skipping.')
    process.exit(0)
  }
  console.log(`\nUsing sites ${sites.join(' and ')}`)

  /* One active till per site, and what it looked like before we touched it. */
  const targets: { siteId: number; id: number; code: string }[] = []
  const snaps: Snap[] = []
  for (const siteId of sites) {
    const list = await listTerminals(siteId, false)
    const pick = list[0]
    if (!pick) {
      console.log(`site ${siteId} has no active till; cannot run.`)
      process.exit(0)
    }
    targets.push({ siteId, id: pick.id, code: pick.code })
    const rows = await siteQuery<Snap & { id: number }>(
      siteId,
      'SELECT id, device_id, device_label FROM terminals WHERE id = ?',
      [pick.id],
    )
    snaps.push({ siteId, id: pick.id, device_id: rows[0]?.device_id ?? null, device_label: rows[0]?.device_label ?? null })
  }
  console.log(targets.map((t) => `  site ${t.siteId}: ${t.code}`).join('\n'))

  try {
    console.log('\n── Claim the SAME machine in both shops ─────────────────────')
    const first = await claimTerminal(targets[0].siteId, targets[0].id, FAKE, 'Verify machine')
    check(`claimed ${targets[0].code} at site ${targets[0].siteId}`, first.ok, 'error' in first ? first.error : '')

    /* THE ASSERTION THIS WHOLE CHANGE IS FOR. This used to be refused with
       "already registered as … at …", which is what a multi-store customer hit. */
    const second = await claimTerminal(targets[1].siteId, targets[1].id, FAKE, 'Verify machine')
    check(
      `claimed ${targets[1].code} at site ${targets[1].siteId} TOO`,
      second.ok,
      'error' in second ? second.error : '',
    )

    console.log('\n── Both claims are really on file ───────────────────────────')
    for (const t of targets) {
      const rows = await siteQuery<{ device_id: string | null }>(
        t.siteId,
        'SELECT device_id FROM terminals WHERE id = ?',
        [t.id],
      )
      check(`site ${t.siteId} ${t.code} holds the machine`, rows[0]?.device_id === FAKE, String(rows[0]?.device_id))
    }

    console.log('\n── The unlock path sees BOTH, and does not pick one ─────────')
    const found = await sitesForDevice(FAKE)
    check('it returns two shops', found.length === 2, `saw ${found.length}`)
    check(
      'each carries its shop name and till code',
      found.every((f) => f.siteName && f.terminalCode),
      JSON.stringify(found),
    )
    console.log('   ' + found.map((f) => `${f.siteName} / ${f.terminalCode}`).join('  |  '))

    console.log('\n── A single-store machine is unaffected ─────────────────────')
    /* Release one and the ambiguity disappears — the ordinary case still
       resolves to exactly one shop with no question to ask. */
    await releaseTerminal(targets[1].siteId, targets[1].id)
    const one = await sitesForDevice(FAKE)
    check('one claim means one shop', one.length === 1, `saw ${one.length}`)

    console.log('\n── An unknown machine still gets nothing ────────────────────')
    const none = await sitesForDevice('zz-not-a-real-device-9999')
    check('an unregistered machine matches no shop', none.length === 0, `saw ${none.length}`)
    const malformed = await sitesForDevice('../../etc/passwd')
    check('a malformed id is rejected before any query', malformed.length === 0)
  } finally {
    console.log('\n── Putting every row back ───────────────────────────────────')
    for (const s of snaps) {
      await siteExecute(
        s.siteId,
        'UPDATE terminals SET device_id = ?, device_label = ? WHERE id = ?',
        [s.device_id, s.device_label, s.id],
      )
    }
    /* And prove it, rather than trusting the writes. */
    for (const s of snaps) {
      const rows = await siteQuery<{ device_id: string | null }>(
        s.siteId,
        'SELECT device_id FROM terminals WHERE id = ?',
        [s.id],
      )
      const back = (rows[0]?.device_id ?? null) === s.device_id
      console.log(`  site ${s.siteId} till ${s.id}: ${back ? 'restored' : 'NOT RESTORED'}`)
      if (!back) failures++
    }
  }

  console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} failed.\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
