/**
 * The HTTP contract the mobile apps depend on.
 *
 * ── WHY THIS SUITE EXISTS SEPARATELY FROM test:mobile-devices ───────────────
 *
 * That one tests the LIBRARY — enrol, resolve, revoke, against the table. This
 * one tests the three endpoints as a stranger sees them, because from here on
 * two clients that this repo cannot compile depend on their exact shape: an
 * Android client in Java, and later an iOS one in Swift.
 *
 * Neither is typechecked by anything here. A field renamed in a route, a status
 * code changed from 401 to 403, a body that stops carrying `sites` — none of
 * those fail a build, and all of them break an app that is already on somebody's
 * phone. The failure surfaces in a review queue weeks later, or in a support
 * call. So the contract is asserted here, where it fails on the machine of
 * whoever changed it.
 *
 * ── WHAT IT DELIBERATELY DOES NOT TEST ──────────────────────────────────────
 *
 * The rules behind the endpoints — lockout, 2FA refusal, capability gates — all
 * belong to the libraries and have their own suites. This asserts only the
 * things a CLIENT can see and would break on: status codes, field names, and
 * whether the session cookie actually opens a page.
 *
 *   npm run test:mobile-auth-contract
 *
 * Needs a running dev server; set TEST_BASE if it is not on :4100.
 */
import { randomUUID } from 'node:crypto'
import { execute, queryOne } from '../src/lib/db'
import type { RowDataPacket } from 'mysql2'

const BASE = process.env.TEST_BASE || process.env.APP_URL || 'http://localhost:4100'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** The label every fixture device carries, so cleanup can never touch a real one. */
const FIXTURE_LABEL = 'CONTRACT probe'

type Json = Record<string, unknown>

