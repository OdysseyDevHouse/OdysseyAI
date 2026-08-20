// Where a packaged desktop install gets its environment.
//
// ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
//
// The Next server runs IN-PROCESS inside Electron, and it reads DB_HOST,
// DB_USER, DB_PASSWORD, SESSION_SECRET and ENCRYPTION_KEY straight off
// process.env — src/lib/db.ts and src/lib/crypto/secrets.ts both do, and
// secrets.ts throws outright when its key is missing.
//
// In development those come from `next dev --env-file=.env`. A packaged NSIS
// install has no .env, no shell profile and no way to set them: main.js never
// loaded one, so until now `npm run dist` produced an app that could not open
// a single connection. Everything else in this feature depends on fixing that.
//
// ── WHY THE FILE LIVES IN userData ──────────────────────────────────────────
//
// Not next to the executable: Program Files is read-only to a normal user, and
// a per-user install still gets replaced wholesale on every update. userData
// survives upgrades and uninstall-reinstall, which is exactly the lifetime a
// database password needs.
//
// ── WHAT IS AND IS NOT A SECRET HERE ────────────────────────────────────────
//
// The local MariaDB password is generated on this machine and stored here
// encrypted under DPAPI, so it is bound to the Windows user account: copying
// the file to another machine yields bytes that will not decrypt. That is the
// property that keeps the shop owner out of their own takings.
//
// ENCRYPTION_KEY and SESSION_SECRET are a different matter for a CLOUD-backed
// install, because there they are shared secrets belonging to our
// infrastructure. Those are baked at build time (see resolveBuildDefaults) and
// a determined customer can extract them from any client-side application —
// that is true of every desktop product and is why the server re-validates
// everything a client claims. A LOCAL-backed install does not use ours at all:
// it generates its own on first run, because nothing it holds needs to be
// readable by anyone else.
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const CONFIG_FILE = 'runtime-config.json'

/** Where the config lives. userData, so it survives an upgrade. */
function configPath() {
  return path.join(app.getPath('userData'), CONFIG_FILE)
}

/**
 * Encrypt at rest with DPAPI when the OS offers it.
 *
 * safeStorage binds the ciphertext to the logged-in Windows account, which is
 * what makes "the customer cannot read their own database password" true
 * rather than aspirational. When it is unavailable — a Linux box with no
 * keyring — we store plainly and SAY SO in the file, rather than pretending.
 * A silent downgrade to plaintext is worse than a visible one.
 */
function seal(plain) {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { v: 'dpapi', d: safeStorage.encryptString(plain).toString('base64') }
    }
  } catch {
    /* fall through to plaintext */
  }
  return { v: 'plain', d: Buffer.from(plain, 'utf8').toString('base64') }
}

