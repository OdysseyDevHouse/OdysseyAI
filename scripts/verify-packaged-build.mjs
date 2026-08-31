/**
 * Does the thing we are about to ship actually run?
 *
 * ── WHY A GREEN CHECK LIED TWICE ────────────────────────────────────────────
 *
 * Two separate packaging bugs reached a "verified" state in one afternoon, and
 * both got past a check that looked thorough. They are worth naming, because
 * the whole design of this script is to make them impossible rather than
 * unlikely.
 *
 *   1. TESTED IN PLACE. Serving pages from release/win-unpacked while it sits
 *      inside the repository proves nothing: Node resolves a missing module by
 *      walking UP the directory tree, straight into OdysseyAI/node_modules, and
 *      happily loads something that was never in the package. A build missing
 *      ten of Next's thirteen .runtime.prod.js files passed exactly this way.
 *      So this script copies the payload OUT of the repo first.
 *
 *   2. ASSERTED THE MODE INSTEAD OF READING IT. The old harness set
 *      APP_MODE=desktop itself, then reported /api/health returning
 *      {"mode":"desktop"} as proof. It was proof of the environment variable it
 *      had just set. A Back Office packed from a WEB build passed, and would
 *      have gone to a customer. So this reads NEXT_PUBLIC_APP_MODE out of the
 *      build's own required-server-files.json and refuses to continue if it is
 *      wrong.
 *
 * ── AND WHY IT ASKS FOR BOTH A ROUTE AND A PAGE ─────────────────────────────
 *
 * The two failure modes are distinct and neither implies the other:
 *
 *   · missing next-server runtimes  -> App ROUTES die  (/api/health)
 *   · missing Turbopack server chunks -> PAGE renders die  (/)
 *
 * /api/health alone was green while every page 500'd with
 * `Cannot find module '../chunks/ssr/[turbopack]_runtime.js'`. Checking one and
 * inferring the other is how that shipped.
 *
 *   node scripts/verify-packaged-build.mjs [--keep]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createRequire } from 'node:module'

const REPO = process.cwd()
const SRC = path.join(REPO, 'release', 'win-unpacked', 'resources', 'app')
const KEEP = process.argv.includes('--keep')

let failures = 0
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`) }
const pass = (m) => console.log(`  PASS  ${m}`)

if (!fs.existsSync(SRC)) {
  console.error(`No packaged app at ${SRC}. Run an electron-builder pack first.`)
  process.exit(1)
}

/* ── 1. THE BAKED MODE, READ NOT ASSUMED ─────────────────────────────────── */
console.log('\nWhat this build actually is')
const rsf = JSON.parse(
  fs.readFileSync(path.join(SRC, '.next', 'required-server-files.json'), 'utf8'),
)
const mode = rsf.config?.env?.NEXT_PUBLIC_APP_MODE
console.log(`  baked NEXT_PUBLIC_APP_MODE = ${JSON.stringify(mode)}`)
if (mode === 'desktop') pass('it is a desktop build')
else {
  fail(`it is NOT a desktop build - packed from \`next build\` without APP_MODE=desktop`)
  console.log('\nRefusing to go further; run `npm run build:desktop` and repack.\n')
  process.exit(1)
}

/* ── 2. OUT OF THE REPO, SO RESOLUTION CANNOT CHEAT ──────────────────────── */
const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'odyssey-verify-'))
console.log(`\nCopying the payload outside the repo\n  -> ${dest}`)
fs.cpSync(SRC, dest, { recursive: true })
/* Belt and braces: if anything DOES try to walk up, it must not find a
   node_modules on the way. A sentinel proves the copy is genuinely isolated. */
let up = path.dirname(dest)
let leaked = null
for (let i = 0; i < 6 && up && up !== path.dirname(up); i++) {
  if (fs.existsSync(path.join(up, 'node_modules'))) { leaked = up; break }
  up = path.dirname(up)
}
if (leaked) fail(`a node_modules exists above the copy at ${leaked} - resolution could still cheat`)
else pass('nothing resolvable above the copy')

const files = (() => { let n = 0; (function w(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name); if (e.isDirectory()) w(p); else n++ } })(dest); return n })()
console.log(`  ${files.toLocaleString()} files copied`)

/* ── 3. BOOT IT AND ASK FOR BOTH SHAPES ──────────────────────────────────── */
const req = createRequire(path.join(dest, 'package.json'))
process.env.NODE_ENV = 'production'
/* Deliberately NOT setting APP_MODE - the build carries its own, and setting it
   here is what masked the web-build bug. */

console.log('\nServing from the copy')
let server
try {
  const next = req(req.resolve('next', { paths: [path.join(dest, 'node_modules')] }))
  const app = next({ dev: false, dir: dest })
  await app.prepare()
  pass('next().prepare() from the isolated copy')

  const handle = app.getRequestHandler()
  server = http.createServer((q, r) => handle(q, r))
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const port = server.address().port

  /* An App ROUTE and a PAGE. Different failure modes; check both. */
  for (const [label, url] of [['App Route  /api/health', '/api/health'], ['Page       /', '/'], ['Page       /database-setup', '/database-setup']]) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${url}`, { redirect: 'manual' })
      const body = (await r.text()).slice(0, 70).replace(/\s+/g, ' ')
      if (r.status >= 500) fail(`${label} -> ${r.status} | ${body}`)
      else pass(`${label} -> ${r.status}`)
    } catch (e) {
      fail(`${label} -> threw: ${e.message}`)
    }
  }

  /* ── TWO DIFFERENT VARIABLES, AND ONLY ONE OF THEM IS THIS SCRIPT'S JOB ──
   *
   * This asserted /api/health reports mode=desktop, and failed a perfectly good
   * build. The two are not the same thing:
   *
   *   NEXT_PUBLIC_APP_MODE  baked at BUILD time by next.config.mjs. This is the
   *                         one that tells a desktop build from a web build, and
   *                         it is checked above, from the build's own manifest.
   *   APP_MODE              set at RUN time by electron/runtimeConfig.js, which
   *                         is what /api/health actually reads. There is no
   *                         Electron here, so it is legitimately absent and the
   *                         route correctly answers "web".
   *
   * Reported, never asserted: outside Electron the honest expectation is "web",
   * and a script that demands otherwise is testing its own harness again - the
   * exact mistake this file exists to stop. */
  try {
    const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()
    console.log(`  note  /api/health mode=${h.mode}, database=${h.database} (no Electron here, so "web" is expected)`)
  } catch { /* already counted above */ }
} catch (e) {
  fail(`could not boot: ${e.message.split('\n')[0]}`)
} finally {
  try { server?.close() } catch {}
  if (!KEEP) { try { fs.rmSync(dest, { recursive: true, force: true }) } catch {} }
  else console.log(`\n(kept at ${dest})`)
}

console.log(
  failures === 0
    ? '\nPackaged build verified: right mode, isolated, routes and pages both serve.\n'
    : `\n${failures} check(s) FAILED - do not ship this build.\n`,
)
process.exit(failures === 0 ? 0 : 1)
