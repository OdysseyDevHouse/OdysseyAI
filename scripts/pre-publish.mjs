// Everything that has to be true before the back office is published.
//
//   node --env-file=.env --env-file=.env.local scripts/pre-publish.mjs [options]
//
//     --gate=static,migrations,domain,smoke   run only these gates
//     --skip=smoke                            run everything but these
//     --json <file>                           write a machine-readable report
//     --concurrency=4                         parallel domain tests (default 4)
//     --allow-remote-db                       permit a non-local database
//
// Four gates, cheapest first, so a typo is caught in seconds rather than after
// ten minutes of database work:
//
//   static      tsc --noEmit, next build, the design-system check
//   migrations  sql/site/*.sql applied to every active site
//   domain      every scripts/test-*.ts
//   smoke       every back-office screen requested in a real browser
//
// A failing gate does NOT stop the run. The point of this script is to produce
// one complete list of what is broken — stopping at the first failure is what
// makes a long suite something nobody runs, because each fix costs another full
// pass to find the next problem. Gates that depend on an earlier one are the
// exception: there is no sense smoking screens against a build that failed.
import { spawn } from 'node:child_process'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import mysql from 'mysql2/promise'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.split('=').slice(1).join('=')
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)

const ALL_GATES = ['static', 'migrations', 'domain', 'smoke']
const only = (flag('gate') || '').split(',').filter(Boolean)
const skip = (flag('skip') || '').split(',').filter(Boolean)
const GATES = ALL_GATES.filter((g) => (only.length ? only.includes(g) : true) && !skip.includes(g))
const CONCURRENCY = Math.max(1, Number(flag('concurrency', '4')))
const JSON_OUT = flag('json')

const started = Date.now()
const report = { startedAt: new Date().toISOString(), gates: [] }

// Direct JS entry points for the tools this runs, so nothing goes through a
// .cmd shim (see `run` below for why that matters).
const BIN = {
  tsx: path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  tsc: path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  next: path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'),
}

