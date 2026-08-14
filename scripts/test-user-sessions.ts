/**
 * Back-office single session — the registry rules, against the real control DB.
 *
 * The behaviour this asserts is the whole feature: a second sign-in displaces
 * the first, and the displaced token stops being current. Also covers the two
 * cases that must NOT evict anyone, because getting either wrong signs people
 * out who have done nothing wrong.
 *
 * Uses a user id far outside the real range and sweeps its own rows — a leaked
 * row here would silently exempt (or evict) a real user.
 */
import { claimSession, sessionIsCurrent, releaseSession } from '../src/lib/control/sessions'
import { execute, query } from '../src/lib/db'

/** Well outside any real cp2_users.id, so a crashed run cannot touch a person. */
const USER_A = 990001
const USER_B = 990002
let fails = 0

const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function sweep(): Promise<number> {
  const res = await execute('DELETE FROM cp2_user_sessions WHERE user_id IN (?, ?)', [
    USER_A,
    USER_B,
  ])
  return res.affectedRows
}

async function rowsFor(userId: number) {
  return query<{ user_id: number; session_id: string; ip: string | null }>(
    'SELECT user_id, session_id, ip FROM cp2_user_sessions WHERE user_id = ?',
    [userId],
  )
}

async function main() {
  const swept = await sweep()
  if (swept) console.log(`(swept ${swept} row(s) from an earlier run)\n`)

  // ── Not enrolled ────────────────────────────────────────────────────────
  // The case that must not lock anyone out: a session minted before this
  // shipped, or by the till's PIN unlock, has no row here.
  ok(
    '*** a user with no registry row is NOT evicted ***',
    (await sessionIsCurrent(USER_A, 'any-old-sid')) === true,
  )

  // ── One sign-in ─────────────────────────────────────────────────────────
  await claimSession(USER_A, 'sid-first', { ip: '10.0.0.1', userAgent: 'Chrome' })
  ok('the session just claimed is current', (await sessionIsCurrent(USER_A, 'sid-first')) === true)
  ok(
    'a different sid for the same user is not current',
    (await sessionIsCurrent(USER_A, 'sid-other')) === false,
  )

  const first = await rowsFor(USER_A)
  ok('exactly one row exists for the user', first.length === 1, `${first.length}`)
  ok('  and it recorded where the sign-in came from', first[0]?.ip === '10.0.0.1')

  // ── The second sign-in displaces the first ──────────────────────────────
  await claimSession(USER_A, 'sid-second', { ip: '10.0.0.2', userAgent: 'Firefox' })
  const after = await rowsFor(USER_A)
  ok('*** a second sign-in REPLACES the row, never adds one ***', after.length === 1, `${after.length}`)
  ok('  the newest session is current', (await sessionIsCurrent(USER_A, 'sid-second')) === true)
  ok(
    '*** the displaced session is NO LONGER current ***',
    (await sessionIsCurrent(USER_A, 'sid-first')) === false,
  )

  // ── One user's sign-in must not touch another's ─────────────────────────
  await claimSession(USER_B, 'sid-b', {})
  ok('another user signing in does not evict the first', (await sessionIsCurrent(USER_A, 'sid-second')) === true)
  ok('  and that user holds their own session', (await sessionIsCurrent(USER_B, 'sid-b')) === true)

  // ── Sign-out frees the seat ─────────────────────────────────────────────
  await releaseSession(USER_A)
  ok('after sign-out the row is gone', (await rowsFor(USER_A)).length === 0)
  ok(
    '  and a released user reads as not enrolled rather than evicted',
    (await sessionIsCurrent(USER_A, 'sid-second')) === true,
  )
  ok('  the other user is unaffected', (await rowsFor(USER_B)).length === 1)

  // ── Repeated claims of the SAME sid ─────────────────────────────────────
  // A page load fires several actions in parallel; none of them should churn.
  await claimSession(USER_B, 'sid-b', {})
  await claimSession(USER_B, 'sid-b', {})
  ok('re-claiming the same sid stays at one row', (await rowsFor(USER_B)).length === 1)
  ok('  and remains current', (await sessionIsCurrent(USER_B, 'sid-b')) === true)

  const removed = await sweep()
  console.log(`\ncleaned up ${removed} row(s)`)
  const left = await query<{ n: number }>(
    'SELECT COUNT(*) n FROM cp2_user_sessions WHERE user_id IN (?, ?)',
    [USER_A, USER_B],
  )
  ok('*** no scratch rows left behind ***', Number(left[0]?.n ?? 0) === 0)

  console.log(fails === 0 ? '\nAll session checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
