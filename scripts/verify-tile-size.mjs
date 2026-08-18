// Proves the till's tile-size preference works, and survives a reload.
//
//   node --env-file=.env.local scripts/verify-tile-size.mjs
//
// Two things no Node test can reach, because both are browser facts:
//
//   1. The stored size is applied AFTER MOUNT without a hydration mismatch. Reading
//      localStorage during render would give the server one number and the client
//      another; React then discards the client tree on the till's busiest pane. The
//      only way to see that is to load the page and watch the console.
//   2. The grid actually redraws. `gridTemplateColumns` is computed by the browser
//      from a minmax() recipe, so the assertion has to read the COMPUTED style rather
//      than the prop that went in.
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
import { launchChrome } from './lib/cdp-chrome.mjs'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const SECRET = process.env.SESSION_SECRET
const BASE = process.env.APP_URL || 'http://localhost:4100'
const OUT = process.env.SHOT_DIR || path.join(process.cwd(), '.screenshots')
const DEVICE = process.env.VERIFY_DEVICE_ID || 'b7a53389-9e44-4378-873c-af3cbd870b7d'

if (!EMAIL || !PASSWORD) {
  console.error('Set DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD in .env.local')
  process.exit(1)
}
if (!SECRET) {
  console.error('SESSION_SECRET is not set — the till cookie cannot be minted.')
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })

const { wsUrl, close: closeChrome } = await launchChrome('ts')

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
  console.log('\nStill at the gate — the minted cookie was not accepted, so the grid')
  console.log('assertions below cannot run. Nothing about the feature is proven either way.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}

/* ── 1. No hydration mismatch ───────────────────────────────────────────────── */

const hydration = consoleErrors.filter((m) => /hydrat|did not match|server rendered/i.test(m))
ok(
  'no hydration mismatch from reading localStorage after mount',
  hydration.length === 0,
  hydration.slice(0, 2).join(' | '),
)

/* ── 2. The grid draws at the default ───────────────────────────────────────── */

/*
 * The grid whose size this feature controls.
 *
 * Matched on the RECIPE carrying the sized width, not "the first grid on the page".
 * That was the first version and it silently measured the wrong element: with no quick
 * keys configured the only grid on screen is the department rail, whose size is fixed —
 * so the recipe assertions passed (they read the sized grid) while the column count
 * came from a grid nothing had resized, and reported 4 -> 4 for a real change.
 */
const gridOf = (width) =>
  [
    '(() => {',
    "  const grids = [...document.querySelectorAll('div')].filter(",
    '    (d) =>',
    "      getComputedStyle(d).display === 'grid' &&",
    `      d.style.gridTemplateColumns.includes('${width}px') &&`,
    /* VISIBLE, which the first two versions of this did not check. A hidden pane still
       reports a full gridTemplateColumns from getComputedStyle — 4 tracks at zero
       width — so measuring one gives a column count that never responds to anything
       and a comparison that can only ever pass by accident. */
    '      d.getBoundingClientRect().width > 0',
    '  )',
    '  if (!grids.length) return null',
    '  const g = grids[0]',
    '  const cs = getComputedStyle(g)',
    '  return {',
    '    columns: cs.gridTemplateColumns.split(" ").filter(Boolean).length,',
    '    rowHeight: cs.gridAutoRows,',
    '    recipe: g.style.gridTemplateColumns,',
    '    widthPx: Math.round(g.getBoundingClientRect().width),',
    '  }',
    '})()',
  ].join('\n')

const picked = await openADepartment()
ok('a department opened, so a real product grid is on screen', picked?.n > 0, JSON.stringify(picked))

const before = await evaluate(gridOf(190))
ok('the grid draws at the 190px default', before !== null, JSON.stringify(before))

/* ── 3. A stored size is applied on the next load ───────────────────────────
   Set through the same key the hook writes, then RELOADED — which is the fact that
   matters. Setting state in memory proves nothing about persistence; a till is
   power-cycled every morning and the size has to survive that. */

await evaluate(
  `localStorage.setItem('odyssey.pos.tileSize', JSON.stringify({ width: 300, height: 120 })), true`,
)
consoleErrors.length = 0
await goto('/pos')
await openADepartment()

const after = await evaluate(gridOf(300))
ok('the stored width survives a reload', after !== null, after?.recipe ?? '')
ok('and the stored height with it', after?.rowHeight === '120px', after?.rowHeight ?? '')
/* The point of a width setting: a wider tile means fewer of them per row. Guarded on
   the two grids having the same container width, or this compares two different panes
   and means nothing — which is exactly how the first version of this passed a bug. */
ok(
  'fewer columns at a wider tile',
  before !== null &&
    after !== null &&
    before.widthPx === after.widthPx &&
    after.columns < before.columns,
  `${before?.columns} cols @${before?.widthPx}px -> ${after?.columns} cols @${after?.widthPx}px`,
)

const hydration2 = consoleErrors.filter((m) => /hydrat|did not match|server rendered/i.test(m))
ok(
  'still no hydration mismatch with a non-default stored size',
  hydration2.length === 0,
  hydration2.slice(0, 2).join(' | '),
)

/* ── 4. A junk stored value degrades to something usable ────────────────────
   The clamp matters more than it looks: 4000 gives one tile per row with the whole
   catalogue below the fold, and the only way back is knowing the storage key exists. */

await evaluate(
  `localStorage.setItem('odyssey.pos.tileSize', JSON.stringify({ width: 4000, height: -50 })), true`,
)
await goto('/pos')
await openADepartment()
const clamped = await evaluate(gridOf(420))
ok(
  'an out-of-range stored width is clamped to the ceiling, not obeyed',
  clamped !== null,
  clamped?.recipe ?? 'no grid at 420px — the 4000 was obeyed',
)
ok(
  'and a negative height clamps to the floor',
  clamped?.rowHeight === '80px',
  clamped?.rowHeight ?? '',
)

/* ── 5. The dialog opens and previews ───────────────────────────────────────── */

await evaluate(`localStorage.removeItem('odyssey.pos.tileSize'), true`)
await goto('/pos')
const opened = await evaluate(
  [
    '(() => {',
    "  const b = [...document.querySelectorAll('button')].find(",
    "    (x) => (x.getAttribute('aria-label') || '') === 'Tile size'",
    '  )',
    '  if (!b) return { found: false }',
    '  b.click()',
    '  return { found: true }',
    '})()',
  ].join('\n'),
)
ok('the status bar has a tile-size button', opened?.found === true)

await sleep(900)
const dialog = await evaluate(
  [
    '(() => {',
    "  const d = document.querySelector('dialog[open]')",
    '  if (!d) return null',
    '  return {',
    '    title: (d.innerText || "").slice(0, 40),',
    "    sliders: d.querySelectorAll('input[type=range]').length,",
    '    previewTiles: [...d.querySelectorAll("div")].filter(',
    '      (x) => getComputedStyle(x).display === "grid" && /minmax/.test(x.style.gridTemplateColumns)',
    '    ).length,',
    '  }',
    '})()',
  ].join('\n'),
)
ok('the dialog opens', dialog !== null, JSON.stringify(dialog))
ok('with two sliders', dialog?.sliders === 2, String(dialog?.sliders ?? 0))
ok('and a live preview grid', (dialog?.previewTiles ?? 0) >= 1, String(dialog?.previewTiles ?? 0))

const file = await shot('pos-tile-size')
console.log(`\nscreenshot -> ${file}`)

console.log(
  fails === 0 ? '\nAll tile-size checks passed.' : `\n${fails} FAILURE(S)`,
)
process.exit(fails === 0 ? 0 : 1)
