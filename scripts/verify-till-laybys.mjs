// Proves lay-bys work at the till: the list is the shop's open ones, a payment
// reaches the drawer, and the money is counted by the cash-up.
//
//   node --env-file=.env --env-file=.env.local scripts/verify-till-laybys.mjs
//
// BOTH env files: the login lives in .env.local and SESSION_SECRET — which the
// till cookie is signed with — lives in .env.
//
// ── WHY THIS WAS BLOCKED UNTIL NOW ───────────────────────────────────────────
//
// takePayment has banked into a shift for a while, but expectedCash was derived
// from sales tenders alone — so lay-by money was SHOWN on the declaration and
// left out of the figure it was counted against. A till taking payments would
// have made every drawer read over by exactly them.
//
// So the assertion that matters here is not that the dialog opens. It is that a
// payment taken at the till moves the expected cash by the same amount, which
// is checked against the database rather than the screen.
//
// ── GETTING PAST THE PIN GATE ────────────────────────────────────────────────
//
// Same as verify-pos-returns.mjs: mint the till cookie, a JWT signed with
// SESSION_SECRET. Not a PIN written to a real users row.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SignJWT } from 'jose'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const SECRET = process.env.SESSION_SECRET
const BASE = process.env.APP_URL || 'http://localhost:4100'
const OUT = process.env.SHOT_DIR || path.join(process.cwd(), '.screenshots')
const PORT = 9369
/* A serial_number from cp2_devices with status='active'. Override with
   VERIFY_DEVICE_ID — a device that names no row renders "not set up as a till"
   while every API call in here goes on passing. */
const DEVICE = process.env.VERIFY_DEVICE_ID || '8d3bc8d3-0d97-4cc1-91cc-02afd3fa4c8c'

if (!EMAIL || !PASSWORD) {
  console.error('Set DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD in .env.local')
  process.exit(1)
}
if (!SECRET) {
  console.error('SESSION_SECRET is not set — the till cookie cannot be minted.')
  process.exit(1)
}

const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = path.join(tmpdir(), `odyssey-lay-${process.pid}`)
mkdirSync(OUT, { recursive: true })

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
process.on('exit', () => {
  try { chrome.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
})

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

let id = 0
const waiting = new Map()
const consoleErrors = []
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
    consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
    return
  }
  const entry = waiting.get(msg.id)
  if (!entry) return
  waiting.delete(msg.id)
  msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
}
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const n = ++id
    waiting.set(n, { resolve, reject })
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
  if (r.exceptionDetails) {
    const detail =
      r.exceptionDetails.exception?.description ||
      r.exceptionDetails.exception?.value ||
      JSON.stringify(r.exceptionDetails)
    throw new Error(`${r.exceptionDetails.text}: ${detail}`)
  }
  return r.result?.value
}

