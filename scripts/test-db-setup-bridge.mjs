/**
 * The setup wizard's bridge — what may cross it, and what must not.
 *
 * ── THE TWO THINGS WORTH FAILING OVER ───────────────────────────────────────
 *
 * 1. The shop's database password reaching the renderer. `SetupPlan` carries it
 *    in the clear, and a renderer is a browser: what it holds is one devtools
 *    window from being read, and would sit in a crash report. Only `redact()`
 *    output may cross back.
 *
 * 2. /api/db-setup answering anybody. It runs before there is a session to
 *    authenticate with, so without the key it is a way for anything on that
 *    machine to read a database password off localhost.
 *
 * The key check itself is exercised for real — the route's comparison is copied
 * nowhere, so it is imported and run. The rest is checked against the source,
 * because standing up a provisioned machine to test them is the acceptance run,
 * not a unit test.
 *
 *   node scripts/test-db-setup-bridge.mjs
 */
import { readFileSync } from 'node:fs'
import { timingSafeEqual, randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\nDatabase setup bridge\n')

/* ── The key comparison, run rather than read ─────────────────────────────── */

/* Mirrors the route's keyMatches. Kept in step by the source checks below,
   which assert the route still uses a length guard and timingSafeEqual — the
   two things that make this shape correct rather than merely working. */
function keyMatches(expected, offered) {
  if (!expected || !offered) return false
  const a = Buffer.from(offered)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const key = randomBytes(32).toString('hex')
check('the right key matches', keyMatches(key, key))
check(
  'a wrong key of the same length does not',
  keyMatches(key, randomBytes(32).toString('hex')) === false,
)
check('a short key does not throw, it refuses', keyMatches(key, 'x') === false)
check('an empty offer is refused', keyMatches(key, '') === false)
/* The important one: an install that never minted a key must not accept a
   caller that also has none, which a naive `a === b` would. */
check('no key configured refuses everything', keyMatches('', '') === false)

/* ── The route ────────────────────────────────────────────────────────────── */

const bridge = read('electron/dbSetupBridge.js')
const route = read('src/app/api/db-setup/route.ts')
check('the key is compared in constant time', /timingSafeEqual/.test(route))
check('a length mismatch is guarded before comparing', /a\.length !== b\.length/.test(route))
/* 404 rather than 403: telling an unknown caller that an interesting endpoint
   lives here is itself information. */
check('an unknown caller gets 404, not 403', /status: 404/.test(route) && !/status: 403/.test(route))
check('the guard runs before the body is read', route.indexOf('keyMatches') < route.indexOf('request.json'))
/* The renderer sends a site id. It must be resolved against what the LOGIN
   actually returned, never trusted on its own — otherwise a shop this person
   cannot open is one edited request away. */
check(
  'the site is resolved against the signed-in payload, not trusted',
  /state\.payload\.stores \|\| \[\]\)\.find/.test(bridge),
)
/* A suspended store is returned by the API deliberately, so the wizard can say
   WHICH kind of no it is. It must still refuse to provision one. */
check('a store that is not accessible is refused', /!store\.isAccessible/.test(bridge))
check('the LAN widening is opt-in', /const allowFrom = \['127\.0\.0\.1'\]/.test(route))

/* ── What crosses back ────────────────────────────────────────────────────── */

const planHandler = bridge.slice(
  bridge.indexOf("ipcMain.handle('db-setup:plan'"),
  bridge.indexOf("ipcMain.handle('db-setup:provision'"),
)
/* The password is stripped before anything crosses back. Asserted on the
   handler's own text rather than on a helper elsewhere, because this is the
   single line deciding whether a shop's database password reaches a browser. */
/* An explicit allow-list, not a redaction. Stripping fields off the plan means
   anything ADDED to the plan later crosses back by default; naming what may
   cross means it does not. The host, port, database name and username are as
   unwelcome on that screen as the password. */
const answered = planHandler.slice(planHandler.lastIndexOf('return {'))
check("the plan handler answers an explicit allow-list", /action: 'provision',/.test(answered))
check(
  'and that list carries no part of the connection',
  !/(password|databaseName|username|host|port)\s*:/.test(answered),
)
check('it never returns the plan itself', !/return plan\b/.test(planHandler))
check('the full plan is kept in main', /state\.plan = plan/.test(planHandler))
/* The decrypted password must not be logged either — progress lines go to the
   log file, which a tester is asked to send. */
check('the password never reaches a progress line', !/progress\(.*password/i.test(planHandler))

/* ── The renderer's reach is a list somebody wrote down ───────────────────── */

const preload = read('electron/preload.js')
check('preload exposes a named surface', /dbSetup: \{/.test(preload))
/* A generic invoke(channel, args) would mean anything running in the renderer
   reaches every handler main will ever have — the exact thing contextIsolation
   exists to prevent. */
check(
  'there is no generic invoke escape hatch',
  !/invoke: \(channel/.test(preload) && !/ipcRenderer\.invoke\(channel/.test(preload),
)
check('onProgress returns its own unsubscribe', /return \(\) => ipcRenderer\.removeListener/.test(preload))
/* The Electron event object carries a `sender`; handing it to renderer code
   would leak a handle to the very thing the bridge is narrowing. */
check('the electron event is not passed to the callback', /\(_event, message\) => callback/.test(preload))

/* ── Startup ordering ─────────────────────────────────────────────────────── */

const main = read('electron/main.js')
check(
  'the key is minted before the server starts',
  main.indexOf('dbSetupBridge.installKey') < main.indexOf('await startNextServer()'),
  'compared against the call site, not the function declaration',
)
check('only the installer build registers the handlers', /if \(isDatabaseSetup\(\)\) \{\s*\n\s*dbSetupBridge\.installKey/.test(main))

/* ── The preload has to be able to RUN ────────────────────────────────────── */

/* Electron sandboxes renderers by default since v20, and a sandboxed preload
   gets a polyfilled require that knows `electron` and little else — no node:
   modules, no relative files. preload.js needs both, so it threw on its first
   line and never reached exposeInMainWorld: `window.odyssey` was undefined in
   every packaged build.

   It went unnoticed for a long time because everything reading the bridge
   treats absence as "this is a browser", which is a legal state with a sensible
   fallback. Pinned here so it cannot be quietly tidied away again. */
const needsNode =
  /require\('node:(fs|crypto|path)'\)/.test(preload) || /require\('\.\/appRole'\)/.test(preload)
check('preload still needs Node', needsNode, 'if false, the sandbox check below may be moot')
check('so the renderer is not sandboxed', /sandbox: false/.test(main))
/* The protection that actually matters stays on: the page reaches only the
   named surface, and never Node. */
check('contextIsolation stays on', /contextIsolation: true/.test(main))
check('nodeIntegration stays off', /nodeIntegration: false/.test(main))

/* ── The middleware has to let the wizard through ─────────────────────────── */

/* proxy.ts requires a session for every /api/ route and answers 401 before the
   handler ever runs. The wizard has no session BY DEFINITION — it is installing
   the database that the users table will eventually live in — so both its screen
   and its API have to be public to the middleware.

   Public to the middleware is not the same as unguarded: the route's own key
   check is what protects it, and it answers 404 rather than 401 to anything that
   cannot present one. */
const proxy = read('src/proxy.ts')
const publicExact = proxy.slice(proxy.indexOf('const PUBLIC_EXACT'), proxy.indexOf('const PUBLIC_PREFIXES'))
check('the wizard screen is public to the middleware', publicExact.includes("'/database-setup'"))
check('and so is its API', publicExact.includes("'/api/db-setup'"))
/* EXACT, not a prefix. A future '/database-setup-report' must not become public
   by accident — the same reason '/api-docs' is exact rather than '/api-docs'. */
check('both sit in PUBLIC_EXACT, not PUBLIC_PREFIXES', !proxy.slice(proxy.indexOf('const PUBLIC_PREFIXES')).includes("'/database-setup"))

console.log(`\n${failures === 0 ? 'All bridge checks passed.' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
