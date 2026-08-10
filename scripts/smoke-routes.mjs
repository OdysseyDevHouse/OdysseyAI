// Requests every back-office screen in a signed-in browser and reports the ones
// that fail to render.
//
//   node --env-file=.env --env-file=.env.local scripts/smoke-routes.mjs [--json <file>]
//
// This catches the class of bug that `tsc` and `next build` both miss: a page
// that compiles cleanly and throws at request time. A server component passing
// a DataTable column array across the server/client boundary is the standing
// example — types check, the build succeeds, and the screen 500s the first time
// anyone opens it.
//
// Routes are discovered from the filesystem rather than listed here, so a new
// screen is covered the day it is added and nobody has to remember this file.
// Dynamic segments are filled from real rows in the site database: a made-up id
// only ever exercises the notFound() path, which is not the code that breaks.
//
// Chrome is driven over the DevTools protocol, the same way scripts/screenshot.mjs
// does it — Node ships a global WebSocket, so this needs no browser toolchain
// installed and no dependency added.
import { readdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createDecipheriv, scryptSync } from 'node:crypto'
import mysql from 'mysql2/promise'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/**
 * Which route groups get crawled.
 *
 * (app) is the back office. (pos) is the till, and it is here deliberately: a
 * route group that is not in this list is silently never checked, and the till is
 * the last screen in the product that should go unrendered. It was added the same
 * day /pos was created for exactly that reason.
 *
 * Note what the crawl can and cannot see there. /pos renders a PIN pad until a
 * till session exists, and the crawl has none — so it proves the route compiles,
 * serves, and does not throw at request time, which is what the smoke gate is
 * for. It does not prove the basket renders; that takes a PIN, and is checked by
 * hand with `npm run shot`.
 */
const APP_DIRS = [
  path.join(root, 'src', 'app', '(app)'),
  path.join(root, 'src', 'app', '(pos)'),
]

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4100'
const SITE = Number(process.env.SMOKE_SITE_ID || 1)
const PORT = 9334 // not 9333 — so this can run alongside a screenshot run

const jsonFlag = process.argv.indexOf('--json')
const JSON_OUT = jsonFlag !== -1 ? process.argv[jsonFlag + 1] : null

// --only <substring> crawls just the routes matching it, for re-checking one
// screen after a fix without sitting through all 123.
const onlyFlag = process.argv.indexOf('--only')
const ONLY = onlyFlag !== -1 ? process.argv[onlyFlag + 1] : null

if (!EMAIL || !PASSWORD) {
  console.error(
    'Set DEV_LOGIN_EMAIL and DEV_LOGIN_PASSWORD in .env.local, then run with\n' +
      '  node --env-file=.env --env-file=.env.local scripts/smoke-routes.mjs',
  )
  process.exit(1)
}

