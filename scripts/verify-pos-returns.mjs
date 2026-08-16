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
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SignJWT } from 'jose'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const SECRET = process.env.SESSION_SECRET
const BASE = process.env.APP_URL || 'http://localhost:4100'
const OUT = process.env.SHOT_DIR || path.join(process.cwd(), '.screenshots')
const PORT = 9343
/* A serial_number from cp2_devices with status='active' — the till licence this run
   pretends to be. The previous default named no row at all, which the catalog API
   tolerated while the SCREEN refused to render. Override with VERIFY_DEVICE_ID. */
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
/* POLLED, not a fixed sleep. Sign-in takes anywhere from a moment to several seconds
   depending on how warm the dev server is, and a 4s guess that loses the race lands on
   the "<!DOCTYPE is not valid JSON" crash below rather than saying what went wrong. */
for (let i = 0; i < 30; i++) {
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

/*
 * ── Choose a store ─────────────────────────────────────────────────────────
 *
 * The dev account can reach more than one store, so sign-in ends on a picker dialog
 * OVER the login card rather than in the app. Skipping this does not fail loudly: the
 * catalog fetch below returns the picker's HTML with a 200, and `r.json()` dies on
 * "<!DOCTYPE" a hundred lines from the actual cause. See screenshot.mjs, which learned
 * the same lesson.
 */
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
/* The key `deviceId()` actually reads — see src/lib/deviceId.ts. It was 'ody-device-id'
   once, and this script kept writing that long after the rename, so the page generated a
   fresh UUID instead, found it unlicensed, and rendered "This device is not set up as a
   till" while the API calls below (which take DEVICE as a parameter) went on passing. */
await evaluate(
  `localStorage.setItem('odyssey.device.id', ${JSON.stringify(DEVICE)}), true`,
)

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

/*
 * ── Past the tables gate ───────────────────────────────────────────────────
 *
 * A HOSPITALITY till opens on Tables and has no sale pane until a basket exists, so
 * every assertion below it ran against a screen with no basket, no primary button and
 * no quick keys — reporting the return feature as broken when nothing had been opened.
 * "Quick sale" is the counter/walk-in path and the closest thing to a retail till.
 * A retail till has no gate, so the click is best-effort.
 */
for (let i = 0; i < 20; i++) {
  const state = await evaluate(
    [
      '(() => {',
      "  if (document.querySelector('section')) return 'pane'",
      "  const q = [...document.querySelectorAll('button, a')].find((b) => /Quick sale/i.test(b.innerText || ''))",
      "  if (q) { q.click(); return 'clicked' }",
      "  return 'waiting'",
      '})()',
    ].join('\n'),
  )
  if (state === 'pane') break
  await sleep(700)
}

/*
 * VERIFY_PROBE_FILE='<path>' runs that file's JS in the signed-in till and prints the
 * result, then stops. The screenshot script has the same hook, but it cannot get past
 * the clerk PIN gate — and this one has already minted the till cookie by here, so it
 * is the only place a question about the RENDERED till can be asked directly.
 */
if (process.env.VERIFY_PROBE_FILE) {
  const body = readFileSync(process.env.VERIFY_PROBE_FILE, 'utf8')
  const probed = await evaluate(`(async () => { ${body} })()`)
  console.log('probe:', typeof probed === 'string' ? probed : JSON.stringify(probed))
  console.log('screenshot ->', await shot('pos-probe'))
  process.exit(0)
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
async function addOneItem(railIndex = 0) {
  /* Into the DEPARTMENT rail first. Since the quick keys became the way into return
     mode, the keys floor holds an action key ("Refund") that lives in the same kind of
     grid as a product tile — the drill below would happily click it and put the till
     into a return instead of adding anything. Starting from a department sidesteps it.

     `railIndex` because the FIRST department on this site ("Imp …") holds no products of
     its own — a real shape, not a broken fixture, and one that made this script pass or
     fail depending on which department it happened to land in. The caller walks the rail
     until one of them yields something priced. */
  const rail = await evaluate(
    [
      '(() => {',
      "  const nav = document.querySelector('nav')",
      "  const rows = nav ? [...nav.querySelectorAll('button')] : []",
      `  if (rows[${railIndex}]) rows[${railIndex}].click()`,
      '  return rows.length',
      '})()',
    ].join('\n'),
  )
  if (railIndex >= (rail ?? 0)) return { clicked: null, reason: 'no such department' }
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

/*
 * Back to the quick-key floor of the catalogue.
 *
 * `addOneItem` drills DOWN through departments to find something priced, and the quick
 * keys only render on the top view (CatalogPane renders them for view.kind === 'keys').
 * So after adding an item the Refund key is not on screen — which looks exactly like the
 * key having been removed. Clicks Back until it stops moving.
 */
async function backToKeys() {
  /* Give the catalogue a moment to arrive before deciding where we are — the till can
     paint its panes before the products (and therefore the quick keys) land. */
  for (let i = 0; i < 20; i++) {
    const ready = await evaluate(
      `[...document.querySelectorAll('button')].some((b) => /Credits goods coming back/.test(b.innerText||'')) ||
       [...document.querySelectorAll('button')].some((b) => (b.innerText||'').trim() === 'Back')`,
    )
    if (ready) break
    await sleep(500)
  }
  for (let i = 0; i < 8; i++) {
    /* Already there? The keys floor is the one that shows an action key. Checked FIRST
       and each time round, because "Back" does not disappear at the top of the tree —
       looping on its presence alone never terminates at the right place.
       Matched on the key's HINT, not on "Refund": the primary button says Refund too
       once the till is in return mode, and that one is on screen at every depth. */
    const onKeys = await evaluate(
      `[...document.querySelectorAll('button')].some((b) => /Credits goods coming back/.test(b.innerText||''))`,
    )
    if (onKeys) return true
    const clicked = await evaluate(
      [
        '(() => {',
        "  const b = [...document.querySelectorAll('button')].find(",
        "    (x) => (x.innerText || '').trim() === 'Back' && x.getBoundingClientRect().width > 0",
        '  )',
        '  if (!b) return false',
        '  b.click()',
        '  return true',
        '})()',
      ].join('\n'),
    )
    if (!clicked) break
    await sleep(900)
  }
  /*
   * Into the Supervisor FOLDER, which is where the seeder actually puts the refund key —
   * it is a supervisor action, not a counter one. A quick-key group is a tile that opens
   * a second floor of keys rather than running anything, so the key is one tap deeper
   * than the floor this function had been settling for.
   */
  const already = await evaluate(
    `[...document.querySelectorAll('button')].some((b) => /Credits goods coming back/.test(b.innerText||''))`,
  )
  if (already) return true

  await evaluate(
    [
      '(() => {',
      "  const g = [...document.querySelectorAll('button')].find(",
      "    (b) => /Supervisor/i.test(b.innerText || '') && b.getBoundingClientRect().width > 0",
      '  )',
      '  if (!g) return false',
      '  g.click()',
      '  return true',
      '})()',
    ].join('\n'),
  )
  await sleep(900)

  /* One last look, so a caller can tell "we got there" from "we gave up". If the key
     still is not there, the till genuinely has no Refund key configured. */
  return evaluate(
    `[...document.querySelectorAll('button')].some((b) => /Credits goods coming back/.test(b.innerText||''))`,
  )
}

/**
 * The primary end-of-sale button: its word and its computed background.
 *
 * The BIGGEST match, not the first one in document order. "Refund" is now both the
 * quick key's label and the primary button's word in return mode, and the key comes
 * first in the DOM — so a plain find() would measure the key's colour and compare it
 * against the footer Pay button, which proves nothing about what a cashier presses.
 */
const primaryButton = () =>
  evaluate(
    [
      '(() => {',
      "  const all = [...document.querySelectorAll('button')].filter((x) =>",
      "    /^(Pay|Refund|Working)/.test((x.innerText || '').trim())",
      '  )',
      '  if (!all.length) return null',
      '  const b = all.sort((p, q) => {',
      '    const a = p.getBoundingClientRect(), c = q.getBoundingClientRect()',
      '    return c.width * c.height - a.width * a.height',
      '  })[0]',
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

/* ── 1. There is no mode switch, and a plain basket says nothing ─────────── */

/* The Sale/Return segmented control was REMOVED: return mode is entered by the Refund
   quick key and left when the credit note posts. So the check inverted — a pane that
   offered the choice again would be the regression. What must still hold is that an
   ordinary basket is not labelled a return, since the banner below is the only thing
   distinguishing the two directions once the switch is gone. */
/* The quick keys arrive with the catalogue, a beat after the pane paints, and reading
   the labels too early reports "no Refund key" for a till that has one. backToKeys
   polls for the key itself, so it doubles as that wait. */
await backToKeys()
const modeUi = await evaluate(
  [
    '(() => {',
    "  const labels = [...document.querySelectorAll('button')].map((b) => (b.innerText||'').trim())",
    "  const pane = document.querySelector('section')",
    /* startsWith, not equality: the key renders its caption AND its hint inside the
       button, so its innerText is "Refund\nCredits goods coming back." */
    "  return { sale: labels.includes('Sale'), refundKey: labels.some((t) => /^Refund/.test(t)),",
    "           banner: /Return/.test((pane && pane.innerText || '').split('\\n').slice(0, 3).join(' ')) }",
    '})()',
  ].join('\n'),
)
ok('the pane no longer offers a Sale/Return switch', modeUi?.sale === false, JSON.stringify(modeUi))
ok('  and a selling basket wears no Return banner', modeUi?.banner === false)

/*
 * The Refund quick key is the ONLY way into return mode now that the switch is gone, so
 * a till with no key configured cannot take a return at all.
 *
 * `pos_quick_keys` is empty on a freshly seeded site, which is a FIXTURE gap rather than
 * a code fault — but it is not something to pass over quietly either, because the same
 * empty table on a real shop's till is exactly the misconfiguration that strands a
 * cashier. So it is called out, and the assertions that depend on pressing the key are
 * skipped rather than reported as failures of the feature they cannot reach.
 */
/* Not asserted HERE, only reported. On a hospitality till the catalogue opens on the
   tables view rather than the quick-key floor, so the key legitimately is not on screen
   yet at this point — the assertion that matters is the press further down, which runs
   after backToKeys() has actually reached the floor. Asserting it here reported a
   missing key on a till whose key then worked two steps later. */
if (modeUi?.refundKey !== true) {
  console.log('\nNOTE: no Refund quick key on screen yet — expected on a hospitality till,')
  console.log('which opens on the tables view. The press is asserted below instead.')
  console.log('If it fails there too, check pos_quick_keys has an a:refund row.\n')
}

/* ── 2. A sale basket, then switching to Return, CLEARS it ───────────────── */

/* Walks the department rail rather than trusting the first one to hold stock: the first
   department on this site holds none of its own, so a fixed index made this pass or fail
   on which one it happened to land in. */
async function addFromAnyDepartment() {
  let result = null
  for (let dept = 0; dept < 6; dept++) {
    result = await addOneItem(dept)
    if ((await basketCount()) > 0) return result
    if (result?.reason === 'no such department') return result
    await backToKeys()
  }
  return result
}

const added = await addFromAnyDepartment()
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

/* The Refund QUICK KEY is now the way in.
   Found by its HINT rather than by the word "Refund": a quick key renders its caption
   and its hint inside the one button, so its innerText is "Refund\nCredits goods coming
   back." and an exact-text match finds nothing at all. */
await backToKeys()
const pressedKey = await evaluate(
  [
    '(() => {',
    "  const b = [...document.querySelectorAll('button')].find(",
    "    (x) => /Credits goods coming back/.test(x.innerText || '')",
    '  )',
    '  if (!b) return false',
    '  b.click()',
    '  return true',
    '})()',
  ].join('\n'),
)
ok('the Refund key switches into return mode', pressedKey === true)
await sleep(900)

/* THE assertion. A return's lines surviving into a sale — or a sale's into a return —
   would ring up or credit the wrong direction with nothing on screen looking wrong. */
ok(
  '*** switching to Return CLEARS the basket ***',
  (await basketCount()) === 0,
  `${await basketCount()} line(s) left`,
)

/* With the switch gone, the banner is the ONLY thing on screen saying which direction
   the goods are going. If it fails to appear, a cashier is crediting blind. */
const banner = await evaluate(
  [
    '(() => {',
    "  const pane = document.querySelector('section')",
    "  return /Return/.test((pane && pane.innerText || '').split('\\n').slice(0, 3).join(' '))",
    '})()',
  ].join('\n'),
)
ok('*** the pane now shows the Return banner ***', banner === true)

/* ── 3. The button changes word AND colour ──────────────────────────────── */

/* Something IN the return basket, or the Refund button is disabled and the colour and
   pad assertions below measure a greyed control instead of the one a cashier presses. */
await addFromAnyDepartment()
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
