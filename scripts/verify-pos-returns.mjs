// Proves a cashier can actually take a return at the till.
//
//   node --env-file=.env --env-file=.env.local scripts/verify-pos-returns.mjs
//
// The engine is covered by test-offline-returns (39, no browser) and the reducer by
// test-sale-reducer. What neither can reach is the SCREEN, and the screen carries the
// one property that matters most here: that a cashier can tell which direction the
// goods and the money are going.
//
// Four browser facts:
//
//   1. The Sale/Return toggle is there, and switching it CLEARS the basket. A return's
//      lines surviving into a sale would ring up the goods just handed in.
//   2. The primary button changes its word AND its colour. Green means "money coming in"
//      on every other control on this screen, so a green Refund is the one piece of
//      colour on the till that could actively mislead.
//   3. The refund pad opens, requires a reason, and refuses to over-refund.
//   4. Only refundable tender methods are offered — `allowsRefund` is a per-tender
//      setting and a card refund at the till is exactly what many shops forbid.
//
// ── GETTING PAST THE PIN GATE ────────────────────────────────────────────────
//
// Every other verify-*.mjs stops at the gate and checks the API instead, because the
// till session is per-operator and none of them has a PIN. This one mints the till
// cookie directly — it is a JWT signed with SESSION_SECRET, exactly what the sign-in
// action issues — so the rendered till can be driven for the first time.
//
// That is deliberately NOT setting somebody's PIN. A PIN is a credential and writing
// one to a real users row to make a test pass is the wrong trade; a signed 8-hour
// session token is an artefact this script creates and throws away.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SignJWT } from 'jose'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const SECRET = process.env.SESSION_SECRET
const BASE = process.env.APP_URL || 'http://localhost:4100'
const OUT = process.env.SHOT_DIR || path.join(process.cwd(), '.screenshots')
const PORT = 9343
const DEVICE = process.env.VERIFY_DEVICE_ID || 'b7a53389-9e44-4378-873c-af3cbd870b7d'

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
const profile = path.join(tmpdir(), `odyssey-ret-${process.pid}`)
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
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