// ── Which real row fills each dynamic segment ───────────────────────────
//
// Keyed by the route's own folder shape. The query runs against the SITE
// database and returns one id; a route whose table is empty is reported as
// skipped rather than failed, because "no invoices exist yet on this dev data"
// is not a bug in the screen.
//
// Ordered by id DESC so the most recently created row is used — the oldest row
// on a long-lived dev database is the most likely to predate a column the page
// now reads, which produces a failure that says nothing about today's code.
//
// ── PICK THE ROW THAT RENDERS THE MOST ───────────────────────────────────
//
// One id per route exercises exactly one branch, so the id chosen decides how
// much of the screen is ever compiled. Newest-first quietly selects the
// EMPTIEST branch on any screen whose content is status-dependent: the newest
// sales document is nearly always a draft, and /sales/invoicing/[id] hides its
// whole attachments panel behind `!isEditable(status)`. A broken import inside
// that panel passed this crawl because the crawl only ever opened drafts.
//
// So where a screen shows more once a record advances, the query says so —
// preferring the fuller state and falling back to any row, because a filter
// that matches nothing would skip the route entirely and report an unvisited
// screen as merely un-seeded.
const DYNAMIC = {
  '/accounting/accounts/[id]': 'SELECT id FROM gl_accounts ORDER BY id DESC LIMIT 1',
  '/accounting/assets/[id]': 'SELECT id FROM fixed_assets ORDER BY id DESC LIMIT 1',
  '/accounting/journals/[id]': 'SELECT id FROM journal_batches ORDER BY id DESC LIMIT 1',
  // The cashbook is browsed per bank ACCOUNT, not per transaction — the id in
  // this URL is a bank_accounts row, and a transaction id 404s.
  '/cashbook/[id]': 'SELECT id FROM bank_accounts ORDER BY id DESC LIMIT 1',
  '/commission/[id]': 'SELECT id FROM commission_runs ORDER BY id DESC LIMIT 1',
  '/credit/runs/[id]': 'SELECT id FROM dunning_runs ORDER BY id DESC LIMIT 1',
  '/customers/[id]': 'SELECT id FROM customers ORDER BY id DESC LIMIT 1',
  '/customers/statements/[runId]': 'SELECT id FROM customer_statement_runs ORDER BY id DESC LIMIT 1',
  '/departments/[id]': 'SELECT id FROM departments ORDER BY id DESC LIMIT 1',
  '/expenses/[id]': 'SELECT id FROM expenses ORDER BY id DESC LIMIT 1',
  '/instructions/[id]': 'SELECT id FROM instruction_groups ORDER BY id DESC LIMIT 1',
  '/products/[id]': 'SELECT id FROM products ORDER BY id DESC LIMIT 1',
  // Finalised first, as with invoicing: this screen only renders its received
  // lines and supplier-invoice blocks once the document has been posted.
  '/purchasing/[id]':
    'SELECT id FROM purchase_documents' +
    " ORDER BY (status = 'finalised') DESC, id DESC LIMIT 1",
  '/reports/[id]': 'SELECT id FROM saved_reports ORDER BY id DESC LIMIT 1',
  // quotes, orders and invoices are all sales_documents distinguished by
  // doc_type — there is no separate quotes or sales_orders table.
  '/sales/[id]': "SELECT id FROM sales_documents WHERE status = 'finalised' ORDER BY id DESC LIMIT 1",
  '/sales/contracts/[id]': 'SELECT id FROM contracts ORDER BY id DESC LIMIT 1',
  // Finalised first: the attachments panel only exists once the invoice is no
  // longer editable, so a draft leaves that whole subtree uncompiled. ORDER BY
  // rather than WHERE, so a site holding only drafts still gets checked.
  '/sales/invoicing/[id]':
    "SELECT id FROM sales_documents WHERE doc_type = 'invoice'" +
    " ORDER BY (status IN ('finalised','void','cancelled')) DESC, id DESC LIMIT 1",
  '/sales/laybys/[id]': 'SELECT id FROM laybys ORDER BY id DESC LIMIT 1',
  '/sales/orders/[id]': "SELECT id FROM sales_documents WHERE doc_type = 'sales_order' ORDER BY id DESC LIMIT 1",
  '/sales/quotes/[id]': "SELECT id FROM sales_documents WHERE doc_type = 'quote' ORDER BY id DESC LIMIT 1",
  '/suppliers/[id]': 'SELECT id FROM suppliers ORDER BY id DESC LIMIT 1',
  '/suppliers/remittances/[runId]': 'SELECT id FROM supplier_payment_runs ORDER BY id DESC LIMIT 1',
  '/transfers/[id]': 'SELECT id FROM stock_transfers ORDER BY id DESC LIMIT 1',
  '/manufacturing/[id]': 'SELECT id FROM manufacturing_orders ORDER BY id DESC LIMIT 1',
}

// ── Route discovery ─────────────────────────────────────────────────────
async function discoverRoutes(dir, prefix = '') {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      if (entry.name === 'page.tsx') out.push(prefix || '/')
      continue
    }
    // (groups) do not appear in the URL; @slots and _private are not routes.
    const seg = entry.name
    if (seg.startsWith('_') || seg.startsWith('@')) continue
    const nextPrefix = seg.startsWith('(') && seg.endsWith(')') ? prefix : `${prefix}/${seg}`
    out.push(...(await discoverRoutes(path.join(dir, seg), nextPrefix)))
  }
  return out
}

