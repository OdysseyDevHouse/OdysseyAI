// Proves a lay-by can be STARTED from the basket at the till.
//
//   node --env-file=.env --env-file=.env.local scripts/verify-till-start-layby.mjs
//
// BOTH env files: the login lives in .env.local and SESSION_SECRET — which the
// till cookie is signed with — lives in .env.
//
// ── WHY THIS MATTERS MORE THAN IT LOOKS ──────────────────────────────────────
//
// createLaybyAction existed in the back office with NO CALLER, so the product
// had no way to open a lay-by anywhere — the ones on a system got there by
// import. This is the first screen that creates one.
//
// The assertions that count read the database: a lay-by row with the basket's
// lines on it, a deposit written as a payment, and that payment banked into
// the till's shift so the cash-up counts it. A dialog that closes proves none
// of that.
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
import { launchChrome } from './lib/cdp-chrome.mjs'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const SECRET = process.env.SESSION_SECRET
const BASE = process.env.APP_URL || 'http://localhost:4100'
const OUT = process.env.SHOT_DIR || path.join(process.cwd(), '.screenshots')
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

mkdirSync(OUT, { recursive: true })

const { wsUrl, close: closeChrome } = await launchChrome('new')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
process.on('exit', () => {
})


const ws = new WebSocket(wsUrl)
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
  name: 'New lay-by verifier',
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

const dialogText = () =>
  evaluate(
    [
      '(() => {',
      '  const d = document.querySelector("dialog[open]")',
      '  return d ? (d.innerText || "").replace(/\\s+/g, " ").trim() : null',
      '})()',
    ].join('\n'),
  )

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

/** Whether the dialog's confirm button is pressable. */
const confirmDisabled = (pattern) =>
  evaluate(
    [
      '(() => {',
      '  const d = document.querySelector("dialog[open]")',
      '  if (!d) return null',
      `  const re = new RegExp(${JSON.stringify(pattern)}, "i")`,
      '  const btn = [...d.querySelectorAll("button")].find((b) => re.test(b.innerText || ""))',
      '  return btn ? btn.disabled === true : null',
      '})()',
    ].join('\n'),
  )

const setMoney = (value) =>
  evaluate(
    [
      '(() => {',
      '  const d = document.querySelector("dialog[open]")',
      '  if (!d) return "no dialog"',
      '  const input = [...d.querySelectorAll("input")].find((i) => i.type !== "date")',
      '  if (!input) return "no input"',
      "  const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set",
      `  setter.call(input, ${JSON.stringify(String(value))})`,
      "  input.dispatchEvent(new Event('input', { bubbles: true }))",
      '  return "typed"',
      '})()',
    ].join('\n'),
  )

/**
 * Opens the "put this aside" dialog.
 *
 * Through the MODULE MENU and the lay-by list, which is the route a cashier
 * has: the other way in is a quick key, and a shop configures those itself —
 * this dev site has none, so driving a tile would test the setup rather than
 * the feature. That gap is exactly why the button is on the list at all.
 */
async function openStartDialog() {
  await evaluate(
    [
      '(() => {',
      '  const btn = [...document.querySelectorAll("header button")]',
      '    .find((b) => /go to/i.test(b.getAttribute("aria-label") || b.title || ""))',
      '  if (btn) btn.click()',
      '  return true',
      '})()',
    ].join('\n'),
  )
  await sleep(800)
  await evaluate(
    [
      '(() => {',
      '  const p = document.querySelector("aside[aria-label=\\"Till modules\\"]")',
      '  if (!p) return "no panel"',
      '  const row = [...p.querySelectorAll("button")].find((el) => /lay-?by/i.test(el.innerText || ""))',
      '  if (row) row.click()',
      '  return true',
      '})()',
    ].join('\n'),
  )
  await sleep(2500)
  return pressInDialog('put this basket aside')
}

/* ── The database ───────────────────────────────────────────────────────────── */

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

