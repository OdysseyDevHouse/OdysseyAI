/**
 * Signing in at a till with no database — the matching and the lockout.
 *
 *   npx tsx scripts/test-offline-signin.ts
 *
 * Runs under plain `tsx`, no database and no browser, which is the point: the two
 * things worth checking here are pure, and a rule that can only be exercised in a
 * browser is a rule nobody exercises.
 *
 * What is checked:
 *
 *   · A PIN matches exactly ONE operator, and a wrong PIN matches nobody. This is
 *     the whole of "who is standing at this till" when the server cannot answer.
 *   · An operator's verifier is useless for signing in as somebody else — each is
 *     salted per user, so two people sharing a PIN still get separate verifiers and
 *     the loop cannot cross them.
 *   · The lockout counts up, fires at the threshold, and RESETS rather than sticking
 *     at the ceiling. Getting that backwards would lock a cashier out permanently
 *     after their first mistake past the limit, which is worse than not locking at
 *     all — a shop cannot trade and nobody can explain why.
 */
import { verifierSalt, deriveVerifier } from '../src/lib/offlinePin'
import {
  findOperator,
  afterWrongPin,
  lockoutRemaining,
  MAX_ATTEMPTS,
  LOCKOUT_MS,
} from '../src/lib/posOffline/signInOffline'
import type { OfflineOperator } from '../src/lib/site/offlineOperators'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const SECRET = 'test-offline-signin-key'
const SITE = 1
const DEVICE = 'b7a53389-9e44-4378-873c-af3cbd870b7d'

/* Far fewer iterations than production. The COST is a deployment decision, checked
   in test-offline-pin; what is under test here is the matching, which does not
   change with the count — and 2.4M per candidate would make this file take minutes. */
const ITERS = 1_000

async function operator(
  userId: number,
  name: string,
  pin: string,
  capabilities: string[] = ['sales.till'],
): Promise<OfflineOperator> {
  const saltB64 = await verifierSalt(SECRET, SITE, userId, DEVICE)
  return {
    userId,
    name,
    capabilities,
    saltB64,
    verifier: await deriveVerifier(pin, saltB64, ITERS),
    iterations: ITERS,
    offlineReady: true,
  }
}

async function main() {
  /* ── 1. The matching ───────────────────────────────────────────────────── */

  const ruth = await operator(11, 'Ruth Mbeki', '285193')
  const nomsa = await operator(27, 'Nomsa Dlamini', '471962')
  const owner = await operator(1, 'The Owner', '938274', ['*'])
  const all = [ruth, nomsa, owner]

  const foundRuth = await findOperator(all, '285193')
  ok('a PIN finds its operator', foundRuth?.userId === 11, foundRuth?.name ?? 'none')

  const foundNomsa = await findOperator(all, '471962')
  ok('and a different PIN finds a different one', foundNomsa?.userId === 27, foundNomsa?.name ?? 'none')

  ok('a wrong PIN finds NOBODY', (await findOperator(all, '111111')) === null)
  ok('an empty PIN finds nobody', (await findOperator(all, '')) === null)
  ok('a near-miss finds nobody', (await findOperator(all, '285194')) === null)
  ok('an empty operator list finds nobody', (await findOperator([], '285193')) === null)

  /* ── 2. Two people, ONE shared PIN ──────────────────────────────────────
     `pinInUse` forbids this at save time, so it should not happen — but the salt is
     per-user, so even if it did, the two verifiers differ and the loop returns the
     first rather than mixing them. Worth asserting because the alternative (a shared
     salt) would make the two indistinguishable, and a sale would be attributed to
     whoever happened to be first in the list. */

  const twinA = await operator(41, 'Twin A', '556677')
  const twinB = await operator(42, 'Twin B', '556677')
  ok(
    'two operators with the same PIN get DIFFERENT verifiers',
    twinA.verifier !== twinB.verifier,
  )
  const twin = await findOperator([twinA, twinB], '556677')
  ok('and one of them is returned, deterministically', twin?.userId === 41, twin?.name ?? 'none')

  /* ── 3. One operator's verifier cannot open another's session ───────────
     A stolen verifier row is worth nothing on its own: it is bound to a user id
     through the salt, so replaying Ruth's verifier under Nomsa's identity fails. */

  const forged: OfflineOperator = { ...nomsa, verifier: ruth.verifier }
  ok(
    "one operator's verifier does not authenticate another",
    (await findOperator([forged], '285193')) === null,
    'Ruth\'s verifier under Nomsa\'s salt',
  )

  /* ── 4. Capabilities travel with the match, and are not decided here ──── */

  const asOwner = await findOperator(all, '938274')
  ok('the owner sentinel survives the round trip', asOwner?.capabilities.includes('*') === true,
    JSON.stringify(asOwner?.capabilities))
  ok(
    'an ordinary cashier gets no override rights',
    foundRuth?.capabilities.includes('sales.void') === false,
    JSON.stringify(foundRuth?.capabilities),
  )

  /* ── 5. The lockout ────────────────────────────────────────────────────── */

  const NOW = 1_700_000_000_000
  let attempts = { count: 0, lockedUntil: null as number | null }

  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    attempts = afterWrongPin(attempts, NOW)
    ok(`wrong PIN ${i} counts up without locking`, attempts.count === i && attempts.lockedUntil === null,
      JSON.stringify(attempts))
  }

  attempts = afterWrongPin(attempts, NOW)
  ok(
    `wrong PIN ${MAX_ATTEMPTS} locks the pad`,
    attempts.lockedUntil === NOW + LOCKOUT_MS,
    JSON.stringify(attempts),
  )
  ok(
    'and RESETS the count rather than sticking at the ceiling',
    attempts.count === 0,
    `count = ${attempts.count}`,
  )

  ok('a locked pad reports the wait', lockoutRemaining(attempts, NOW) === LOCKOUT_MS / 1000,
    String(lockoutRemaining(attempts, NOW)))
  ok(
    'the wait counts down',
    lockoutRemaining(attempts, NOW + 30_000) === 30,
    String(lockoutRemaining(attempts, NOW + 30_000)),
  )
  ok(
    'and the lock EXPIRES rather than persisting',
    lockoutRemaining(attempts, NOW + LOCKOUT_MS + 1) === 0,
  )
  ok('no attempts recorded is not locked', lockoutRemaining(null, NOW) === 0)
  ok(
    'a fresh counter after a lockout allows a full run again',
    afterWrongPin({ count: 0, lockedUntil: null }, NOW).lockedUntil === null,
  )

  console.log(fails === 0 ? '\nAll offline sign-in checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