const line = (s = '') => process.stdout.write(s + '\n')
const rule = (title) => {
  line()
  line('='.repeat(72))
  line(`  ${title}`)
  line('='.repeat(72))
}
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`

/** Runs a command, capturing output. Never throws — the exit code is the result. */
function run(cmd, args, { cwd = root, env = process.env, quiet = false } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    // Node 24 refuses to spawn a .cmd shim without shell:true (EINVAL), and
    // shell:true concatenates arguments unescaped (DEP0190). Both are avoided
    // by never invoking a shim: `node <package>/dist/cli.mjs` runs the same
    // code npx would have reached, with the arguments passed as a real argv.
    const child = spawn(cmd, args, { cwd, env, windowsHide: true })
    let out = ''
    const take = (chunk) => {
      const s = chunk.toString()
      out += s
      if (!quiet) process.stdout.write(s)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('close', (code) => resolve({ code: code ?? 1, output: out, ms: Date.now() - t0 }))
    child.on('error', (err) => resolve({ code: 1, output: `${out}\n${err.message}`, ms: Date.now() - t0 }))
  })
}

// ── Safety: never run this against production ───────────────────────────
//
// Every domain test writes real rows to a real database, and the migration gate
// runs DDL. The tests clean up after themselves, but a crash mid-run does not,
// and no cleanup at all can undo an ALTER. So the target is checked before any
// of that starts, rather than trusting whichever .env happens to be loaded.
//
// Local-only by default. --allow-remote-db is deliberately awkward to type and
// prints what it is about to touch.
async function assertSafeDatabase() {
  const host = (process.env.DB_HOST || '').trim()
  const name = (process.env.DB_NAME || '').trim()
  const siteOverride = (process.env.SITE_DB_HOST_OVERRIDE || '').trim()

  if (!host || !name) {
    line('DB_HOST / DB_NAME are not set — load .env before running this.')
    process.exit(2)
  }

  const LOCAL = ['localhost', '127.0.0.1', '::1', '0.0.0.0']
  const remote = []
  if (!LOCAL.includes(host)) remote.push(`DB_HOST=${host}`)
  if (siteOverride && !LOCAL.includes(siteOverride)) remote.push(`SITE_DB_HOST_OVERRIDE=${siteOverride}`)

  // The site databases are the ones the tests actually write to, and they can
  // sit on a different server from the control database. Check them too, or a
  // local control panel pointing at live site data passes this guard.
  let siteHosts = []
  try {
    const control = await mysql.createConnection({
      host,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: name,
      connectTimeout: 8000,
    })
    const [rows] = await control.query(
      `SELECT DISTINCT server_host FROM cp2_site_databases WHERE status = 'active'`,
    )
    await control.end()
    siteHosts = rows.map((r) => r.server_host).filter(Boolean)
  } catch (e) {
    line(`Could not reach the control database (${host}/${name}): ${e.message}`)
    line('Fix the connection before running the suite — every gate below needs it.')
    process.exit(2)
  }

  for (const h of siteHosts) {
    if (!siteOverride && !LOCAL.includes(h)) remote.push(`site database on ${h}`)
  }

  if (remote.length && !has('allow-remote-db')) {
    line('Refusing to run: this suite writes to the database, and the target is not local.')
    line()
    for (const r of remote) line(`  ${r}`)
    line()
    line('These tests create and delete real rows, and the migration gate runs DDL.')
    line('If this really is a disposable database, re-run with --allow-remote-db.')
    process.exit(2)
  }

  line(`database: ${host}/${name}${siteHosts.length ? `  sites on: ${[...new Set(siteHosts)].join(', ')}` : ''}`)
  if (remote.length) line('WARNING: running against a REMOTE database because --allow-remote-db was given.')
}

// ── Gate 1: static ──────────────────────────────────────────────────────
async function gateStatic() {
  rule('GATE 1 / static — types, build, design system')
  const checks = []

  line('\n> tsc --noEmit')
  const tsc = await run('node', [BIN.tsc, '--noEmit'], { quiet: true })
  line(tsc.code === 0 ? `  clean (${secs(tsc.ms)})` : `  FAILED (${secs(tsc.ms)})\n${tail(tsc.output, 40)}`)
  checks.push({ name: 'tsc --noEmit', ok: tsc.code === 0, ms: tsc.ms, output: tsc.output })

  line('\n> design system (scripts/check-ui-kit.mjs)')
  const files = await tsxFiles(path.join(root, 'src'))
  const ui = await run('node', ['scripts/check-ui-kit.mjs', ...files], { quiet: true })
  // check-ui-kit exits 2 with findings on stderr; 0 means clean.
  line(ui.code === 0 ? `  clean — ${files.length} file(s) (${secs(ui.ms)})` : `  FINDINGS (${secs(ui.ms)})\n${tail(ui.output, 40)}`)
  checks.push({ name: 'design system', ok: ui.code === 0, ms: ui.ms, output: ui.output })

  line('\n> next build')
  const build = await run('node', [BIN.next, 'build'], { quiet: true })
  line(build.code === 0 ? `  built (${secs(build.ms)})` : `  FAILED (${secs(build.ms)})\n${tail(build.output, 60)}`)
  checks.push({ name: 'next build', ok: build.code === 0, ms: build.ms, output: build.output })

  return finish('static', checks)
}

/** Every .ts/.tsx under src, for the design-system check. */
async function tsxFiles(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await tsxFiles(full)))
    else if (/\.tsx?$/.test(e.name)) out.push(path.relative(root, full))
  }
  return out
}

// ── Gate 2: migrations ──────────────────────────────────────────────────
//
// Every active site, not just site 1. Schema drifts between sites, and a domain
// test that fails on a missing column is a migration problem wearing a logic
// problem's clothes — running these first means that failure never appears.
async function gateMigrations() {
  rule('GATE 2 / migrations — sql/site/*.sql on every active site')
  const checks = []

  let sites = []
  try {
    const control = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    })
    const [rows] = await control.query(
      `SELECT DISTINCT site_id FROM cp2_site_databases WHERE status = 'active' ORDER BY site_id`,
    )
    await control.end()
    sites = rows.map((r) => r.site_id)
  } catch (e) {
    line(`  could not list sites: ${e.message}`)
    return finish('migrations', [{ name: 'list active sites', ok: false, ms: 0, output: e.message }])
  }

  line(`  ${sites.length} active site(s): ${sites.join(', ')}`)
  // Sequentially: these share a MySQL server and each one runs DDL.
  for (const id of sites) {
    line(`\n> site ${id}`)
    const r = await run('node', ['scripts/site-migrate.mjs', String(id)], { quiet: true })
    line(r.code === 0 ? indent(r.output.trim()) : `  FAILED\n${tail(r.output, 30)}`)
    checks.push({ name: `site ${id}`, ok: r.code === 0, ms: r.ms, output: r.output })
  }
  return finish('migrations', checks)
}

// ── Gate 3: domain ──────────────────────────────────────────────────────
//
// Discovered from the filesystem, not from package.json: the npm `test` script
// had drifted to 37 of 73 scripts, and a test nobody runs is worse than no test
// because it reads as coverage.
//
// ── Why some of these cannot run concurrently ───────────────────────────
//
// Most of the suite is safely parallel: each script creates its own products
// and documents, asserts on them, and deletes them. But roughly a third end by
// asserting a SITE-WIDE invariant — reconcileStock finds no drift anywhere,
// every document number issued has a document behind it. Those are the most
// valuable assertions in the suite, and they are global by nature: they are
// meant to catch a leak that a test looking only at its own rows would miss.
//
// A global assertion cannot tell another test's half-finished work from a real
// leak. Run four of them at once and they fail each other — which is exactly
// what happened the first time this ran: five failures, all of them clean when
// re-run alone.
//
// So these run sequentially, after the parallel ones have finished and cleaned
// up. Detected by reading the source rather than from a list here, because a
// list would silently rot the first time someone adds a reconcile call.
const GLOBAL_ASSERTION = /\breconcile[A-Z]\w*\s*\(|\breconcile\s*\(/

async function gateDomain() {
  rule('GATE 3 / domain — every scripts/test-*.ts')

  const dir = path.join(root, 'scripts')
  const files = (await readdir(dir)).filter((f) => f.startsWith('test-') && f.endsWith('.ts')).sort()

  const exclusive = []
  const parallel = []
  for (const f of files) {
    const src = await readFile(path.join(dir, f), 'utf8')
    ;(GLOBAL_ASSERTION.test(src) ? exclusive : parallel).push(f)
  }

  line(
    `  ${files.length} test script(s): ${parallel.length} in parallel (${CONCURRENCY} at a time),\n` +
      `  then ${exclusive.length} one at a time — they assert site-wide reconciliation,\n` +
      `  which cannot distinguish another test's in-flight rows from real drift.\n`,
  )

  const checks = []

  const runOne = async (file, tag = '') => {
    const name = file.replace(/^test-|\.ts$/g, '')
    // --conditions=react-server matches how the scripts import server-only
    // modules; --env-file is already applied to this process, but the child
    // needs it too.
    const r = await run(
      'node',
      [BIN.tsx, '--conditions=react-server', '--env-file=.env', `scripts/${file}`],
      { quiet: true },
    )
    const ok = r.code === 0
    // The scripts print their own PASS/**FAIL** lines; surface the count.
    const fails = (r.output.match(/\*\*FAIL\*\*/g) || []).length
    line(
      `${ok ? 'PASS' : '**FAIL**'}  ${name.padEnd(22)} ${secs(r.ms).padStart(7)}${tag}` +
        (fails ? `  ${fails} assertion(s) failed` : ok ? '' : '  (exited non-zero)'),
    )
    checks.push({ name, ok, ms: r.ms, output: r.output, failedAssertions: fails, exclusive: !!tag })
  }

  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, parallel.length) }, async () => {
      while (next < parallel.length) await runOne(parallel[next++])
    }),
  )

  if (exclusive.length) line(`\n  — site-wide reconciliation, one at a time —\n`)
  for (const file of exclusive) await runOne(file, '  [solo]')

  checks.sort((a, b) => a.name.localeCompare(b.name))
  return finish('domain', checks)
}

