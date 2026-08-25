/**
 * Which installer produced this app, and what that changes.
 *
 * The role decides whether a machine is a till or a back office, and a till
 * that mistakenly reports itself as a back office is a machine a manager can do
 * admin from at the counter. It is baked at build time by build-config/*.yml,
 * so nothing at runtime can be asked to confirm it — which makes these the only
 * checks there are.
 *
 * Electron is not stubbed here: appRole.js reads package.json and the
 * environment, and touches no Electron API at all. That is deliberate — the
 * role must be knowable before a window exists.
 *
 *   node scripts/test-app-role.mjs
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const appRolePath = path.join(here, '..', 'electron', 'appRole.js')

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** A fresh module each time: the role is memoised per process by design. */
function loadFresh() {
  delete require.cache[require.resolve(appRolePath)]
  return require(appRolePath)
}

function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'ODYSSEY_ROLE')
  const prev = process.env.ODYSSEY_ROLE
  if (value === undefined) delete process.env.ODYSSEY_ROLE
  else process.env.ODYSSEY_ROLE = value
  try {
    return fn()
  } finally {
    if (had) process.env.ODYSSEY_ROLE = prev
    else delete process.env.ODYSSEY_ROLE
  }
}

console.log('\nApp role\n')

/* ── The default ─────────────────────────────────────────────────────────── */

withEnv(undefined, () => {
  const m = loadFresh()
  /* A dev checkout has no odysseyRole in package.json — extraMetadata writes it
     at PACKAGE time. It must behave as the full app, exactly as it did before
     there were three builds. An unpackaged run silently becoming a locked-down
     till would make `npm run dev:desktop` useless. */
  check('a checkout with no baked role is the back office', m.appRole() === 'backoffice')
  check('the back office is not the till', m.isPos() === false)
  check('the back office boots to the root', m.startPath() === '/')
})

/* ── The till ────────────────────────────────────────────────────────────── */

withEnv('pos', () => {
  const m = loadFresh()
  check('ODYSSEY_ROLE=pos is the till', m.appRole() === 'pos')
  check('the till reports isPos', m.isPos() === true)
  check('the till boots to /pos', m.startPath() === '/pos')
  check('the till is not the database installer', m.isDatabaseSetup() === false)
})

/* ── The database installer ──────────────────────────────────────────────── */

withEnv('database', () => {
  const m = loadFresh()
  check('ODYSSEY_ROLE=database is the installer', m.appRole() === 'database')
  check('the installer reports isDatabaseSetup', m.isDatabaseSetup() === true)
  check('the installer is not the till', m.isPos() === false)
  /* Not the root: on this machine the login form would ask for an account
     whose database does not exist yet, which is the reason somebody is running
     the installer in the first place. */
  check('the installer boots to its wizard', m.startPath() === '/database-setup')

  const ORIGIN = 'http://localhost:4100'
  const at = (p) => `${ORIGIN}${p}`
  check('installer allows its own wizard', m.setupNavigation(at('/database-setup'), ORIGIN) === 'allow')
  check(
    'installer allows a step under it',
    m.setupNavigation(at('/database-setup/confirm'), ORIGIN) === 'allow',
  )
  /* The whole point of the guard: this build ships without a back office, so a
     link into one must not open a screen the machine has no business showing. */
  for (const path of ['/', '/dashboard', '/pos', '/setup/users']) {
    check(`installer refuses ${path}`, m.setupNavigation(at(path), ORIGIN) === 'refuse')
  }
  check(
    'installer sends a foreign link to the browser',
    m.setupNavigation('https://mariadb.org/download', ORIGIN) === 'external',
  )
  /* Origin before path, same hole the till guard closes: somebody else's
     /database-setup is not ours. */
  check(
    'a foreign /database-setup is not ours',
    m.setupNavigation('https://evil.example/database-setup', ORIGIN) === 'external',
  )
  check(
    'no appOrigin refuses everything',
    m.setupNavigation(at('/database-setup'), null) === 'refuse',
  )
})

/* ── Junk falls back rather than throwing ────────────────────────────────── */

