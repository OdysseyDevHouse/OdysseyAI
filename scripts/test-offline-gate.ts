/**
 * Telling "this machine has no internet" apart from "this machine is broken".
 *
 * ── WHY THIS IS WORTH A TEST OF ITS OWN ─────────────────────────────────────
 *
 * `(app)/layout.tsx` and `(invoicing)/layout.tsx` wrap requireSiteUser() in a
 * try/catch so that a shop with no line gets NeedsInternetScreen instead of a
 * stack trace. That catch is the most dangerous shape in the codebase, because
 * `redirect()` in Next works by THROWING — so a catch that is one shade too
 * broad silently swallows the redirect for a password change, a missing site or
 * a superseded session, and strands the user on an offline screen with a
 * working connection.
 *
 * The classifier is what keeps the catch narrow, so it is asserted directly:
 * every case below is a real thing that reaches it in production.
 *
 *   npx tsx --conditions=react-server scripts/test-offline-gate.ts
 */
import {
  isControlUnreachable,
  isStoreDetailsUnavailable,
  StoreDetailsUnavailableError,
} from '../src/lib/sites'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** A socket error shaped the way mysql2 hands them over. */
function sockErr(code: string) {
  return Object.assign(new Error(`connect ${code} 105.30.57.88:3306`), { code })
}

console.log('\nThe errors that MEAN "no line"')
{
  /* The exact one off a customer's machine — this is the error that started
     the whole thing, from lib/control/devices.ts and lib/storeGroups.ts. */
  check('raw ENETUNREACH to the control database', isControlUnreachable(sockErr('ENETUNREACH')))

  for (const code of ['EHOSTUNREACH', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']) {
    check(`${code} — the same condition, different coat`, isControlUnreachable(sockErr(code)))
  }

  /* getSite() raises this ONLY when there is no mirror to fall back on, and
     carries the original socket error as its cause. Both halves matter: the
     screen needs to know it is the first run, and the classifier must still
     recognise it. */
  const firstRun = new StoreDetailsUnavailableError({ cause: sockErr('ENETUNREACH') })
  check('StoreDetailsUnavailableError is unreachable', isControlUnreachable(firstRun))
  check('…and is identified as the FIRST RUN', isStoreDetailsUnavailable(firstRun))

  /* mysql2 and Next both wrap. A cause chain must not hide the answer. */
  const wrapped = new Error('query failed', {
    cause: new Error('pool acquire failed', { cause: sockErr('ETIMEDOUT') }),
  })
  check('a socket error nested two causes deep', isControlUnreachable(wrapped))
}

console.log('\nThe throws that must PASS STRAIGHT THROUGH')
{
  /* THE ONE THAT MATTERS MOST. Next signals a redirect by throwing an error
     carrying this digest; requireSession() uses it for /change-password,
     /select-site and /?kicked=1. Catching it would break all three. */
  const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
    digest: 'NEXT_REDIRECT;replace;/change-password;307;',
  })
  check('a Next redirect is NOT treated as offline', !isControlUnreachable(redirect))
  check('…and is not mistaken for the first run', !isStoreDetailsUnavailable(redirect))

  const notFound = Object.assign(new Error('NEXT_HTTP_ERROR_FALLBACK;404'), {
    digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
  })
  check('a Next notFound() passes through', !isControlUnreachable(notFound))

  /* A genuine bug must still reach global-error.tsx, which is the screen that
     shows a technician what actually happened. Dressing a TypeError up as "no
     internet" would send somebody to check a network cable for an afternoon. */
  check('a real TypeError still surfaces', !isControlUnreachable(new TypeError('x is not a function')))

  /* An SQL error means the database ANSWERED. That is the opposite of offline,
     and it must not be softened — a missing column is a deploy problem. */
  const sqlErr = Object.assign(new Error("Unknown column 'foo'"), { code: 'ER_BAD_FIELD_ERROR' })
  check('a server-side SQL error is not offline', !isControlUnreachable(sqlErr))

  /* Access denied means we REACHED the server and it refused us — a wrong
     password in runtime-config, not a dead line. */
  const denied = Object.assign(new Error('Access denied'), { code: 'ER_ACCESS_DENIED_ERROR' })
  check('access denied is not offline', !isControlUnreachable(denied))
}

console.log('\nThings that are not errors at all')
{
  for (const [label, value] of [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'ENETUNREACH'],
    ['a number', 42],
    ['a bare object', {}],
  ] as const) {
    check(`${label} is handled without throwing`, !isControlUnreachable(value))
  }

  /* A cause chain that points at itself must terminate rather than hang: the
     loop is depth-bounded precisely so a malformed error cannot spin the
     server while somebody is waiting for a page. */
  const loop: { code?: string; cause?: unknown } = {}
  loop.cause = loop
  let settled = false
  try {
    isControlUnreachable(loop)
    settled = true
  } catch {
    settled = false
  }
  check('a self-referencing cause chain terminates', settled)
}

console.log(
  failures === 0
    ? '\nAll offline-gate checks passed.\n'
    : `\n${failures} check(s) FAILED.\n`,
)
process.exit(failures === 0 ? 0 : 1)
