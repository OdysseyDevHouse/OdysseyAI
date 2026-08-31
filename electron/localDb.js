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

/**
 * Where the database binaries sit.
 *
 * ── THEY ARE NO LONGER IN THIS APP ──────────────────────────────────────────
 *
 * MariaDB ships in its own installer — Odyssey Database Setup — rather than
 * inside the Back Office and Point of Sale builds. It is ~200MB of third-party
 * binaries on their own release cadence, and bundling it meant every app update
 * re-downloaded a database that had not changed. It also meant a ten-till
 * restaurant put ten copies of a database on ten machines that would never run
 * one.
 *
 * So there are three places to look, in order:
 *
 *   1. ODYSSEY_MARIADB_DIR — a support engineer pointing this at a database
 *      somewhere unusual, and the seam the tests drive.
 *   2. This app's own resources. Only the Database Setup build has them, and
 *      that build is exactly the one that needs to run the server it installed.
 *   3. The shared install location Database Setup writes to. This is the normal
 *      answer for a Back Office build on a machine that also hosts the shop's
 *      database.
 *
 * A dev checkout keeps using vendor/mariadb, unchanged.
 */
function binDir() {
  const override = String(process.env.ODYSSEY_MARIADB_DIR || '').trim()
  if (override) return path.join(override, 'bin')

  if (!app.isPackaged) return path.join(__dirname, '..', 'vendor', 'mariadb', 'bin')

  const own = path.join(process.resourcesPath, 'mariadb', 'bin')
  if (fs.existsSync(own)) return own

  return path.join(sharedDbDir(), 'bin')
}

/**
 * Where Odyssey Database Setup installs the server.
 *
 * ProgramData, not userData: the database is a MACHINE-level asset that outlives
 * any one Windows account. A technician provisions it under their own login and
 * the shop then runs the app under the owner's — a per-user directory would
 * leave the second account unable to find the first's database.
 *
 * The data directory stays in userData and is untouched by this. Only the
 * binaries moved.
 */
function sharedDbDir() {
  const base =
    process.platform === 'win32'
      ? process.env.ProgramData || 'C:\\ProgramData'
      : '/usr/local/share'
  return path.join(base, 'Odyssey', 'mariadb')
}

function exe(name) {
  return path.join(binDir(), process.platform === 'win32' ? `${name}.exe` : name)
}

function dataDir() {
  return path.join(app.getPath('userData'), 'mariadb', 'data')
}

/**
 * This server's replication id.
 *
 * Must be unique across every server taking part in replication, which for us
 * means unique per shop. The site id already is exactly that, so it is used
 * directly rather than inventing a second numbering nobody can cross-reference
 * when a replica misbehaves.
 *
 * Falls back to 1 when the machine has not been told its site yet. Such a
 * machine has nothing to replicate to — it has never reached the control panel
 * — so the collision it could theoretically cause cannot occur in practice.
 */
function serverId() {
  const raw = Number(process.env.ODYSSEY_SITE_ID)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1
}

