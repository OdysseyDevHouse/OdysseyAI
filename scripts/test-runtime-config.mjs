/**
 * The desktop runtime config decides where a packaged install gets its
 * database, its secrets and its uploads directory. Getting it wrong means an
 * app that cannot open a connection at all — which is exactly what a packaged
 * build did before it existed — or, worse, one that rotates a credential its
 * own database is already using.
 *
 * Electron is stubbed: these are pure decisions about files and environment,
 * and running them under a real Electron would test the stub rather than the
 * logic.
 *
 *   node scripts/test-runtime-config.mjs
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
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

/* ── Stub electron ──────────────────────────────────────────────────────────
   safeStorage reports unavailable, which exercises the plaintext fallback —
   the path a Linux box with no keyring takes, and the one where a silent
   downgrade would be a real hazard. */
const userData = mkdtempSync(path.join(tmpdir(), 'odyssey-cfg-'))
const exeDir = mkdtempSync(path.join(tmpdir(), 'odyssey-exe-'))

/* ── AND ProgramData, WHICH IS NOT THIS PROCESS'S TO READ ──────────────────
 *
 * runtimeConfig now adopts what OdysseyAI Database Setup left in
 * ProgramData\Odyssey\site.json. Left pointing at the real one, this suite
 * reads whatever the developer's own machine happens to have been provisioned
 * with — and it silently did, resolving a "fresh local install" against a live
 * shop's credentials and reporting failures that were nothing to do with the
 * code.
 *
 * A test that reads real machine state is not testing the code. */
process.env.ProgramData = mkdtempSync(path.join(tmpdir(), 'odyssey-pd-'))

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
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  return origLoad.apply(this, arguments)
}

const require_ = createRequire(import.meta.url)
const rc = require_('../electron/runtimeConfig.js')

function reset() {
  rmSync(path.join(userData, 'runtime-config.json'), { force: true })
  for (const k of [
    'ODYSSEY_BACKEND',
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME',
    'SESSION_SECRET',
    'ENCRYPTION_KEY',
    'SITE_DB_HOST_OVERRIDE',
    'UPLOADS_DIR',
    'APP_MODE',
    'NEXT_PUBLIC_APP_MODE',
  ]) delete process.env[k]
  try { rmSync(path.join(exeDir, 'backend.txt'), { force: true }) } catch {}
}

console.log('\nAn install with no marker stays on the cloud')
reset()
check('defaults to cloud', rc.resolveInitialBackend() === 'cloud')
check('and an upgrade of a field machine changes nothing', rc.resolveEnv().mode === 'cloud')

console.log('\nThe installer can say which kind this is')
reset()
writeFileSync(path.join(exeDir, 'backend.txt'), 'local\n', 'utf8')
check('a marker beside the executable selects local', rc.resolveInitialBackend() === 'local')

console.log('\nAn environment variable overrides, for support')
reset()
process.env.ODYSSEY_BACKEND = 'local'
check('ODYSSEY_BACKEND wins', rc.resolveInitialBackend() === 'local')
reset()

console.log('\nProvisioning a local backend')
reset()
process.env.ODYSSEY_BACKEND = 'local'
const first = rc.resolveEnv()
check('the mode is local', first.mode === 'local')
check('it points at loopback', first.env.DB_HOST === '127.0.0.1')
check('on a port that is not 3306', Number(first.env.DB_PORT) !== 3306 && Number(first.env.DB_PORT) >= 33060)
check('with a generated password', typeof first.env.DB_PASSWORD === 'string' && first.env.DB_PASSWORD.length >= 20)
check('a session secret was minted', Boolean(first.env.SESSION_SECRET))
check('an encryption key was minted', Boolean(first.env.ENCRYPTION_KEY))
check('site databases resolve to this machine', first.env.SITE_DB_HOST_OVERRIDE === '127.0.0.1')
check('desktop mode is declared', first.env.APP_MODE === 'desktop')
check('uploads land outside the app directory', String(first.env.UPLOADS_DIR).startsWith(userData))

