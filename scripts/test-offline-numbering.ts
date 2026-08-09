/**
 * Numbering a sale offline — pure, no database, no browser.
 *
 *   npx tsx scripts/test-offline-numbering.ts
 *
 * The seed rule is the whole point and it has one dangerous failure mode: a till
 * with unsynced sales is AHEAD of what the server knows, so taking the server's
 * figure would reissue numbers already printed on customers' slips. Two sales under
 * one invoice number, with no unique index offline to catch it.
 *
 * The Dexie-backed functions cannot run under `tsx` — there is no IndexedDB — so
 * what is exercised here is the LOGIC they implement, against the same formatter
 * the server uses. `seedCounter` mirrors seedSequence's arithmetic exactly.
 */
import { formatNumber, numberValueOf } from '../src/lib/numberFormat'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** The rule from saleNumber.seedSequence: seed-if-higher, never lower. */
const seedCounter = (localCounter: number, serverNextNumber: number) =>
  Math.max(localCounter, Math.max(0, Math.trunc(serverNextNumber) - 1))

function main() {
  /* ── The seed rule ───────────────────────────────────────────────────── */

  {
    // A fresh till takes the server's position.
    ok('a fresh till seeds from the server', seedCounter(0, 59) === 58, String(seedCounter(0, 59)))
    // The server's NEXT is 59, so the last it knows about is 58 and the till's next
    // sale is 59. Off by one here means every till starts by reissuing a number.
    ok('the next sale is the server’s next_number', seedCounter(0, 59) + 1 === 59)
  }

  {
    /* THE ONE THAT MATTERS.
       The till has sold 62, 63, 64 offline. The server still thinks next is 62,
       because it has not seen them. Seeding DOWN to 61 would hand out 62 again —
       the number a customer is already holding a slip for. */
    ok(
      'a till AHEAD of the server is not rewound',
      seedCounter(64, 62) === 64,
      String(seedCounter(64, 62)),
    )
    ok('so its next sale is 65, not 62', seedCounter(64, 62) + 1 === 65)
  }

  {
    // Repeated refreshes must not creep the counter upward either.
    const once = seedCounter(58, 59)
    const twice = seedCounter(once, 59)
    ok('seeding twice with the same server figure is idempotent', once === twice, `${once}/${twice}`)
  }

  {
    // A server that has caught up moves the till forward — another till may have
    // issued numbers on the shared run before the store switched to per-till.
    ok('a server AHEAD of the till moves it forward', seedCounter(58, 100) === 99)
    // Nonsense from the server cannot drive the counter negative.
    ok('a zero next_number cannot rewind below zero', seedCounter(0, 0) === 0)
    ok('a negative next_number is floored at zero', seedCounter(0, -5) === 0)
  }

  /* ── The shape is the server's shape ─────────────────────────────────── */

  {
    // The till formats with the SAME function the server does. A second
    // implementation is how INV_01_02_000097 and INV_01_2_97 end up in one
    // invoice register with nothing to say which is right.
    const number = formatNumber('INV', 59, 6, null, { store: '01', till: '01' })
    ok('an offline number has the server’s shape', number === 'INV_01_01_000059', number)
    // And it reads back, which is what the server needs to advance the sequence.
    ok('and reads back to its counter', numberValueOf(number) === 59, String(numberValueOf(number)))
  }

  {
    const yearly = formatNumber('INV', 59, 6, '2026', { store: '01', till: '02' })
    ok('a yearly-reset offline number keeps its year', yearly === 'INV_01_02_2026_000059', yearly)
    ok('and still reads back to 59', numberValueOf(yearly) === 59)
  }

  /* ── Advancing, and the release rule ────────────────────────────────── */

  {
    /* nextLocalNumber writes the counter BEFORE returning, so a crash between
       numbering and printing burns a number rather than reusing one. A burnt
       number is an explainable gap; a reused one is two sales under one. */
    let counter = 58
    const take = () => formatNumber('INV', ++counter, 6, null, { store: '01', till: '01' })
    ok('successive numbers do not repeat', take() !== take())
    ok('and they ascend', counter === 60, String(counter))
  }

  {
    /* releaseLocalNumber only undoes the number MOST RECENTLY issued, and only if
       the caller names it. Anything else must burn: the slip may have printed, and
       reissuing a printed number puts two sales under one. */
    const canRelease = (stored: number, claimed: number) => stored === claimed
    ok('the last number can be handed back', canRelease(60, 60))
    ok('an earlier number cannot', !canRelease(60, 59))
    ok('a number from another till cannot', !canRelease(60, 999))
  }

  console.log(fails === 0 ? '\nAll offline-numbering checks passed.' : `\n${fails} check(s) failed.`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