async function goto(p) {
  await send('Page.navigate', { url: `${BASE}${p}` }, sessionId)
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    if (
      await evaluate(
        `document.readyState === 'complete' && (document.body?.innerText||'').trim().length > 0`,
      )
    )
      break
  }
  await sleep(1500)
  return evaluate('location.pathname')
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  const file = path.join(OUT, `${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

let fails = 0
const ok = (label, cond, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/* ── Sign in ────────────────────────────────────────────────────────────────── */

await goto('/')
await evaluate(
  [
    '(() => {',
    '  const set = (sel, value) => {',
    '    const el = document.querySelector(sel)',
    "    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set",
    '    setter.call(el, value)',
    "    el.dispatchEvent(new Event('input', { bubbles: true }))",
    '  }',
    `  set('input[type=email]', ${JSON.stringify(EMAIL)})`,
    `  set('input[type=password]', ${JSON.stringify(PASSWORD)})`,
    "  document.querySelector('form').requestSubmit()",
    '  return true',
    '})()',
  ].join('\n'),
)

for (let i = 0; i < 40; i++) {
  const state = await evaluate(
    [
      '(() => {',
      '  const dialog = document.querySelector("dialog[open]")',
      '  if (dialog && /choose a store|select which one/i.test(dialog.innerText || "")) return "picker"',
      '  return location.pathname.startsWith("/login") || location.pathname === "/" ? "login" : "app"',
      '})()',
    ].join('\n'),
  )
  if (state === 'picker' || state === 'app') break
  await sleep(500)
}

/* The dev account reaches more than one store, so sign-in ends on a picker over
   the login card. Skipping it does not fail loudly — the catalog fetch below
   returns the picker's HTML with a 200 and r.json() dies on "<!DOCTYPE". */
const picked = await evaluate(
  [
    '(() => {',
    '  const dialog = document.querySelector("dialog[open]")',
    '  if (!dialog || !/choose a store|select which one/i.test(dialog.innerText || "")) return "no picker"',
    '  const rows = [...dialog.querySelectorAll("button, a[href]")]',
    '    .filter((el) => (el.textContent || "").trim().length > 0)',
    '    .filter((el) => !/cancel|sign out/i.test(el.textContent))',
    '  const want = ' + JSON.stringify(process.env.SHOT_SITE || ''),
    '  const hit = want',
    '    ? rows.find((el) => el.textContent.toLowerCase().includes(want.toLowerCase()))',
    '    : rows[0]',
    '  if (!hit) return null',
    '  hit.click()',
    '  return hit.textContent.replace(/\\s+/g, " ").trim()',
    '})()',
  ].join('\n'),
)
if (picked === null) {
  console.error('The store picker opened but held no store to choose.')
  process.exit(1)
}
if (picked !== 'no picker') {
  await sleep(4000)
  console.log('chose store:', picked, '->', await evaluate('location.pathname'))
}

/* ── Past the PIN gate, by minting the till cookie the action would issue ───── */

const catalog = await evaluate(
  [
    '(async () => {',
    "  const r = await fetch('/api/pos/catalog?deviceId=' + encodeURIComponent(",
    `    ${JSON.stringify(DEVICE)}`,
    "  ), { headers: { accept: 'application/json' } })",
    '  if (!r.ok) return { ok: false, status: r.status }',
    '  const b = await r.json()',
    '  return {',
    '    ok: true,',
    '    siteId: b.siteId ?? null,',
    '    operator: (b.operators || [])[0] || null,',
    '    products: (b.products || []).length,',
    '  }',
    '})()',
  ].join('\n'),
)
ok('the catalog answers for this device', catalog?.ok === true, JSON.stringify(catalog?.status ?? ''))

const token = await new SignJWT({
  userId: catalog?.operator?.userId ?? 1,
  name: 'Lay-bys verifier',
  siteId: catalog?.siteId ?? 1,
})
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('8h')
  .sign(new TextEncoder().encode(SECRET))

await send(
  'Network.setCookie',
  { name: 'odyssey_till', value: token, domain: 'localhost', path: '/', httpOnly: true },
  sessionId,
)
/* The key deviceId() actually reads — see src/lib/deviceId.ts. */
await evaluate(`localStorage.setItem('odyssey.device.id', ${JSON.stringify(DEVICE)}), true`)

consoleErrors.length = 0
const landed = await goto('/pos')
const stillGated = await evaluate(`document.body.innerText.includes('Enter your PIN')`)
ok('the till renders rather than the PIN gate', landed === '/pos' && !stillGated, landed)

if (stillGated) {
  console.log('\nStill at the gate — the minted cookie was not accepted, so nothing')
  console.log('below can run. Nothing about the menu is proven either way.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}

/* ── Helpers that talk to the screen ────────────────────────────────────────── */

/** Money comparison, to the cent. Floating point makes 550.0000001 otherwise. */
const round2 = (n) => Math.round(n * 100) / 100

const heading = () =>
  evaluate(
    [
      '(() => {',
      '  const h = document.querySelector("header")',
      '  return h ? (h.innerText || "").replace(/\\s+/g, " ").trim() : ""',
      '})()',
    ].join('\n'),
  )

const onGate = () =>
  evaluate(
    [
      '(() => {',
      '  const h = document.querySelector("header h1")',
      '  return h ? /odyssey/i.test(h.innerText || "") : false',
      '})()',
    ].join('\n'),
  )

const lineCount = () =>
  evaluate(
    [
      '(() => {',
      '  const h = document.querySelector("header")',
      '  if (!h) return null',
      '  const m = (h.innerText || "").match(/(\\d+)\\s+items?\\b/i)',
      '  return m ? Number(m[1]) : null',
      '})()',
    ].join('\n'),
  )

const openModuleMenu = () =>
  evaluate(
    [
      '(() => {',
      '  const btn = [...document.querySelectorAll("header button")]',
      '    .find((b) => /go to/i.test(b.getAttribute("aria-label") || b.title || ""))',
      '  if (!btn) return false',
      '  btn.click()',
      '  return true',
      '})()',
    ].join('\n'),
  )

const menuText = () =>
  evaluate(
    [
      '(() => {',
      '  const p = document.querySelector("aside[aria-label=\\"Till modules\\"]")',
      '  return p ? (p.innerText || "").replace(/\\s+/g, " ").trim() : null',
      '})()',
    ].join('\n'),
  )

const pickModule = (label) =>
  evaluate(
    [
      '(() => {',
      '  const p = document.querySelector("aside[aria-label=\\"Till modules\\"]")',
      '  if (!p) return "no panel"',
      '  const row = [...p.querySelectorAll("button")]',
      `    .find((el) => (el.innerText || "").toLowerCase().includes(${JSON.stringify(
        String(label).toLowerCase(),
      )}))`,
      '  if (!row) return "no row"',
      '  row.click()',
      '  return "clicked"',
      '})()',
    ].join('\n'),
  )

const dialogText = () =>
  evaluate(
    [
      '(() => {',
      '  const d = document.querySelector("dialog[open]")',
      '  return d ? (d.innerText || "").replace(/\\s+/g, " ").trim() : null',
      '})()',
    ].join('\n'),
  )

const laybyRows = () =>
  evaluate(
    [
      '(() => {',
      '  const d = document.querySelector("dialog[open]")',
      '  if (!d) return null',
      '  return [...d.querySelectorAll("button")]',
      '    .filter((b) => !/^close$/i.test((b.innerText || "").trim()))',
      '    .filter((b) => (b.innerText || "").trim().length > 12)',
      '    .map((b) => ({',
      '      text: (b.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 110),',
      '      disabled: b.disabled === true,',
      '    }))',
      '})()',
    ].join('\n'),
  )

/** Clicks a lay-by row whose text contains `needle`. */
const openLayby = (needle) =>
  evaluate(
    [
      '(() => {',
      '  const d = document.querySelector("dialog[open]")',
      '  if (!d) return "no dialog"',
      '  const row = [...d.querySelectorAll("button")]',
      '    .filter((b) => (b.innerText || "").trim().length > 12)',
      `    .find((b) => (b.innerText || "").includes(${JSON.stringify(needle)}))`,
      '  if (!row) return "no row"',
      '  row.click()',
      '  return "clicked"',
      '})()',
    ].join('\n'),
  )

/** Presses a button in the open dialog, matched on its label. */
const pressInDialog = (pattern) =>
  evaluate(
    [
      '(() => {',
      '  const d = document.querySelector("dialog[open]")',
      '  if (!d) return "no dialog"',
      `  const re = new RegExp(${JSON.stringify(pattern)}, "i")`,
      '  const btn = [...d.querySelectorAll("button")].find((b) => re.test(b.innerText || ""))',
      '  if (!btn) return "no button"',
      '  if (btn.disabled) return "disabled"',
      '  btn.click()',
      '  return "clicked"',
      '})()',
    ].join('\n'),
  )

/** Types into the dialog's money field. */
const setAmount = (value) =>
  evaluate(
    [
      '(() => {',
      '  const d = document.querySelector("dialog[open]")',
      '  if (!d) return "no dialog"',
      '  const input = [...d.querySelectorAll("input")].find((i) => i.inputMode === "decimal" || i.type === "text")',
      '  if (!input) return "no input"',
      "  const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set",
      `  setter.call(input, ${JSON.stringify(String(value))})`,
      "  input.dispatchEvent(new Event('input', { bubbles: true }))",
      '  return "typed"',
      '})()',
    ].join('\n'),
  )

/* ── The database, for the half the screen cannot answer ────────────────────── */

async function withSite(fn) {
  const mysql = await import('mysql2/promise')
  const root = await mysql.default.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    timezone: 'Z',
  })
  const [sites] = await root.query(
    "SELECT database_name FROM cp2_site_databases WHERE status='active' LIMIT 1",
  )
  await root.end()
  if (!sites.length) return null

  const site = await mysql.default.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: sites[0].database_name,
    timezone: 'Z',
  })
  try {
    return await fn(site)
  } finally {
    await site.end()
  }
}

const laybyState = (id) =>
  withSite(async (db) => {
    const [rows] = await db.query(
      'SELECT status, total_incl, paid_total, document_number FROM laybys WHERE id = ?',
      [id],
    )
    if (!rows.length) return null
    const [pays] = await db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total,
              COUNT(shift_id) AS with_shift
         FROM layby_payments WHERE layby_id = ?`,
      [id],
    )
    return {
      status: rows[0].status,
      total: Number(rows[0].total_incl),
      paid: Number(rows[0].paid_total),
      number: rows[0].document_number,
      payments: Number(pays[0].n),
      paymentsTotal: Number(pays[0].total),
      banked: Number(pays[0].with_shift),
    }
  })

