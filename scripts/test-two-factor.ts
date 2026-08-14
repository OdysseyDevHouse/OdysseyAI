/**
 * Two-factor, against the real control database.
 *
 * A fabricated high user_id (no FK on cp2_user_totp, by design) keeps this
 * clear of real accounts. The property that matters most: a code is
 * SINGLE-USE — the same six digits, replayed a second later, are refused.
 *
 *   npm run test:two-factor
 */
import { execute, queryOne } from '../src/lib/db'
import {
  totpStatus,
  totpEnabledMap,
  beginTotpEnrolment,
  confirmTotpEnrolment,
  verifySignInCode,
  disableTotp,
  clearTotp,
} from '../src/lib/twoFactor'
import { totpCode } from '../src/lib/totp'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const USER = 900_000_001 // far above any real cp2_users id

async function main() {
  await execute('DELETE FROM cp2_user_totp WHERE user_id = ?', [USER])

  ok('a bare account reports off', !(await totpStatus(USER)).enabled)

  const begin = await beginTotpEnrolment(USER, 'test@example.com')
  ok('*** enrolment mints a secret and a URI ***', begin.ok)
  if (!begin.ok) { console.log('cannot continue'); process.exit(1) }

  ok('  the stored secret is ENCRYPTED, not the base32',
    String((await queryOne<any>('SELECT secret_enc FROM cp2_user_totp WHERE user_id = ?', [USER]))?.secret_enc)
      .startsWith('enc:v1:'))
  ok('  unconfirmed means NOT enforced — a half enrolment cannot lock anyone out',
    !(await totpStatus(USER)).enabled && (await totpStatus(USER)).pending)
  ok('  and the sign-in check refuses everything while unconfirmed',
    !(await verifySignInCode(USER, totpCode(begin.secret))))

  const wrong = await confirmTotpEnrolment(USER, '000000')
  ok('a wrong code does not confirm', !wrong.ok)

  const confirmed = await confirmTotpEnrolment(USER, totpCode(begin.secret))
  ok('*** the live code confirms and turns the lock on ***', confirmed.ok,
    confirmed.ok ? '' : confirmed.error)
  ok('  status now reads enabled', (await totpStatus(USER)).enabled)
  ok('  and the map for the users screen sees it',
    (await totpEnabledMap([USER, 900_000_999])).has(USER))

  // The single-use property. The confirmation consumed the current step, so
  // the NEXT step's code is the one to spend — computed 30s ahead.
  const nextCode = totpCode(begin.secret, { atMs: Date.now() + 30_000 })
  const first = await verifySignInCode(USER, nextCode)
  const replay = await verifySignInCode(USER, nextCode)
  ok('*** a fresh code verifies once ***', first)
  ok('*** and the SAME code replayed is refused ***', !replay)

  const badOff = await disableTotp(USER, '000000')
  ok('turning it off needs a live code', !badOff.ok)

  // Strictly single-use means every step inside the ±1 window is now spent.
  // In real life the next code arrives 30 seconds later; the test winds the
  // replay guard back two steps to simulate exactly that passage of time.
  await execute('UPDATE cp2_user_totp SET last_used_step = last_used_step - 2 WHERE user_id = ?', [USER])
  const off = await disableTotp(USER, totpCode(begin.secret))
  ok('*** a live code turns it off ***', off.ok, off.ok ? '' : off.error)
  ok('  and status reads off again', !(await totpStatus(USER)).enabled)

  // The owner-recovery path: no code at all.
  const again = await beginTotpEnrolment(USER, 'test@example.com')
  if (again.ok) await confirmTotpEnrolment(USER, totpCode(again.secret))
  await clearTotp(USER)
  ok('*** clearTotp wipes without a code — the lost-authenticator path ***',
    !(await totpStatus(USER)).enabled)

  await execute('DELETE FROM cp2_user_totp WHERE user_id = ?', [USER])
  console.log(fails === 0 ? '\nAll two-factor checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
