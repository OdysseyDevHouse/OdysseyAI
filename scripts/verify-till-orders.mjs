// Proves sales orders work at the till: the list is what is still owed, and
// handing one over DELIVERS it — goods out, invoice onto the basket.
//
//   node --env-file=.env --env-file=.env.local scripts/verify-till-orders.mjs
//
// BOTH env files: the login lives in .env.local and SESSION_SECRET — which the
// till cookie is signed with — lives in .env.
//
// ── WHY THIS DIFFERS FROM verify-till-quotes ─────────────────────────────────
//
// A quote recall puts a price on screen and nothing has happened. Collecting an
// ORDER is a delivery: the outstanding quantities drop, a linked invoice is
// raised for exactly what went out, and the fulfilment status moves. None of
// that is undone by clearing the basket.
//
// So the assertions here are about STATE THAT CHANGED, not just what rendered:
// the order is gone from the list afterwards because nothing is outstanding,
// the basket is an INVOICE rather than an order, and the delivery invoice
// exists in the database linked back to the order it came from.
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

const { wsUrl, close: closeChrome } = await launchChrome('ord')

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
  name: 'Orders verifier',
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

/** The pane's recall key — "Saved", "Quotes" or "Orders" by module. */
const recallKeyLabel = () =>
  evaluate(
    [
      '(() => {',
      '  const btn = [...document.querySelectorAll("button")]',
      '    .filter((b) => !b.closest("header") && !b.closest("dialog"))',
      '    .find((b) => /^(saved|quotes|orders)\\b/i.test((b.innerText || "").trim()))',
      '  return btn ? (btn.innerText || "").replace(/\\s+/g, " ").trim() : null',
      '})()',
    ].join('\n'),
  )

