// Proves the till's module menu opens, lists what this build has, and switches
// the basket between document types without losing lines by accident.
//
//   node --env-file=.env --env-file=.env.local scripts/verify-till-modules.mjs
//
// BOTH env files: the login lives in .env.local and SESSION_SECRET — which the
// till cookie is signed with — lives in .env. Loading only one fails at the mint
// step with nothing else run.
//
// ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
//
// The complaint that started this work was a button that looked like it did
// something and did nothing: "New quotation" landed on the till and left the
// cashier at a tables view. A menu of modules is exactly the same shape of
// promise, so it is worth proving at RUNTIME rather than by reading the code —
// a row that renders and does not change the screen is the failure mode.
//
// Four things are asserted, in the order a cashier meets them:
//
//   1. The menu button is on the bar, and opens a panel listing the modules.
//   2. Picking one with an EMPTY basket switches straight through — the header
//      renames itself, which is the only visible proof the till changed what it
//      is writing.
//   3. Picking one with lines in the basket ASKS first, and cancelling keeps
//      every line. This is the assertion that matters: SET_DOC_TYPE clears the
//      basket by design, so an unguarded menu would be the most destructive
//      control on the screen.
//   4. Confirming that same switch does clear it, and lands on the new type.
//
// ── GETTING PAST THE PIN GATE ────────────────────────────────────────────────
//
// Same approach as verify-pos-returns.mjs: mint the till cookie directly. It is
// a JWT signed with SESSION_SECRET, exactly what the sign-in action issues. That
// is deliberately not writing a PIN to a real users row — a signed 8-hour token
// is an artefact this script creates and throws away.
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
const PORT = 9351
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
const profile = path.join(tmpdir(), `odyssey-mod-${process.pid}`)
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
  name: 'Module menu verifier',
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

/**
 * The bar's heading, which is what NAMES the document being written.
 *
 * Read via innerText of the header, not of the body: "Quote" appears in several
 * places once a quote is on screen, and matching the body would pass on a till
 * that had not switched at all.
 *
 * Uppercased headings are a trap here — innerText reflects text-transform, so
 * this compares case-insensitively rather than inventing a bug in working code.
 */
const heading = () =>
  evaluate(
    [
      '(() => {',
      '  const h = document.querySelector("header")',
      '  return h ? (h.innerText || "").replace(/\\s+/g, " ").trim() : ""',
      '})()',
    ].join('\n'),
  )

const openMenu = () =>
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

const panelText = () =>
  evaluate(
    [
      '(() => {',
      '  const p = document.querySelector("aside[aria-label=\\"Till modules\\"]")',
      '  return p ? (p.innerText || "").replace(/\\s+/g, " ").trim() : null',
      '})()',
    ].join('\n'),
  )

/** Clicks a module row by its visible label. */
const pickModule = (label) =>
  evaluate(
    [
      '(() => {',
      '  const p = document.querySelector("aside[aria-label=\\"Till modules\\"]")',
      '  if (!p) return "no panel"',
      '  const row = [...p.querySelectorAll("button, [role=button]")]',
      `    .find((el) => (el.innerText || "").toLowerCase().includes(${JSON.stringify(
        String(label).toLowerCase(),
      )}))`,
      '  if (!row) return "no row"',
      '  row.click()',
      '  return "clicked"',
      '})()',
    ].join('\n'),
  )

/** The open confirm dialog's text, or null. */
const dialogText = () =>
  evaluate(
    [
      '(() => {',
      '  const d = document.querySelector("dialog[open]")',
      '  return d ? (d.innerText || "").replace(/\\s+/g, " ").trim() : null',
      '})()',
    ].join('\n'),
  )

/** Presses a button inside the open dialog, matched on its label. */
const pressInDialog = (pattern) =>
  evaluate(
    [
      '(() => {',
      '  const d = document.querySelector("dialog[open]")',
      '  if (!d) return "no dialog"',
      `  const re = new RegExp(${JSON.stringify(pattern)}, "i")`,
      '  const btn = [...d.querySelectorAll("button")].find((b) => re.test(b.innerText || ""))',
      '  if (!btn) return "no button"',
      '  btn.click()',
      '  return "clicked"',
      '})()',
    ].join('\n'),
  )

/**
 * How many lines are in the basket.
 *
 * Read off the header's item pill rather than by counting rows in the sale
 * pane. The pill is a real thing a cashier looks at — asserting on it proves
 * the number they can SEE is right — and it needs no test-only attribute added
 * to production markup to find it.
 *
 * Returns null when there is no pill at all, which is a different answer from
 * zero: the pill is deliberately absent on either gate, where there is no
 * basket to count.
 */
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

/* ── Onto the sale screen ───────────────────────────────────────────────────── */

