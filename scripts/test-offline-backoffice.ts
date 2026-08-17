/**
 * Signing in to the BACK OFFICE with no control database.
 *
 * Distinct from test-offline-signin.ts, which covers the till's PIN. This is
 * the back-office password path on a local backend: a different credential, a
 * different table, and a much larger blast radius if it is wrong — a
 * back-office password is often reused elsewhere, where a till PIN is not.
 *
 * The derivation itself is pure (WebCrypto only), so the properties that matter
 * can be checked with no database:
 *
 *   · The same password under the same salt always verifies.
 *   · A verifier is bound to its user and site — one cannot open another.
 *   · The server secret is what makes it unattackable; without it the salt
 *     cannot even be constructed.
 *   · The stored iteration count is honoured, so raising the cost later does
 *     not lock out everyone who has not signed in since.
 *
 *   npx tsx scripts/test-offline-backoffice.ts
 */
import {
  deriveVerifier,
  verifierMatches,
  verifierSalt,
  VERIFIER_ITERATIONS,
} from '../src/lib/offlinePin'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const SECRET = 'a-server-side-offline-pin-key-that-never-leaves-the-server'
const OTHER_SECRET = 'a-different-deployments-key'
/* The real count is 2.4M and takes ~240ms per derivation. These tests do many,
   so they run at a lower cost — the PROPERTIES under test are independent of
   the number, and the number itself is asserted separately below. */
const FAST = 1_000

const SITE = 7
const USER = 42
const PURPOSE = 'backoffice'

/* An async main rather than top-level await: these scripts transpile to CJS,
   where top-level await is not available. Matches test-offline-signin.ts. */
async function main() {
console.log('\nThe basic round trip')
{
  const salt = await verifierSalt(SECRET, SITE, USER, PURPOSE)
  const v = await deriveVerifier('correct horse battery staple', salt, FAST)
  const again = await deriveVerifier('correct horse battery staple', salt, FAST)
  check('the same password reproduces the verifier', verifierMatches(v, again))

  const wrong = await deriveVerifier('correct horse battery stapler', salt, FAST)
  check('a wrong password does not', !verifierMatches(v, wrong))

  const empty = await deriveVerifier('', salt, FAST)
  check('an empty password does not', !verifierMatches(v, empty))
}

console.log('\nOne case difference is a different password')
{
  const salt = await verifierSalt(SECRET, SITE, USER, PURPOSE)
  const lower = await deriveVerifier('sunflower', salt, FAST)
  const upper = await deriveVerifier('Sunflower', salt, FAST)
  check('case is significant', !verifierMatches(lower, upper))
}

console.log('\nA verifier belongs to one user at one site')
{
  const password = 'shared-password-because-people-do-that'
  const forUser = await deriveVerifier(password, await verifierSalt(SECRET, SITE, USER, PURPOSE), FAST)
  const otherUser = await deriveVerifier(password, await verifierSalt(SECRET, SITE, 43, PURPOSE), FAST)
  const otherSite = await deriveVerifier(password, await verifierSalt(SECRET, 8, USER, PURPOSE), FAST)

  check('two users sharing a password get different verifiers', !verifierMatches(forUser, otherUser))
  check('the same user at another site gets a different verifier', !verifierMatches(forUser, otherSite))
}

console.log('\nThe till PIN and the back-office password never collide')
{
  const password = '1234'
  const asBackOffice = await deriveVerifier(password, await verifierSalt(SECRET, SITE, USER, PURPOSE), FAST)
  const asDevicePin = await deriveVerifier(
    password,
    await verifierSalt(SECRET, SITE, USER, 'device-uuid-here'),
    FAST,
  )
  check(
    'the same secret string under two purposes gives two verifiers',
    !verifierMatches(asBackOffice, asDevicePin),
  )
}

console.log('\nWithout the server secret the salt cannot be built')
{
  const real = await verifierSalt(SECRET, SITE, USER, PURPOSE)
  const forged = await verifierSalt(OTHER_SECRET, SITE, USER, PURPOSE)
  check('a different key gives a different salt', real !== forged)

  const password = 'the-password'
  const genuine = await deriveVerifier(password, real, FAST)
  const attacker = await deriveVerifier(password, forged, FAST)
  check(
    'so even the right password derives the wrong verifier',
    !verifierMatches(genuine, attacker),
  )

  let threw = false
  try {
    await verifierSalt('', SITE, USER, PURPOSE)
  } catch {
    threw = true
  }
  check('an absent key is refused rather than defaulted', threw)
}

console.log('\nThe stored iteration count is honoured')
{
  const salt = await verifierSalt(SECRET, SITE, USER, PURPOSE)
  const cheap = await deriveVerifier('same-password', salt, 1_000)
  const dear = await deriveVerifier('same-password', salt, 2_000)
  check('a different cost gives a different verifier', !verifierMatches(cheap, dear))
  check(
    're-deriving at the recorded cost still matches',
    verifierMatches(cheap, await deriveVerifier('same-password', salt, 1_000)),
  )
}

console.log('\nThe cost new verifiers are minted at')
{
  check(
    'is high enough to be worth having',
    VERIFIER_ITERATIONS >= 2_400_000,
    String(VERIFIER_ITERATIONS),
  )
}

console.log('\nComparison is constant-time in shape')
{
  check('a length mismatch is refused', !verifierMatches('abc', 'abcd'))
  check('a non-string is refused', !verifierMatches('abc', undefined as unknown as string))
  check('identical strings match', verifierMatches('abcdef', 'abcdef'))
}

console.log('\nA long passphrase is handled')
{
  const salt = await verifierSalt(SECRET, SITE, USER, PURPOSE)
  const long = 'x'.repeat(400)
  const v = await deriveVerifier(long, salt, FAST)
  check('it derives', typeof v === 'string' && v.length > 0)
  check('and reproduces', verifierMatches(v, await deriveVerifier(long, salt, FAST)))
  check('and differs by one character', !verifierMatches(v, await deriveVerifier(`${long}y`, salt, FAST)))
}

console.log('\nUnicode survives the round trip')
{
  const salt = await verifierSalt(SECRET, SITE, USER, PURPOSE)
  const pw = 'wagwoord-Ω-日本語-🔐'
  check(
    'a non-ASCII password reproduces',
    verifierMatches(await deriveVerifier(pw, salt, FAST), await deriveVerifier(pw, salt, FAST)),
  )
}

}

main()
  .then(() => {
    console.log(
      failures === 0 ? '\nOffline back-office credentials hold.\n' : `\n${failures} FAILED\n`,
    )
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