// ── Site database, for the dynamic ids ──────────────────────────────────
// Mirrors src/lib/crypto/secrets.ts, the same way site-migrate.mjs does.
const PREFIX = 'enc:v1:'
function decryptSecret(stored) {
  if (!stored) return ''
  if (!stored.startsWith(PREFIX)) return stored
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':').map((s) => Buffer.from(s, 'base64'))
  const key = scryptSync(process.env.ENCRYPTION_KEY, 'odyssey-secret-v1', 32)
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

async function siteConnection() {
  const control = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  })
  const [rows] = await control.query(
    `SELECT server_host, server_port, database_name, db_username, db_password_enc
       FROM cp2_site_databases
      WHERE site_id = ? AND status = 'active'
      ORDER BY purpose LIMIT 1`,
    [SITE],
  )
  await control.end()
  if (!rows.length) throw new Error(`No active database configured for site ${SITE}`)
  const cfg = rows[0]
  return mysql.createConnection({
    host: process.env.SITE_DB_HOST_OVERRIDE?.trim() || cfg.server_host,
    port: cfg.server_port || 3306,
    user: cfg.db_username || '',
    password: decryptSecret(cfg.db_password_enc),
    database: cfg.database_name,
  })
}

/**
 * Fills [id] segments with real ids. Returns { url } for a route that can be
 * requested, or { skip } for one whose table is empty or missing.
 *
 * Schema drifts between sites, so a table named here may genuinely not exist on
 * the site being smoked — that is a skip, not a failure.
 */
async function resolveRoute(route, db) {
  if (!route.includes('[')) return { url: route }
  // The id belongs to the deepest dynamic segment's own entity, which is the
  // longest key in DYNAMIC that this route starts with:
  // /customers/[id]/statement takes its id from /customers/[id].
  const key = Object.keys(DYNAMIC)
    .filter((k) => route === k || route.startsWith(k + '/'))
    .sort((a, b) => b.length - a.length)[0]
  if (!key) return { skip: 'no id source configured' }
  try {
    const [rows] = await db.query(DYNAMIC[key])
    if (!rows.length) return { skip: 'no rows in the source table' }
    const id = Object.values(rows[0])[0]
    return { url: route.replace(/\[[^\]]+\]/, String(id)) }
  } catch (e) {
    return { skip: `id lookup failed: ${e.message}` }
  }
}

// ── Chrome ──────────────────────────────────────────────────────────────
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = path.join(tmpdir(), `odyssey-smoke-${process.pid}-${process.hrtime.bigint()}`)
mkdirSync(profile, { recursive: true })

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    `--user-data-dir=${profile}`,
    '--window-size=1600,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function cleanup() {
  try { chrome.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

async function devtoolsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return (await r.json()).webSocketDebuggerUrl
    } catch {}
    await sleep(250)
  }
  throw new Error('Chrome did not expose a debugging port')
}

const ws = new WebSocket(await devtoolsUrl())
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pending = new Map()
// Console errors and failed requests are collected per-navigation. A screen can
// paint a perfectly convincing shell while a data fetch 500s underneath it, and
// only the network event says so.
let consoleErrors = []
let failedRequests = []
let lastStatus = null

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params?.exceptionDetails
    consoleErrors.push((d?.exception?.description || d?.text || 'exception').slice(0, 300))
    return
  }
  if (msg.method === 'Network.responseReceived') {
    const { response, type } = msg.params
    if (type === 'Document' && lastStatus === null) lastStatus = response.status
    if (response.status >= 500) failedRequests.push(`${response.status} ${response.url.slice(0, 160)}`)
    return
  }
  const entry = pending.get(msg.id)
  if (!entry) return
  pending.delete(msg.id)
  msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
}

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const n = ++msgId
    pending.set(n, { resolve, reject })
    ws.send(JSON.stringify({ id: n, method, params, sessionId }))
  })

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)
await send('Network.enable', {}, sessionId)