withEnv('nonsense', () => {
  const m = loadFresh()
  /* A machine that cannot make sense of its own role is still a machine
     somebody is trying to trade on. Falling back beats refusing to start —
     and it fails towards the SAFE side only because the fallback is the build
     a person signs into, not the one that skips a login. */
  check('an unknown role falls back to the back office', m.appRole() === 'backoffice')
})

/* ── Memoisation ─────────────────────────────────────────────────────────── */

withEnv('pos', () => {
  const m = loadFresh()
  check('first read is the till', m.appRole() === 'pos')
  process.env.ODYSSEY_ROLE = 'backoffice'
  check('the role does not change mid-process', m.appRole() === 'pos')
  m.resetForTests()
  check('resetForTests clears the memo', m.appRole() === 'backoffice')
})

/* ── The build configs agree with the roles this module accepts ──────────── */

import { readFileSync, existsSync } from 'node:fs'

const CONFIGS = [
  ['backoffice', 'Odyssey Back Office'],
  ['pos', 'Odyssey Point of Sale'],
  ['database', 'Odyssey Database Setup'],
]

for (const [role, productName] of CONFIGS) {
  const file = path.join(here, '..', 'build-config', `${role}.yml`)
  if (!existsSync(file)) {
    check(`build-config/${role}.yml exists`, false)
    continue
  }
  const yml = readFileSync(file, 'utf8')
  /* A typo here produces an installer that reports the wrong role — a till that
     opens the back office, or a back office with no way in. Nothing else would
     catch it until somebody installed the thing. */
  check(`${role}.yml bakes odysseyRole: ${role}`, new RegExp(`odysseyRole:\\s*${role}\\b`).test(yml))
  check(`${role}.yml is named "${productName}"`, yml.includes(`productName: ${productName}`))
  /* `./`, not `../`. electron-builder resolves `extends` against the PROJECT
     ROOT rather than the config file's own directory, so the intuitive
     `../electron-builder.yml` from build-config/ fails with "Cannot find
     parent config file". */
  check(`${role}.yml extends the shared base`, /extends:\s*\.\/electron-builder\.yml/.test(yml))
  /* The names dropped "AI" deliberately. */
  check(`${role}.yml does not say OdysseyAI`, !/productName:.*OdysseyAI/.test(yml))
}

/* Only the database installer carries the server. If this ever appears in the
   app builds, every app update grows by ~200MB again and nobody notices until
   a customer complains about the download. */
const posYml = readFileSync(path.join(here, '..', 'build-config', 'pos.yml'), 'utf8')
const boYml = readFileSync(path.join(here, '..', 'build-config', 'backoffice.yml'), 'utf8')
const dbYml = readFileSync(path.join(here, '..', 'build-config', 'database.yml'), 'utf8')
check('the till build carries no database', !posYml.includes('vendor/mariadb'))
check('the back office build carries no database', !boYml.includes('vendor/mariadb'))
check('the database build carries the database', dbYml.includes('vendor/mariadb'))

const base = readFileSync(path.join(here, '..', 'electron-builder.yml'), 'utf8')
check('the shared base carries no database', !base.includes('vendor/mariadb'))

/* ── Where the till build may go ─────────────────────────────────────────── */