// ── Gate 4: smoke ───────────────────────────────────────────────────────
async function gateSmoke() {
  rule('GATE 4 / smoke — every back-office screen in a browser')

  if (!process.env.DEV_LOGIN_EMAIL || !process.env.DEV_LOGIN_PASSWORD) {
    line('  skipped: DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD are not set.')
    line('  Add them to .env.local, or run with --skip=smoke to stop seeing this.')
    return finish('smoke', [{ name: 'credentials', ok: false, ms: 0, output: 'no dev login configured', skipped: true }])
  }

  const base = process.env.APP_URL || 'http://localhost:4100'
  // A dev server that has been up for a while degrades: its Turbopack worker
  // pool starts failing with "Jest worker encountered N child process
  // exceptions", and every route compiled after that returns 500. That looks
  // exactly like a broken page — the first full crawl here reported 19 of
  // them, and all 19 passed against a server that had just been restarted.
  //
  // So the gate does not trust a server it did not start, unless told to.
  // --reuse-server skips this when you are deliberately crawling a running
  // instance and know it is fresh.
  const existing = await serverUp(base)
  const reuse = has('reuse-server')
  let server = null

  if (existing && !reuse) {
    line(`  a server is already on ${base}; restarting it so the crawl is not`)
    line(`  reading a degraded worker pool (pass --reuse-server to keep it)`)
    await run('node', ['scripts/free-port.mjs', new URL(base).port || '4100'], { quiet: true })
    // free-port only signals; give the socket a moment to actually close.
    for (let i = 0; i < 20 && (await serverUp(base)); i++) await new Promise((r) => setTimeout(r, 500))
  }

  if (!(await serverUp(base))) {
    line(`  starting a dev server on ${base}`)
    server = spawn('node', [BIN.next, 'dev', '-p', new URL(base).port || '4100'], {
      cwd: root,
      stdio: 'ignore',
      windowsHide: true,
    })
    const ready = await waitFor(base, 120_000)
    if (!ready) {
      try { server.kill() } catch {}
      line('  server did not come up within 120s')
      return finish('smoke', [{ name: 'dev server', ok: false, ms: 120_000, output: 'server never became ready' }])
    }
    line('  server ready')
  } else {
    line(`  using the server already on ${base}`)
  }

  // The first route compiled on a cold server pays for the whole toolchain
  // warming up, which can exceed the crawler's per-route patience and report a
  // healthy screen as a timeout. Ask for one page first and throw the timing
  // away.
  if (server) {
    line('  warming up…')
    try { await fetch(`${base}/dashboard`, { signal: AbortSignal.timeout(120_000) }) } catch {}
  }

  const jsonPath = path.join(root, '.pre-publish', 'smoke.json')
  await mkdir(path.dirname(jsonPath), { recursive: true })
  const r = await run('node', ['scripts/smoke-routes.mjs', '--json', jsonPath], { quiet: false })

  // Loading a screen is not using one. The crawl above proves every page
  // renders; this drives the handful that have to actually work — a PinPad
  // that re-submits on a loop renders perfectly and clocks somebody in and
  // out twice a second. Run through tsx: it imports the app's own DB routing.
  const interactionsJson = path.join(root, '.pre-publish', 'interactions.json')
  const i = await run(
    process.execPath,
    [BIN.tsx, '--conditions=react-server', 'scripts/smoke-interactions.mjs', '--json', interactionsJson],
    { quiet: false },
  )

  if (server) {
    // The dev server is a shell wrapper around next; kill the tree.
    try { process.platform === 'win32' ? spawn('taskkill', ['/pid', server.pid, '/T', '/F']) : server.kill() } catch {}
  }

  return finish('smoke', [
    { name: 'route crawl', ok: r.code === 0, ms: r.ms, output: r.output },
    { name: 'interactions', ok: i.code === 0, ms: i.ms, output: i.output },
  ])
}