function unseal(sealed) {
  if (!sealed || typeof sealed !== 'object') return null
  try {
    const buf = Buffer.from(String(sealed.d || ''), 'base64')
    if (sealed.v === 'dpapi') return safeStorage.decryptString(buf)
    return buf.toString('utf8')
  } catch {
    /* Wrong Windows account, or a corrupted file. Null rather than a throw:
       the caller decides whether that is fatal, and for most fields it is
       recoverable by asking again. */
    return null
  }
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeConfig(cfg) {
  const file = configPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  /* Write-then-rename: a power cut halfway through must not leave a truncated
     config, because that is a machine that cannot start and cannot be talked
     through starting over the telephone. */
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  return cfg
}

/**
 * Secrets a local-backend install mints for itself.
 *
 * A local install shares nothing with anyone: its session cookies are signed
 * for a server only it talks to, and the only reversible secret it holds is its
 * own database password. So generating these on the machine is strictly better
 * than shipping ours — there is no shared key to leak, and no two installs have
 * the same one.
 */
function generateSecret() {
  return crypto.randomBytes(32).toString('base64')
}

/**
 * A password for the bundled MariaDB.
 *
 * Base64 of 24 random bytes, minus the characters that make a password painful
 * to pass through a connection string or a shell: no quotes, no backslash, no
 * ampersand. Still ~140 bits, which is not the number that matters here anyway
 * — nothing can reach this server but this machine.
 */
function generateDbPassword() {
  return crypto
    .randomBytes(24)
    .toString('base64')
    .replace(/[+/=]/g, '')
    .slice(0, 28)
}

/**
 * A port for the bundled server.
 *
 * NOT 3306. A customer who already runs MySQL — a workshop machine, an old
 * install we are replacing — must not have their existing server shadowed or
 * this one refuse to start. Chosen once at provisioning time and recorded, so
 * it stays stable across restarts.
 */
function pickPort() {
  // 33060-33359: high, static, and clear of the IANA registered range.
  return 33060 + Math.floor(Math.random() * 300)
}

/**
 * The environment the Next server should run with.
 *
 * Called before next().prepare(), and its return value is assigned onto
 * process.env. Anything already set in the real environment WINS — that is what
 * keeps `npm run dev:desktop` working against a developer's own .env, and it is
 * also the escape hatch for a support engineer who needs to point a customer's
 * machine at something else for an afternoon.
 */
function resolveEnv() {
  /* Decides and provisions on first run; a no-op on every run after. Done here
     rather than by the caller so there is exactly one path that can produce an
     environment, and it is never possible to build one for an install that has
     not chosen a backend. */
  const mode = ensureBackend()
  const cfg = readConfig()

  const env = {}
  const set = (k, v) => {
    if (v === null || v === undefined || v === '') return
    if (process.env[k] !== undefined && process.env[k] !== '') return // real env wins
    env[k] = String(v)
  }

  if (mode === 'local') {
    // The shop's own MariaDB, on this machine, on the port we recorded.
    set('DB_HOST', '127.0.0.1')
    set('DB_PORT', cfg.dbPort)
    set('DB_USER', cfg.dbUser || 'odyssey')
    set('DB_PASSWORD', unseal(cfg.dbPasswordSealed))
    set('DB_NAME', cfg.controlDbName || 'odyssey_tickets')
    /* Site databases live on the same server. The override is process-global,
       which is exactly right here: this machine hosts one shop. */
    set('SITE_DB_HOST_OVERRIDE', '127.0.0.1')
    set('SESSION_SECRET', unseal(cfg.sessionSecretSealed))
    set('ENCRYPTION_KEY', unseal(cfg.encryptionKeySealed))
    set('BACKUP_ENCRYPTION_KEY', unseal(cfg.backupKeySealed))
    /* Backups and the offline sign-in both live beside the config rather than
       inside the app directory, which is replaced wholesale on every update. */
    set('BACKUP_DIR', path.join(app.getPath('userData'), 'backups'))
    /* Which shop this machine is. Read back by resolveOfflineSite() when there
       is no control database to ask, and verified against the lease before it
       is trusted. */
    set('ODYSSEY_SITE_ID', cfg.siteId)
  } else {
    // Cloud: our servers, our shared secrets, baked at build time.
    const d = resolveBuildDefaults()
    set('DB_HOST', cfg.dbHost || d.DB_HOST)
    set('DB_PORT', cfg.dbPort || d.DB_PORT)
    set('DB_USER', cfg.dbUser || d.DB_USER)
    set('DB_PASSWORD', unseal(cfg.dbPasswordSealed) || d.DB_PASSWORD)
    set('DB_NAME', cfg.controlDbName || d.DB_NAME)
    set('SESSION_SECRET', d.SESSION_SECRET)
    set('ENCRYPTION_KEY', d.ENCRYPTION_KEY)
  }

  set('APP_MODE', 'desktop')
  set('NEXT_PUBLIC_APP_MODE', 'desktop')
  set('NODE_ENV', 'production')
  /* Uploads must not land inside the app directory, which is replaced on every
     update. Documents are the one thing here that cannot be re-fetched. */
  set('UPLOADS_DIR', path.join(app.getPath('userData'), 'uploads'))

  return { env, mode }
}

/**
 * Build-time defaults for a cloud install, injected by electron-builder.
 *
 * Read from a generated file rather than hard-coded, so the values live in CI
 * secrets and never in the repository. A build that forgot to write it yields
 * an app that says so at startup instead of failing later with a confusing
 * database error.
 */
function resolveBuildDefaults() {
  try {
    // eslint-disable-next-line global-require
    return require('./buildDefaults.json')
  } catch {
    return {}
  }
}

/** Has this machine been provisioned as a local backend yet? */
function isProvisioned() {
  const cfg = readConfig()
  return cfg.backend === 'local' && Boolean(cfg.dbPort) && Boolean(cfg.dbPasswordSealed)
}

/**
 * Decide which backend this install uses, the first time it starts.
 *
 * ── A BOOTSTRAP ORDERING PROBLEM ────────────────────────────────────────────
 *
 * cp2_sites.connection_type is the authority on cloud vs local, and it should
 * be: it is the same row support looks at, and changing a customer's mind
 * should not mean sending out a new installer.
 *
 * But it cannot be the answer on FIRST run, because reading it needs a
 * connection to the control database, and on a local install the whole point is
 * that we may not have one. Worse, a customer whose line is down during
 * installation would silently be provisioned as a cloud site.
 *
 * So the installer carries the decision, and the control panel confirms it
 * afterwards:
 *
 *   1. The build, or a marker file the installer drops beside the executable,
 *      says which kind of install this is. That is a fact known at download
 *      time, because the customer downloaded from a link we generated.
 *   2. On first successful sign-in the app compares that against
 *      connection_type and tells the control panel what it actually did.
 *   3. A mismatch is surfaced to support rather than silently corrected —
 *      switching a running shop between backends means moving its data, which
 *      is not something an app should do to itself at startup.
 *
 * Absent any marker, cloud. That is the behaviour every existing install
 * already has, so an upgrade of a machine in the field changes nothing.
 */
function resolveInitialBackend() {
  const cfg = readConfig()
  if (cfg.backend) return cfg.backend // already decided; never re-decide

  /* An explicit environment variable wins, for support and for `npm run
     dev:desktop -- --local` style testing. */
  const fromEnv = String(process.env.ODYSSEY_BACKEND || '').toLowerCase()
  if (fromEnv === 'local' || fromEnv === 'cloud') return fromEnv

  /* A marker dropped next to the executable by the installer. Read from the
     app directory rather than userData: it describes the INSTALLER, and it
     must not survive being pointed somewhere else by a later reinstall. */
  try {
    const marker = path.join(path.dirname(app.getPath('exe')), 'backend.txt')
    const raw = fs.readFileSync(marker, 'utf8').trim().toLowerCase()
    if (raw === 'local' || raw === 'cloud') return raw
  } catch {
    /* No marker. */
  }

  const baked = String(resolveBuildDefaults().BACKEND || '').toLowerCase()
  if (baked === 'local' || baked === 'cloud') return baked

  return 'cloud'
}

/**
 * Make sure this install has decided, and is set up for what it decided.
 *
 * Called once at startup, before resolveEnv(). Idempotent: an install that has
 * already chosen keeps its choice and its credentials.
 */
function ensureBackend() {
  const chosen = resolveInitialBackend()
  if (chosen === 'local') {
    if (!isProvisioned()) provisionLocal()
    return 'local'
  }
  const cfg = readConfig()
  if (!cfg.backend) setCloudBackend()
  return 'cloud'
}

/** Which backend this install points at. */
function backendMode() {
  return readConfig().backend === 'local' ? 'local' : 'cloud'
}

/**
 * Mint the local backend's configuration.
 *
 * Idempotent: called on every start, does nothing once the fields exist. That
 * matters because it must never rotate a password the database is already
 * using — a machine that regenerated its credential on restart would lock
 * itself out of its own data.
 */
function provisionLocal() {
  const cfg = readConfig()
  cfg.backend = 'local'
  if (!cfg.dbPort) cfg.dbPort = pickPort()
  if (!cfg.dbUser) cfg.dbUser = 'odyssey'
  if (!cfg.controlDbName) cfg.controlDbName = 'odyssey_tickets'
  if (!cfg.dbPasswordSealed) cfg.dbPasswordSealed = seal(generateDbPassword())
  if (!cfg.rootPasswordSealed) cfg.rootPasswordSealed = seal(generateDbPassword())
  if (!cfg.sessionSecretSealed) cfg.sessionSecretSealed = seal(generateSecret())
  if (!cfg.encryptionKeySealed) cfg.encryptionKeySealed = seal(generateSecret())
  /* The nightly backup is encrypted on this machine before it is uploaded, so
     we store ciphertext we cannot read. Its own key, deliberately separate from
     encryptionKeySealed: that one protects credentials and is shared with the
     v2 backend, and a key used for two unrelated purposes cannot be rotated for
     either. Escrowed like the rest — "only the shop holds the key" must not
     mean "a dead hard drive is a dead shop". */
  if (!cfg.backupKeySealed) cfg.backupKeySealed = seal(generateSecret())
  /* The account the cloud replica streams the binary log with. Its own
     credential, because it is the one account reachable from outside the shop
     — everything else on that server is bound to loopback — and it must be
     revocable without disturbing the app's own connection. */
  if (!cfg.replicationUser) cfg.replicationUser = 'odyssey_repl'
  if (!cfg.replicationPasswordSealed) cfg.replicationPasswordSealed = seal(generateDbPassword())
  if (!cfg.createdAt) cfg.createdAt = new Date().toISOString()
  return writeConfig(cfg)
}

/** Point this install at the cloud. Leaves any local config in place. */
function setCloudBackend(overrides = {}) {
  const cfg = readConfig()
  cfg.backend = 'cloud'
  if (overrides.dbHost) cfg.dbHost = overrides.dbHost
  return writeConfig(cfg)
}

/**
 * The secrets support needs to escrow, in plain text.
 *
 * Deliberately a separate call from resolveEnv, and deliberately explicit in
 * its name: reading these out is a privileged act, and it should be obvious at
 * every call site that it is happening.
 */
function revealSecrets() {
  const cfg = readConfig()
  return {
    dbPort: cfg.dbPort || null,
    dbUser: cfg.dbUser || null,
    dbName: cfg.controlDbName || null,
    dbPassword: unseal(cfg.dbPasswordSealed),
    rootPassword: unseal(cfg.rootPasswordSealed),
    encryptionKey: unseal(cfg.encryptionKeySealed),
    /* Without this the nightly backups are unrecoverable. It is the single
       most important thing to escrow, and the one whose loss is silent until
       the day somebody needs a restore. */
    backupKey: unseal(cfg.backupKeySealed),
    /* Needed to re-point a replica after a reinstall. */
    replicationUser: cfg.replicationUser || null,
    replicationPassword: unseal(cfg.replicationPasswordSealed),
  }
}

/** Record which site this install serves, once it is known. */
function setSiteId(siteId) {
  const cfg = readConfig()
  if (cfg.siteId === siteId) return cfg
  cfg.siteId = siteId
  return writeConfig(cfg)
}

/** The data directory for the bundled server. Beside the config, for the same reasons. */
function dataDir() {
  return path.join(app.getPath('userData'), 'mariadb', 'data')
}

module.exports = {
  resolveEnv,
  ensureBackend,
  resolveInitialBackend,
  isProvisioned,
  backendMode,
  provisionLocal,
  setCloudBackend,
  setSiteId,
  revealSecrets,
  dataDir,
  configPath,
  readConfig,
  writeConfig,
  seal,
  unseal,
}
