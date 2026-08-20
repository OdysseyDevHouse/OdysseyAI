/**
 * Enrolling a phone, keeping it signed in, and cutting it off.
 *
 * The mobile app's whole premise is that a refresh token outlives the session,
 * so this table holds the only long-lived credential in the product. Each way
 * of getting it wrong is invisible from the app:
 *
 *   • a token that still resolves after revocation means a lost phone stays
 *     signed in, and the revoke button in the back office does nothing at all
 *     while appearing to work;
 *   • scoping a revoke to the row id alone means one user can cut off another
 *     user's phone by guessing a number;
 *   • storing the plaintext means a database backup is a set of working logins
 *     for every device in the estate.
 *
 * None of those fail a typecheck or change a single pixel, so they are asserted
 * here against the real table.
 *
 *   npm run test:mobile-devices
 */
import { createHash } from 'node:crypto'
import {
  enrolDevice,
  listDevices,
  revokeAllDevices,
  revokeDevice,
  userForToken,
} from '../src/lib/control/mobileDevices'
import { execute, queryOne } from '../src/lib/db'
import type { RowDataPacket } from 'mysql2'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* Ids well above anything cp2_users holds, so this suite can never collide with
   a real account. There is no FK on user_id (deliberately — see the migration),
   which is what makes borrowing them safe. */
const USER_A = 990001
const USER_B = 990002

async function main() {
  /* Anything a previous crashed run left behind. Per the house rule about test
     litter: a leaked row on a UNIQUE column kills an unrelated suite before its
     first assertion. */
  await cleanup()

  try {
    console.log('\nEnrolling a device')
    const { token, deviceId } = await enrolDevice(USER_A, 'ios', "Tiaan's iPhone")
    check('a token comes back', typeof token === 'string' && token.length >= 40)
    check('it resolves to the user who enrolled it', (await userForToken(token)) === USER_A)

    console.log('\nThe plaintext is never stored')
    /* The property that matters if a backup leaks: what is on disk must not be
       usable as a credential. */
    const row = await queryOne<RowDataPacket & Record<string, unknown>>(
      `SELECT token_hash FROM odyssey_mobile_devices WHERE id = ?`,
      [deviceId],
    )
    const stored = String(row?.token_hash ?? '')
    check('the column does not hold the token', stored !== token)
    check(
      'it holds the SHA-256 of it',
      stored === createHash('sha256').update(token, 'utf8').digest('hex'),
    )

    console.log('\nA token nobody enrolled resolves to nobody')
    check('an unknown token is refused', (await userForToken('not-a-real-token-aaaaaaaaaaaa')) === null)
    check('an empty token is refused', (await userForToken('')) === null)
    /* Length-bounded before the query, so a megabyte of junk costs no round trip. */
    check('an absurd token is refused', (await userForToken('x'.repeat(5000))) === null)

    console.log('\nTwo devices, and revoking one leaves the other alone')
    /* The reason this table is a history and cp2_user_sessions is not: a person
       may hold a phone and a tablet, and losing one must not sign out both. */
    const second = await enrolDevice(USER_A, 'android', 'Warehouse tablet')
    check('both are listed', (await listDevices(USER_A)).length === 2)

    check('revoking reports it did something', await revokeDevice(USER_A, deviceId))
    check('the revoked token stops resolving', (await userForToken(token)) === null)
    check('the other device still works', (await userForToken(second.token)) === USER_A)
    check('only the survivor is listed', (await listDevices(USER_A)).length === 1)

    console.log('\nRevoking twice is honest about it')
    check('a second revoke reports nothing to do', !(await revokeDevice(USER_A, deviceId)))

    console.log('\nA revoke cannot reach across users')
    /* Without user_id in the WHERE this passes by guessing an integer. */
    const theirs = await enrolDevice(USER_B, 'ios', "Someone else's phone")
    check('another user cannot revoke it', !(await revokeDevice(USER_A, theirs.deviceId)))
    check('and it still works', (await userForToken(theirs.token)) === USER_B)

    console.log('\nThe row survives the revoke')
    /* Marked, not deleted, so "when did we cut that phone off?" outlives the act. */
    const revoked = await queryOne<RowDataPacket & Record<string, unknown>>(
      `SELECT revoked_at FROM odyssey_mobile_devices WHERE id = ?`,
      [deviceId],
    )
    check('the history is kept', revoked !== null && revoked.revoked_at !== null)

    console.log('\nSigning out everywhere')
    const count = await revokeAllDevices(USER_A)
    check('it reports how many it cut off', count === 1, `got ${count}`)
    check('nothing is left listed', (await listDevices(USER_A)).length === 0)
    check("another user's device is untouched", (await userForToken(theirs.token)) === USER_B)
  } finally {
    await cleanup()
  }

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
  process.exit(failures === 0 ? 0 : 1)
}

async function cleanup() {
  await execute(`DELETE FROM odyssey_mobile_devices WHERE user_id IN (?, ?)`, [USER_A, USER_B])
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