async function evaluate(expression) {
  const r = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  )
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}

async function goto(p) {
  consoleErrors = []
  failedRequests = []
  lastStatus = null
  await send('Page.navigate', { url: `${BASE}${p}` }, sessionId)
  for (let i = 0; i < 120; i++) {
    await sleep(500)
    const ready = await evaluate(
      `document.readyState === 'complete' && (document.body?.innerText || '').trim().length > 0`,
    )
    if (ready) break
  }
  await sleep(600) // let streamed-in data settle
  return evaluate('location.pathname')
}

// ── Sign in ─────────────────────────────────────────────────────────────
// '/' IS the login page; there is no /login route. Driven as a user because the
// form posts a server action and React ignores a raw `.value =`.
const at = await goto('/')
const alreadyIn = at !== '/' && !at.startsWith('/login')

if (!alreadyIn) {
  for (let i = 0; i < 40; i++) {
    if (await evaluate(
      `!!document.querySelector('input[name="email"]') && !!document.querySelector('button[type="submit"]')`,
    )) break
    await sleep(500)
  }
}

const submitted = alreadyIn || (await evaluate(`(() => {
  const set = (el, v) => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const email = document.querySelector('input[name="email"]')
  const pass = document.querySelector('input[name="password"]')
  if (!email || !pass) return false
  set(email, ${JSON.stringify(EMAIL)})
  set(pass, ${JSON.stringify(PASSWORD)})
  email.closest('form').querySelector('button[type="submit"]').click()
  return true
})()`))

if (!submitted) {
  console.error('Could not find the login fields — has the form changed?')
  process.exit(1)
}

// Poll rather than sleep a fixed span. The sign-in posts a server action and
// the destination is compiled on demand, so on a cold dev server the redirect
// can take far longer than any constant worth hard-coding — and a wait that
// expires one second early reports a WORKING login as a broken one, which is
// exactly the false alarm that sent this script's first run chasing a
// credential that was correct all along.
let landed = await evaluate('location.pathname')
for (let i = 0; i < 120 && (landed === '/' || landed.startsWith('/login')); i++) {
  // A rejected sign-in renders its reason immediately; stop waiting for a
  // redirect that is never coming.
  const err = await evaluate(
    `(document.querySelector('[role="alert"]') || {}).textContent || ''`,
  )
  if (String(err).trim()) break
  await sleep(500)
  landed = await evaluate('location.pathname')
}

if (landed === '/' || landed.startsWith('/login')) {
  const message = await evaluate(
    `(document.querySelector('[role="alert"]') || {}).textContent || 'no message shown'`,
  )
  console.error('Sign-in failed:', String(message).trim())
  process.exit(1)
}
console.log(`signed in as ${EMAIL}, landed on ${landed}\n`)

// ── Crawl ───────────────────────────────────────────────────────────────
const discovered = (await Promise.all(APP_DIRS.map((dir) => discoverRoutes(dir)))).flat()
// Deduped: a path that somehow exists under two groups would otherwise be
// crawled twice and reported twice, which reads as a flaky screen.
const routes = [...new Set(discovered)].sort().filter((r) => !ONLY || r.includes(ONLY))
const db = await siteConnection()

console.log(`smoking ${routes.length} route(s) as ${EMAIL} against ${BASE}\n`)