let fails = 0
const ok = (label, cond, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/**
 * Put a real product grid on screen.
 *
 * Necessary because the till opens on the quick-key pane, and this dev site has no
 * quick keys configured — so the default view is an EmptyState and the only grid in the
 * document is a hidden one. Tapping a department switches to the drill, which is the
 * pane whose tile size this feature actually controls.
 */
async function openADepartment() {
  /* Found through the rail's own <nav>, not by guessing at button dimensions: the
     department list is the only nav on this screen, so its buttons are unambiguously
     departments. A size heuristic would happily click Pay. */
  const picked = await evaluate(
    [
      '(() => {',
      "  const nav = document.querySelector('nav')",
      '  if (!nav) return { via: "no-nav", n: 0 }',
      "  const rows = [...nav.querySelectorAll('button')]",
      '  if (!rows.length) return { via: "empty-nav", n: 0 }',
      '  rows[0].click()',
      '  return { via: "nav", n: rows.length, label: (rows[0].innerText || "").trim().slice(0, 30) }',
      '})()',
    ].join('\n'),
  )
  await sleep(1800)
  return picked
}

/* ── Sign in to the back office ─────────────────────────────────────────────── */

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
await sleep(4000)

/* ── Past the PIN gate, by minting the till cookie the action would issue ───── */

const operator = await evaluate(
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
ok('the catalog answers for this device', operator?.ok === true, JSON.stringify(operator?.status ?? ''))

const userId = operator?.operator?.userId ?? 1
const siteId = operator?.siteId ?? 1
const token = await new SignJWT({ userId, name: 'Tile size verifier', siteId })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('8h')
  .sign(new TextEncoder().encode(SECRET))

await send(
  'Network.setCookie',
  { name: 'odyssey_till', value: token, domain: 'localhost', path: '/', httpOnly: true },
  sessionId,
)
await evaluate(`localStorage.setItem('ody-device-id', ${JSON.stringify(DEVICE)}), true`)

consoleErrors.length = 0
const landed = await goto('/pos')
const stillGated = await evaluate(`document.body.innerText.includes('Enter your PIN')`)
ok('the till renders rather than the PIN gate', landed === '/pos' && !stillGated, landed)

if (stillGated) {
  console.log('\nStill at the gate — the minted cookie was not accepted, so the return')
  console.log('assertions below cannot run. Nothing about the feature is proven either way.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}

/* ── Helpers for driving the pane ────────────────────────────────────────── */

/** Clicks a button by its visible text. Returns whether one was found. */
const clickByText = (text) =>
  evaluate(
    [
      '(() => {',
      "  const b = [...document.querySelectorAll('button')].find(",
      `    (x) => (x.innerText || '').trim().toLowerCase() === ${JSON.stringify(text.toLowerCase())}`,
      '  )',
      '  if (!b) return false',
      '  b.click()',
      '  return true',
      '})()',
    ].join('\n'),
  )

/**
 * Puts one product in the basket.
 *
 * DRILLS until it finds a product tile, rather than assuming the first department holds
 * products. The first version of this tapped the first tile it found and reported
 * `{"clicked":"Cooldrink sub 1"}` — a DEPARTMENT tile — so it kept navigating deeper and
 * never added anything, and every assertion after it failed on an empty basket. A
 * product tile is the one that shows a price; a department tile does not.
 */
async function addOneItem() {
  await evaluate(
    [
      '(() => {',
      "  const nav = document.querySelector('nav')",
      "  const rows = nav ? [...nav.querySelectorAll('button')] : []",
      '  if (rows.length) rows[0].click()',
      '  return rows.length',
      '})()',
    ].join('\n'),
  )
  await sleep(1800)

  /* Down through the tree. Six levels is far more than this catalogue has, and stopping
     is better than looping if the shape is not what we expect. */
  for (let depth = 0; depth < 6; depth++) {
    const found = await evaluate(
      [
        '(() => {',
        "  const grids = [...document.querySelectorAll('div')].filter(",
        '    (d) =>',
        "      getComputedStyle(d).display === 'grid' &&",
        '      /minmax/.test(d.style.gridTemplateColumns) &&',
        '      d.getBoundingClientRect().width > 0',
        '  )',
        '  for (const g of grids) {',
        "    const tiles = [...g.querySelectorAll('button')].filter((b) => {",
        '      const r = b.getBoundingClientRect()',
        '      return r.width > 0 && r.height > 0',
        '    })',
        '    if (!tiles.length) continue',
        // A price means a PRODUCT. Departments carry a name and a chevron only.
        "    const priced = tiles.filter((b) => /R\\s?[0-9]/.test(b.innerText || ''))",
        '    if (priced.length) return { kind: "product", label: (priced[0].innerText||"").replace(/\\s+/g," ").slice(0,40) }',
        '    return { kind: "department", label: (tiles[0].innerText||"").replace(/\\s+/g," ").slice(0,40) }',
        '  }',
        '  return { kind: "none" }',
        '})()',
      ].join('\n'),
    )
    if (found?.kind === 'product') break
    if (found?.kind !== 'department') return { clicked: null, reason: found?.kind ?? 'no grid' }
    // Go one level deeper and look again.
    await evaluate(
      [
        '(() => {',
        "  const grids = [...document.querySelectorAll('div')].filter(",
        '    (d) =>',
        "      getComputedStyle(d).display === 'grid' &&",
        '      /minmax/.test(d.style.gridTemplateColumns) &&',
        '      d.getBoundingClientRect().width > 0',
        '  )',
        '  for (const g of grids) {',
        "    const tiles = [...g.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0)",
        '    if (tiles.length) { tiles[0].click(); return true }',
        '  }',
        '  return false',
        '})()',
      ].join('\n'),
    )
    await sleep(1600)
  }
  /*
   * The FIRST product tile in the drill, and the click has to reach a tile that is
   * actually laid out.
   *
   * The first version took `tiles[tiles.length - 1]` — the LAST tile — which in a
   * department of 40 products is below the fold, so the click landed on nothing and the
   * basket stayed empty. Every assertion after it then failed for the wrong reason: the
   * primary button reported the right word and the right colour, but with a `/0.4` alpha
   * because it was DISABLED on an empty basket, and a disabled button cannot open a pad.
   *
   * A tile is a product tile rather than a department one when it shows a price, so the
   * search is for the first one whose text carries a currency figure.
   */
  const added = await evaluate(
    [
      '(() => {',
      "  const grids = [...document.querySelectorAll('div')].filter(",
      '    (d) =>',
      "      getComputedStyle(d).display === 'grid' &&",
      '      /minmax/.test(d.style.gridTemplateColumns) &&',
      '      d.getBoundingClientRect().width > 0',
      '  )',
      '  for (const g of grids) {',
      // PRICED tiles only — a department tile has no price and navigates instead of adding.
      "    const tiles = [...g.querySelectorAll('button')].filter((b) => {",
      '      const r = b.getBoundingClientRect()',
      "      return r.width > 0 && r.height > 0 && /R\\s?[0-9]/.test(b.innerText || '')",
      '    })',
      '    if (tiles.length) {',
      '      tiles[0].click()',
      "      return { clicked: (tiles[0].innerText || '').replace(/\\s+/g, ' ').slice(0, 40), of: tiles.length }",
      '    }',
      '  }',
      "  return { clicked: null, grids: grids.length }",
      '})()',
    ].join('\n'),
  )
  await sleep(1600)
  return added
}

/** The primary end-of-sale button: its word and its computed background. */
const primaryButton = () =>
  evaluate(
    [
      '(() => {',
      "  const b = [...document.querySelectorAll('button')].find((x) =>",
      "    /^(Pay|Refund|Working)/.test((x.innerText || '').trim())",
      '  )',
      '  if (!b) return null',
      '  return {',
      "    text: (b.innerText || '').replace(/\\s+/g, ' ').trim(),",
      '    background: getComputedStyle(b).backgroundColor,',
      '    disabled: b.disabled,',
      '  }',
      '})()',
    ].join('\n'),
  )

const basketCount = () =>
  evaluate(
    [
      '(() => {',
      "  const list = document.querySelector('ul.till-pane')",
      '  return list ? list.children.length : 0',
      '})()',
    ].join('\n'),
  )

/* ── 1. The toggle exists, and says which mode ───────────────────────────── */

const toggle = await evaluate(
  [
    '(() => {',
    "  const labels = [...document.querySelectorAll('button')].map((b) => (b.innerText||'').trim())",
    "  return { sale: labels.includes('Sale'), ret: labels.includes('Return') }",
    '})()',
  ].join('\n'),
)
ok('the pane offers Sale and Return', toggle?.sale === true && toggle?.ret === true, JSON.stringify(toggle))

/* ── 2. A sale basket, then switching to Return, CLEARS it ───────────────── */

const added = await addOneItem()
ok(
  'an item goes in the basket',
  (await basketCount()) > 0,
  `${await basketCount()} line(s); tapped ${JSON.stringify(added)}`,
)

const paySale = await primaryButton()
ok('the button says Pay while selling', /^Pay/.test(paySale?.text ?? ''), paySale?.text ?? '')
/* ENABLED, or the colour comparison is meaningless: a disabled button wears the same
   variant colour at 0.4 alpha, so two disabled buttons differ in hue while telling you
   nothing about what a cashier actually sees. The first run of this compared exactly
   that and "passed". */
ok(
  '  and it is live, so its colour is the one a cashier sees',
  paySale?.disabled === false,
  `disabled=${paySale?.disabled}`,
)
const payColour = paySale?.background

ok('switching to Return is possible', (await clickByText('Return')) === true)
await sleep(900)

/* THE assertion. A return's lines surviving into a sale — or a sale's into a return —
   would ring up or credit the wrong direction with nothing on screen looking wrong. */
ok(
  '*** switching to Return CLEARS the basket ***',
  (await basketCount()) === 0,
  `${await basketCount()} line(s) left`,
)

/* ── 3. The button changes word AND colour ──────────────────────────────── */

await addOneItem()
const refundBtn = await primaryButton()
ok('the button now says Refund', /^Refund/.test(refundBtn?.text ?? ''), refundBtn?.text ?? '')
/* Green means "money coming in" on every other control here, so a green Refund is the
   one piece of colour on this screen that could actively mislead. */
ok(
  '  and it too is live',
  refundBtn?.disabled === false,
  `disabled=${refundBtn?.disabled}`,
)
ok(
  '*** and it is NOT the same colour as Pay ***',
  refundBtn?.disabled === false &&
    paySale?.disabled === false &&
    refundBtn?.background !== payColour,
  `Pay ${payColour} vs Refund ${refundBtn?.background}`,
)

const warning = await evaluate(
  `(document.body.innerText || '').toLowerCase().includes('no receipt is checked')`,
)
ok('the pane says no receipt is checked', warning === true)

/* ── 4. The refund pad ──────────────────────────────────────────────────── */

/* Clicked by PREFIX, not exact text: the button reads "Refund R944.02", so an
   equality match found nothing and the four assertions below all failed on a pad that
   had never been asked to open. */
const opened = await evaluate(
  [
    '(() => {',
    "  const b = [...document.querySelectorAll('button')].find((x) =>",
    "    /^Refund/.test((x.innerText || '').trim()) && !x.disabled",
    '  )',
    '  if (!b) return false',
    '  b.click()',
    '  return true',
    '})()',
  ].join('\n'),
)
ok('the Refund button opens the pad', opened === true)
await sleep(1000)

const pad = await evaluate(
  [
    '(() => {',
    "  const d = document.querySelector('dialog[open]')",
    '  if (!d) return null',
    "  const text = (d.innerText || '')",
    '  return {',
    '    title: text.slice(0, 30),',
    "    hasReason: /why is it coming back/i.test(text),",
    "    methods: [...d.querySelectorAll('button')].map((b) => (b.innerText||'').trim()).filter(Boolean),",
    "    doneDisabled: [...d.querySelectorAll('button')].find((b) => /^Done/.test((b.innerText||'').trim()))?.disabled ?? null,",
    '  }',
    '})()',
  ].join('\n'),
)
ok('the refund pad opens', pad !== null, JSON.stringify(pad))
ok('it asks why the goods are coming back', pad?.hasReason === true)
/* Done must start disabled: no reason and nothing handed back yet. createCreditNote
   refuses a blank reason server-side, so collecting it here is the difference between a
   three-second fix and a return rejected at sync after the cash is gone. */
ok(
  'Done is disabled before a reason and a method are given',
  pad?.doneDisabled === true,
  String(pad?.doneDisabled),
)
/* And it SAYS why. A disabled primary button on a dark panel still reads as solid — the
   variant dims to 40%, but 40% of a bright colour over a dark surface looks live — so a
   cashier taps it and nothing happens. The screenshot showed exactly that; the
   assertions above could not. */
const whyDisabled = await evaluate(
  [
    '(() => {',
    "  const d = document.querySelector('dialog[open]')",
    '  if (!d) return null',
    "  return /choose how the money goes back|add a reason|take a line off/i.test(d.innerText || '')",
    '})()',
  ].join('\n'),
)
ok('*** and it says WHAT IS MISSING rather than just sitting there ***', whyDisabled === true)

/* Only refundable methods. A card refund at the till is exactly what many shops forbid,
   and `allowsRefund` is the per-tender setting that says so. */
const offered = await evaluate(
  [
    '(async () => {',
    "  const r = await fetch('/api/pos/catalog?deviceId=' + encodeURIComponent(",
    `    ${JSON.stringify(DEVICE)}`,
    "  ), { headers: { accept: 'application/json' } })",
    '  if (!r.ok) return null',
    '  const b = await r.json()',
    '  return (b.tenders || []).map((t) => ({ name: t.name, allowsRefund: t.allowsRefund }))',
    '})()',
  ].join('\n'),
)
if (Array.isArray(offered) && offered.length) {
  const blocked = offered.filter((t) => !t.allowsRefund).map((t) => t.name)
  const shown = pad?.methods ?? []
  const wronglyOffered = blocked.filter((name) => shown.includes(name))
  ok(
    'no un-refundable method is offered as a button',
    wronglyOffered.length === 0,
    wronglyOffered.join(', ') || `${blocked.length} blocked method(s) correctly withheld`,
  )
} else {
  ok('the catalog listed tenders so the filter could be checked', false, 'no tenders returned')
}

const file = await shot('pos-return')
console.log(`\nscreenshot -> ${file}`)

/* ── 5. And the credit-note sequence reached the till ────────────────────── */

const creditSeq = await evaluate(
  [
    '(async () => {',
    "  const r = await fetch('/api/pos/catalog?deviceId=' + encodeURIComponent(",
    `    ${JSON.stringify(DEVICE)}`,
    "  ), { headers: { accept: 'application/json' } })",
    '  if (!r.ok) return null',
    '  const b = await r.json()',
    '  return b.creditSequence',
    '})()',
  ].join('\n'),
)
/* Without this the till cannot number a return offline at all — the same way a missing
   invoice sequence stops it selling. Migration 079 creates one per numbered terminal. */
ok(
  'the catalog ships a credit-note sequence, so a return can be numbered offline',
  creditSeq !== null && typeof creditSeq?.prefix === 'string',
  JSON.stringify(creditSeq),
)

console.log(fails === 0 ? '\nAll return-screen checks passed.' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