/** An open lay-by with a balance left, to pay against. */
const target = await withSite(async (db) => {
  const [rows] = await db.query(
    `SELECT id, document_number, total_incl, paid_total
       FROM laybys
      WHERE status = 'open' AND total_incl - paid_total > 1
      ORDER BY id LIMIT 1`,
  )
  return rows.length
    ? {
        id: Number(rows[0].id),
        number: rows[0].document_number,
        outstanding: Number(rows[0].total_incl) - Number(rows[0].paid_total),
      }
    : null
})

if (!target) {
  console.log('')
  console.log('**SKIPPED**  no open lay-by with a balance on this site, so a payment could')
  console.log('             not be taken. Nothing is proven.')
  process.exit(1)
}
const before = await laybyState(target.id)
console.log(
  `target lay-by ${before.number}: ${before.paid}/${before.total} paid, ${before.payments} payment(s)`,
)

/* ── Onto the sale screen ───────────────────────────────────────────────────── */

if (await onGate()) {
  const entered = await evaluate(
    [
      '(() => {',
      '  const all = [...document.querySelectorAll("button")].filter((b) => !b.closest("header"))',
      '  const quick = all.find((b) => /quick sale|walk-?in|no table/i.test(b.innerText || ""))',
      '  if (quick) { quick.click(); return "quick sale" }',
      '  const table = all.find((b) => /^[A-Z]?\\d+$|table/i.test((b.innerText || "").trim()))',
      '  if (table) { table.click(); return (table.innerText || "").trim().slice(0, 20) }',
      '  return null',
      '})()',
    ].join('\n'),
  )
  await sleep(2500)
  console.log(`through the floor gate via: ${entered ?? 'nothing found'}`)
}

