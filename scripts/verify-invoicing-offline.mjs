// What the invoicing window actually does when the shop server dies.
//
//   node --env-file=.env --env-file=.env.local scripts/verify-invoicing-offline.mjs
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// The window was built on a promise: a hardware shop whose local server crashes
// keeps invoicing, because everything reachable from here is invoicing and the
// back-office rail — full of screens that cannot survive it — has been removed.
//
// That promise had never been TESTED. All four screens are server-rendered async
// pages that query the database on every request, so the honest question is not
// whether they keep working (they cannot) but what an operator is left looking
// at: their work, an explanation, or a blank window.
//
// Driven with a real offline condition through CDP rather than a stubbed fetch,
// so what is measured is the state a dead server actually produces.
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
const PORT = 9399
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
const profile = path.join(tmpdir(), `odyssey-ioff-${process.pid}`)
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
  name: 'Invoicing window',
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

/* ── What an operator sees when the line goes ───────────────────────────── */

const bodyText = () =>
  evaluate('(document.body.innerText || "").replace(/\\s+/g, " ").trim()')

/*
 * A GENUINE offline condition, not a stubbed fetch — Chrome stops the requests
 * at the network layer, which is the state a shop with a dead server is in.
 */
async function setOffline(offline) {
  await send(
    'Network.emulateNetworkConditions',
    { offline, latency: 0, downloadThroughput: offline ? 0 : -1, uploadThroughput: offline ? 0 : -1 },
    sessionId,
  )
}

/* ── Online first, so there is something to compare against ─────────────── */

await goto('/invoicing')
const onlineText = await bodyText()
ok(
  'the register renders while the line is up',
  /invoicing/i.test(onlineText),
  onlineText.slice(0, 60),
)

/* The window is loaded and interactive. THIS is the moment a shop's server
   dies — mid-shift, with the screen already open. */
await setOffline(true)
await sleep(2500)
console.log(`   (navigator.onLine = ${await evaluate('navigator.onLine')})`)

/*
 * ── 1. DOES THE OPEN SCREEN SURVIVE? ──────────────────────────────────────
 *
 * The page is already painted, so the answer should be yes — nothing repaints
 * it until something asks the server. That is worth pinning down, because it
 * is the difference between "the shop keeps looking at its work" and "the
 * screen goes white the moment the line drops".
 */
const afterCut = await bodyText()
ok(
  '*** the screen already open survives the line dropping ***',
  /invoicing/i.test(afterCut),
  afterCut.slice(0, 60),
)
await shot('invoicing-offline-open')

/*
 * ── 2. AND MOVING BETWEEN SCREENS? ────────────────────────────────────────
 *
 * This is the real question. Every screen in this window is a server-rendered
 * async page that queries the database on each request, so navigating with no
 * server means a request that cannot be answered.
 *
 * Recorded rather than asserted-as-passing: what matters is knowing WHAT the
 * operator gets — a stale screen, an error, or a blank page — because the
 * window was built on the promise that it keeps working.
 */
const before = await evaluate('location.pathname')
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
await sleep(900)
const menuOpened = await evaluate(
  '!!document.querySelector("aside[aria-label=\\"Invoicing screens\\"]")',
)
ok(
  'the menu still opens offline (it is local state)',
  menuOpened === true,
  String(menuOpened),
)

await evaluate(
  [
    '(() => {',
    '  const p = document.querySelector("aside[aria-label=\\"Invoicing screens\\"]")',
    '  if (!p) return false',
    '  const row = [...p.querySelectorAll("a")].find((a) => /quotes/i.test(a.innerText || ""))',
    '  if (row) row.click()',
    '  return true',
    '})()',
  ].join('\n'),
)
await sleep(5000)

const after = await evaluate('location.pathname')
const navText = await bodyText()
const moved = after !== before
const blank = navText.length < 40
const errored = /could not load|couldn.t load|something went wrong|error|failed/i.test(navText)

console.log('')
console.log('── NAVIGATING WITH NO SERVER ────────────────────────────────')
console.log(`   path:    ${before} -> ${after}${moved ? '' : '  (did not move)'}`)
console.log(`   content: ${blank ? 'BLANK' : errored ? 'ERROR' : 'rendered'}`)
console.log(`   text:    ${navText.slice(0, 90) || '(nothing)'}`)
console.log('')
await shot('invoicing-offline-navigate')

/*
 * THE HONEST ASSERTION.
 *
 * Not "navigation works offline" — it cannot, and pretending otherwise would
 * be a test written to pass. What a counter needs is to not be left staring at
 * a blank window with no idea whether the system is gone: either the screen it
 * had stays put, or something says what happened.
 */
ok(
  '*** the operator is not left with a blank window ***',
  !blank,
  blank ? 'the page went blank — nothing on screen to explain it' : 'something is on screen',
)

/* ── 3. And back on the line ────────────────────────────────────────────── */

await setOffline(false)
await sleep(2500)
await goto('/invoicing')
const recovered = await bodyText()
ok(
  'the window recovers once the line is back',
  /invoicing/i.test(recovered),
  recovered.slice(0, 60),
)

const noisy = consoleErrors.filter((m) => !/favicon|DevTools|Failed to load resource/i.test(m))
console.log(`   (console while offline: ${noisy.length} error(s))`)

console.log(`\nShots in ${OUT}`)
console.log(`${fails} FAILURE(S)`)
process.exit(fails > 0 ? 1 : 0)