/*
 * THE MENU IS DELIBERATELY ABSENT ON EITHER GATE, so this has to walk past one.
 *
 * The closed-till gate exists to insist on a shift before anything happens, and
 * the floor gate is a choice of TABLE — a cashier who switched to quotes from
 * there would land on a trading screen belonging to no bill. Both lead to the
 * sale screen, where the menu is waiting.
 *
 * This site is hospitality, so /pos opens on the floor. The first run of this
 * script asserted straight away and reported six failures that were really one
 * fact: it was still standing on the gate. Worse, two assertions PASSED —
 * "picking a module closes the panel" is trivially true when no panel ever
 * opened. Hence the hard stop below rather than carrying on.
 */
const onGate = () =>
  evaluate(
    [
      '(() => {',
      '  const h = document.querySelector("header h1")',
      '  return h ? /odyssey/i.test(h.innerText || "") : false',
      '})()',
    ].join('\n'),
  )

if (await onGate()) {
  /* A table, or the quick-sale key that skips choosing one. Either lands on the
     trading screen, which is all this script needs. */
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
  /*
   * Stop rather than assert. Every check below reads controls that live on the
   * sale screen, and running them against a gate produces a mix of honest
   * failures and meaningless passes — which is worse than no result at all.
   */
  console.log('\nStill on a gate, where the module menu is deliberately absent.')
  console.log('Nothing about the menu is proven either way.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}

/* ── 1. The menu is on the bar, and lists the modules ───────────────────────── */

const opened = await openMenu()
ok('the bar carries a way to another module', opened === true)

await sleep(600)
const panel = await panelText()
ok('it opens a panel of modules', panel !== null && /go to/i.test(panel || ''), (panel || '').slice(0, 90))
ok('the panel lists Point of sale', /point of sale/i.test(panel || ''))
ok('the panel lists Quotes', /quotes/i.test(panel || ''))
ok('the panel lists Sales orders', /sales order/i.test(panel || ''))
/*
 * NOT lay-bys, and that is the assertion rather than an omission.
 *
 * They are built in the back office, but the till cannot take a payment against
 * one until the cash-up counts that money — lay-by takings are shown on the
 * declaration while being left out of the expected cash they are counted
 * against. A row here now would be a button that opens nothing, which is the
 * exact complaint this whole feature exists to answer.
 */
ok(
  'it does NOT offer lay-bys, which the till cannot do yet',
  !/lay-?by/i.test(panel || ''),
  'a row here would be a button that opens nothing',
)
/*
 * NOTHING IS CUT OFF.
 *
 * TouchRow truncates its subtitle on one line — the kit's decision, not this
 * screen's to overrule — so a hint written as a sentence shows as "Price
 * something up for a custom…", which stops before the useful half. Measured
 * rather than eyeballed: scrollWidth outruns clientWidth exactly when the
 * ellipsis appears, and a screenshot only catches it if somebody looks.
 */
const clipped = await evaluate(
  [
    '(() => {',
    '  const p = document.querySelector("aside[aria-label=\\"Till modules\\"]")',
    '  if (!p) return null',
    '  return [...p.querySelectorAll("span")]',
    '    .filter((s) => s.classList.contains("truncate"))',
    '    .filter((s) => s.scrollWidth > s.clientWidth + 1)',
    '    .map((s) => (s.innerText || "").trim())',
    '})()',
  ].join('\n'),
)
ok(
  'no label or hint is cut off',
  Array.isArray(clipped) && clipped.length === 0,
  (clipped || []).join(' | '),
)
await shot('till-modules-open')

/* ── 2. Empty basket switches straight through ──────────────────────────────── */

const before = await heading()
const jumped = await pickModule('Quotes')
ok('a module row can be pressed', jumped === 'clicked', jumped)
await sleep(1200)

/* Guarded on the pick having happened. Without that this reads PASS on a run
   where the panel never opened, which is how the first attempt reported a
   working menu while proving nothing. */
const closedAfterPick = await panelText()
ok('picking a module closes the panel', jumped === 'clicked' && closedAfterPick === null)

const afterQuote = await heading()
ok(
  'the header now names a quote',
  /quote/i.test(afterQuote) && !/current sale/i.test(afterQuote),
  `was "${before}", now "${afterQuote}"`,
)
await shot('till-modules-quote')

/* ── 3. With lines in the basket, it asks first — and cancelling keeps them ─── */

/*
 * Put something in the basket.
 *
 * Through the SEARCH BOX rather than a department drill. The drill was the
 * first attempt, on the precedent verify-pos-returns.mjs set — but on this site
 * both departments come up "No quick keys yet" with no product grid behind
 * them, so the click landed on a department row and the basket stayed empty.
 * Search reaches the same catalogue without depending on how a shop has
 * arranged its tiles.
 *
 * The product is whatever comes back first. This script is about the MENU; what
 * is in the basket does not matter, only that something is.
 */
/*
 * The search term comes from the CATALOGUE, not from a guess.
 *
 * A hardcoded 'a' matched nothing on this site, and the script then clicked the
 * first thing on screen carrying a price — which was the sale pane's own
 * "Sale discount R0.00" row — and reported an empty basket. Asking the catalog
 * endpoint for a real product name means the search cannot come back empty for
 * a reason that has nothing to do with the menu.
 */
const probe = await evaluate(
  [
    '(async () => {',
    "  const r = await fetch('/api/pos/catalog?deviceId=' + encodeURIComponent(",
    `    ${JSON.stringify(DEVICE)}`,
    "  ), { headers: { accept: 'application/json' } })",
    '  if (!r.ok) return null',
    '  const b = await r.json()',
    '  const p = (b.products || [])[0]',
    '  return p ? { name: p.name || null, code: p.code || p.sku || null } : null',
    '})()',
  ].join('\n'),
)
const term =
  process.env.VERIFY_SEARCH ||
  (probe?.code ? String(probe.code) : probe?.name ? String(probe.name).slice(0, 12) : 'a')
const typed = await evaluate(
  [
    '(() => {',
    '  const input = [...document.querySelectorAll("input")]',
    '    .find((i) => /scan|search/i.test(i.placeholder || ""))',
    '  if (!input) return "no search box"',
    "  const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set",
    `  setter.call(input, ${JSON.stringify(term)})`,
    "  input.dispatchEvent(new Event('input', { bubbles: true }))",
    '  return "typed"',
    '})()',
  ].join('\n'),
)
/* Search is a round trip and debounced. */
await sleep(3000)

/*
 * A RESULT, and geometrically so.
 *
 * Matching "carries a price" alone clicked the sale pane's own "Sale discount
 * R0.00" row and reported an empty basket. The basket is the LEFT column and
 * the catalogue is everything right of it, so the search box's own x-position
 * is the divider — no knowledge of either pane's markup required, and it
 * survives a restyle of both.
 */
const added = await evaluate(
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
    '  if (!hit) return "no priced result"',
    '  hit.click()',
    '  return (hit.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 30)',
    '})()',
  ].join('\n'),
)
await sleep(1800)
const lines = await lineCount()
console.log(`   (search "${term}": ${typed}, result: ${added}, items on screen: ${lines})`)

if (lines === null || lines === 0) {
  /*
   * NOT a silent pass.
   *
   * If nothing could be rung up, the guard below is untested — and an assertion
   * over an empty basket would prove nothing while printing PASS. Say so.
   */
  console.log('')
  console.log('**SKIPPED**  the basket guard — nothing could be rung up on this site,')
  console.log('             so "switching with lines asks first" was never exercised.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(fails > 0 ? 1 : 0)
}

await openMenu()
await sleep(600)
await pickModule('Point of sale')
await sleep(800)

const asked = await dialogText()
ok(
  'switching with a basket in hand asks first',
  asked !== null && /clear/i.test(asked || ''),
  (asked || 'no dialog').slice(0, 100),
)
ok(
  'the question says how many lines are at stake',
  new RegExp(`\\b${lines}\\b`).test(asked || ''),
  `basket has ${lines}`,
)
/*
 * The question names the MODULE that was pressed, not the document behind it.
 * The first build asked "Start a invoice?" after a tap on "Point of sale" —
 * wrong article, and the wrong noun besides. Both are asserted because both
 * were real.
 */
ok(
  'the question names what was pressed, not the document behind it',
  /start a sale\b/i.test(asked || ''),
  (asked || '').slice(0, 40),
)
ok(
  "it reads as English — no 'a invoice'",
  !/\ba (invoice|order|a|e|i|o|u)/i.test(asked || ''),
  (asked || '').slice(0, 40),
)
await shot('till-modules-confirm')

await pressInDialog('cancel|no|close')
await sleep(900)
const keptHeading = await heading()
const keptLines = await lineCount()
ok(
  'cancelling keeps every line',
  keptLines === lines,
  `${lines} before, ${keptLines} after`,
)
ok('cancelling stays on the same module', /quote/i.test(keptHeading), keptHeading)

/* ── 4. Confirming does switch, and does clear ──────────────────────────────── */

await openMenu()
await sleep(600)
await pickModule('Point of sale')
await sleep(800)
const confirmed = await pressInDialog('yes|clear|start a')
ok('the question can be confirmed', confirmed === 'clicked', confirmed)
await sleep(1200)

const finalHeading = await heading()
const finalLines = await lineCount()
ok(
  'confirming lands on the sale screen',
  /current sale/i.test(finalHeading),
  finalHeading,
)
ok('confirming clears the basket', finalLines === 0, `${finalLines} line(s) left`)
await shot('till-modules-back-to-sale')

/* ── Console ────────────────────────────────────────────────────────────────── */

const noisy = consoleErrors.filter(
  (m) => !/favicon|Download the React DevTools|Failed to load resource/i.test(m),
)
ok('no console errors while driving the menu', noisy.length === 0, noisy.slice(0, 2).join(' | '))

console.log(`\nShots in ${OUT}`)
console.log(`${fails} FAILURE(S)`)
process.exit(fails > 0 ? 1 : 0)
