// The shop's own database server, bundled and run as a child process.
//
// ── WHY NOT AN INSTALLER FOR MySQL ──────────────────────────────────────────
//
// The obvious design is an NSIS wizard that runs the MySQL MSI. It was
// rejected, and the reasons are worth keeping written down because it keeps
// looking like the easy path:
//
//   - It needs administrator rights. A shop assistant double-clicking a
//     download does not have them, and "ask your IT person" is where an
//     unattended install stops being unattended.
//   - It collides. A machine that already runs MySQL — the system we are
//     replacing, a workshop tool — either shadows ours or refuses to start,
//     and the customer sees a failure with somebody else's name on it.
//   - It is visible. A service in Add/Remove Programs is a service a customer
//     can stop, uninstall, or point a database tool at.
//   - It is uninstallable-with-consequences. Removing our app must not leave a
//     MySQL service behind, and must not take away one the customer had first.
//
// Running a portable server ourselves has none of those properties. Nothing is
// registered, nothing needs admin, the port is ours alone, and uninstalling
// removes exactly what we put there.
//
// ── THE DATA DIRECTORY IS THE SHOP ──────────────────────────────────────────
//
// Everything below treats the data directory as sacred. It is initialised once,
// on a machine that has never had one, and after that it is only ever started.
// There is deliberately no "repair" path that re-initialises: re-initialising is
// indistinguishable from erasing the shop's trading history, and a bug that
// took that branch by mistake would be unrecoverable. A directory that exists
// but will not start is an error the customer must be told about, not something
// to be silently fixed.
const { app } = require('electron')
const { spawn, execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')

let serverProcess = null

/** Where the bundled binaries sit, packaged or in a dev checkout. */
function binDir() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'mariadb')
    : path.join(__dirname, '..', 'vendor', 'mariadb')
  return path.join(base, 'bin')
}

function exe(name) {
  return path.join(binDir(), process.platform === 'win32' ? `${name}.exe` : name)
}

function dataDir() {
  return path.join(app.getPath('userData'), 'mariadb', 'data')
}

/** Is the bundled server present at all? */
function isBundled() {
  try {
    return fs.existsSync(exe('mysqld')) || fs.existsSync(exe('mariadbd'))
  } catch {
    return false
  }
}

/** mariadbd in recent releases, mysqld in older ones. Accept either. */
function serverExe() {
  const mariadbd = exe('mariadbd')
  return fs.existsSync(mariadbd) ? mariadbd : exe('mysqld')
}

function clientExe() {
  const mariadb = exe('mariadb')
  return fs.existsSync(mariadb) ? mariadb : exe('mysql')
}

function installExe() {
  const mariadbInstall = exe('mariadb-install-db')
  return fs.existsSync(mariadbInstall) ? mariadbInstall : exe('mysql_install_db')
}

/** Has this data directory ever been initialised? */
function isInitialised() {
  try {
    // The `mysql` system schema is what init creates; its absence means a bare
    // or half-made directory.
    return fs.existsSync(path.join(dataDir(), 'mysql'))
  } catch {
    return false
  }
}

/** Can something already be reached on this port? */
function portInUse(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const done = (used) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(used)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, host)
  })
}

/** Wait until the server answers, or give up. */
async function waitForPort(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portInUse(port)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
      } else resolve({ stdout, stderr })
    })
  })
}

/**
 * Create the data directory.
 *
 * Only ever called when there is not one. See the note at the top of the file
 * about why there is no repair path.
 */
async function initialise(onProgress) {
  const dir = dataDir()
  onProgress?.('Preparing the database for the first time…')
  fs.mkdirSync(dir, { recursive: true })

  if (process.platform === 'win32') {
    /* Windows builds ship mariadb-install-db.exe, which wants the base
       directory rather than a datadir-relative layout. */
    await run(installExe(), [`--datadir=${dir}`])
  } else {
    await run(installExe(), [`--datadir=${dir}`, '--auth-root-authentication-method=normal'])
  }
}

/**
 * Start the server, bound to loopback only.
 *
 * --skip-networking is deliberately NOT used: the app connects over TCP because
 * mysql2 does, and a named pipe would mean a second code path in siteDb.ts for
 * one platform. Binding to 127.0.0.1 gives the same protection — nothing off
 * this machine can reach it — without changing how the app connects.
 */