/* The guard decides what happens to every link followed INSIDE the till window.
   Get it wrong in one direction and a cashier is stranded on a screen with no
   way out; wrong in the other and the till navigates to a supplier's website
   with our preload attached. */
{
  const { posNavigation, isPosPath } = loadFresh()
  const ORIGIN = 'http://127.0.0.1:4100'
  const at = (p) => `${ORIGIN}${p}`

  /* Screens a till legitimately shows. Each of these was broken by the first
     version of this guard, which allowed /pos* and nothing else. */
  for (const [p, why] of [
    ['/pos', 'the till itself'],
    ['/pos-unlock', 'where proxy.ts sends a lapsed session'],
    ['/pos?new=quote', 'opened from Orders with a start type'],
    ['/', 'the admin sign-in, and the unlock screen’s way out'],
    ['/not-allowed', 'no sales.till capability'],
  ]) {
    check(`till allows ${p} — ${why}`, posNavigation(at(p), ORIGIN) === 'allow')
  }

  /* Our own back office. Refused OUTRIGHT rather than externalised: opening it
     in a browser would hand somebody a signed-in back office from a machine
     whose whole point is that it has none. */
  for (const p of ['/dashboard', '/purchasing', '/setup/tills', '/sales/12/bill']) {
    check(`till refuses ${p}`, posNavigation(at(p), ORIGIN) === 'refuse')
  }

  /* Somebody else's site goes to the user's own browser, as it does from the
     back office. */
  check(
    'a supplier link opens externally',
    posNavigation('https://supplier.example/help', ORIGIN) === 'external',
  )

  /* THE HOLE THIS ORDERING EXISTS TO CLOSE. Path-first, a foreign /pos matches
     and the till window navigates to a third-party site. */
  check(
    'a foreign /pos does NOT count as the till',
    posNavigation('https://supplier.example/pos', ORIGIN) === 'external',
  )
  check('...and isPosPath alone would have allowed it', isPosPath('https://supplier.example/pos'))

  /* Non-web schemes must not reach shell.openExternal. */
  for (const u of ['javascript:alert(1)', 'file:///C:/Windows/system32', 'not a url']) {
    check(`refuses ${u.slice(0, 24)}`, posNavigation(u, ORIGIN) === 'refuse')
  }

  /* Startup: the window shows starting.html, origin 'null'. With appOrigin
     unset, nothing may be treated as ours — and in particular our own URL must
     not be shipped off to the user's browser. */
  check('no appOrigin refuses our own URL', posNavigation(at('/pos'), null) === 'refuse')
  check('no appOrigin still externalises nothing', posNavigation(at('/dashboard'), null) === 'refuse')
}

/* ── The configs actually RESOLVE ────────────────────────────────────────── */

/* Everything above is string matching: the YAML is valid and the words are all
   present. None of it would notice a broken `extends`, which fails at merge
   time and takes the whole build with it. Only asking electron-builder to do
   the merge proves the chain works. */
const { getConfig } = require('app-builder-lib/out/util/config/config')

for (const [role, productName] of CONFIGS) {
  let merged = null
  try {
    merged = await getConfig(process.cwd(), `build-config/${role}.yml`, null)
  } catch (err) {
    check(`${role}.yml resolves its parent`, false, err.message)
    continue
  }
  check(`${role}.yml resolves its parent`, true)
  check(`${role} merges to "${productName}"`, merged.productName === productName)
  check(`${role} keeps its own appId`, merged.appId === `za.co.pointofsale.odyssey.${role}`)
  check(`${role} inherits the nsis block`, merged.nsis?.oneClick === false)

  /* The app payload must survive the merge. deepAssign APPENDS arrays of
     objects rather than replacing them — which is what lets the database build
     add MariaDB without losing .next — but that is library behaviour this
     depends on, so it is worth pinning rather than assuming. */
  /* Asserted on the DESTINATION rather than the source, because one of them is
     deliberately not the file it looks like: naming the repo's own package.json
     as an extraResources source excluded it from the asar ROOT — every `from`
     here is added to the app copier's exclude list — and Electron needs it there
     to find `main`. So the Next app dir gets a staged copy instead. What has to
     survive the merge is the payload, which is what `to` describes. */
  const from = (merged.extraResources || []).map((r) => r.from)
  const to = (merged.extraResources || []).map((r) => r.to)
  for (const need of ['.next', 'public', 'node_modules', 'package.json', 'next.config.mjs']) {
    check(`${role} still ships ${need}`, to.includes(`app/${need}`))
  }
  /* The schema has to travel with the installer. Odyssey Database Setup
     creates an empty database and fills it from sql/site — 254 files applied by
     electron/siteMigrate.js — and until this shipped, the wizard would have
     created a database with no tables and called it done. Silent success is
     the failure mode worth a test. */
  check(`${role} ships the schema`, to.includes('sql'))

  const hasDb = from.includes('vendor/mariadb')
  check(
    role === 'database' ? 'database ships MariaDB' : `${role} ships no MariaDB`,
    role === 'database' ? hasDb : !hasDb,
  )
}

console.log(`\n${failures === 0 ? 'All app-role checks passed.' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