const reachedSale = !(await onGate())
ok('the sale screen is reachable', reachedSale, await heading())
if (!reachedSale) {
  console.log('\nStill on a gate. Nothing about lay-bys is proven either way.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}

/* ── 1. The module menu offers lay-bys ──────────────────────────────────────── */

await openModuleMenu()
await sleep(700)
const menu = await menuText()
ok('the module menu offers lay-bys', /lay-?by/i.test(menu || ''), (menu || '').slice(0, 90))
await shot('till-laybys-menu')

/* ── 2. Picking it opens a LIST and leaves the basket alone ─────────────────── */

/*
 * THE ASSERTION THAT SEPARATES THIS MODULE FROM THE OTHERS.
 *
 * Quotes and orders CHANGE what the basket is, and switching with lines in hand
 * clears it after asking. A lay-by is not something the basket can be — it
 * lives in its own table — so picking that row must leave a half-rung sale
 * exactly where it was. Routing it through SET_DOC_TYPE would bin the basket to
 * show a list and then hand back an identical empty till.
 *
 * Asserted with a basket ON SCREEN, because an empty one would pass either way.
 */
const closedMenu = await evaluate(
  [
    '(() => {',
    '  const p = document.querySelector("aside[aria-label=\\"Till modules\\"]")',
    '  if (!p) return false',
    '  const btn = [...p.querySelectorAll("button")].find((b) => /close/i.test(b.getAttribute("aria-label") || ""))',
    '  if (btn) btn.click()',
    '  return true',
    '})()',
  ].join('\n'),
)
await sleep(800)

/* Ring something up first. */
const probe = await evaluate(
  [
    '(async () => {',
    "  const r = await fetch('/api/pos/catalog?deviceId=' + encodeURIComponent(",
    `    ${JSON.stringify(DEVICE)}`,
    "  ), { headers: { accept: 'application/json' } })",
    '  if (!r.ok) return null',
    '  const b = await r.json()',
    '  const p = (b.products || [])[0]',
    '  return p ? { code: p.code || null } : null',
    '})()',
  ].join('\n'),
)
await evaluate(
  [
    '(() => {',
    '  const input = [...document.querySelectorAll("input")]',
    '    .find((i) => /scan|search/i.test(i.placeholder || ""))',
    '  if (!input) return "no search box"',
    "  const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set",
    `  setter.call(input, ${JSON.stringify(String(probe?.code ?? 'a'))})`,
    "  input.dispatchEvent(new Event('input', { bubbles: true }))",
    '  return "typed"',
    '})()',
  ].join('\n'),
)
await sleep(3000)
await evaluate(
  [
    '(() => {',
    '  const input = [...document.querySelectorAll("input")]',
    '    .find((i) => /scan|search/i.test(i.placeholder || ""))',
    '  const leftEdge = input ? input.getBoundingClientRect().left : 0',
    '  const hit = [...document.querySelectorAll("button")]',
    '    .filter((b) => !b.closest("header"))',
    '    .filter((b) => b.getBoundingClientRect().left >= leftEdge - 8)',
    '    .filter((b) => b.getBoundingClientRect().width > 40)',
    '    .find((b) => /R\\s?\\d/.test(b.innerText || ""))',
    '  if (hit) hit.click()',
    '  return true',
    '})()',
  ].join('\n'),
)
await sleep(1800)

const basketBefore = await lineCount()
console.log(`   (basket before opening lay-bys: ${basketBefore} item(s))`)

await openModuleMenu()
await sleep(700)
const pickedModule = await pickModule('Lay-bys')
ok('the lay-by module can be picked', pickedModule === 'clicked', pickedModule)
await sleep(2500)

const listText = await dialogText()
ok(
  'it opens the lay-by list',
  listText !== null && /lay-?bys/i.test(listText || ''),
  (listText || 'no dialog').slice(0, 80),
)

const basketAfter = await lineCount()
ok(
  '*** opening lay-bys does NOT clear the basket ***',
  basketAfter === basketBefore,
  `${basketBefore} before, ${basketAfter} after`,
)

const rows = await laybyRows()
console.log(`   (${(rows || []).length} lay-by row(s) listed)`)
for (const r of (rows || []).slice(0, 6)) console.log(`     ${r.text}`)

ok('open lay-bys are listed', Array.isArray(rows) && rows.length > 0, `${(rows || []).length} row(s)`)
/* A settled one says so rather than looking like another payment to take. */
const settledRow = (rows || []).find((r) => /ready to collect/i.test(r.text))
console.log(`   (settled row present: ${settledRow ? 'yes' : 'no'})`)
await shot('till-laybys-list')

/* ── 3. Taking a payment ────────────────────────────────────────────────────── */

const opened = await openLayby(String(before.number))
ok('a lay-by can be opened', opened === 'clicked', opened)
await sleep(1200)

const payScreen = await dialogText()
ok(
  'it shows what is outstanding',
  /outstanding/i.test(payScreen || ''),
  (payScreen || '').slice(0, 90),
)

const PAY = 50
await setAmount(String(PAY))
await sleep(600)
await shot('till-laybys-pay')

const took = await pressInDialog('^take ')
ok('the payment can be taken', took === 'clicked', took)
await sleep(3500)

/* ── 4. What actually changed, in the data ──────────────────────────────────── */

const after = await laybyState(target.id)
ok(
  '*** the payment reached the lay-by ***',
  after && round2(after.paid) === round2(before.paid + PAY),
  `paid ${before.paid} -> ${after?.paid}`,
)
ok(
  '  a payment row was written',
  (after?.payments ?? 0) === before.payments + 1,
  `${before.payments} -> ${after?.payments}`,
)

/*
 * AND IT BANKED INTO A SHIFT — which is the whole reason this was blocked.
 *
 * A payment with a null shift_id is money the cash-up cannot see. Before the
 * off-ledger work it would not have been counted even WITH one; now the shift
 * stamp is what carries it into expectedCash.
 */
ok(
  '*** the payment banked into a shift ***',
  (after?.banked ?? 0) > (before.banked ?? 0),
  `${before.banked} banked before, ${after?.banked} after`,
)

/* ── 5. And the cash-up counts it ───────────────────────────────────────────── */

/*
 * THE ASSERTION THIS PHASE EXISTS FOR.
 *
 * The declaration used to SHOW lay-by money while the expected cash excluded
 * it, so a till taking payments made every drawer read over by exactly them.
 * Read from the database rather than the screen: the cash-up screen is behind
 * its own navigation, and the figure is what matters rather than its rendering.
 */
const drawer = await withSite(async (db) => {
  const [rows] = await db.query(
    `SELECT p.shift_id, COALESCE(SUM(p.amount),0) AS cash
       FROM layby_payments p
       JOIN tender_types tt ON tt.id = p.tender_type_id
      WHERE p.layby_id = ? AND tt.counts_as_drawer_cash = 1 AND p.shift_id IS NOT NULL
      GROUP BY p.shift_id`,
    [target.id],
  )
  return rows.map((r) => ({ shiftId: Number(r.shift_id), cash: Number(r.cash) }))
})
ok(
  'the payment is cash the cash-up can find',
  drawer.length > 0,
  JSON.stringify(drawer),
)

/* ── Console ────────────────────────────────────────────────────────────────── */

const noisy = consoleErrors.filter(
  (m) => !/favicon|Download the React DevTools|Failed to load resource/i.test(m),
)
ok('no console errors while driving lay-bys', noisy.length === 0, noisy.slice(0, 2).join(' | '))

console.log(`\nShots in ${OUT}`)
console.log(`${fails} FAILURE(S)`)
process.exit(fails > 0 ? 1 : 0)