/** The newest lay-by, with everything hanging off it. */
const newestLayby = () =>
  withSite(async (db) => {
    const [rows] = await db.query(
      `SELECT id, document_number, status, total_incl, paid_total, due_date, customer_id
         FROM laybys ORDER BY id DESC LIMIT 1`,
    )
    if (!rows.length) return null
    const id = Number(rows[0].id)
    const [lines] = await db.query(
      'SELECT COUNT(*) AS n, COALESCE(SUM(line_total_incl),0) AS total FROM layby_lines WHERE layby_id = ?',
      [id],
    )
    const [pays] = await db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total, COUNT(shift_id) AS banked
         FROM layby_payments WHERE layby_id = ?`,
      [id],
    )
    return {
      id,
      number: rows[0].document_number,
      status: rows[0].status,
      total: Number(rows[0].total_incl),
      paid: Number(rows[0].paid_total),
      dueDate: rows[0].due_date ? String(rows[0].due_date).slice(0, 10) : null,
      customerId: Number(rows[0].customer_id),
      lines: Number(lines[0].n),
      linesTotal: Number(lines[0].total),
      payments: Number(pays[0].n),
      paid_rows: Number(pays[0].total),
      banked: Number(pays[0].banked),
    }
  })

const before = await newestLayby()
console.log(`newest lay-by before: ${before ? `#${before.id} ${before.number}` : 'none'}`)

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
  console.log('\nStill on a gate. Nothing is proven.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}

/* ── Ring something up ──────────────────────────────────────────────────────── */

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

const basket = await lineCount()
ok('a basket can be rung up', typeof basket === 'number' && basket > 0, `${basket} item(s)`)
if (!basket) {
  console.log('\nNothing could be rung up, so nothing could be put aside.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}

/* ── The dialog refuses without a customer ──────────────────────────────────── */

/*
 * A lay-by is goods held for a NAMED person, for weeks, against money they have
 * not finished paying. "Walk-in" cannot come back and claim it — so this is the
 * one thing the dialog refuses without, and it says so rather than failing on a
 * round trip after the cashier has filled the rest in.
 *
 * Opened through the shell's own handler: the key is a shop-configured quick key
 * and this dev site has none, so driving the tile would be testing the setup
 * rather than the feature.
 */
const opened = await openStartDialog()
if (opened !== 'clicked') {
  console.log('')
  console.log(`**SKIPPED**  no way to open the dialog from this build (${opened}).`)
  console.log('             The action is covered by the database assertions below only if')
  console.log('             the dialog can be reached; it cannot, so nothing is proven.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}
await sleep(1200)

const noCustomer = await dialogText()
ok(
  'the dialog opens against the basket',
  noCustomer !== null && /lay-?by/i.test(noCustomer || ''),
  (noCustomer || 'no dialog').slice(0, 80),
)
ok(
  '*** it refuses without a customer, and says why ***',
  /attach the customer/i.test(noCustomer || ''),
  (noCustomer || '').slice(0, 100),
)
ok(
  '  and the confirm cannot be pressed',
  (await confirmDisabled('open it')) === true,
  String(await confirmDisabled('open it')),
)
await shot('till-start-layby-no-customer')

/* ── Attach a customer, then open it ────────────────────────────────────────── */

await pressInDialog('cancel')
await sleep(800)

const attached = await evaluate(
  [
    '(async () => {',
    '  const btn = [...document.querySelectorAll("button")]',
    '    .find((b) => /attach customer|tap to change/i.test(b.innerText || ""))',
    '  if (!btn) return "no customer key"',
    '  btn.click()',
    '  return "opened"',
    '})()',
  ].join('\n'),
)
await sleep(2000)
console.log(`   (dialog after the customer key: ${(await dialogText())?.slice(0, 70) ?? 'none'})`)
/*
 * THE PICKER LISTS NOTHING UNTIL IT IS SEARCHED — two characters minimum, so a
 * counter machine does not hold the whole debtor book in memory. The first run
 * found "no account rows" and read as a broken dialog; it was an unsearched one.
 *
 *  * TWO letters — one is below the threshold and returns nothing, which is what
 * the second run tripped over. "ca" matches Harbour Cafe and Catering alike.
 */
await evaluate(
  [
    '(() => {',
    '  const d = document.querySelector("dialog[open]")',
    '  if (!d) return "no picker"',
    '  const input = [...d.querySelectorAll("input")].find((i) => /search/i.test(i.placeholder || ""))',
    '  if (!input) return "no search box"',
    "  const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set",
    "  setter.call(input, 'ca')",
    "  input.dispatchEvent(new Event('input', { bubbles: true }))",
    '  return "typed"',
    '})()',
  ].join('\n'),
)
await sleep(2500)

/*
 * A REAL ACCOUNT, not simply the first row.
 *
 * The picker leads with "Walk-in sale", which is the DETACH option — and a
 * lay-by refusing that is the rule under test rather than a way to satisfy it.
 * The first run clicked it and the dialog correctly stayed refused, which read
 * as a broken feature until the log showed which row had been chosen.
 */
const chose = await evaluate(
  [
    '(() => {',
    '  const d = document.querySelector("dialog[open]")',
    '  if (!d) return "no picker"',
    '  const row = [...d.querySelectorAll("button")]',
    '    .filter((b) => !/^(close|cancel|search)$/i.test((b.innerText || "").trim()))',
    '    .filter((b) => !/walk-?in/i.test(b.innerText || ""))',
    '    .filter((b) => (b.innerText || "").trim().length > 4)[0]',
    '  if (!row) return "no account rows"',
    '  row.click()',
    '  return (row.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40)',
    '})()',
  ].join('\n'),
)
await sleep(2500)
console.log(`   (customer: ${attached} -> ${chose})`)

await openStartDialog()
await sleep(1200)

const withCustomer = await dialogText()
/*
 * The ABSENCE of the refusal matters as much as the presence of the name.
 *
 * Matching /held for/ alone passed on the first run while the dialog was still
 * showing "Attach the customer first" — the word appears in that copy too, so
 * the assertion agreed with a screen that had refused. Both halves are checked.
 */
ok(
  '*** with a customer attached it says who it is held for ***',
  /held for/i.test(withCustomer || '') && !/attach the customer/i.test(withCustomer || ''),
  (withCustomer || '').slice(0, 90),
)

/* The due date comes from the SHOP's term, computed on the server. */
const dueOnScreen = await evaluate(
  [
    '(() => {',
    '  const d = document.querySelector("dialog[open]")',
    '  if (!d) return null',
    '  const input = [...d.querySelectorAll("input")].find((i) => i.type === "date")',
    '  return input ? input.value : null',
    '})()',
  ].join('\n'),
)
ok('it opens with a collect-by date', !!dueOnScreen, String(dueOnScreen))

const DEPOSIT = 20
await setMoney(String(DEPOSIT))
await sleep(700)
await shot('till-start-layby')

const confirmed = await pressInDialog('open it')
ok('the lay-by can be opened', confirmed === 'clicked', confirmed)
await sleep(4000)

/* ── What actually exists now ───────────────────────────────────────────────── */

const after = await newestLayby()
ok(
  '*** a lay-by was created ***',
  after && (!before || after.id > before.id),
  after ? `#${after.id} ${after.number}` : 'none',
)
if (!after || (before && after.id === before.id)) {
  console.log('\nNo lay-by was written, so nothing below can be checked.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}

ok('  it carries the basket lines', after.lines > 0, `${after.lines} line(s)`)
ok('  it is open', after.status === 'open', after.status)
ok(
  '  the total matches its lines',
  round2(after.total) === round2(after.linesTotal),
  `header ${after.total} vs lines ${after.linesTotal}`,
)
ok('  it has a number', !!after.number, String(after.number))
ok('  it is held for a customer', after.customerId > 0, String(after.customerId))
ok('  the shop term became a due date', !!after.dueDate, String(after.dueDate))

/*
 * THE DEPOSIT IS THE SAME MONEY AS AN INSTALMENT.
 *
 * It writes a layby_payments row and banks into this till's shift, which is
 * what carries it into the cash-up's expected cash. Before the off-ledger work
 * that money was shown on the declaration and left out of the figure it was
 * counted against — so this assertion is the one that says the key is safe to
 * put in front of a cashier.
 */
ok(
  '*** the deposit was written as a payment ***',
  after.payments === 1 && round2(after.paid_rows) === DEPOSIT,
  `${after.payments} payment(s) totalling ${after.paid_rows}`,
)
ok(
  '*** and it banked into a shift ***',
  after.banked === 1,
  `${after.banked} of ${after.payments} banked`,
)
ok(
  '  the outstanding balance is the rest',
  round2(after.total - after.paid) === round2(after.total - DEPOSIT),
  `${after.paid} paid of ${after.total}`,
)

/* ── And the till went back to empty ────────────────────────────────────────── */

/*
 * A lay-by is not a sales document and never becomes the one on screen. Leaving
 * the lines up would invite somebody to take payment for goods now sitting on a
 * shelf with a name on them.
 */
const basketAfter = await lineCount()
ok('*** the basket is cleared ***', basketAfter === 0, `${basketAfter} item(s) left`)
await shot('till-start-layby-done')

/* ── Console ────────────────────────────────────────────────────────────────── */

const noisy = consoleErrors.filter(
  (m) => !/favicon|Download the React DevTools|Failed to load resource/i.test(m),
)
ok('no console errors', noisy.length === 0, noisy.slice(0, 2).join(' | '))

console.log(`\nShots in ${OUT}`)
console.log(`created lay-by #${after.id} (${after.number}) — remove it after reading the shots`)
console.log(`${fails} FAILURE(S)`)
process.exit(fails > 0 ? 1 : 0)
