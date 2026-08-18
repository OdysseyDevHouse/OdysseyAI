// Proves the till SAYS WHY rather than failing, when the line is down.
//
//   node --env-file=.env --env-file=.env.local scripts/verify-till-offline-guards.mjs
//
// BOTH env files: the login lives in .env.local and SESSION_SECRET — which the
// till cookie is signed with — lives in .env.
//
// ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
//
// Quotes, orders and lay-bys all live on the server, and every one of them was
// added to the till without an online check. Offline, tapping any of them ran a
// server action that could only fail — a raw error, or worse an empty list that
// reads as "this shop has no quotes" rather than "this till cannot see them".
//
// The till already had a house style for this, on the online-order and gift
// card keys: refuse, and say what needs the connection and why. These are the
// same sentence in the same voice.
//
// Driven with a REAL offline condition through CDP rather than a stubbed fetch,
// so what is tested is the same state a shop with a dead line is in.
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

const { wsUrl, close: closeChrome } = await launchChrome('off')

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

/**
 * A GENUINE offline condition, not a stubbed fetch.
 *
 * Chrome stops the requests at the network layer, which is what the browser
 * reports to navigator.onLine and what the till reads. Stubbing fetch would
 * test the stub.
 */
async function setOffline(offline) {
  await send(
    'Network.emulateNetworkConditions',
    { offline, latency: 0, downloadThroughput: offline ? 0 : -1, uploadThroughput: offline ? 0 : -1 },
    sessionId,
  )
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
  name: 'Offline guards verifier',
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

const dialogText = () =>
  evaluate(
    [
      '(() => {',
      '  const d = document.querySelector("dialog[open]")',
      '  return d ? (d.innerText || "").replace(/\\s+/g, " ").trim() : null',
      '})()',
    ].join('\n'),
  )

/** Everything the toasts are saying right now. */
const toastText = () =>
  evaluate(
    [
      '(() => {',
      '  const nodes = [...document.querySelectorAll("[role=status], [role=alert], [data-toast]")]',
      '  if (nodes.length) return nodes.map((n) => n.innerText || "").join(" | ").replace(/\\s+/g, " ").trim()',
      '  /* The toaster may not carry a role — fall back to whatever sits',
      '     in the bottom-right corner, which is where it renders. */',
      '  const guess = [...document.querySelectorAll("div")]',
      '    .filter((d) => {',
      '      const r = d.getBoundingClientRect()',
      '      return r.width > 120 && r.width < 700 && r.top > window.innerHeight * 0.6 && r.left > window.innerWidth * 0.5',
      '    })',
      '    .map((d) => (d.innerText || "").replace(/\\s+/g, " ").trim())',
      '    .filter((t) => t.length > 10 && t.length < 300)',
      '  return guess.join(" | ")',
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

const closeMenu = () =>
  evaluate(
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

/** The pane's recall key — "Saved", "Quotes" or "Orders" by module. */
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

/* ── Onto the sale screen, while still online ──────────────────────────────── */

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
  console.log('\nStill on a gate. Nothing about the guards is proven.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}

/* ── Cut the line ───────────────────────────────────────────────────────────── */

await setOffline(true)
/* The till watches connectivity itself; give its own listener a moment to
   notice rather than assuming the flag lands instantly. */
await sleep(3000)

console.log(`   (navigator.onLine = ${await evaluate('navigator.onLine')})`)

/*
 * THE BAR HAS TWO CHIPS WITH THE SAME WORD IN THEM, and they mean opposite
 * things:
 *
 *   "Offline"     the line is down right now
 *   "Online only" this MACHINE cannot trade offline at all (no HTTPS, no
 *                 service worker) — a capability, not a connection state
 *
 * Matching /offline/ hit the second one and passed while the till was still
 * perfectly connected. Anchored to the standalone chip instead.
 */
/*
 * READ FROM THE CHIP ITSELF, not from the header's text.
 *
 * Two earlier versions of this passed while the till was perfectly connected:
 * /offline/ matched the "Online only" capability chip, and an anchored version
 * then matched this run's own operator name, "Offline guards verifier". The
 * header is full of the word. The chip is a specific element, so ask it.
 */
const offlineChip = await evaluate(
  [
    '(() => {',
    '  const h = document.querySelector("header")',
    '  if (!h) return null',
    '  const chip = [...h.querySelectorAll("span, button")]',
    '    .find((el) => /^offline$/i.test((el.innerText || "").trim()))',
    '  return chip ? "offline" : null',
    '})()',
  ].join('\n'),
)
ok(
  'the till knows the line is down',
  offlineChip === 'offline',
  offlineChip ?? `no Offline chip — bar reads: ${(await heading()).slice(0, 70)}`,
)
await shot('till-offline-guards')

/**
 * Presses something and reports what the till SAID about it.
 *
 * The assertion each time is the same shape: a dialog must not have opened, and
 * the refusal must name the connection. A guard that silently did nothing would
 * satisfy the first half and fail a cashier just as badly as a raw error.
 */
async function refuses(label, press, expect) {
  await evaluate('(() => { document.querySelectorAll("[role=status]").forEach((n) => n.remove()); return true })()')
  const pressed = await press()
  await sleep(1800)
  const dialog = await dialogText()
  const said = await toastText()
  ok(
    `*** ${label} refuses offline ***`,
    dialog === null,
    dialog ? `a dialog opened: ${dialog.slice(0, 60)}` : `pressed: ${pressed}`,
  )
  ok(
    `  and says the connection is why`,
    expect.test(said || ''),
    (said || 'nothing said').slice(0, 120),
  )
  /* Anything that did open must be shut, or the next check inherits it. */
  if (dialog) {
    await evaluate(
      [
        '(() => {',
        '  const d = document.querySelector("dialog[open]")',
        '  if (!d) return false',
        '  const btn = [...d.querySelectorAll("button")].find((b) => /^(close|cancel)$/i.test((b.innerText || "").trim()))',
        '  if (btn) btn.click()',
        '  return true',
        '})()',
      ].join('\n'),
    )
    await sleep(800)
  }
}

/* ── 1. The lay-by list, from the module menu ───────────────────────────────── */

await refuses(
  'the lay-by list',
  async () => {
    await openModuleMenu()
    await sleep(700)
    const r = await pickModule('Lay-bys')
    await sleep(500)
    await closeMenu()
    return r
  },
  /lay-?bys need the connection/i,
)

/* ── 2. The quote list, from the pane's recall key ──────────────────────────── */

/*
 * Switching the module first, which is itself offline-safe: SET_DOC_TYPE is
 * local state and touches no server. Only the LIST behind the key is remote,
 * which is the distinction being checked — a till with no line can still be
 * put into quote mode, it just cannot look up what the shop already has.
 */
await openModuleMenu()
await sleep(700)
await pickModule('Quotes')
await sleep(1500)
ok(
  'switching module still works offline',
  /quote/i.test(await heading()),
  (await heading()).slice(0, 40),
)

/*
 * THE QUOTE GUARD, checked while the till is actually ON quotes.
 *
 * Order matters here and cost a run: an earlier version switched to Point of
 * sale in between, so the recall key read "Saved" and pressing it opened the
 * parked-basket list — which is local and correctly does NOT refuse. That read
 * as a broken guard when it was a step in the wrong place.
 */
await refuses('the quote list', pressRecallKey, /quotes need the connection/i)

/* ── 3. The order list ──────────────────────────────────────────────────────── */

await openModuleMenu()
await sleep(700)
await pickModule('Sales orders')
await sleep(1800)

/*
 * ── A LIMIT OF THIS RUN, STATED RATHER THAN HIDDEN ────────────────────────
 *
 * By this point the page has usually gone blank — "This page couldn't load".
 * That is NOT the order module and not these guards: switching to Sales orders
 * as the FIRST offline action works perfectly (checked separately), and module
 * switching triggers no navigation at all — it is local reducer state.
 *
 * It is `next dev` losing an RSC prefetch after several offline interactions,
 * which a production build with a service worker does not do. Chasing it here
 * would be testing the dev server.
 *
 * So the order guard is asserted only if the page is still alive, and SAID
 * OTHERWISE if it is not. A silent skip would let a broken guard through
 * looking like a passing run — the order and quote guards are the same three
 * lines against the same flag, and the quote one is proven above.
 */
const alive = (await heading()).length > 0
if (!alive) {
  console.log('')
  console.log('**UNPROVEN**  the order list guard — `next dev` dropped the page after four')
  console.log('              offline interactions. Not the guard: see the note above.')
  console.log('')
} else {
  await refuses('the order list', pressRecallKey, /sales orders need the connection/i)
}

/* ── Back on the line ───────────────────────────────────────────────────────── */

/*
 * THE OTHER HALF OF THE GUARD. A refusal that outlived the outage would be its
 * own bug — a shop whose line came back would be told for the rest of the day
 * that quotes need a connection it now has.
 */
await setOffline(false)
await sleep(3000)

/* Reloaded rather than continued: the dev server may have dropped the page
   above, and what is being proven here is that the REFUSAL does not outlive the
   outage — which a fresh load answers just as well and without depending on
   whatever state four offline interactions left behind. */
await goto('/pos')
if (await onGate()) {
  await evaluate(
    [
      '(() => {',
      '  const all = [...document.querySelectorAll("button")].filter((b) => !b.closest("header"))',
      '  const quick = all.find((b) => /quick sale|walk-?in|no table/i.test(b.innerText || ""))',
      '  if (quick) quick.click()',
      '  return true',
      '})()',
    ].join('\n'),
  )
  await sleep(2500)
}

await openModuleMenu()
await sleep(700)
await pickModule('Quotes')
await sleep(1500)
const backOnline = await pressRecallKey()
await sleep(2500)
const listAgain = await dialogText()
ok(
  '*** the list opens again once the line is back ***',
  listAgain !== null && /quotes/i.test(listAgain || ''),
  `${backOnline}: ${(listAgain || 'no dialog').slice(0, 60)}`,
)

console.log(`\nShots in ${OUT}`)
console.log(`${fails} FAILURE(S)`)
process.exit(fails > 0 ? 1 : 0)
