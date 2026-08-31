// MariaDB as a Windows service, owned by the machine rather than by an app.
//
// ── WHY A SERVICE AND NOT A CHILD PROCESS ───────────────────────────────────
//
// The original local backend started mariadbd as a child of the Back Office.
// That is coherent while ONE app owns the database, and it fails the moment two
// do: OdysseyAI Database Setup installs the server, the Back Office runs the shop,
// and a database that is a child of one of them stops existing when somebody
// closes a window.
//
// It is also wrong for the shop. A till rung up at 07:00 should not depend on
// whether anybody has opened the back office yet, and a database that only runs
// while a window is open is a database that goes down when a cashier tidies
// their taskbar.
//
// So the server belongs to the MACHINE: installed once, started at boot, and
// outliving every app that talks to it.
//
// ── WHY NOTHING LIVES IN A USER'S APPDATA ───────────────────────────────────
//
// A Windows service runs as LocalSystem, which cannot reliably read a user's
// AppData — and even where it can, the technician provisions under their login
// and the shop trades under the owner's. So everything here is machine-level,
// split across two directories with two different lifetimes:
//
//   Program Files\Odyssey\MariaDB   the SERVER. Immutable, replaced wholesale
//                                   on an upgrade, read-only to a normal user.
//   ProgramData\Odyssey\mariadb     the SHOP. The data directory and my.ini —
//                                   mutable, irreplaceable, and never removed
//                                   by anything, including an uninstall.
//
// That split is the safety property this design turns on: the left-hand side
// can be thrown away and reinstalled without going near the right.
//
// ── WHAT THIS NEEDS THAT NOTHING ELSE HERE DOES ─────────────────────────────
//
// Administrator rights. Registering a service is a machine-level act and
// Windows will not let a normal user do it. OdysseyAI Database Setup asks for
// elevation when it launches — it is an installer, and installers may — while
// the Back Office never does and never needs to, because it only connects.
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { EOL } = require('node:os')

/** One name, so a technician looking at services.msc knows what they found. */
const SERVICE_NAME = 'OdysseyMariaDB'
const DISPLAY_NAME = 'Odyssey Database'

/**
 * ── TWO DIRECTORIES, BECAUSE THEY HAVE DIFFERENT LIFETIMES ──────────────────
 *
 * Program Files holds the SERVER: binaries, which are immutable, replaceable on
 * an upgrade, and read-only to a normal user. ProgramData holds the SHOP: the
 * data directory and the config, which are mutable, irreplaceable, and must
 * survive everything — including an upgrade that replaces every binary.
 *
 * That separation is the Windows convention and it is also the safety property
 * this whole design turns on: you can throw away and reinstall the left-hand
 * side without ever going near the right.
 *
 * Deliberately NOT `C:\Program Files\MariaDB 11.4`, which is where the official
 * MariaDB installer puts itself. Squatting there would collide with a shop that
 * already runs MariaDB, imply to an administrator that this is a general-purpose
 * install they may upgrade independently, and put a version number in a path we
 * would then have to rename on every upgrade.
 */
function serverDir() {
  const root =
    process.platform === 'win32'
      ? process.env.ProgramFiles || 'C:\\Program Files'
      : '/usr/local/lib'
  return path.join(root, 'Odyssey', 'MariaDB')
}

/** The shop's own data. Never removed, by anything — see writeWarning(). */
function baseDir() {
  const root =
    process.platform === 'win32' ? process.env.ProgramData || 'C:\\ProgramData' : '/usr/local/share'
  return path.join(root, 'Odyssey', 'mariadb')
}

const binDir = () => path.join(serverDir(), 'bin')
const dataDir = () => path.join(baseDir(), 'data')
const configPath = () => path.join(baseDir(), 'my.ini')
const exe = (name) => path.join(binDir(), process.platform === 'win32' ? `${name}.exe` : name)

/** Are the binaries in place on this machine? */
function isInstalled() {
  return fs.existsSync(exe('mariadbd'))
}

/** Has the data directory been initialised? Never re-initialise a live one. */
function isInitialised() {
  try {
    return fs.existsSync(path.join(dataDir(), 'mysql'))
  } catch {
    return false
  }
}

function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message).trim()
        reject(new Error(detail || err.message))
        return
      }
      resolve(String(stdout || ''))
    })
  })
}

/** Is this process running with administrator rights? */
async function isElevated() {
  if (process.platform !== 'win32') return process.getuid?.() === 0
  try {
    /* `net session` is refused to a non-elevated caller and is present on every
       Windows since forever — cheaper and more reliable than probing a registry
       key we would then have to clean up. */
    await run('net', ['session'])
    return true
  } catch {
    return false
  }
}

/**
 * Put the server binaries where the machine can reach them.
 *
 * Copied rather than referenced in place: OdysseyAI Database Setup can be
 * uninstalled — it is a one-shot tool — and a service pointing into the folder
 * of an uninstalled application is a database that disappears on a tidy-up.
 */
async function installBinaries(sourceDir, onProgress) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`This build shipped without a database server (looked in ${sourceDir}).`)
  }
  if (isInstalled()) {
    onProgress?.('Database server already installed on this machine.')
    return serverDir()
  }
  onProgress?.('Copying the database server…')
  fs.mkdirSync(serverDir(), { recursive: true })
  fs.cpSync(sourceDir, serverDir(), { recursive: true })
  if (!isInstalled()) {
    throw new Error('The database server did not copy correctly.')
  }
  return serverDir()
}

/**
 * The server's configuration, written once and owned by the service.
 *
 * Everything here was previously passed as command-line arguments by
 * localDb.start(). A service has no command line to speak of — it is registered
 * with a defaults-file and reads the rest from there — so the same decisions
 * move into the file, with the same reasons.
 */
