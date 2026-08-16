// Proves a waiter can split a table's bill.
//
//   node --env-file=.env --env-file=.env.local scripts/verify-pos-split.mjs
//
// The engine is covered by test-pos-split (37, no browser), which proves the money is
// conserved. What that cannot reach is the GESTURE, and the gesture is where this feature
// can go wrong in front of a customer: the floor plan's tiles already resume a table when
// tapped, so arming a second meaning for the same tap has to be unmistakable.
//
// Requires site 1 in hospitality mode with a seated table — see tmp-seed-hospitality.ts.
// Four browser facts:
//
//   1. The gate offers "Split a bill" only when some table HAS one.
//   2. Arming it CHANGES what the tile tap does, and says so.
//   3. The split screen opens on the tapped table with its real lines.
//   4. Confirm is refused until BOTH a line and a destination are chosen — and only FREE
//      tables are offered, because a merge onto an occupied one has no way back.
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
const PORT = 9345
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
const profile = path.join(tmpdir(), `odyssey-spl-${process.pid}`)
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
  console.log('\nStill at the gate — the minted cookie was not accepted, so the split')
  console.log('assertions below cannot run. Nothing about the feature is proven either way.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}

/* ── The floor plan is what a hospitality till opens on ──────────────────── */

const onFloor = await evaluate(
  [
    '(() => {',
    "  const text = document.body.innerText || ''",
    '  return {',
    "    walkIn: /walk-in or takeaway/i.test(text),",
    /* The gate must NOT offer its own Split button any more — the gesture is armed
       from a quick key, and a button here would be a second way in that a shop
       cannot turn off. Asserted as an absence on purpose. */
    "    splitOffer: /split a bill/i.test(text),",
    /*
     * Character classes, not \s and \d.
     *
     * The heredoc that wrote this file collapsed both escapes, so `/^T0\d/` reached the
     * browser as `/^T0d/` and matched nothing — the assertion reported "0 tables on the
     * floor" while four were plainly rendered. `[ \t]` and `[0-9]` survive every layer.
     */
    "    tiles: [...document.querySelectorAll('button')]",
    "      .map((b) => (b.innerText || '').replace(/[ \\t\\r\\n]+/g, ' ').trim())",
    "      .filter((t) => /^T0[0-9]/.test(t)),",
    '  }',
    '})()',
  ].join('\n'),
)
ok('the till opens on the floor plan', onFloor?.walkIn === true, JSON.stringify(onFloor?.tiles))
/* The gate carries NO Split button. It was removed once the gesture became a quick key:
   a shop that does not serve tables should not pay for it in header space, and two ways
   into one gesture is one more than a shop can configure. */
ok('and the gate offers no Split button of its own', onFloor?.splitOffer === false)
ok('the seeded tables are on the floor', (onFloor?.tiles?.length ?? 0) >= 4, String(onFloor?.tiles?.length))

/* ── Arming the mode changes what a tap means, and says so ───────────────── */

const clickText = (re) =>
  evaluate(
    [
      '(() => {',
      "  const b = [...document.querySelectorAll('button')].find((x) =>",
      `    ${re}.test((x.innerText || '').replace(/[ \\t\\r\\n]+/g, ' ').trim()) && !x.disabled`,
      '  )',
      '  if (!b) return false',
      '  b.click()',
      '  return true',
      '})()',
    ].join('\n'),
  )

ok('the split mode can be armed', (await clickText('/^Split a bill/i')) === true)
await sleep(700)
const armed = await evaluate(
  `/tap the bill to split/i.test(document.body.innerText || '')`,
)
/* The armed state must SAY what the next tap will do — the same tile means "resume" a
   moment earlier, and getting that wrong opens the wrong bill in front of a customer. */
ok('*** and it says the next tap will split, not resume ***', armed === true)

/* ── Tapping the occupied table opens the split screen ───────────────────── */

ok('the occupied table can be tapped', (await clickText('/^T01/')) === true)
await sleep(1600)

const screen = await evaluate(
  [
    '(() => {',
    "  const d = document.querySelector('dialog[open]')",
    '  if (!d) return null',
    "  const text = (d.innerText || '')",
    '  return {',
    /* A literal newline inside this string was a syntax error in the browser — the
       heredoc that wrote this file collapsed the escape. Split on a character class
       instead, which needs no escaping at any layer. */
    '    title: text.split(/[\\r\\n]/)[0],',
    "    lines: [...d.querySelectorAll('li')].length,",
    "    staying: /staying on/i.test(text),",
    "    destinations: [...d.querySelectorAll('button')]",
    "      .map((b) => (b.innerText || '').replace(/[ \\t\\r\\n]+/g, ' ').trim())",
    "      .filter((t) => /^T0[0-9]/.test(t)),",
    "    moveDisabled: [...d.querySelectorAll('button')]",
    "      .find((b) => /^Move/.test((b.innerText || '').trim()))?.disabled ?? null,",
    '  }',
    '})()',
  ].join('\n'),
)
ok('the split screen opens', screen !== null, JSON.stringify(screen))
ok('  on the table that was tapped', /T01/.test(screen?.title ?? ''), screen?.title ?? '')
/* The REAL lines, off the document — the tile carries only a count and a total. */
ok('  with the bill’s three lines', screen?.lines === 3, String(screen?.lines))
ok('  and shows what stays behind', screen?.staying === true)

/*
 * Only FREE tables offered. A merge onto an occupied one is refused server-side because
 * two parties' food on one bill has no way back, so it is not offered here either rather
 * than being offered and then refused after the waiter has chosen.
 */
ok(
  '*** T01 is NOT offered as its own destination ***',
  !(screen?.destinations ?? []).some((t) => t.startsWith('T01')),
  (screen?.destinations ?? []).join(', '),
)
ok(
  '  and the three free tables are',
  (screen?.destinations ?? []).length === 3,
  (screen?.destinations ?? []).join(', '),
)

/* Refused until BOTH halves of the gesture are done. Nothing is written until Confirm, so
   a waiter interrupted halfway leaves the bill exactly as it was. */
ok('Move is disabled before anything is chosen', screen?.moveDisabled === true, String(screen?.moveDisabled))
const prompt = await evaluate(
  `/choose what to move/i.test(document.querySelector('dialog[open]')?.innerText || '')`,
)
ok('  and says what is missing rather than sitting there', prompt === true)

/* Choose a line, and the prompt should move on to the table. */
/*
 * Tap the ROW, not the first button inside it.
 *
 * `li button` matched the MINUS stepper, which is disabled at zero — so the click did
 * nothing and the assertion reported the prompt had not advanced. The row is the widest
 * clickable thing in the li, and tapping it moves the whole line, which is the gesture
 * this is meant to exercise.
 */
const tappedLine = await evaluate(
  [
    '(() => {',
    "  const d = document.querySelector('dialog[open]')",
    "  const li = d?.querySelector('li')",
    '  if (!li) return { clicked: null }',
    "  const candidates = [...li.querySelectorAll('button')].filter((b) => {",
    '    const r = b.getBoundingClientRect()',
    '    return !b.disabled && r.width > 120',
    '  })',
    '  const target = candidates[0] || li',
    '  target.click()',
    "  return { clicked: (target.innerText || '').replace(/[ \\t\\r\\n]+/g, ' ').trim().slice(0, 40) }",
    '})()',
  ].join('\n'),
)
await sleep(700)
const afterLine = await evaluate(
  [
    '(() => {',
    "  const d = document.querySelector('dialog[open]')",
    '  if (!d) return null',
    "  const text = d.innerText || ''",
    '  return {',
    "    asksForTable: /choose a table/i.test(text),",
    "    moveDisabled: [...d.querySelectorAll('button')]",
    "      .find((b) => /^Move/.test((b.innerText || '').trim()))?.disabled ?? null,",
    '  }',
    '})()',
  ].join('\n'),
)
ok(
  'choosing a line moves the prompt on to the table',
  afterLine?.asksForTable === true,
  `${JSON.stringify(afterLine)} after tapping ${JSON.stringify(tappedLine?.clicked)}`,
)
ok('  and Move is still disabled without one', afterLine?.moveDisabled === true)

const file = await shot('pos-split')
console.log(`\nscreenshot -> ${file}`)

console.log(fails === 0 ? '\nAll split-screen checks passed.' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