const results = []
for (const route of routes) {
  const resolved = await resolveRoute(route, db)
  if (resolved.skip) {
    results.push({ route, state: 'skip', detail: resolved.skip })
    console.log(`SKIP  ${route}  -- ${resolved.skip}`)
    continue
  }

  const url = resolved.url
  let landedOn
  try {
    landedOn = await goto(url)
  } catch (e) {
    results.push({ route, url, state: 'fail', detail: `navigation threw: ${e.message}` })
    console.log(`**FAIL**  ${url}  -- navigation threw: ${e.message}`)
    continue
  }

  // What the page actually says. The dev error overlay lives in a shadow root,
  // so a screen that threw looks empty from document.body alone.
  const diag = await evaluate(`(() => {
    const out = []
    const root = document.querySelector('nextjs-portal')?.shadowRoot
    if (root) {
      root.querySelectorAll('h1, h2, p, pre, [data-nextjs-codeframe]').forEach((el) => {
        const t = (el.innerText || el.textContent || '').trim()
        if (t && !out.includes(t)) out.push(t)
      })
    }
    // The page's OWN content, measured apart from the chrome around it.
    //
    // document.body includes the sidebar and top bar, which the layout renders
    // on every route — roughly 330 characters of navigation before the page
    // contributes anything. So "did the body render text" is satisfied by the
    // shell alone and cannot tell a working screen from one whose content
    // failed entirely. Measuring <main> asks the question that was meant.
    //
    // <main> is where (app)/layout.tsx puts the page. Falling back to body
    // keeps the login and storefront routes, which have no <main>, measurable.
    const main = document.querySelector('main')
    const own = ((main || document.body)?.innerText || '').trim()
    return {
      overlay: out.join(' | ').slice(0, 600),
      text: (document.body?.innerText || '').trim().slice(0, 400),
      ownText: own.slice(0, 400),
      ownLength: own.length,
      hasMain: !!main,
      // The app's own error boundary, distinct from Next's dev overlay.
      boundary: !!document.querySelector('[data-error-boundary]'),
    }
  })()`)

  const problems = []
  if (lastStatus && lastStatus >= 400) problems.push(`HTTP ${lastStatus}`)
  if (diag.overlay) problems.push(`error overlay: ${diag.overlay}`)
  if (diag.boundary) problems.push('app error boundary rendered')
  if (failedRequests.length) problems.push(`server error: ${failedRequests[0]}`)
  if (consoleErrors.length) problems.push(`uncaught: ${consoleErrors[0]}`)
  if (!diag.text) problems.push('page rendered nothing')
  // A page inside the app shell that put nothing in <main> failed, however
  // healthy the surrounding chrome looks. The threshold is deliberately low —
  // this is catching "the content never rendered at all", not "the content is
  // thin". The emptiest real screen here still prints a heading and an empty
  // state well past this.
  else if (diag.hasMain && diag.ownLength < 40) {
    problems.push(`page shell rendered but its content did not (${diag.ownLength} chars in <main>)`)
  }
  // Auth is a real failure here: every one of these screens is meant to be
  // reachable by the dev account, so a bounce to login means the guard is wrong.
  if (landedOn === '/' || landedOn.startsWith('/login')) problems.push('redirected to login')
  // …except on /not-allowed itself, which IS the permission-denied screen.
  if (landedOn === '/not-allowed' && route !== '/not-allowed') {
    problems.push('redirected to not-allowed')
  }

  if (problems.length) {
    results.push({ route, url, state: 'fail', detail: problems.join('; ') })
    console.log(`**FAIL**  ${url}  -- ${problems.join('; ')}`)
  } else {
    results.push({ route, url, state: 'pass' })
    console.log(`PASS  ${url}`)
  }
}

await db.end()
ws.close()

const failed = results.filter((r) => r.state === 'fail')
const skipped = results.filter((r) => r.state === 'skip')
const passed = results.filter((r) => r.state === 'pass')

console.log(
  `\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped` +
    ` (of ${results.length} route(s))`,
)
if (skipped.length) {
  console.log(`\nSkipped routes were NOT checked — they need data before they can be:`)
  for (const s of skipped) console.log(`  ${s.route}  -- ${s.detail}`)
}
if (failed.length) {
  console.log('\nFailures:')
  for (const f of failed) console.log(`  ${f.url || f.route}\n    ${f.detail}`)
}

if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify({ base: BASE, site: SITE, results }, null, 2))
  console.log(`\nreport -> ${JSON_OUT}`)
}

console.log(failed.length === 0 ? '\nALL PASS' : `\n${failed.length} FAILURE(S)`)
cleanup()
process.exit(failed.length === 0 ? 0 : 1)
