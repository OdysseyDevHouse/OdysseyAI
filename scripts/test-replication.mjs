/**
 * Replication: the parts that can be checked without two database servers.
 *
 * The replication itself is MariaDB's, deliberately — the schema has no delete
 * tracking, so an application-level sync would copy every insert and update
 * faithfully and never once see a delete. What IS ours, and worth pinning
 * down, is the configuration that makes it possible and the reconnect
 * behaviour of the tunnel the shop dials out through.
 *
 *   node scripts/test-replication.mjs
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Module from 'node:module'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const userData = mkdtempSync(path.join(tmpdir(), 'odyssey-repl-'))
const exeDir = mkdtempSync(path.join(tmpdir(), 'odyssey-replexe-'))

const electronStub = {
  app: {
    isPackaged: false,
    getPath: (k) => (k === 'userData' ? userData : path.join(exeDir, 'app.exe')),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(s, 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8'),
  },
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'electron') return electronStub
  return origLoad.apply(this, arguments)
}

const require_ = createRequire(import.meta.url)
const rc = require_('../electron/runtimeConfig.js')
const localDb = require_('../electron/localDb.js')
const tunnel = require_('../electron/replicationTunnel.js')

console.log('\nThe replication account is provisioned')
process.env.ODYSSEY_BACKEND = 'local'
const env = rc.resolveEnv().env
const secrets = rc.revealSecrets()

check('a replication user exists', typeof secrets.replicationUser === 'string' && secrets.replicationUser.length > 0)
check('with its own password', typeof secrets.replicationPassword === 'string' && secrets.replicationPassword.length >= 20)
check(
  'that is NOT the application password',
  secrets.replicationPassword !== secrets.dbPassword,
)
check('nor the root password', secrets.replicationPassword !== secrets.rootPassword)

console.log('\nIt is stable, like every other credential')
const again = rc.revealSecrets()
check('the replication password does not rotate on restart', again.replicationPassword === secrets.replicationPassword)
check('nor does the user name', again.replicationUser === secrets.replicationUser)

console.log('\nThe server id is unique per shop')
{
  const before = process.env.ODYSSEY_SITE_ID
  process.env.ODYSSEY_SITE_ID = '42'
  check('it follows the site id', localDb.serverId() === 42)
  process.env.ODYSSEY_SITE_ID = '7'
  check('a different site gives a different id', localDb.serverId() === 7)
  delete process.env.ODYSSEY_SITE_ID
  check('an unknown site falls back rather than throwing', localDb.serverId() === 1)
  process.env.ODYSSEY_SITE_ID = '0'
  check('a nonsense site falls back too', localDb.serverId() === 1)
  if (before === undefined) delete process.env.ODYSSEY_SITE_ID
  else process.env.ODYSSEY_SITE_ID = before
}

console.log('\nThe tunnel backs off rather than hammering')
{
  const first = tunnel.backoffMs(1)
  const later = tunnel.backoffMs(6)
  check('the first retry is soon', first >= 3_000 && first <= 10_000, String(first))
  check('a long outage backs right off', later >= 60_000, String(later))
  check('and never negative or zero', tunnel.backoffMs(0) > 0)

  /* Sampled hard rather than once. Jitter made this flaky when the cap was
     applied BEFORE it — a "capped" five minutes came out as six and a half
     roughly half the time, and a single sample missed it on most runs. A
     ceiling that only usually holds is not a ceiling. */
  const CAP = 5 * 60_000
  let worst = 0
  for (let i = 0; i < 2_000; i++) {
    worst = Math.max(worst, tunnel.backoffMs(1 + (i % 60)))
  }
  check('the cap holds across 2000 samples', worst <= CAP, `worst was ${worst}`)

  let lowest = Infinity
  for (let i = 0; i < 2_000; i++) lowest = Math.min(lowest, tunnel.backoffMs(1 + (i % 60)))
  check('and nothing ever redials instantly', lowest >= 1_000, `lowest was ${lowest}`)

  /* Without jitter every shop that lost the link in one outage redials in
     lockstep, and our endpoint takes the whole estate at once. */
  const samples = new Set(Array.from({ length: 40 }, () => tunnel.backoffMs(4)))
  check('successive delays differ (jitter)', samples.size > 20, `${samples.size} distinct of 40`)
}

console.log('\nThe tunnel refuses to start unconfigured')
{
  let threw = false
  try {
    tunnel.start({ url: '', token: '', siteId: 1, dbPort: 3306 })
  } catch {
    threw = true
  }
  check('no url means it quietly does nothing', !threw)
  check('and it reports itself disconnected', tunnel.status().connected === false)
  tunnel.stop()
}

console.log('\nStopping is safe even when never started')
{
  let threw = false
  try {
    tunnel.stop()
    tunnel.stop()
  } catch {
    threw = true
  }
  check('stop is idempotent', !threw)
}

Module._load = origLoad
rmSync(userData, { recursive: true, force: true })
rmSync(exeDir, { recursive: true, force: true })

console.log(failures === 0 ? '\nReplication configuration holds.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
