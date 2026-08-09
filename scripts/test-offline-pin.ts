/**
 * Offline PIN verification — pure, no database, no browser.
 *
 *   npx tsx scripts/test-offline-pin.ts
 *
 * That this runs under `tsx` at all is half the point: `offlinePin.ts` uses
 * WebCrypto and nothing else, so the code checked here is byte-for-byte the code
 * that runs on the till. A crypto helper that could only be exercised in a browser
 * would not be exercised.
 *
 * What is checked is the three properties the design rests on — the verifier is
 * useless without the server secret, useless on another device, and cannot be
 * compared in a way that leaks it — plus the plain determinism that makes it
 * usable at all.
 */
import {
  verifierSalt,
  deriveVerifier,
  verifierMatches,
  VERIFIER_ITERATIONS,
} from '../src/lib/offlinePin'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const SECRET = 'test-offline-pin-key-not-a-real-one'
const OTHER_SECRET = 'a-different-server-secret'
const SITE = 1
const USER = 27
const DEVICE = 'b7a53389-9e44-4378-873c-af3cbd870b7d'
const OTHER_DEVICE = '11111111-2222-3333-4444-555555555555'

/* Fewer iterations than production for speed. The COST is a deployment choice;
   what is under test is the derivation's behaviour, which does not change with
   the count — and a test that took 20 seconds per assertion would be skipped. */
const ITERS = 1_000

async function main() {
  const salt = await verifierSalt(SECRET, SITE, USER, DEVICE)

  /* ── Determinism, which is what makes it comparable ──────────────────── */

  {
    const a = await deriveVerifier('2846', salt, ITERS)
    const b = await deriveVerifier('2846', salt, ITERS)
    ok('the same PIN and salt give the same verifier', a === b)
    ok('a verifier is base64 of 32 bytes', a.length === 44, `${a.length} chars`)
  }

  {
    const right = await deriveVerifier('2846', salt, ITERS)
    const wrong = await deriveVerifier('2847', salt, ITERS)
    ok('a one-digit difference gives a different verifier', right !== wrong)
  }

  /* ── The salt binds the SERVER SECRET ─────────────────────────────────
     This is what makes a dumped IndexedDB useless: without the key an attacker
     cannot construct the salt, so cannot test a guess at all. */

  {
    const otherSalt = await verifierSalt(OTHER_SECRET, SITE, USER, DEVICE)
    ok('a different server secret gives a different salt', otherSalt !== salt)
    const underOther = await deriveVerifier('2846', otherSalt, ITERS)
    const underOurs = await deriveVerifier('2846', salt, ITERS)
    ok('so the same PIN verifies to something else entirely', underOther !== underOurs)
  }

  /* ── The salt binds the DEVICE ────────────────────────────────────────
     Copying the local database to another machine must yield verifiers that
     verify nothing. */

  {
    const otherDevice = await verifierSalt(SECRET, SITE, USER, OTHER_DEVICE)
    ok('a different device gives a different salt', otherDevice !== salt)
    const moved = await deriveVerifier('2846', otherDevice, ITERS)
    const here = await deriveVerifier('2846', salt, ITERS)
    ok('a verifier copied to another machine does not match', moved !== here)
  }

  /* ── And the SITE and the USER ────────────────────────────────────────
     Two operators sharing a PIN across two shops must not share a verifier. */

  {
    const otherSite = await verifierSalt(SECRET, 2, USER, DEVICE)
    const otherUser = await verifierSalt(SECRET, SITE, 99, DEVICE)
    ok('a different site gives a different salt', otherSite !== salt)
    ok('a different user gives a different salt', otherUser !== salt)
  }

  {
    // The separator matters: without one, site 1 + user 127 and site 11 + user 27
    // would concatenate to the same string and share a salt.
    const a = await verifierSalt(SECRET, 1, 127, DEVICE)
    const b = await verifierSalt(SECRET, 11, 27, DEVICE)
    ok('the salt cannot be collided by concatenation (1|127 vs 11|27)', a !== b)
  }

  /* ── The iteration count is part of the derivation ───────────────────── */

  {
    const cheap = await deriveVerifier('2846', salt, 1_000)
    const dearer = await deriveVerifier('2846', salt, 2_000)
    ok('changing the iteration count changes the verifier', cheap !== dearer)
    /* Which is why the count is STORED alongside each verifier rather than
       assumed — raising it later must not silently invalidate every PIN.

       Asserted as a FLOOR, not an equality: raising the cost is always safe and
       should not fail a test, but dropping below what was measured to give
       ~40 minutes per 4-digit PIN silently weakens every till. */
    ok(
      'production mints at 2.4M iterations or more',
      VERIFIER_ITERATIONS >= 2_400_000,
      String(VERIFIER_ITERATIONS),
    )
  }

  /* ── Comparison must not leak ─────────────────────────────────────────── */

  {
    const v = await deriveVerifier('2846', salt, ITERS)
    ok('a verifier matches itself', verifierMatches(v, v))
    ok('a different verifier does not match', !verifierMatches(v, 'A'.repeat(v.length)))
    // Length is compared first and is not secret; a near-miss of a different
    // length must be refused rather than indexing past the end.
    ok('a shorter string does not match', !verifierMatches(v, v.slice(0, -1)))
    ok('a longer string does not match', !verifierMatches(v, v + 'A'))
    ok('empty does not match', !verifierMatches(v, ''))
    // A one-character difference at the END must be caught: an early-return
    // comparison would find it, but only after leaking the prefix by timing.
    const nearMiss = v.slice(0, -1) + (v.endsWith('A') ? 'B' : 'A')
    ok('a one-character difference at the end is caught', !verifierMatches(v, nearMiss))
    // Non-strings arrive from parsed JSON in the local database.
    ok('a non-string does not match', !verifierMatches(v, null as unknown as string))
  }

  /* ── A missing secret fails loudly ───────────────────────────────────── */

  {
    let threw = false
    try {
      await verifierSalt('', SITE, USER, DEVICE)
    } catch {
      threw = true
    }
    // Silently deriving under an empty key would mint verifiers that look fine
    // and protect nothing.
    ok('an unset OFFLINE_PIN_KEY throws rather than deriving', threw)
  }

  console.log(fails === 0 ? '\nAll offline-PIN checks passed.' : `\n${fails} check(s) failed.`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