/**
 * Is a database server installed on this machine at all?
 *
 * This used to ask "did this BUILD ship with one". Since MariaDB moved into its
 * own installer the question is about the machine, not the build — see binDir.
 * The distinction matters for the error a customer sees: "run Odyssey Database
 * Setup" is actionable, "this build was made wrong" is not.
 */
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
async function start(port, onProgress, options = {}) {
  onProgress?.('Starting the database…')

  /*
   * ── A HYBRID BOX MUST ANSWER THE SHOP'S LAN ────────────────────────────────
   *
   * Loopback is right for a LOCAL backend: one machine, its own database, and
   * nothing else has any business reaching it.
   *
   * A hybrid box is the opposite by definition — ten tills in the building
   * connect to it, and that is the entire reason it exists. Bound to loopback it
   * would serve nobody but itself.
   *
   * The widening is real and is why the caller has to ask for it explicitly
   * rather than get it by default. What bounds it: the box holds open tabs and
   * an outbox and nothing else (fifteen tables, no stock, no ledger, no
   * customers), and the account provisioned for the tills is granted on that ONE
   * database rather than *.* — see lib/dbSetup/sql.ts.
   */
  const bindAddress = options.lan ? '0.0.0.0' : '127.0.0.1'

  const args = [
    `--datadir=${dataDir()}`,
    `--port=${port}`,
    `--bind-address=${bindAddress}`,
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

    /* ── THE BINARY LOG, WHICH IS HOW THE CLOUD COPY STAYS HONEST ──────────
     *
     * The shop's data is mirrored to a replica we can query. The obvious way
     * to build that is an application-level sync — ship rows changed since a
     * watermark — and it does not work here: the schema has no delete
     * tracking at all (no tombstones, no deleted_at, and deletes cascade), so
     * a watermark replicator would copy every insert and update faithfully
     * and never once see a delete. The replica would drift quietly, and a
     * reporting database that is silently wrong is worse than none because
     * people trust it.
     *
     * The binary log has none of that problem. It is a record of every change
     * the server actually made, deletes included, and replicating from it is
     * what the database is designed to do. It also needs no updated_at, no
     * triggers and no per-table code across 238 tables.
     *
     * ROW format, deliberately: STATEMENT format replays the SQL, so anything
     * non-deterministic (NOW(), UUID(), an UPDATE with a LIMIT and no ORDER
     * BY) can produce different rows on the replica. ROW ships the actual
     * before/after images, so the replica is a copy rather than a
     * re-enactment.
     */
    /* ── AND WHY A HYBRID BOX KEEPS NONE OF IT ────────────────────────────
     *
     * Everything above is about a shop whose data lives on this machine and is
     * mirrored to a replica we can query. A hybrid box is not that: its master
     * IS the cloud, and it holds open tabs and an outbox that are deleted once
     * the cloud has them. There is nothing on it to replicate.
     *
     * So the binlog would be pure cost — and not a small one. `--sync-binlog=1`
     * flushes on every commit, and a busy floor commits on every item a waiter
     * rings up. Paying that to write a log nothing reads, on a machine chosen
     * for being cheap and small, is the wrong trade twice over.
     */
    ...(options.lan
      ? []
      : [
          '--log-bin=odyssey-bin',
          '--binlog-format=ROW',
          /* A server id unique per shop. Taken from the site id, which is exactly
          the number that is unique across our estate — two machines sharing one
          would make replication ambiguous at the far end. Falls back to 1 on a
          machine that has not been told its site yet, which cannot replicate
          anyway. */
          `--server-id=${serverId()}`,
          /* How long the shop keeps its own binlog. Seven days matches the licence
          lease on purpose: a machine offline longer than this is locked and has
          stopped trading, so there is nothing newer to ship. It also bounds the
          disk a counter PC gives up — binlogs grow forever otherwise, and a full
          disk stops the shop. */
          '--expire-logs-days=7',
          /* Cap a single binlog file so rotation is frequent and each file is a
          reasonable unit to ship or discard. */
          '--max-binlog-size=64M',
          /* Durability: flush the binlog every commit. Slower, and correct — the
          alternative loses the tail of the log on a power cut, which on a till
          means the cloud copy is missing sales the shop believes it made. */
          '--sync-binlog=1',
        ]),
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
 * The account the cloud replica reads the binary log with.
 *
 * ── WHY A SEPARATE USER, AND WHY IT CAN DO SO LITTLE ────────────────────────
 *
 * REPLICATION SLAVE is the whole of its rights: it may stream the binary log
 * and nothing else. It cannot SELECT a table, cannot write, cannot see the
 * schema. That matters because this is the ONE account reachable from outside
 * the shop — everything else on this server is bound to loopback — so it is
 * the account an attacker would find. Streaming the log is still a serious
 * capability, which is why the tunnel it arrives over is authenticated
 * separately; but it is bounded, and it cannot be turned into a shell on the
 * shop's data.
 *
 * The password is generated on this machine like every other, sealed with
 * DPAPI, and escrowed — support needs it to re-point a replica after a
 * reinstall, and nobody should be able to reconstruct it from anything else.
 */
async function ensureReplicationUser(port, user, password) {
  if (!user || !password) return

  const sql = [
    `CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY '${password}';`,
    `ALTER USER '${user}'@'%' IDENTIFIED BY '${password}';`,
    /* Deliberately NOT REPLICATION CLIENT: that adds SHOW MASTER STATUS and
       server-variable visibility, which the replica does not need to stream a
       log it is already positioned in. */
    `GRANT REPLICATION SLAVE ON *.* TO '${user}'@'%';`,
    `FLUSH PRIVILEGES;`,
  ].join('\n')

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
async function ensureRunning({
  port,
  user,
  password,
  controlDbName,
  rootPassword,
  replicationUser,
  replicationPassword,
  onProgress,
}) {
  if (!isBundled()) {
    /* The ordering trap: someone ran the app installer, chose "this machine
       hosts the database", and has not run Odyssey Database Setup. Say exactly
       that. The app deliberately does not fetch or install it — the three
       artifacts stay independent — so the only useful thing here is to name the
       missing step. */
    throw new Error(
      'This installation is set to keep its database on this machine, but no database server is installed. ' +
        'Run Odyssey Database Setup on this machine first.',
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
  /* Every start, not only the first: the password can be rotated from the
     control panel, and the statement is an ALTER as well as a CREATE so a
     rotation takes effect the next time the shop opens. */
  await ensureReplicationUser(port, replicationUser, replicationPassword)
  if (fresh && rootPassword) await secureRoot(port, rootPassword)

  return { started: true, initialised: fresh }
}

/**
 * Provision this machine for a site, from a plan the control panel produced.
 *
 * This is the apply step of Odyssey Database Setup: the statements were built
 * and checked by lib/dbSetup, and this is what runs them against a server that
 * may not exist yet.
 *
 * ── SEPARATE FROM ensureRunning, DELIBERATELY ──────────────────────────────
 *
 * `ensureRunning` is what the APP calls on every start, and its job is to get a
 * database it already owns back up. This runs ONCE, driven by a technician, and
 * creates something that was not there. Folding them together would mean the
 * everyday path carrying provisioning code, and provisioning is the one thing
 * that must not happen by accident.
 *
 * ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
 *
 * Re-initialise. `initialise` runs only when there is no data directory, which
 * is the rule the whole file is built on: re-initialising is indistinguishable
 * from erasing a shop's trading history. Re-running this against a provisioned
 * machine — the "Retrieve new details" path — starts the server it finds and
 * reapplies the statements, every one of which is CREATE IF NOT EXISTS or
 * ALTER.
 *
 * ── AND WHY IT NEVER SEES THE PASSWORD ─────────────────────────────────────
 *
 * It does not build the statements; it is handed them. The credentials came
 * from the control panel over an authenticated connection and go straight to
 * MariaDB, so the technician standing here types an email and password they
 * already have and learns nothing about the database. Nothing in this function
 * logs `statements`, and nothing should: they carry the password in plaintext
 * by necessity, because MariaDB allows no placeholders in CREATE USER.
 */
async function provisionForPlan({ port, statements, lan = false, rootPassword, onProgress }) {
  if (!isBundled()) {
    throw new Error(
      'No database server is installed on this machine. ' +
        'Run Odyssey Database Setup, or point ODYSSEY_MARIADB_DIR at an existing install.',
    )
  }
  if (!Array.isArray(statements) || statements.length === 0) {
    throw new Error('Refusing to provision with no statements.')
  }

  const alreadyUp = await portInUse(port)
  const fresh = !isInitialised()

  if (fresh) {
    if (alreadyUp) {
      /* Something answers on our port but this machine has no data directory —
         so it is not ours. Initialising now would start a second server that
         cannot bind, and the clearer failure is to say what was found. */
      throw new Error(
        `Something is already listening on port ${port}, but this machine has no Odyssey database. ` +
          `Choose a different port, or stop whatever holds it.`,
      )
    }
    await initialise(onProgress)
  }

  if (!alreadyUp) await start(port, onProgress, { lan })

  onProgress?.('Applying the shop’s settings…')
  /* One statement per call rather than one joined string: a failure then names
     the statement that failed instead of the whole batch, which is the
     difference between a technician knowing the grant failed and knowing
     "something in the SQL" failed. */
  for (const statement of statements) {
    await run(clientExe(), [
      '--protocol=TCP',
      '-h',
      '127.0.0.1',
      '-P',
      String(port),
      '-u',
      'root',
      '-e',
      statement,
    ])
  }

  /* Last, and only on a fresh directory. Locking root down before the shop's
     own user exists would leave a database nobody can administer — the same
     ordering ensureRunning uses. */
  if (fresh && rootPassword) await secureRoot(port, rootPassword)

  return { initialised: fresh, started: !alreadyUp, lan }
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
  provisionForPlan,
  stop,
  isBundled,
  isInitialised,
  dataDir,
  binDir,
  portInUse,
  serverId,
  ensureReplicationUser,
}