console.log('\nCredentials must never rotate under a live database')
const secondEnv = rc.resolveEnv().env
check('the password is stable across restarts', secondEnv.DB_PASSWORD === first.env.DB_PASSWORD)
check('the port is stable across restarts', secondEnv.DB_PORT === first.env.DB_PORT)
check('the session secret is stable', secondEnv.SESSION_SECRET === first.env.SESSION_SECRET)
check('the encryption key is stable', secondEnv.ENCRYPTION_KEY === first.env.ENCRYPTION_KEY)

console.log('\nA decided install never re-decides')
writeFileSync(path.join(exeDir, 'backend.txt'), 'cloud\n', 'utf8')
check('a later marker does not flip a provisioned machine', rc.backendMode() === 'local')

console.log('\nThe nightly backup has its own key')
check('a backup key was minted', Boolean(first.env.BACKUP_ENCRYPTION_KEY))
check(
  'it is 32 bytes, as the push script demands',
  Buffer.from(String(first.env.BACKUP_ENCRYPTION_KEY), 'base64').length === 32,
)
check(
  'it is NOT the credential encryption key',
  first.env.BACKUP_ENCRYPTION_KEY !== first.env.ENCRYPTION_KEY,
)
check('backups land outside the app directory', String(first.env.BACKUP_DIR).startsWith(userData))
check('the backup key is stable across restarts', secondEnv.BACKUP_ENCRYPTION_KEY === first.env.BACKUP_ENCRYPTION_KEY)

console.log('\nWhat support can reveal')
const secrets = rc.revealSecrets()
check('the database password is recoverable', secrets.dbPassword === first.env.DB_PASSWORD)
check('the root password is recoverable', typeof secrets.rootPassword === 'string' && secrets.rootPassword.length > 0)
check('root and app passwords differ', secrets.rootPassword !== secrets.dbPassword)
check('the encryption key is recoverable', secrets.encryptionKey === first.env.ENCRYPTION_KEY)
check('the port is reported', Number(secrets.dbPort) === Number(first.env.DB_PORT))
/* Without this escrowed, every nightly backup is unrecoverable — and the loss
   is silent until the day somebody needs a restore. */
check('the BACKUP key is recoverable', secrets.backupKey === first.env.BACKUP_ENCRYPTION_KEY)

console.log('\nEach install is unique')
const other = mkdtempSync(path.join(tmpdir(), 'odyssey-cfg2-'))
electronStub.app.getPath = (k) => (k === 'userData' ? other : path.join(exeDir, 'app.exe'))
reset()
process.env.ODYSSEY_BACKEND = 'local'
const otherEnv = rc.resolveEnv().env
check('a second machine gets a different password', otherEnv.DB_PASSWORD !== first.env.DB_PASSWORD)
check('and a different encryption key', otherEnv.ENCRYPTION_KEY !== first.env.ENCRYPTION_KEY)
electronStub.app.getPath = (k) => (k === 'userData' ? userData : path.join(exeDir, 'app.exe'))

console.log('\nThe real environment always wins')
reset()
process.env.ODYSSEY_BACKEND = 'local'
process.env.DB_HOST = 'db.example.test'
const overridden = rc.resolveEnv().env
check('a developer .env is not clobbered', overridden.DB_HOST === undefined)
delete process.env.DB_HOST

console.log('\nSealing round-trips')
const sealed = rc.seal('a-secret-value')
check('a sealed value comes back', rc.unseal(sealed) === 'a-secret-value')
check('the fallback is labelled honestly', sealed.v === 'plain')
check('rubbish unseals to null rather than throwing', rc.unseal({ v: 'dpapi', d: '!!!' }) === null || rc.unseal({ v: 'dpapi', d: '!!!' }) === '')

Module._load = origLoad
rmSync(userData, { recursive: true, force: true })
rmSync(other, { recursive: true, force: true })
rmSync(exeDir, { recursive: true, force: true })

console.log(failures === 0 ? '\nRuntime config holds.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
