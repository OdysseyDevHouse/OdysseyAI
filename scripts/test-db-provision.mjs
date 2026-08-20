/**
 * The apply step of Odyssey Database Setup.
 *
 * What it decides, and why each matters:
 *
 *   · A HYBRID box binds the shop's LAN; a local backend stays on loopback.
 *     Bound to loopback a hybrid box serves nobody but itself, which is the one
 *     thing it exists not to do.
 *   · A hybrid box keeps NO binary log. Its master is the cloud and its rows are
 *     deleted once the cloud has them, so there is nothing to replicate — and
 *     --sync-binlog=1 flushes on every commit, which on a busy floor is every
 *     item a waiter rings up.
 *   · It never re-initialises. Re-initialising is indistinguishable from erasing
 *     a shop's trading history, which is the rule the whole file is built on.
 *
 * MariaDB is stubbed: the question is which arguments and which statements, and
 * a real server would make the answer slower without making it clearer.
 *
 *   node scripts/test-db-provision.mjs
 */
import { createRequire } from 'node:module'
import Module from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ── A fake install: binaries that exist, a data directory that does not ──── */

const home = mkdtempSync(path.join(tmpdir(), 'odyssey-prov-'))
const mariaDir = path.join(home, 'mariadb')
mkdirSync(path.join(mariaDir, 'bin'), { recursive: true })
for (const exe of ['mariadbd', 'mariadb', 'mariadb-install-db']) {
  const file = path.join(mariaDir, 'bin', process.platform === 'win32' ? `${exe}.exe` : exe)
  writeFileSync(file, '')
}
process.env.ODYSSEY_MARIADB_DIR = mariaDir

/* ── Stub Electron and the child processes ───────────────────────────────── */

const spawned = []
const ran = []

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => home } }
  }
  if (request === 'node:child_process') {
    return {
      spawn: (file, args) => {
        spawned.push({ file, args })
        return {
          stderr: { on: () => {} },
          stdout: { on: () => {} },
          on: () => {},
          kill: () => {},
          pid: 1234,
        }
      },
      execFile: (file, args, opts, cb) => {
        ran.push({ file, args })
        cb(null, '', '')
      },
    }
  }
  if (request === 'node:net') {
    /*
     * Nothing is listening until the (stubbed) server is spawned, and then
     * everything is.
     *
     * That mirrors what provisionForPlan actually asks: FIRST "is this port
     * already taken" — which decides whether the machine is ours — and then,
     * inside start(), "has it come up yet". A stub that always refused would
     * make the first question right and hang the second; one that always
     * accepted would make provisioning believe every fresh machine was already
     * occupied.
     */
    return {
      Socket: class {
        setTimeout() {}
        once(event, fn) {
          const listening = spawned.length > 0
          if (listening && event === 'connect') setTimeout(fn, 0)
          if (!listening && event === 'error') setTimeout(() => fn(new Error('closed')), 0)
        }
        connect() {}
        destroy() {}
      },
    }
  }
  return origLoad(request, parent, isMain)
}

const localDb = require('../electron/localDb.js')

function serverArgs() {
  return spawned[spawned.length - 1]?.args ?? []
}
function statementsRun() {
  return ran.filter((r) => r.args?.includes('-e')).map((r) => r.args[r.args.indexOf('-e') + 1])
}

async function main() {
  console.log('\nProvisioning a shop database\n')

  const STATEMENTS = [
    'CREATE DATABASE IF NOT EXISTS `ody10000_hybrid`;',
    "CREATE USER IF NOT EXISTS 'ody10000_hybrid'@'127.0.0.1' IDENTIFIED BY 'secret';",
    'FLUSH PRIVILEGES;',
  ]

  /* ── A hybrid box ──────────────────────────────────────────────────────── */

  const hybrid = await localDb.provisionForPlan({
    port: 33101,
    statements: STATEMENTS,
    lan: true,
  })

  check('a fresh machine is initialised', hybrid.initialised)
  check('  and the server is started', hybrid.started)

  const hybridArgs = serverArgs()
  /* THE reason a hybrid box exists: ten tills in the building connect to it. */
  check(
    '*** a hybrid box binds the shop LAN ***',
    hybridArgs.includes('--bind-address=0.0.0.0'),
    hybridArgs.find((a) => a.startsWith('--bind-address')),
  )
  /* Its master is the cloud and its rows are deleted once the cloud has them,
     so a binlog would be pure cost — and --sync-binlog=1 costs it on every
     item rung up. */
  check(
    '*** and keeps no binary log ***',
    !hybridArgs.some((a) => /log-bin|binlog/.test(a)),
    hybridArgs.filter((a) => /log-bin|binlog/.test(a)).join(' '),
  )

  const applied = statementsRun()
  check('every statement is applied', STATEMENTS.every((s) => applied.includes(s)))
  /* One per call, so a failure names the statement rather than the batch. */
  check('  one at a time, not joined', applied.length === STATEMENTS.length, String(applied.length))

  /* ── A local backend ───────────────────────────────────────────────────── */

  spawned.length = 0
  ran.length = 0
  await localDb.provisionForPlan({ port: 33102, statements: STATEMENTS, lan: false })

  const localArgs = serverArgs()
  check('a local backend stays on loopback', localArgs.includes('--bind-address=127.0.0.1'))
  /* It IS the shop's master, and the cloud copy is a binlog replica — see the
     note in localDb.js on why a watermark sync cannot work here. */
  check('  and keeps its binary log', localArgs.includes('--log-bin=odyssey-bin'))
  check('  in ROW format', localArgs.includes('--binlog-format=ROW'))

  /* ── Refusals ──────────────────────────────────────────────────────────── */

  let refused = false
  try {
    await localDb.provisionForPlan({ port: 33103, statements: [], lan: false })
  } catch {
    refused = true
  }
  check('provisioning with no statements is refused', refused)

  let noServer = false
  const keep = process.env.ODYSSEY_MARIADB_DIR
  process.env.ODYSSEY_MARIADB_DIR = path.join(home, 'nothing-here')
  try {
    await localDb.provisionForPlan({ port: 33104, statements: STATEMENTS, lan: false })
  } catch (err) {
    /* The actionable message: name the missing step rather than blame the build. */
    noServer = /Odyssey Database Setup|ODYSSEY_MARIADB_DIR/.test(err.message)
  }
  process.env.ODYSSEY_MARIADB_DIR = keep
  check('a machine with no server says which step is missing', noServer)

  console.log(`\n${failures === 0 ? 'Provisioning holds.' : `${failures} FAILED`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`\n  ${err?.message || err}\n`)
  process.exit(1)
})