function writeConfig({ port, lan = false }) {
  const bind = lan ? '0.0.0.0' : '127.0.0.1'
  const ini = `# Written by OdysseyAI Database Setup. Edited by hand at your own risk:
# Setup rewrites this file when it is re-run.
[mysqld]
datadir=${dataDir().replace(/\\/g, '/')}
port=${port}
# Loopback for a shop that serves itself; the LAN only when a hybrid box has to
# answer the tills in the building.
bind-address=${bind}
skip-name-resolve

# A counter PC, not a server. Modest and predictable.
innodb-buffer-pool-size=256M
max-connections=64

character-set-server=utf8mb4
collation-server=utf8mb4_unicode_ci
# The app's pools set timezone 'Z' per connection; the server agrees, so a
# DATETIME written by a migration matches one written by the app.
default-time-zone=+00:00
`
  fs.mkdirSync(baseDir(), { recursive: true })
  fs.writeFileSync(configPath(), ini, 'utf8')
  writeWarning()
  return configPath()
}

/**
 * A note for whoever finds this folder and wonders whether it matters.
 *
 * Uninstalling Odyssey does not remove any of this, deliberately — a technician
 * uninstalling to apply an update must find the shop exactly as they left it.
 * The corollary is that somebody eventually finds a large unexplained directory
 * on a machine they are tidying up, and decides for themselves.
 *
 * So it explains itself, in the place they will be standing when they decide.
 */
function writeWarning() {
  const text = [
    'ODYSSEY DATABASE — DO NOT DELETE',
    '',
    'This folder holds the shop’s live trading data: sales, stock, customers,',
    'accounts. It is the only copy on this machine.',
    '',
    'Deleting it destroys the shop’s records. It cannot be undone from here,',
    'and uninstalling or reinstalling Odyssey will not bring it back.',
    '',
    'It is kept OUTSIDE the Odyssey program folders on purpose, so that',
    'uninstalling Odyssey — to install a newer version, for example — leaves the',
    'shop’s data untouched.',
    '',
    'Served by the Windows service "' + SERVICE_NAME + '".',
    '',
    'If this machine genuinely needs to be cleared, contact Odyssey support',
    'first. There is a supported way to do it, and this is not it.',
    '',
  ].join(EOL)
  try {
    fs.writeFileSync(path.join(baseDir(), 'DO-NOT-DELETE.txt'), text, 'utf8')
  } catch {
    /* A warning that could not be written must not stop a database being
       installed. The protection that matters is where the folder LIVES. */
  }
}

/** Initialise the data directory. Once, ever, on a machine that has none. */
async function initialise(onProgress) {
  if (isInitialised()) {
    onProgress?.('Database directory already exists — leaving it alone.')
    return
  }
  onProgress?.('Preparing the database for the first time…')
  fs.mkdirSync(dataDir(), { recursive: true })
  await run(exe('mariadb-install-db'), [`--datadir=${dataDir()}`])
  if (!isInitialised()) {
    throw new Error('The database directory was not created.')
  }
}

/** 'running' | 'stopped' | 'absent' */
async function status() {
  try {
    const out = await run('sc', ['query', SERVICE_NAME])
    if (/RUNNING/i.test(out)) return 'running'
    return 'stopped'
  } catch {
    return 'absent'
  }
}

/**
 * Register the service.
 *
 * mariadbd installs itself, rather than us calling `sc create`: it knows the
 * argument form it wants to be started with, and a hand-built command line is
 * one more thing to get subtly wrong.
 */
async function install(onProgress) {
  if ((await status()) !== 'absent') {
    onProgress?.('Database service already registered.')
    return
  }
  onProgress?.('Registering the database service…')
  await run(exe('mariadbd'), ['--install', SERVICE_NAME, `--defaults-file=${configPath()}`])

  /* Start at boot, so the shop opens without anybody opening an app first, and
     restart on failure rather than leaving the till dead until somebody
     notices. Both are `sc` because mariadbd does not set them. */
  await run('sc', ['config', SERVICE_NAME, 'start=', 'auto', 'DisplayName=', DISPLAY_NAME]).catch(
    () => {},
  )
  await run('sc', ['failure', SERVICE_NAME, 'reset=', '86400', 'actions=', 'restart/5000/restart/10000/restart/30000']).catch(
    () => {},
  )
}

async function startService(onProgress) {
  const state = await status()
  if (state === 'running') {
    onProgress?.('Database service already running.')
    return
  }
  if (state === 'absent') throw new Error('The database service is not registered.')
  onProgress?.('Starting the database service…')
  await run('sc', ['start', SERVICE_NAME])
}

async function stopService() {
  if ((await status()) !== 'running') return
  await run('sc', ['stop', SERVICE_NAME]).catch(() => {})
}

/** Wait for the port to answer, so callers do not race the service's startup. */
function waitForPort(port, timeoutMs = 60000) {
  const net = require('node:net')
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.destroy()
        resolve()
      })
      socket.on('error', () => {
        socket.destroy()
        if (Date.now() > deadline) reject(new Error(`The database did not answer on port ${port}.`))
        else setTimeout(attempt, 400)
      })
    }
    attempt()
  })
}

module.exports = {
  SERVICE_NAME,
  serverDir,
  baseDir,
  binDir,
  dataDir,
  configPath,
  exe,
  isInstalled,
  isInitialised,
  isElevated,
  installBinaries,
  writeConfig,
  initialise,
  status,
  install,
  startService,
  stopService,
  waitForPort,
  run,
}
