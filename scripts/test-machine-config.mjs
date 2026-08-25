/**
 * The handoff between the two installers.
 *
 * ── WHY THIS IS THE FRAGILE JOINT ───────────────────────────────────────────
 *
 * Odyssey Database Setup and Odyssey Back Office are separate installers with
 * separate appIds, so they have separate userData directories and share nothing
 * except the machine. One file in ProgramData is the only thing that carries
 * "which shop is this, and how do I reach its database" from the one that knows
 * to the one that needs it.
 *
 * If it is written wrong, or read too loosely, the symptom is the one that cost
 * a day already: sign-in works and the first screen showing real data dies,
 * because the app cannot find a database that is sitting right there.
 *
 *   node scripts/test-machine-config.mjs
 *
 * Writes to a temporary ProgramData, never the real one.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\nMachine handoff\n')

/* Redirect ProgramData so nothing touches a real install. */
const sandbox = mkdtempSync(path.join(tmpdir(), 'odyssey-machine-'))
process.env.ProgramData = sandbox

const machineConfig = require(path.join(root, 'electron', 'machineConfig.js'))

check('nothing is there before Setup runs', machineConfig.read() === null)
check('exists() agrees', machineConfig.exists() === false)

const written = {
  siteId: 4,
  siteCode: 'ODY10003',
  host: '127.0.0.1',
  port: 3306,
  databaseName: 'ODY10003_master',
  username: 'ody10003',
  password: 'a-password-from-the-control-panel',
}
const at = machineConfig.write(written)
check('it lands under ProgramData\\Odyssey', at.startsWith(path.join(sandbox, 'Odyssey')))

const read = machineConfig.read()
check('every field survives the round trip', !!read && [
  'siteId', 'siteCode', 'host', 'port', 'databaseName', 'username', 'password',
].every((k) => String(read[k]) === String(written[k])))

/* The Back Office resolves `localhost` against ITSELF. Setup must therefore
   write loopback rather than copying the control panel's word for it, which
   means "localhost of the database server". */
check('the host is loopback, not the word localhost', read.host === '127.0.0.1')

/* A file that says it is not encrypted is honest; one that is silent invites
   somebody to assume it is. */
check('it says plainly that it is not encrypted', /not encrypted/i.test(read._note || ''))

/* ── A partial file is worse than no file ─────────────────────────────────── */

const file = machineConfig.configPath()
const full = JSON.parse(readFileSync(file, 'utf8'))

for (const field of ['siteId', 'host', 'port', 'databaseName', 'username', 'password']) {
  const broken = { ...full }
  delete broken[field]
  writeFileSync(file, JSON.stringify(broken), 'utf8')
  check(`a file missing ${field} reads as nothing`, machineConfig.read() === null)
}

const blank = { ...full, password: '' }
writeFileSync(file, JSON.stringify(blank), 'utf8')
check('an empty password reads as nothing', machineConfig.read() === null)

writeFileSync(file, 'not json at all', 'utf8')
check('unparseable content reads as nothing, not a throw', machineConfig.read() === null)

/* ── The site guard in siteDb ─────────────────────────────────────────────── */

const siteDb = readFileSync(path.join(root, 'src', 'lib', 'siteDb.ts'), 'utf8')
/* Handing this shop's database back under ANOTHER shop's id is the worst way to
   be wrong — a store group sharing a customer file would read the wrong shop's
   data and never know. */
check('a request for another site falls through', /own !== siteId/.test(siteDb))
check('only the master purpose is answered from the file', /purpose !== 'master'/.test(siteDb))
/* The pool is what opens the socket. Checking only getSiteDatabase would leave
   a control-database query in front of every site query. */
check('sitePool honours it too', siteDb.split('givenConnection').length - 1 >= 3)

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'All machine-handoff checks passed.' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
