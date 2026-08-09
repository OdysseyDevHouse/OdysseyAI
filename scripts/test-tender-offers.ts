/**
 * What the tender pad offers — pure, no database.
 *
 *   npx tsx scripts/test-tender-offers.ts
 *
 * These are convenience, not permission: `checkTenders` is the gate, and the
 * server re-reads every loyalty balance under a lock at finalise. What is tested
 * here is that the pad never PROPOSES an amount the server is going to refuse,
 * and that the note buttons are ones a cashier would actually be handed.
 */
import { quickAmounts, loyaltyCeiling, prefillAmount } from '../src/lib/tenderOffers'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const cash = { integrationKey: null, code: 'CASH' }
const points = { integrationKey: 'loyalty', code: 'LOYALTY_POINTS' }
const wallet = { integrationKey: 'loyalty', code: 'LOYALTY_WALLET' }

function main() {
  /* ── Note buttons ────────────────────────────────────────────────────── */

  {
    const notes = quickAmounts(87.5)
    ok('the exact amount is always first', notes[0] === 87.5, notes.join(', '))
    ok('the next round notes follow', notes.includes(100) && notes.includes(200), notes.join(', '))
    ok('every option covers the sale', notes.every((n) => n >= 87.5), notes.join(', '))
    ok('ascending, so the eye scans one way', notes.join() === [...notes].sort((a, b) => a - b).join())
  }

  {
    // A round total should not offer the same figure twice — the Set is what
    // stops "R100, R100, R100" appearing when 100 is both exact and the next note.
    const notes = quickAmounts(100)
    ok('a round total has no duplicate buttons', new Set(notes).size === notes.length, notes.join(', '))
  }

  {
    ok('nothing owed offers no notes', quickAmounts(0).length === 0)
    ok('a credit balance offers no notes', quickAmounts(-5).length === 0)
  }

  {
    // The cap exists because a row of eight buttons takes longer to read than
    // the keypad takes to type — and because four is what fits beside the pad.
    ok('capped at five by default', quickAmounts(1).length <= 5)
    ok('the cap is adjustable for a narrow column', quickAmounts(87.5, 4).length === 4)
    ok(
      'trimming drops the LARGEST notes, not the exact amount',
      quickAmounts(87.5, 2)[0] === 87.5,
      quickAmounts(87.5, 2).join(', '),
    )
  }

  /* ── Loyalty ceilings ────────────────────────────────────────────────── */

  {
    // Null and zero mean different things, and the difference is load-bearing:
    // null is "cash, take what you like"; zero is "a loyalty tender against a
    // customer with nothing in it", which must read as unavailable.
    ok('cash has no ceiling', loyaltyCeiling(cash, null) === null)
    ok(
      'a loyalty tender with no standing is capped at ZERO, not uncapped',
      loyaltyCeiling(points, null) === 0,
    )
  }

  {
    const standing = { maxRedeemable: 40, walletBalance: 125.5 }
    ok('points are capped by what may be redeemed', loyaltyCeiling(points, standing) === 40)
    ok('the wallet is capped by its balance', loyaltyCeiling(wallet, standing) === 125.5)
    // An unrecognised loyalty code must not be silently treated as unlimited.
    ok(
      'an unknown loyalty code is uncapped rather than guessed at',
      loyaltyCeiling({ integrationKey: 'loyalty', code: 'LOYALTY_SOMETHING' }, standing) === null,
    )
  }

  /* ── Pre-fill ────────────────────────────────────────────────────────── */

  {
    ok('cash pre-fills the whole outstanding amount', prefillAmount(cash, 87.5, null) === 87.5)
    ok('nothing owed pre-fills zero, not a negative', prefillAmount(cash, -3, null) === 0)
  }

  {
    const standing = { maxRedeemable: 40, walletBalance: 125.5 }
    // The point of the whole helper: offer the smaller of the two, so the pad
    // never proposes an amount the posting engine will refuse.
    ok(
      'points pre-fill the CEILING when it is below what is owed',
      prefillAmount(points, 87.5, standing) === 40,
    )
    ok(
      'points pre-fill what is OWED when the ceiling is above it',
      prefillAmount(points, 25, standing) === 25,
    )
    ok(
      'a loyalty tender with no standing pre-fills zero',
      prefillAmount(points, 87.5, null) === 0,
    )
  }

  console.log(fails === 0 ? '\nAll tender-offer checks passed.' : `\n${fails} check(s) failed.`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