const pressRecallKey = () =>
  evaluate(
    [
      '(() => {',
      '  const btn = [...document.querySelectorAll("button")]',
      '    .filter((b) => !b.closest("header") && !b.closest("dialog"))',
      '    .find((b) => /^(saved|quotes|orders)\\b/i.test((b.innerText || "").trim()))',
      '  if (!btn) return "no key"',
      '  btn.click()',
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

const orderRows = () =>
  evaluate(
    [
      '(() => {',
      '  const d = document.querySelector("dialog[open]")',
      '  if (!d) return null',
      '  return [...d.querySelectorAll("button")]',
      '    .filter((b) => !/^close$/i.test((b.innerText || "").trim()))',
      '    .filter((b) => (b.innerText || "").trim().length > 8)',
      '    .map((b) => ({',
      '      text: (b.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 100),',
      '      disabled: b.disabled === true,',
      '    }))',
      '})()',
    ].join('\n'),
  )

const closeDialog = () =>
  evaluate(
    [
      '(() => {',
      '  const d = document.querySelector("dialog[open]")',
      '  if (!d) return "no dialog"',
      '  const btn = [...d.querySelectorAll("button")].find((b) => /^close$/i.test((b.innerText || "").trim()))',
      '  if (!btn) return "no close"',
      '  btn.click()',
      '  return "clicked"',
      '})()',
    ].join('\n'),
  )

/* ── The database, for the half the screen cannot answer ────────────────────── */

/**
 * A delivery is a STATE CHANGE, and the screen only shows its consequences.
 *
 * Whether the outstanding quantities actually dropped, and whether the invoice
 * that came back is linked to the order it was raised against, are questions
 * only the data answers — a basket with the right lines on it would look
 * identical either way.
 */
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

const orderState = (id) =>
  withSite(async (db) => {
    const [rows] = await db.query(
      `SELECT d.status, COALESCE(o.fulfilment_status,'open') AS fulfilment,
              COALESCE(SUM(l.qty),0) AS ordered,
              COALESCE(SUM(l.qty_delivered),0) AS delivered
         FROM sales_documents d
         LEFT JOIN sales_order_details o ON o.document_id = d.id
         LEFT JOIN sales_document_lines l ON l.document_id = d.id
        WHERE d.id = ?
        GROUP BY d.status, o.fulfilment_status`,
      [id],
    )
    if (!rows.length) return null
    const [inv] = await db.query(
      `SELECT id, status, total_incl FROM sales_documents
        WHERE converted_from_id = ? AND doc_type = 'invoice' ORDER BY id DESC`,
      [id],
    )
    return {
      status: rows[0].status,
      fulfilment: rows[0].fulfilment,
      ordered: Number(rows[0].ordered),
      delivered: Number(rows[0].delivered),
      invoices: inv.map((r) => ({ id: r.id, status: r.status, total: Number(r.total_incl) })),
    }
  })

/** The outstanding order this run works against, chosen before anything is driven. */
const target = await withSite(async (db) => {
  const [rows] = await db.query(
    `SELECT d.id, d.document_number, d.total_incl
       FROM sales_documents d
       LEFT JOIN sales_order_details o ON o.document_id = d.id
       LEFT JOIN sales_document_lines l ON l.document_id = d.id
      WHERE d.doc_type = 'sales_order' AND d.status <> 'cancelled'
        AND COALESCE(o.fulfilment_status,'open') IN ('open','part_delivered')
      GROUP BY d.id, d.document_number, d.total_incl
     HAVING COALESCE(SUM(l.qty),0) - COALESCE(SUM(l.qty_delivered),0) > 0
      ORDER BY d.id DESC LIMIT 1`,
  )
  return rows.length ? { id: Number(rows[0].id), total: Number(rows[0].total_incl) } : null
})

if (!target) {
  /*
   * NOT a silent pass. Every assertion below works against a real outstanding
   * order, and over an empty list they would all pass while proving nothing.
   */
  console.log('')
  console.log('**SKIPPED**  no outstanding sales order on this site, so nothing could be')
  console.log('             collected. Create one and re-run; nothing is proven.')
  process.exit(1)
}
const before = await orderState(target.id)
console.log(
  `target order #${target.id}: ${before.delivered}/${before.ordered} delivered, ${before.fulfilment}`,
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
  console.log('\nStill on a gate. Nothing about orders is proven either way.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}

/* ── 1. Switch to orders, and the key becomes the order list ────────────────── */

await openModuleMenu()
await sleep(700)
const switched = await pickModule('Sales orders')
ok('the till can be switched to orders', switched === 'clicked', switched)
await sleep(1500)

const orderHeading = await heading()
ok('the header names an order', /order/i.test(orderHeading), orderHeading.slice(0, 40))

const key = await recallKeyLabel()
ok('the recall key becomes the order list', /^orders/i.test(key || ''), key || 'no key found')

/* ── 2. The list shows what is still owed ───────────────────────────────────── */

const pressed = await pressRecallKey()
ok('the order list opens', pressed === 'clicked', pressed)
await sleep(2500)

const listed = await dialogText()
ok(
  'it is the orders dialog',
  listed !== null && /sales orders/i.test(listed || '') && /hand it over/i.test(listed || ''),
  (listed || 'no dialog').slice(0, 80),
)
/*
 * THE WORDING IS AN ASSERTION, not decoration.
 *
 * Tapping a row here commits stock that cannot be un-committed by the same
 * gesture — unlike the quote list, where a tap only puts a price on screen. The
 * dialog has to say so before somebody finds out.
 */
ok(
  'the dialog says what tapping one DOES',
  /goods go out/i.test(listed || '') && /invoice/i.test(listed || ''),
  (listed || '').slice(0, 110),
)
await shot('till-orders-list')

const rows = await orderRows()
console.log(`   (${(rows || []).length} order row(s) listed)`)
for (const r of (rows || []).slice(0, 6)) {
  console.log(`     ${r.disabled ? 'inert ' : 'tap   '} ${r.text}`)
}

const haveRows = Array.isArray(rows) && rows.length > 0
ok('outstanding orders are listed', haveRows, `${(rows || []).length} row(s)`)
if (!haveRows) {
  console.log('\nNo rows to work with, so the collection was never exercised.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}

/* The list leads with what is STILL OWED, not the order's total — on a
   part-delivered order those differ, and the outstanding figure is what the
   cashier is about to hand over. */
ok(
  'each row says how much is still owed',
  (rows || []).every((r) => /still owed/i.test(r.text)),
  (rows || []).map((r) => r.text.slice(0, 40))[0],
)

/* ── 3. Handing one over delivers it ────────────────────────────────────────── */

const tapped = await evaluate(
  [
    '(() => {',
    '  const d = document.querySelector("dialog[open]")',
    '  if (!d) return "no dialog"',
    '  const hit = [...d.querySelectorAll("button")]',
    '    .filter((b) => !/^close$/i.test((b.innerText || "").trim()))',
    '    .filter((b) => (b.innerText || "").trim().length > 8)',
    '    .filter((b) => !b.disabled)[0]',
    '  if (!hit) return "none tappable"',
    '  hit.click()',
    '  return "clicked"',
    '})()',
  ].join('\n'),
)
ok('an order can be handed over', tapped === 'clicked', tapped)
await sleep(4000)

ok('the list closes once an order is taken', (await dialogText()) === null)

const basket = await lineCount()
ok(
  'the order lines land in the basket',
  typeof basket === 'number' && basket > 0,
  `${basket} item(s)`,
)

/*
 * AND THE BASKET IS AN INVOICE.
 *
 * The opposite of the quote rule, and just as load-bearing. What came back is
 * the DELIVERY invoice — the order stays an order and has already moved on. A
 * basket still calling itself an order would put a Save key where Pay belongs
 * and leave the goods handed over with nothing collected for them.
 */
const afterHeading = await heading()
ok(
  'the basket is an INVOICE to be paid, not an order',
  /current sale/i.test(afterHeading) && !/sales order/i.test(afterHeading),
  afterHeading.slice(0, 40),
)
await shot('till-orders-collected')

/* ── 4. What actually changed, in the data ──────────────────────────────────── */

const after = await orderState(target.id)
ok(
  'the outstanding quantity dropped',
  after && after.delivered > before.delivered,
  `delivered ${before.delivered} -> ${after?.delivered}`,
)
ok(
  'the order is now marked delivered',
  after?.fulfilment === 'delivered',
  `${before.fulfilment} -> ${after?.fulfilment}`,
)
ok(
  'a delivery invoice was raised against the order',
  (after?.invoices.length ?? 0) > (before.invoices.length ?? 0),
  JSON.stringify(after?.invoices ?? []),
)

/* ── 5. And it is gone from the list ────────────────────────────────────────── */

/*
 * The list is OUTSTANDING ONLY, so an order handed over in full must not appear
 * again — showing it would invite somebody to collect the same goods twice.
 *
 * Checked on a fresh basket: the list refuses to open over one, which is its own
 * guard and would otherwise be mistaken for the order having vanished.
 */
await evaluate(
  [
    '(() => {',
    '  const btn = [...document.querySelectorAll("button")]',
    '    .filter((b) => !b.closest("header") && !b.closest("dialog"))',
    '    .find((b) => /^close\\b/i.test((b.innerText || "").trim()))',
    '  if (btn) btn.click()',
    '  return true',
    '})()',
  ].join('\n'),
)
await sleep(2000)

/* Close may raise "save, void or carry on" on a basket with lines. */
const afterClose = await dialogText()
if (afterClose && /void|discard|clear/i.test(afterClose)) {
  await evaluate(
    [
      '(() => {',
      '  const d = document.querySelector("dialog[open]")',
      '  if (!d) return false',
      '  const btn = [...d.querySelectorAll("button")].find((b) => /void|discard|clear/i.test(b.innerText || ""))',
      '  if (btn) btn.click()',
      '  return true',
      '})()',
    ].join('\n'),
  )
  await sleep(2500)
}

if (await onGate()) {
  await evaluate(
    [
      '(() => {',
      '  const all = [...document.querySelectorAll("button")].filter((b) => !b.closest("header"))',
      '  const quick = all.find((b) => /quick sale|walk-?in|no table/i.test(b.innerText || ""))',
      '  if (quick) { quick.click(); return true }',
      '  return false',
      '})()',
    ].join('\n'),
  )
  await sleep(2500)
}

/*
 * BACK TO THE ORDER MODULE, and the basket must be empty first.
 *
 * The first run of this never reached the list: after a collection the basket
 * is an INVOICE on a hospitality till, where the park keys are correctly hidden
 * — so there was no recall key to press. That was the setup being wrong rather
 * than the screen, and worth writing down because "no key" reads like a bug in
 * the feature when it is a bug in the test.
 */
if (!/sales order/i.test(await heading())) {
  await openModuleMenu()
  await sleep(700)
  await pickModule('Sales orders')
  await sleep(1500)
  /* Switching with lines in hand asks first — confirm it, since the basket has
     already been through the assertions that needed it. */
  const asked = await dialogText()
  if (asked && /cleared/i.test(asked)) {
    await evaluate(
      [
        '(() => {',
        '  const d = document.querySelector("dialog[open]")',
        '  if (!d) return false',
        '  const btn = [...d.querySelectorAll("button")].find((b) => /^yes/i.test((b.innerText || "").trim()))',
        '  if (btn) btn.click()',
        '  return true',
        '})()',
      ].join('\n'),
    )
    await sleep(1800)
  }
}

const reopened = await pressRecallKey()
if (reopened === 'clicked') {
  await sleep(2500)
  const nowRows = await orderRows()
  const stillListed = (nowRows || []).some((r) => r.text.includes(String(target.id)))
  ok(
    'a fully delivered order drops off the list',
    !stillListed,
    `${(nowRows || []).length} row(s) remain`,
  )
  await closeDialog()
} else {
  console.log(`   (list not re-opened: ${reopened})`)
}

/* ── Console ────────────────────────────────────────────────────────────────── */

const noisy = consoleErrors.filter(
  (m) => !/favicon|Download the React DevTools|Failed to load resource/i.test(m),
)
ok('no console errors while driving orders', noisy.length === 0, noisy.slice(0, 2).join(' | '))

console.log(`\nShots in ${OUT}`)
console.log(`${fails} FAILURE(S)`)
process.exit(fails > 0 ? 1 : 0)
