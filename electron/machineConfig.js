// What Odyssey Database Setup leaves behind for Odyssey Back Office to find.
//
// ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
//
// The two are separate installers with separate appIds, so they have separate
// userData directories. Setup finishes knowing everything the Back Office needs
// — which shop this machine is, and how to reach the database it just created —
// and has nowhere to put it that the Back Office will look.
//
// ProgramData, for the same reason localDb puts the MariaDB binaries there: the
// technician provisions under their own Windows login and the shop then runs
// the app under the owner's. A per-user directory would leave the second
// account unable to find the first's work.
//
// ── WHY THE PASSWORD IS NOT SEALED HERE ─────────────────────────────────────
//
// safeStorage's DPAPI binds ciphertext to the Windows ACCOUNT that wrote it, so
// a file sealed by the technician is bytes the owner cannot decrypt. That is
// exactly the property that makes it valuable in userData and useless here.
//
// So this is written in the clear, and says so in the file. That is a real
// reduction and worth naming: any account on this machine can read the shop's
// database password. It is bounded — MariaDB listens on 127.0.0.1 only, the
// machine is the shop's own office computer, and the accounts on it belong to
// the people who work there. It follows the precedent runtimeConfig already
// sets: when sealing is not available, store plainly and SAY SO rather than
// pretend.
//
// The Back Office adopts it on first run and seals it into its own per-user
// config. This file stays afterwards, deliberately: a second Windows account on
// the same machine has to be able to do the same adoption.
const fs = require('node:fs')
const path = require('node:path')

const FILE = 'site.json'

/** ProgramData\Odyssey — mirrors localDb.sharedDbDir(). */
function machineDir() {
  const base =
    process.platform === 'win32' ? process.env.ProgramData || 'C:\\ProgramData' : '/usr/local/share'
  return path.join(base, 'Odyssey')
}

function configPath() {
  return path.join(machineDir(), FILE)
}

/**
 * What Setup knows and the Back Office needs.
 *
 * Everything required to reach the shop's own database WITHOUT asking the
 * control panel — which is the whole point, because a local site must open on a
 * morning when the line is down.
 */
function write({ siteId, siteCode, host, port, databaseName, username, password }) {
  fs.mkdirSync(machineDir(), { recursive: true })
  const body = {
    /* A note to whoever finds this file, rather than a comment in code they
       will never read. */
    _note:
      'Written by Odyssey Database Setup so Odyssey Back Office on this machine can reach the ' +
      'shop database. Not encrypted: it has to be readable by a different Windows account than ' +
      'the one that wrote it.',
    siteId,
    siteCode,
    host,
    port,
    databaseName,
    username,
    password,
    writtenAt: new Date().toISOString(),
  }
  fs.writeFileSync(configPath(), `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  return configPath()
}

/**
 * Read it, or null when this machine was never provisioned.
 *
 * Null rather than a throw: a Back Office installed on a CLOUD site will never
 * find one, and that is the ordinary case rather than an error.
 */
function read() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    /* Every field is load-bearing. A partial file is a failed write, and half a
       connection is worse than none — it would fail later, somewhere less
       obvious than startup. */
    const needed = ['siteId', 'host', 'port', 'databaseName', 'username', 'password']
    if (needed.some((k) => parsed[k] === undefined || parsed[k] === null || parsed[k] === '')) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/** Has Odyssey Database Setup run on this machine? */
function exists() {
  return read() !== null
}

module.exports = { read, write, exists, configPath, machineDir }
