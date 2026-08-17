// Proves the invoicing window is its own room: no back-office rail, its own
// way between the four screens, and the old URLs still land somewhere.
//
//   node --env-file=.env --env-file=.env.local scripts/verify-invoicing-window.mjs
//
// BOTH env files: the login lives in .env.local and SESSION_SECRET in .env.
//
// ── WHY THE MISSING SIDEBAR IS THE ASSERTION ─────────────────────────────────
//
// Invoicing, quotes, orders and lay-bys are what a trade counter does all day,
// and that counter has to keep working when the shop server dies. A rail full
// of screens that CANNOT survive that — Customers, Suppliers, Reports — is a
// way for an operator to land on a dead page mid-document. So its absence is
// the feature, and absence is exactly the kind of thing that quietly comes back.
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
const PORT = 9393
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
const profile = path.join(tmpdir(), `odyssey-inv-${process.pid}`)
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

/* ── The invoicing window's chrome and menu ─────────────────────────────── */

const bodyText = () => evaluate('(document.body.innerText || "").replace(/\\s+/g, " ").trim()')

await goto('/invoicing')

/*
 * NO SIDEBAR is the whole point.
 *
 * The back-office rail lists Customers, Suppliers, Reports and Accounting —
 * none of which survive the shop's server dying, and one absent-minded click
 * lands the operator on a dead page mid-document. Removing it is what makes
 * "this window keeps working" a promise the app can keep.
 */
const rail = await evaluate(
  [
    '(() => {',
    '  const nav = [...document.querySelectorAll("nav, aside")]',
    '    .find((n) => /customers|suppliers|accounting|reports/i.test(n.innerText || ""))',
    '  return nav ? (nav.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 60) : null',
    '})()',
  ].join('\n'),
)
ok('*** the back-office rail is absent ***', rail === null, rail ?? 'none')

const text = await bodyText()
ok('the invoice register renders', /invoicing/i.test(text), text.slice(0, 60))

/* The one way out, named rather than drawn — for the operator who did not open
   this window themselves, or who has lost the back office behind it. */
ok('there is a way back to the back office', /back office/i.test(text))

/* ── The menu ───────────────────────────────────────────────────────────── */

const opened = await evaluate(
  [
    '(() => {',
    '  const btn = [...document.querySelectorAll("header button")]',
    '    .find((b) => /go to/i.test(b.getAttribute("aria-label") || b.title || ""))',
    '  if (!btn) return "no menu button"',
    '  btn.click()',
    '  return "clicked"',
    '})()',
  ].join('\n'),
)
ok('the window has a way between its screens', opened === 'clicked', opened)
await sleep(900)

const panel = await evaluate(
  [
    '(() => {',
    '  const p = document.querySelector("aside[aria-label=\\"Invoicing screens\\"]")',
    '  return p ? (p.innerText || "").replace(/\\s+/g, " ").trim() : null',
    '})()',
  ].join('\n'),
)
ok('it opens a panel of screens', panel !== null, (panel || 'no panel').slice(0, 80))
ok('  listing Invoicing', /invoicing/i.test(panel || ''))
ok('  listing Quotes', /quotes/i.test(panel || ''))
ok('  listing Sales orders', /sales orders/i.test(panel || ''))
ok('  listing Lay-bys', /lay-?by/i.test(panel || ''))
await shot('invoicing-window-menu')

/*
 * Tapping one NAVIGATES.
 *
 * The distinction from the till's menu, which switches what a basket IS and
 * never navigates — unmounting a half-rung basket would lose the sale. These
 * are separate screens with separate data, so they are links.
 */
const went = await evaluate(
  [
    '(() => {',
    '  const p = document.querySelector("aside[aria-label=\\"Invoicing screens\\"]")',
    '  if (!p) return "no panel"',
    '  const row = [...p.querySelectorAll("a")].find((a) => /quotes/i.test(a.innerText || ""))',
    '  if (!row) return "no quotes row"',
    '  row.click()',
    '  return "clicked"',
    '})()',
  ].join('\n'),
)
await sleep(3500)
const onQuotes = await evaluate('location.pathname')
/* `onQuotes`, NOT `landed` — the harness above already declared that for its
   own `goto('/pos')`, so reading it here asserted against the till's path and
   reported /pos. Named apart so the two cannot be confused again. */
ok('picking a screen navigates to it', onQuotes === '/invoicing/quotes', `${onQuotes} (${went})`)

/* And the panel closed itself on the way — otherwise it sits over the screen it
   just opened, which reads as the tap not having worked. */
const stillOpen = await evaluate(
  '!!document.querySelector("aside[aria-label=\\"Invoicing screens\\"]")',
)
ok('  and the panel closes behind it', stillOpen === false)

/* ── The old URLs must not 404 ──────────────────────────────────────────── */

/*
 * /sales still redirects to the register. It is on printed references,
 * bookmarks and a dozen revalidatePath calls, so it earns its keep — and a move
 * that broke it would be a move that broke the back office's own links.
 */
await goto('/sales')
const afterSales = await evaluate('location.pathname')
ok('/sales still lands on the register', afterSales === '/invoicing', afterSales)

const noisy = consoleErrors.filter((m) => !/favicon|DevTools|Failed to load resource/i.test(m))
ok('no console errors', noisy.length === 0, noisy.slice(0, 2).join(' | '))

console.log(`\nShots in ${OUT}`)
console.log(`${fails} FAILURE(S)`)
process.exit(fails > 0 ? 1 : 0)
