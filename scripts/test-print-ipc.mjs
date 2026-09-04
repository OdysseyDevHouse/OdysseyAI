// The print engine's IPC contract: the rules it enforces, and the shape of the
// bridge that exposes it.
//
//   npm run test:print-ipc
//
// Modelled on test-db-setup-bridge.mjs, and half of each kind for the same
// reasons. The RULES are run — electron/printTargets.js requires nothing, which
// is precisely why it was split out, so the rejections here are the real ones
// rather than a regex over the source. The SHAPE is read, because a handler
// registered without a matching verb (or a `partition:` added to the hidden
// window) is a source-level fact no unit test can reach without an Electron
// process and a display.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const targets = require(path.join(root, 'electron', 'printTargets.js'))

let fails = 0
const ok = (label, cond, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const read = (rel) => readFileSync(path.join(root, rel), 'utf8')

/**
 * The same file with its comments removed.
 *
 * Every "this must never appear" check has to read CODE, because the reason it
 * must never appear is written directly above it. `partition: 'print'` and
 * `shell: true` are both named in prose explaining why they are forbidden, and a
 * plain text search finds the warning and calls it the crime.
 */
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')

const printing = read('electron/printing.js')
const printingCode = code('electron/printing.js')
const preload = read('electron/preload.js')
const transportsCode = code('electron/printTransports.js')
const main = read('electron/main.js')
const queues = read('electron/printQueues.js')

/* ── 1. Targets ──────────────────────────────────────────────────────────── */
console.log('\n── Targets ─────────────────────────────────────────────────\n')

ok('a network printer normalises', targets.normaliseTarget({ transport: 'tcp', host: '192.168.1.50' }).ok)
ok(
  '…defaulting the port to 9100',
  targets.normaliseTarget({ transport: 'tcp', host: '192.168.1.50' }).target.port === 9100,
)
ok('a hostname is accepted', targets.normaliseTarget({ transport: 'tcp', host: 'kitchen-printer' }).ok)
ok('an IPv6 literal is accepted', targets.normaliseTarget({ transport: 'tcp', host: 'fe80::1' }).ok)

/* This argument becomes an outbound socket from the desktop app's position on
   the shop network. Anything that is not a bare host cannot become one. */
ok('*** a URL is not a host ***', !targets.normaliseTarget({ transport: 'tcp', host: 'http://evil.test' }).ok)
ok('*** a UNC path is not a host ***', !targets.normaliseTarget({ transport: 'tcp', host: '\\\\evil\\share' }).ok)
ok('*** a path is not a host ***', !targets.normaliseTarget({ transport: 'tcp', host: '../../etc/passwd' }).ok)
ok('*** an over-long host is refused ***', !targets.normaliseTarget({ transport: 'tcp', host: 'a'.repeat(300) }).ok)
ok('*** a host with a space is refused ***', !targets.normaliseTarget({ transport: 'tcp', host: 'a b' }).ok)

/* Without the port allow-list, sendRaw is a general "connect to any host and
   port on this LAN and write these bytes" primitive available to anything
   running in the renderer. */
ok('*** MySQL is not a printer port ***', !targets.normaliseTarget({ transport: 'tcp', host: 'x', port: 3306 }).ok)
ok('*** nor is 22 ***', !targets.normaliseTarget({ transport: 'tcp', host: 'x', port: 22 }).ok)
ok('*** nor is port 0 ***', !targets.normaliseTarget({ transport: 'tcp', host: 'x', port: 0 }).ok)
ok('*** a port as a STRING is refused, not coerced ***', !targets.normaliseTarget({ transport: 'tcp', host: 'x', port: '9100' }).ok)
ok('9100 through 9109 are allowed', [9100, 9105, 9109].every((p) => targets.isAllowedPort(p)))
ok('LPD and IPP are allowed', targets.isAllowedPort(515) && targets.isAllowedPort(631))

/* The transport is matched against a frozen array, never used as a lookup key
   into an object — which is what keeps prototype names out of it. */
ok('*** __proto__ is not a transport ***', !targets.normaliseTarget({ transport: '__proto__' }).ok)
ok('*** constructor is not a transport ***', !targets.normaliseTarget({ transport: 'constructor' }).ok)
ok('*** a missing target is refused ***', !targets.normaliseTarget(null).ok)

ok('a queue normalises', targets.normaliseTarget({ transport: 'queue', name: 'EPSON TM-T20III' }).ok)
ok('*** a blank queue name is refused ***', !targets.normaliseTarget({ transport: 'queue', name: '  ' }).ok)
/* A share name becomes a UNC path component; a slash in it climbs out of
   \\localhost\ and onto another machine entirely. */
ok(
  '*** a share name cannot contain a path separator ***',
  !targets.normaliseTarget({ transport: 'queue', name: 'q', shareName: '..\\..\\evil' }).ok,
)

/* ── 2. Route paths ──────────────────────────────────────────────────────── */
console.log('\n── Route paths ─────────────────────────────────────────────\n')

ok('a sales document is printable', targets.isAllowedRoutePath('/sales/12/slip'))
ok('a label sheet is printable', targets.isAllowedRoutePath('/labels/a4?ids=1,2'))
ok('a purchase order is printable', targets.isAllowedRoutePath('/purchasing/9/order'))

/* Without the prefix list, "render a document to a PDF" is also "render an
   arbitrary authenticated back-office page to a file and open it". */
ok('*** a setup screen is NOT a document ***', !targets.isAllowedRoutePath('/setup/users'))
ok('*** nor is the reports screen ***', !targets.isAllowedRoutePath('/reports'))
ok('*** traversal cannot climb out of the allow-list ***', !targets.isAllowedRoutePath('/sales/../setup/users'))
ok('*** a protocol-relative URL is a different origin ***', !targets.isAllowedRoutePath('//evil.test/x'))
ok('*** a Windows path is not a route ***', !targets.isAllowedRoutePath('C:\\Windows\\win.ini'))
ok('*** a scheme cannot be smuggled in ***', !targets.isAllowedRoutePath('/sales/javascript:alert(1)'))
ok('*** a fragment is refused ***', !targets.isAllowedRoutePath('/sales/1/slip#x'))
ok('*** a relative path is refused ***', !targets.isAllowedRoutePath('sales/1/slip'))

/* `?auto=1` makes a (print) route print ITSELF and call recordPrintAction. A
   hidden window driven with it would print twice and count the slip twice —
   which drives the COPY banner on the next one. */
ok('*** auto is stripped, keeping the rest ***', targets.stripAuto('/sales/1/slip?auto=1&gift=1') === '/sales/1/slip?gift=1')
ok('…and a lone auto leaves no dangling question mark', targets.stripAuto('/sales/1/slip?auto=1') === '/sales/1/slip')
ok('…and a path without one is untouched', targets.stripAuto('/sales/1/slip') === '/sales/1/slip')

/* ── 3. PDF names ────────────────────────────────────────────────────────── */
console.log('\n── PDF names ───────────────────────────────────────────────\n')

/* The renderer supplies a STEM and never a directory. A renderer-chosen path is
   an arbitrary file write, and because the engine opens the result it is also an
   arbitrary file execute — write foo.bat, open it. */
ok('a plain stem survives', targets.sanitisePdfStem('INV-000123') === 'INV-000123')
ok('*** traversal is flattened ***', !targets.sanitisePdfStem('../../evil').includes('..'))
ok('*** a separator cannot survive ***', !targets.sanitisePdfStem('a/b\\c').includes('/'))
ok('*** a leading dot cannot make a hidden file ***', !targets.sanitisePdfStem('.bashrc').startsWith('.'))
ok('*** a bare .. becomes something safe ***', targets.sanitisePdfStem('..') === 'document')
ok('*** an empty stem becomes something safe ***', targets.sanitisePdfStem('') === 'document')
ok('a long stem is capped', targets.sanitisePdfStem('x'.repeat(500)).length <= 64)
ok('the .pdf is not doubled', targets.sanitisePdfStem('invoice.pdf') === 'invoice')

/* ── 4. Bytes and options ────────────────────────────────────────────────── */
console.log('\n── Bytes and options ───────────────────────────────────────\n')

ok('a real job is accepted', targets.checkBytes(new Uint8Array(1024)).ok)
ok('*** an empty job is refused ***', !targets.checkBytes(new Uint8Array(0)).ok)
ok('*** a missing job is refused ***', !targets.checkBytes(null).ok)
/* Not 32KB — a slip with a raster logo is comfortably 50-100KB. */
ok('a 100KB slip with a logo is fine', targets.checkBytes(new Uint8Array(100 * 1024)).ok)
ok('*** a job over 2MB is refused ***', !targets.checkBytes(new Uint8Array(3 * 1024 * 1024)).ok)

ok('copies defaults to 1', targets.normaliseCopies(undefined) === 1)
ok('*** copies is capped at 10, so a typo is not a ream ***', targets.normaliseCopies(500) === 10)
ok('*** a fractional copy count falls back to 1 ***', targets.normaliseCopies(2.5) === 1)
ok('an unknown page size is dropped', targets.normalisePageSize('Letter') === null)
ok('roll80 is a page size', targets.normalisePageSize('roll80') === 'roll80')

/* ── 5. The bridge's shape ───────────────────────────────────────────────── */
console.log('\n── The bridge’s shape ──────────────────────────────────────\n')

const handled = [...printing.matchAll(/ipcMain\.handle\('(printing:[^']+)'/g)].map((m) => m[1])
const exposed = [...preload.matchAll(/ipcRenderer\.invoke\('(printing:[^']+)'/g)].map((m) => m[1])

ok('five verbs are handled', handled.length === 5, handled.join(', '))
ok(
  '*** every handler has a verb, and every verb a handler ***',
  new Set(handled).size === new Set(exposed).size &&
    handled.every((c) => exposed.includes(c)) &&
    exposed.every((c) => handled.includes(c)),
  `handled: ${handled.join(', ')} | exposed: ${exposed.join(', ')}`,
)

/* The rule preload.js states about itself. A generic bridge means anything that
   ends up running in the renderer reaches every handler the main process will
   ever have. */
ok('*** no generic invoke escape hatch ***', !/invoke:\s*\(channel/.test(preload) && !/ipcRenderer\.invoke\(channel/.test(preload))

/* THE line that decides whether a rendered document authenticates. The session
   cookie lives in the DEFAULT session's jar; a partition gets an empty one, so
   every print becomes a redirect to the sign-in page — and because non-200 is
   refused, the symptom is "printing stopped working" with no other clue. */
ok('*** the hidden window has no partition ***', !/partition\s*:/.test(printingCode))
ok('*** and no preload — it has no business holding window.odyssey ***', !/preload\s*:/.test(printingCode))
ok('…so it can be sandboxed, and is', /sandbox:\s*true/.test(printingCode))
ok('*** it is given a real width and height, or it prints blank ***', /width:\s*\d{3,}/.test(printingCode) && /height:\s*\d{3,}/.test(printingCode))
ok('*** background throttling is off, or its timers run at 1Hz ***', /backgroundThrottling:\s*false/.test(printingCode))

/* See stripAuto above: `auto` must never reach a route the engine drives. */
ok('*** the engine never appends auto=1 ***', !printingCode.includes('auto=1') && !/['"]auto['"]/.test(printingCode))

/* printBackground defaults to FALSE in Chromium, and (print)/print.css relies
   on print-color-adjust: exact so tints and rules survive. */
ok('*** backgrounds are printed, or the document loses its structure ***', /printBackground:\s*true/.test(printingCode))

/* The most valuable check in the engine: it turns an attacker-chosen string
   into a choice from a list the operating system produced, BEFORE that string
   becomes an argv element. */
const rawHandler = printing.slice(printing.indexOf("ipcMain.handle('printing:raw'"), printing.indexOf("ipcMain.handle('printing:route'"))
ok('*** a queue name is checked against the OS list before anything is spawned ***',
   rawHandler.includes('checkQueue') && rawHandler.indexOf('checkQueue') < rawHandler.indexOf('sendQueueRaw'))
/* Classified from the PORT rather than the name, in printQueues.js, because a
   printer's name is localised and PORTPROMPT: is not. Denied on THIS side of
   the bridge and not only in the picker, because this is the side that receives
   an untrusted name. */
ok('the virtual queues are denied in the ENGINE, not only in the screen',
   /portprompt:/i.test(queues) && /xps document writer/i.test(queues))
ok('*** and the engine refuses one before printing to it ***',
   /isVirtual/.test(printingCode) && /not a real printer/i.test(printing))

/* `shell: true` is what would turn a printer called "Bar & Grill (2)" into a
   command. The argv array is the whole defence. */
ok('*** nothing is ever spawned through a shell ***', !/shell:\s*true/.test(transportsCode))

/* Registered before the window exists, with thunks, like dbSetupBridge. */
ok('the engine is registered in main', /printing\.register\(/.test(main))
ok('*** …before the window is created ***', main.indexOf('printing.register(') < main.indexOf('return createWindow()'))
ok('*** …and released on quit, or the process outlives its server ***', /printing\.shutdown\(\)/.test(main))

/* The two APIs disagree on units — print() takes microns, printToPDF() inches —
   and passing one to the other asks for an 80,000-inch page. */
ok('*** the two page-size units are named apart ***', /ROLL80_MICRONS/.test(printing) && /ROLL80_INCHES/.test(printing))

console.log(fails === 0 ? '\nThe print bridge holds its shape.\n' : `\n${fails} check(s) failed.\n`)
process.exit(fails === 0 ? 0 : 1)