async function serverUp(base) {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2500) })
    return r.ok
  } catch { return false }
}
async function waitFor(base, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await serverUp(base)) return true
    await new Promise((r) => setTimeout(r, 1500))
  }
  return false
}

// ── Reporting ───────────────────────────────────────────────────────────
const tail = (s, n) => indent(s.trim().split('\n').slice(-n).join('\n'))
const indent = (s) => s.split('\n').map((l) => '  ' + l).join('\n')

function finish(gate, checks) {
  const failed = checks.filter((c) => !c.ok && !c.skipped)
  const entry = {
    gate,
    ok: failed.length === 0,
    checks: checks.map(({ output, ...rest }) => ({
      ...rest,
      // Keep the tail only — a full next build log is megabytes and the
      // interesting part is always at the end.
      output: rest.ok ? undefined : output.trim().split('\n').slice(-80).join('\n'),
    })),
  }
  report.gates.push(entry)
  line(`\n  ${gate}: ${checks.length - failed.length}/${checks.length} ok`)
  return entry.ok
}

// ── Run ─────────────────────────────────────────────────────────────────
line('OdysseyAI — pre-publish check')
line(`gates: ${GATES.join(', ')}`)
await assertSafeDatabase()

const RUNNERS = { static: gateStatic, migrations: gateMigrations, domain: gateDomain, smoke: gateSmoke }
let staticOk = true

for (const gate of GATES) {
  // Smoking screens against a build that failed only re-reports the build
  // error 123 times. Every other gate still runs — a type error should not
  // hide a broken cash-up.
  if (gate === 'smoke' && !staticOk) {
    rule('GATE 4 / smoke — skipped')
    line('  the static gate failed; a browser crawl would only repeat that error.')
    report.gates.push({ gate: 'smoke', ok: true, skipped: true, checks: [] })
    continue
  }
  const ok = await RUNNERS[gate]()
  if (gate === 'static') staticOk = ok
}

// ── Summary ─────────────────────────────────────────────────────────────
const elapsed = Date.now() - started
report.finishedAt = new Date().toISOString()
report.ms = elapsed

rule('SUMMARY')
for (const g of report.gates) {
  const failed = g.checks.filter((c) => !c.ok && !c.skipped)
  const state = g.skipped ? 'SKIPPED' : g.ok ? 'PASS' : `${failed.length} FAILED`
  line(`  ${g.gate.padEnd(12)} ${state}`)
  for (const f of failed) line(`      - ${f.name}${f.failedAssertions ? ` (${f.failedAssertions} assertion(s))` : ''}`)
}
line(`\n  total ${secs(elapsed)}`)

if (JSON_OUT) {
  await mkdir(path.dirname(path.resolve(root, JSON_OUT)), { recursive: true })
  await writeFile(path.resolve(root, JSON_OUT), JSON.stringify(report, null, 2))
  line(`  report -> ${JSON_OUT}`)
}

const allOk = report.gates.every((g) => g.ok)
line(allOk ? '\nREADY TO PUBLISH\n' : '\nNOT READY — see the failures above.\n')
process.exit(allOk ? 0 : 1)