async function main() {
  console.log(`\nContract under test: ${BASE}\n`)

  const email = process.env.DEV_LOGIN_EMAIL
  const password = process.env.DEV_LOGIN_PASSWORD
  if (!email || !password) {
    console.error('DEV_LOGIN_EMAIL and DEV_LOGIN_PASSWORD must be set (.env.local).')
    process.exit(1)
  }

  await cleanup()

  try {
    /* ── /login ──────────────────────────────────────────────────────────── */
    console.log('Enrolling a device')

    const badPassword = await post('/api/mobile/auth/login', {
      email,
      password: `definitely-not-${randomUUID()}`,
      platform: 'android',
      label: FIXTURE_LABEL,
    })
    check('a wrong password is 401', badPassword.status === 401, `got ${badPassword.status}`)
    check('and says so in `error`', typeof badPassword.body?.error === 'string')
    check('and hands out no token', badPassword.body?.token === undefined)

    const badPlatform = await post('/api/mobile/auth/login', {
      email,
      password,
      platform: 'windows-phone',
      label: FIXTURE_LABEL,
    })
    check('an unknown platform is 400', badPlatform.status === 400, `got ${badPlatform.status}`)

    const login = await post('/api/mobile/auth/login', {
      email,
      password,
      platform: 'android',
      label: FIXTURE_LABEL,
    })
    check('valid credentials are 200', login.status === 200, `got ${login.status}`)
    const token = typeof login.body?.token === 'string' ? login.body.token : ''
    check('a token comes back on `token`', token.length >= 40, `got ${token.length} chars`)

    /* The enrolment must not leave the caller holding a session — the app takes
       its session from the exchange, in one place, so there is only ever one
       path that mints one.

       Asserted as "no USABLE session", not "no Set-Cookie header": signIn() sets
       a cookie as a side effect and the route clears it, and clearing one IS a
       Set-Cookie — an empty value with an expiry in 1970. Checking for the
       header's absence failed on the route doing exactly the right thing. */
    check(
      'enrolment leaves no usable session cookie',
      sessionCookieFrom(login.setCookie) === null,
      login.setCookie ?? '',
    )

    if (!token) throw new Error('no token — the rest of the contract cannot be tested')

    /* ── /session ────────────────────────────────────────────────────────── */
    console.log('\nTrading the token for a session')

    const noAuth = await post('/api/mobile/auth/session', {})
    check('no bearer token is 401', noAuth.status === 401, `got ${noAuth.status}`)

    const badAuth = await post('/api/mobile/auth/session', {}, `Bearer not-a-real-${randomUUID()}`)
    check('an unknown bearer token is 401', badAuth.status === 401, `got ${badAuth.status}`)

    const session = await post('/api/mobile/auth/session', {}, `Bearer ${token}`)
    check('a valid token is 200', session.status === 200, `got ${session.status}`)

    /* The field names the clients read. Renaming any of them silently breaks an
       app that is already installed. */
    const site = session.body?.site as Json | undefined
    check('the body carries `site`', !!site)
    check('site has a numeric `id`', typeof site?.id === 'number')
    check('site has `name`', typeof site?.name === 'string')
    check('site has `code`', typeof site?.code === 'string')
    check('the body carries a `sites` array', Array.isArray(session.body?.sites))
    check('the body carries `user.name`', typeof (session.body?.user as Json)?.name === 'string')

    const cookie = sessionCookieFrom(session.setCookie)
    check('the exchange sets a session cookie', cookie !== null)

    /* The point of the whole exercise: the cookie must open a real page. A body
       that looks right while the cookie does not work is the failure this
       endpoint exists to prevent. */
    if (cookie) {
      const page = await fetch(`${BASE}/dashboard`, {
        headers: { cookie: `odyssey_session=${cookie}` },
        redirect: 'manual',
      })
      check('and that cookie opens /dashboard', page.status === 200, `got ${page.status}`)
    }

    /* The mobile session must NOT be enrolled in the eviction registry — that is
       what stops a phone signing the manager out of their desk. Asserted from
       the outside: the token is not readable here, so the check is that a second
       exchange does not displace the first. */
    const second = await post('/api/mobile/auth/session', {}, `Bearer ${token}`)
    const secondCookie = sessionCookieFrom(second.setCookie)
    if (cookie && secondCookie) {
      const stillGood = await fetch(`${BASE}/dashboard`, {
        headers: { cookie: `odyssey_session=${cookie}` },
        redirect: 'manual',
      })
      check(
        'a second exchange does not evict the first session',
        stillGood.status === 200,
        `got ${stillGood.status} — a phone must not sign out a desk`,
      )
    }

    /* ── /revoke ─────────────────────────────────────────────────────────── */
    console.log('\nSigning the device out')

    const revoke = await post('/api/mobile/auth/revoke', {}, `Bearer ${token}`)
    check('revoke answers 204', revoke.status === 204, `got ${revoke.status}`)

    const afterRevoke = await post('/api/mobile/auth/session', {}, `Bearer ${token}`)
    check(
      'the revoked token can no longer mint a session',
      afterRevoke.status === 401,
      `got ${afterRevoke.status}`,
    )

    /* Revoking twice must not be distinguishable from revoking once: a caller
       signing out cannot act on the difference, and answering differently would
       let a stranger test token strings for validity. */
    const revokeAgain = await post('/api/mobile/auth/revoke', {}, `Bearer ${token}`)
    check('revoking twice still answers 204', revokeAgain.status === 204, `got ${revokeAgain.status}`)
  } finally {
    await cleanup()
  }

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
  process.exit(failures === 0 ? 0 : 1)
}

async function post(
  path: string,
  body: Json,
  authorization?: string,
): Promise<{ status: number; body: Json | null; setCookie: string | null }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (authorization) headers.Authorization = authorization

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'manual',
  })

  /* 204 carries no body, and .json() on one throws — which would report as a
     failed request rather than as the success it is. */
  let parsed: Json | null = null
  if (res.status !== 204) {
    parsed = (await res.json().catch(() => null)) as Json | null
  }

  return { status: res.status, body: parsed, setCookie: res.headers.get('set-cookie') }
}

/**
 * The session token from a Set-Cookie header, or null when there is not one.
 *
 * An EMPTY value counts as null, deliberately: that is what clearing a cookie
 * looks like on the wire (`odyssey_session=; Expires=…1970`), and treating it
 * as a value would make "the session was deleted" read as "a session was set".
 */
function sessionCookieFrom(setCookie: string | null): string | null {
  if (!setCookie) return null
  const match = /odyssey_session=([^;]*)/.exec(setCookie)
  return match && match[1] ? match[1] : null
}

/** By LABEL, so a real enrolment on the dev account can never be caught. */
async function cleanup() {
  await execute('DELETE FROM odyssey_mobile_devices WHERE label = ?', [FIXTURE_LABEL])
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
