/**
 * Where each build looks for its updates.
 *
 * ── WHY THIS IS WORTH A SUITE OF ITS OWN ───────────────────────────────────
 *
 * Every failure mode of an updater is silent by construction. The app is meant
 * to shrug off a feed it cannot reach — a shop whose line is down must still
 * open — so "wrong URL", "no URL" and "URL half a second too late" all look
 * exactly like "no release yet" from the outside, and the only person who could
 * notice is the one who is not going to be told.
 *
 * That is not hypothetical. The first version read process.env, which
 * runtimeConfig.resolveEnv() does not populate until after updater.start() has
 * already run and latched — so every packaged build ever cut had the URL baked
 * in and never used it. Nothing failed. Nothing logged. The builds simply never
 * updated, and would not have until somebody asked why.
 *
 * So the resolution is checked here, where it is cheap, rather than by cutting
 * an installer and waiting four hours.
 *
 *   node scripts/test-updater-feed.mjs
 *
 * Electron IS stubbed: updater.js pulls `app` and `dialog` off it at require
 * time, and neither is touched by the paths under test.
 */
import Module from 'node:module'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const updaterPath = path.join(here, '..', 'electron', 'updater.js')
const appRolePath = path.join(here, '..', 'electron', 'appRole.js')
const defaultsPath = path.join(here, '..', 'electron', 'buildDefaults.json')

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ── The stub ─────────────────────────────────────────────────────────────
 *
 * Nothing here is exercised: feedUrl() reads the environment, a JSON file and
 * appRole(). The stub exists only so `require('electron')` resolves outside an
 * Electron process. */
const load = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getVersion: () => '0.0.0-test', setName() {} },
      dialog: { showMessageBox: async () => ({}) },
    }
  }
  return load.call(this, request, ...rest)
}

/** A fresh updater each time. appRole memoises the role per process by design,
    so it has to be evicted alongside — otherwise every case after the first
    would answer with the first case's role. */
function loadFresh(buildDefaults) {
  delete require.cache[require.resolve(updaterPath)]
  delete require.cache[require.resolve(appRolePath)]
  delete require.cache[require.resolve(defaultsPath)]
  if (buildDefaults !== undefined) require.cache[require.resolve(defaultsPath)] = { exports: buildDefaults }
  return require(updaterPath)
}

function withEnv(vars, fn) {
  const saved = new Map()
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined)
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

console.log('\nUpdater feed\n')

/* ── One host, three folders ──────────────────────────────────────────────
 *
 * The manifest is called latest.yml whatever the product is, so the three
 * builds cannot share a folder. If any two of these ever come out equal, two
 * products are reading one manifest and at most one of them can be right. */

const HOST = 'https://updates.example.test'
const seen = new Map()
for (const role of ['backoffice', 'pos', 'database']) {
  withEnv({ ODYSSEY_ROLE: role, ODYSSEY_UPDATE_URL: HOST }, () => {
    const { feedUrl } = loadFresh({})
    const url = feedUrl()
    seen.set(role, url)
    check(`${role} reads ${HOST}/${role}/`, url === `${HOST}/${role}/`, url)
  })
}
check(
  'the three builds do not share a feed',
  new Set(seen.values()).size === 3,
  [...seen.values()].join(' '),
)

/* ── The bug this file was written for ────────────────────────────────────
 *
 * The baked value must work on its own, with NOTHING in the environment. That
 * is the packaged case, and it is the one that was broken: resolveEnv() copies
 * buildDefaults into process.env, but not until long after start() has run. */
withEnv({ ODYSSEY_ROLE: 'pos', ODYSSEY_UPDATE_URL: undefined }, () => {
  const { feedUrl } = loadFresh({ ODYSSEY_UPDATE_URL: HOST })
  check(
    'the baked URL is used without any environment',
    feedUrl() === `${HOST}/pos/`,
    feedUrl() || '(empty)',
  )
})

/* The environment still wins, because that is the support engineer's override
   and the only way to point a dev checkout at a staging host. */
withEnv({ ODYSSEY_ROLE: 'pos', ODYSSEY_UPDATE_URL: 'https://staging.example.test' }, () => {
  const { feedUrl } = loadFresh({ ODYSSEY_UPDATE_URL: HOST })
  check(
    'the environment overrides the baked URL',
    feedUrl() === 'https://staging.example.test/pos/',
    feedUrl(),
  )
})

/* ── A build with no feed says nothing rather than guessing ───────────────
 *
 * An empty string is what start() checks for. A URL assembled out of an absent
 * host — "/pos/", or "undefined/pos/" — would be a relative path the provider
 * would then fail on obscurely, four hours after launch. */
withEnv({ ODYSSEY_ROLE: 'backoffice', ODYSSEY_UPDATE_URL: undefined }, () => {
  const { feedUrl } = loadFresh({})
  check('no host configured yields an empty feed', feedUrl() === '', feedUrl())
})

/* ── Trailing slashes ─────────────────────────────────────────────────────
 *
 * Whoever sets ODYSSEY_UPDATE_URL will sometimes end it with a slash and
 * sometimes not, and a doubled one is a different path on an S3-compatible
 * store than a single one: R2 keys are opaque strings, so //backoffice/ is a
 * 404 rather than a tidied-up /backoffice/. */
for (const given of [HOST, `${HOST}/`, `${HOST}///`]) {
  withEnv({ ODYSSEY_ROLE: 'database', ODYSSEY_UPDATE_URL: given }, () => {
    const { feedUrl } = loadFresh({})
    check(`"${given}" normalises to one slash`, feedUrl() === `${HOST}/database/`, feedUrl())
  })
}

console.log(
  failures ? `\n**FAIL** ${failures} check(s) failed\n` : '\nAll updater feed checks passed\n',
)
process.exit(failures ? 1 : 0)
