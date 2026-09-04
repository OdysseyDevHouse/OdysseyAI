/**
 * Each back office opens one kind of store, and only that kind.
 *
 * The failure this guards against is silent and expensive, in both directions:
 * a cloud site opened in the desktop back office works perfectly on the office
 * LAN where it was demonstrated and times out at the customer, because it is a
 * raw MySQL connection to the control database on 3306; a local site offered by
 * the web back office can never work at all, because its database sits behind
 * the shop's own router. So the rule is exercised for every combination of
 * build and site, not just the one somebody tried.
 *
 * Pure environment in, boolean out — no database, no server.
 *
 *   npx tsx --conditions=react-server scripts/test-site-opens-here.ts
 */
import {
  isBackOfficeDesktop,
  isCloudBackOffice,
  opensHere,
  cloudSiteMessage,
  localSiteMessage,
  wrongShellMessage,
} from '../src/lib/siteOpensHere'
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

/* NODE_ENV is spelled out in every case below rather than inherited, because
   `tsx` leaves it at whatever the shell had and the web rule reads it. A test
   that passes only on a developer's machine is worse than no test. */
const BACK_OFFICE = { APP_MODE: 'desktop', ODYSSEY_ROLE: 'backoffice', NODE_ENV: 'production' }
const TILL = { APP_MODE: 'desktop', ODYSSEY_ROLE: 'pos', NODE_ENV: 'production' }
const SETUP = { APP_MODE: 'desktop', ODYSSEY_ROLE: 'database', NODE_ENV: 'production' }
const WEB = { APP_MODE: undefined, ODYSSEY_ROLE: undefined, NODE_ENV: 'production' }
const DEV_DESKTOP = { APP_MODE: 'desktop', ODYSSEY_ROLE: undefined, NODE_ENV: 'development' }
const DEV_WEB = {
  APP_MODE: undefined,
  ODYSSEY_ROLE: undefined,
  NODE_ENV: 'development',
  ODYSSEY_CLOUD_ONLY: undefined,
}

const TYPES: ConnectionType[] = ['cloud', 'local', 'hybrid']

console.log('\nWhich front door is this')
withEnv(BACK_OFFICE, () => {
  check('the back office EXE is recognised', isBackOfficeDesktop())
  check('and it is not the web back office', !isCloudBackOffice())
})
withEnv(TILL, () => check('the till EXE is not the back office', !isBackOfficeDesktop()))
withEnv(WEB, () => {
  check('the deployed web build is not the EXE', !isBackOfficeDesktop())
  check('the deployed web build IS the web back office', isCloudBackOffice())
})
withEnv(DEV_DESKTOP, () => {
  check('a desktop run with no role is not the back office EXE', !isBackOfficeDesktop())
  check('and a desktop run is never the web back office', !isCloudBackOffice())
})
withEnv(DEV_WEB, () =>
  check('`npm run dev` IS the web back office — same code, same rule', isCloudBackOffice()),
)

console.log('\nThe back office EXE opens local stores, and only local stores')
withEnv(BACK_OFFICE, () => {
  check('cloud is refused', !opensHere('cloud'))
  check('local opens', opensHere('local'))
  check('hybrid opens — it has a local half to serve', opensHere('hybrid'))
})

console.log('\nThe web back office opens cloud stores, and only cloud stores')
withEnv(WEB, () => {
  check('local is refused', !opensHere('local'))
  check('cloud opens', opensHere('cloud'))
  check('hybrid opens — it has a remote half to serve', opensHere('hybrid'))
})

console.log('\nEverything that is not a back office opens everything')
for (const [label, env] of [
  ['the till', TILL],
  ['OdysseyAI Database Setup', SETUP],
  ['npm run dev:desktop', DEV_DESKTOP],
] as const) {
  withEnv(env, () => {
    check(`${label} opens every connection type`, TYPES.every((t) => opensHere(t)))
  })
}

console.log('\nThe desktop role must be explicit — absent is never a refusal')
withEnv({ APP_MODE: 'desktop', ODYSSEY_ROLE: '', NODE_ENV: 'production' }, () =>
  check('an empty role does not refuse a cloud store', opensHere('cloud')),
)
withEnv({ APP_MODE: undefined, ODYSSEY_ROLE: 'backoffice', NODE_ENV: 'development' }, () => {
  /* Still the WEB back office, so a local store is refused — but by the web
     rule, not by the role. What the role alone must never do is make a browser
     behave like the EXE and turn away the cloud stores it exists to serve. */
  check('the role alone, without desktop mode, is not the EXE', opensHere('cloud'))
  check('and the web rule still applies to it', !opensHere('local'))
})

console.log('\nODYSSEY_CLOUD_ONLY=0 is the one way out, and it only loosens the web rule')
withEnv({ ...DEV_WEB, ODYSSEY_CLOUD_ONLY: '0' }, () => {
  check('a developer on the shop LAN can open a local store', opensHere('local'))
  check('and still opens a cloud one', opensHere('cloud'))
})
withEnv({ ...WEB, ODYSSEY_CLOUD_ONLY: '0' }, () =>
  check('so can the testing VM, whose local sites are on the same box', opensHere('local')),
)
withEnv({ ...WEB, ODYSSEY_CLOUD_ONLY: '  ' }, () =>
  check('a blank value is not an opt-out', !opensHere('local')),
)
withEnv({ ...WEB, ODYSSEY_CLOUD_ONLY: '1' }, () =>
  check('and neither is anything else', !opensHere('local')),
)
withEnv(
  { APP_MODE: 'desktop', ODYSSEY_ROLE: 'backoffice', NODE_ENV: 'production', ODYSSEY_CLOUD_ONLY: '0' },
  () => check('it cannot make the EXE open a cloud store', !opensHere('cloud')),
)

console.log('\nEach refusal tells them what to do instead')
const named = cloudSiteMessage('Sandton Branch')
check('the cloud refusal names the store', named.includes('Sandton Branch'), named)
check('the cloud refusal points at a browser', /browser/i.test(named))
check('the unnamed form still reads as a sentence', cloudSiteMessage().startsWith('This store'))
check(
  'an empty name falls back rather than printing a gap',
  cloudSiteMessage('  ').startsWith('This store'),
)

const namedLocal = localSiteMessage('Sandton Branch')
check('the local refusal names the store', namedLocal.includes('Sandton Branch'), namedLocal)
check(
  'the local refusal points at the app in the store',
  /OdysseyAI Back Office/.test(namedLocal) && /in the store/i.test(namedLocal),
)
check('the unnamed form still reads as a sentence', localSiteMessage().startsWith('This store'))
check(
  'an empty name falls back rather than printing a gap',
  localSiteMessage('  ').startsWith('This store'),
)
check('the two refusals are not the same sentence', cloudSiteMessage() !== localSiteMessage())

console.log('\nThe screens pick the refusal that matches their build')
withEnv(BACK_OFFICE, () =>
  check('the EXE explains that a cloud store needs a browser', wrongShellMessage() === cloudSiteMessage()),
)
withEnv(WEB, () =>
  check('the browser explains that a local store needs the EXE', wrongShellMessage() === localSiteMessage()),
)

console.log(failures === 0 ? '\nAll front-door checks passed.' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
