/**
 * Opening the .exe must show the login screen.
 *
 * A desktop install is a SHARED machine — the owner, the bookkeeper and
 * whoever is covering the counter all sit at the same keyboard — so the
 * twelve-hour session that is a convenience in a browser is an accountability
 * hole here: the next person to open the app would be signed in as the last,
 * with their name on every document issued.
 *
 * The failure mode this guards is silent in both directions, which is why it
 * is tested rather than eyeballed:
 *
 *   · removing the wrong cookie NAMES leaves the session intact and the app
 *     resuming, which looks like nothing happened;
 *   · removing them from the wrong ORIGIN silently succeeds — Chromium stores
 *     cookies per host, so `remove` on a URL that never held them is not an
 *     error — with exactly the same appearance;
 *   · taking too much (clearStorageData, say) would un-license the machine and
 *     lose the offline outbox, which does not show up until a customer is
 *     standing there.
 *
 * Electron is not available to a plain node run, and is not needed: the module
 * takes a session object and drives it, so a fake one records what it was
 * asked to do.
 *
 *   node scripts/test-sign-out-on-launch.mjs
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const { signOutOnLaunch, AUTH_COOKIES } = require(
  path.join(here, '..', 'electron', 'signOutOnLaunch.js'),
)

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * A stand-in for Electron's `session`.
 *
 * `present` is the jar. `get` answers only for cookies that are actually there,
 * which is what makes the "first ever launch" case — nothing to remove, no
 * error — a state this test can assert rather than an exception it swallows.
 */
function fakeSession(present = [], { failOn = null } = {}) {
  const removed = []
  const asked = []
  return {
    removed,
    asked,
    cookies: {
      async get({ url, name }) {
        asked.push({ url, name })
        if (failOn === name) throw new Error('profile unreadable')
        return present.filter((c) => c.name === name).map((c) => ({ ...c }))
      },
      async remove(url, name) {
        removed.push({ url, name })
      },
    },
  }
}

const ORIGIN = 'http://localhost:4100'

/* ── THE BACK-OFFICE SESSION GOES ──────────────────────────────────────── */
{
  const s = fakeSession([{ name: 'odyssey_session' }])
  await signOutOnLaunch(s, ORIGIN)
  check(
    'the back-office session cookie is removed',
    s.removed.some((r) => r.name === 'odyssey_session'),
    JSON.stringify(s.removed),
  )
  check(
    'it is removed from the app origin',
    s.removed.every((r) => r.url === ORIGIN),
    JSON.stringify(s.removed),
  )
}

/* ── AND SO DOES THE TILL OPERATOR ─────────────────────────────────────── */
{
  const s = fakeSession([
    { name: 'odyssey_session' },
    { name: 'odyssey_till' },
    { name: 'odyssey_wid' },
  ])
  await signOutOnLaunch(s, ORIGIN)
  const names = s.removed.map((r) => r.name)
  check(
    'the till session goes with the browser session',
    names.includes('odyssey_till'),
    names.join(', '),
  )
  check('the tab marker goes too', names.includes('odyssey_wid'), names.join(', '))
}

/* ── AND NOTHING ELSE DOES ─────────────────────────────────────────────────
 *
 * The device id, the offline outbox and the cached catalogue live in
 * localStorage, and the licence is issued against the first of them. This
 * asserts the module never reaches for a bulk clear: the ONLY surface it
 * touches is `cookies`, by name. */
{
  const s = fakeSession([{ name: 'odyssey_session' }])
  s.clearStorageData = () => {
    throw new Error('signOutOnLaunch must never clear storage — it holds the device id')
  }
  await signOutOnLaunch(s, ORIGIN)
  check(
    'only the named auth cookies are even asked about',
    s.asked.every((a) => AUTH_COOKIES.includes(a.name)),
    s.asked.map((a) => a.name).join(', '),
  )
  check(
    'nothing that is not in the jar is removed',
    s.removed.length === 1,
    JSON.stringify(s.removed),
  )
}

/* ── A FIRST LAUNCH IS NOT AN ERROR ────────────────────────────────────── */
{
  const s = fakeSession([])
  await signOutOnLaunch(s, ORIGIN)
  check('an empty jar removes nothing and throws nothing', s.removed.length === 0)
}

/* ── ONE FAILURE MUST NOT STOP THE REST ────────────────────────────────────
 *
 * The back-office cookie is the first in the list. If a read failing on it
 * aborted the loop, a machine with an unreadable profile entry would keep the
 * till operator signed in — the accountability hole, reappearing on the one
 * machine nobody can diagnose. */
{
  const s = fakeSession([{ name: 'odyssey_till' }], { failOn: 'odyssey_session' })
  await signOutOnLaunch(s, ORIGIN)
  check(
    'a cookie that cannot be read does not strand the ones after it',
    s.removed.some((r) => r.name === 'odyssey_till'),
    JSON.stringify(s.removed),
  )
}

/* ── AND A MISSING PROFILE MUST NOT STOP THE SHOP ──────────────────────────
 *
 * Called before loadURL. Throwing here would mean a machine that cannot start
 * at all, which is a far worse outcome than the behaviour we had before this
 * existed. */
{
  await signOutOnLaunch(null, ORIGIN)
  await signOutOnLaunch(fakeSession([]), null)
  check('no session or no origin is a no-op rather than a throw', true)
}

/* ── THE NAMES MUST STILL BE THE REAL ONES ────────────────────────────────
 *
 * electron/ is plain CommonJS and cannot import a TypeScript constant, so the
 * three cookie names are repeated there. That repetition is the risk: renaming
 * SESSION_COOKIE in src/lib/session.ts would leave this module dutifully
 * removing a cookie that no longer exists, the app resuming its session, and
 * every test above still passing — they drive a fake jar that knows only what
 * the module tells it.
 *
 * So the names are checked against the source of truth rather than against
 * themselves. */
{
  const { readFileSync } = await import('node:fs')
  const declared = [
    'src/lib/session.ts',
    'src/lib/tillSession.ts',
    'src/lib/windowSession.ts',
  ].flatMap((file) =>
    [
      ...readFileSync(path.join(here, '..', file), 'utf8').matchAll(/_COOKIE = '([^']+)'/g),
    ].map((m) => m[1]),
  )

  for (const name of AUTH_COOKIES) {
    check(
      `${name} is still a cookie the app actually sets`,
      declared.includes(name),
      `src/lib declares: ${declared.join(', ')}`,
    )
  }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
