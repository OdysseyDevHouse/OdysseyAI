/**
 * The back office EXE opens local stores only.
 *
 * The failure this guards against is silent and expensive: a cloud site opened
 * in the desktop back office works perfectly on the office LAN where it was
 * demonstrated, and times out at the customer, because it is a raw MySQL
 * connection to the control database on 3306. So the rule has to be exercised
 * for every combination of build and site, not just the one somebody tried.
 *
 * Pure environment in, boolean out — no database, no server.
 *
 *   npx tsx --conditions=react-server scripts/test-cloud-site-refusal.ts
 */
import { isBackOfficeDesktop, opensHere, cloudSiteMessage } from '../src/lib/desktopBackOffice'
import type { ConnectionType } from '../src/lib/sites'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Run `fn` with exactly this environment, then put the process back. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const previous = new Map<string, string | undefined>()
  for (const [k, v] of Object.entries(vars)) {
    previous.set(k, process.env[k])
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    fn()
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const BACK_OFFICE = { APP_MODE: 'desktop', ODYSSEY_ROLE: 'backoffice' }
const TILL = { APP_MODE: 'desktop', ODYSSEY_ROLE: 'pos' }
const WEB = { APP_MODE: undefined, ODYSSEY_ROLE: undefined }
const DEV_DESKTOP = { APP_MODE: 'desktop', ODYSSEY_ROLE: undefined }

const TYPES: ConnectionType[] = ['cloud', 'local', 'hybrid']

console.log('\nWhich build is this')
withEnv(BACK_OFFICE, () => check('the back office EXE is recognised', isBackOfficeDesktop()))
withEnv(TILL, () => check('the till EXE is not the back office', !isBackOfficeDesktop()))
withEnv(WEB, () => check('the web build is not the back office', !isBackOfficeDesktop()))
withEnv(DEV_DESKTOP, () =>
  check('a desktop run with no role is not the back office', !isBackOfficeDesktop()),
)

console.log('\nThe back office EXE refuses a cloud store, and only a cloud store')
withEnv(BACK_OFFICE, () => {
  check('cloud is refused', !opensHere('cloud'))
  check('local opens', opensHere('local'))
  check('hybrid opens — it has a local half to serve', opensHere('hybrid'))
})

console.log('\nEvery other build opens everything')
for (const [label, env] of [
  ['the till', TILL],
  ['the web build', WEB],
  ['npm run dev:desktop', DEV_DESKTOP],
] as const) {
  withEnv(env, () => {
    check(`${label} opens every connection type`, TYPES.every((t) => opensHere(t)))
  })
}

console.log('\nThe role must be explicit — absent is never a refusal')
withEnv({ APP_MODE: 'desktop', ODYSSEY_ROLE: '' }, () =>
  check('an empty role does not refuse', opensHere('cloud')),
)
withEnv({ APP_MODE: undefined, ODYSSEY_ROLE: 'backoffice' }, () =>
  check('the role alone, without desktop mode, does not refuse', opensHere('cloud')),
)

console.log('\nThe message tells them what to do instead')
const named = cloudSiteMessage('Sandton Branch')
check('it names the store when there is one to name', named.includes('Sandton Branch'), named)
check('it points at a browser', /browser/i.test(named))
check('the unnamed form still reads as a sentence', cloudSiteMessage().startsWith('This store'))
check('an empty name falls back rather than printing a gap', cloudSiteMessage('  ').startsWith('This store'))

console.log(failures === 0 ? '\nAll cloud-site checks passed.' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