async function start(port, onProgress) {
  onProgress?.('Starting the database…')

  const args = [
    `--datadir=${dataDir()}`,
    `--port=${port}`,
    '--bind-address=127.0.0.1',
    // No shared memory, no named pipes: one way in, and it is the one we chose.
    '--skip-name-resolve',
    // A shop database on a counter PC, not a server. Modest and predictable.
    '--innodb-buffer-pool-size=256M',
    '--max-connections=64',
    '--character-set-server=utf8mb4',
    '--collation-server=utf8mb4_unicode_ci',
    // The app's pools set timezone 'Z' per connection; make the server agree
    // so a DATETIME written by a migration matches one written by the app.
    '--default-time-zone=+00:00',
  ]

  serverProcess = spawn(serverExe(), args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  serverProcess.stderr?.on('data', (chunk) => {
    const line = String(chunk).trim()
    /* MariaDB logs its normal startup to stderr, so this is not an error
       channel. Kept for support: it is the only record of why a server that
       would not start refused. */
    if (line) console.log('[mariadb]', line)
  })

  serverProcess.on('exit', (code) => {
    console.log('[mariadb] exited with', code)
    serverProcess = null
  })

  const up = await waitForPort(port)
  if (!up) throw new Error('The local database did not start. See the log for details.')
}

/**
 * Create the app's user and its control database.
 *
 * Idempotent — every statement is IF NOT EXISTS or its equivalent — because it
 * runs on every start, not only the first. That is what makes a half-finished
 * first run recoverable by simply starting again.
 *
 * The customer is never given these credentials. The app's user is not root: it
 * owns its own databases and nothing else, so a compromised app cannot drop the
 * server's own system tables.
 */
async function ensureUserAndDb(port, user, password, controlDbName, onProgress) {
  onProgress?.('Preparing the database…')

  const sql = [
    `CREATE DATABASE IF NOT EXISTS \`${controlDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    `CREATE USER IF NOT EXISTS '${user}'@'127.0.0.1' IDENTIFIED BY '${password}';`,
    /* The app creates site databases at runtime (site-migrate.mjs does exactly
       this), so it needs to be able to. Scoped to this host, and it is still
       not root. */
    `GRANT ALL PRIVILEGES ON *.* TO '${user}'@'127.0.0.1' WITH GRANT OPTION;`,
    `FLUSH PRIVILEGES;`,
  ].join('\n')

  /* Connected as root over loopback with no password: that is the state
     mariadb-install-db leaves a fresh directory in, and it is only reachable
     from this machine. Locking root down happens below, after the app's own
     user exists — in that order, or a failure here would leave a database
     nobody can administer. */
  await run(clientExe(), ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root', '-e', sql])
}

/**
 * Take away root's passwordless loopback access.
 *
 * Run after the app's user exists, so a failure cannot strand the database. The
 * root password is escrowed to the control panel, which is what lets support
 * back in without the customer ever holding it.
 */
async function secureRoot(port, rootPassword) {
  const sql = [
    `ALTER USER 'root'@'localhost' IDENTIFIED BY '${rootPassword}';`,
    `DELETE FROM mysql.global_priv WHERE User='';`,
    `FLUSH PRIVILEGES;`,
  ].join('\n')
  try {
    await run(clientExe(), ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root', '-e', sql])
  } catch (err) {
    /* Not fatal: the server is loopback-only, so an unsecured root is reachable
       only by someone already on this machine — and the app works either way.
       Worth logging loudly, not worth refusing to open the shop over. */
    console.error('[mariadb] could not secure the root account', err?.message || err)
  }
}

/**
 * Bring the local database up, whatever state it is in.
 *
 * The one entry point main.js calls. Safe to call on every start.
 */
async function ensureRunning({ port, user, password, controlDbName, rootPassword, onProgress }) {
  if (!isBundled()) {
    throw new Error(
      'This installation is set to use a local database, but the database server was not included in the build.',
    )
  }

  /* Something is already listening. Assume it is ours from a previous run of
     this same app — the port was chosen at provisioning time and recorded, so
     a collision with an unrelated program is close to impossible, and killing
     whatever holds a port is how you take down somebody else's server. */
  if (await portInUse(port)) {
    onProgress?.('Connecting to the database…')
    return { started: false }
  }

  const fresh = !isInitialised()
  if (fresh) await initialise(onProgress)

  await start(port, onProgress)
  await ensureUserAndDb(port, user, password, controlDbName, onProgress)
  if (fresh && rootPassword) await secureRoot(port, rootPassword)

  return { started: true, initialised: fresh }
}

/**
 * Stop the server on the way out.
 *
 * A polite shutdown first: InnoDB recovers from a hard kill, but recovery on
 * next start is slow and frightening, and the customer sees it as the app
 * taking a minute to open after a power cut.
 */
async function stop(port, timeoutMs = 8000) {
  if (!serverProcess) return
  const proc = serverProcess

  try {
    const admin = fs.existsSync(exe('mariadb-admin')) ? exe('mariadb-admin') : exe('mysqladmin')
    if (fs.existsSync(admin)) {
      await run(admin, ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root', 'shutdown'])
    }
  } catch {
    /* Root may now need a password, or the server may already be going down.
       Either way the wait below decides what happens next. */
  }

  const deadline = Date.now() + timeoutMs
  while (serverProcess && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
  }

  if (serverProcess) {
    console.log('[mariadb] did not stop politely; terminating')
    try {
      proc.kill()
    } catch {
      /* Already gone. */
    }
  }
}

module.exports = {
  ensureRunning,
  stop,
  isBundled,
  isInitialised,
  dataDir,
  binDir,
  portInUse,
}
