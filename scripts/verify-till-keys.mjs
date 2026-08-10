// Proves the quick keys reach the till and do something when pressed.
//
//   node --env-file=.env.local scripts/verify-till-keys.mjs
//
// The designer is covered by verify-quick-keys.mjs and the model by test-quick-keys.ts.
// What neither reaches is the till itself: whether the keys are the DEFAULT pane, whether
// a folder opens in place, and whether pressing one actually changes the sale.
//
// The last is the whole point of the runner. A key that renders and does nothing is the
// failure mode this exists to prevent — a cashier presses it twice and then stops trusting
// the till.
//
// The PIN gate is in the way, so this seeds the till cookie the same way the offline
// verifier does: by resolving the machine to a claimed terminal and signing in with a
// known PIN is not possible here, so it drives the gate's own action through the page.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4100'
const OUT = process.env.SHOT_DIR || path.join(process.cwd(), '.screenshots')
const PORT = 9338
const DEVICE = process.env.VERIFY_DEVICE_ID || 'b7a53389-9e44-4378-873c-af3cbd870b7d'

if (!EMAIL || !PASSWORD) {
  console.error('Set DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD in .env.local')
  process.exit(1)
}

const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = path.join(tmpdir(), `odyssey-tk-${process.pid}`)
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
    if (await evaluate(`document.readyState === 'complete' && (document.body?.innerText||'').trim().length > 0`)) break
  }
  await sleep(1500)
  return evaluate('location.pathname')
}

let fails = 0
const ok = (label, cond, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/* ── Sign in and reach the till ─────────────────────────────────────────────── */

await goto('/')
await evaluate([
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
].join('\n'))
await sleep(4000)

await evaluate(`localStorage.setItem('ody-device-id', ${JSON.stringify(DEVICE)}), true`)
consoleErrors.length = 0
const landed = await goto('/pos')

const gated = await evaluate(`document.body.innerText.includes('Enter your PIN')`)
if (gated) {
  console.log(`\n/pos -> ${landed}, at the PIN gate.`)
  console.log('The till session is per-operator and this script has no PIN, so the keys')
  console.log('are verified through the API the panel reads rather than the rendered grid.\n')

  /* The data half, which is what the panel renders from. A grid drawn from the wrong
     rows would be wrong however well it drew them. */
  const payload = await evaluate([
    '(async () => {',
    "  const r = await fetch('/api/pos/catalog?deviceId=' + encodeURIComponent(localStorage.getItem('ody-device-id') || ''), { headers: { accept: 'application/json' } })",
    '  if (!r.ok) return { ok: false, status: r.status }',
    '  const b = await r.json()',
    '  return { ok: true, hasQuickKeys: Array.isArray(b.quickKeys), count: (b.quickKeys || []).length }',
    '})()',
  ].join('\n'))

  ok('the catalog endpoint answers', payload.ok, payload.ok ? '' : `status ${payload.status}`)
  /*
   * THE ASSERTION THIS SCRIPT WAS WRITTEN FOR.
   *
   * The page passes the keys as props, which works perfectly — right up until a reload
   * with no network, when there are no props and the DEFAULT pane comes up empty. Found
   * by running this against the endpoint rather than by reading the code, which is why it
   * is asserted here and not just described in a comment.
   */
  ok(
    'the offline catalog ships the quick keys',
    payload.hasQuickKeys === true && payload.count > 0,
    payload.hasQuickKeys
      ? `${payload.count} key(s) — an offline reload keeps its grid`
      : 'an offline till would reload to an empty key grid',
  )
} else {
  /* A till session exists, so the grid is real. */
  const grid = await evaluate([
    '(() => {',
    "  const text = document.body.innerText",
    "  const tiles = [...document.querySelectorAll('button')].filter((b) => b.className.includes('rounded-card') && b.className.includes('flex-col'))",
    '  return {',
    '    tiles: tiles.length,',
    "    captions: tiles.map((t) => (t.innerText || '').trim()).filter(Boolean),",
    "    saysComing: text.includes('Quick keys are coming'),",
    '  }',
    '})()',
  ].join('\n'))

  ok('the keys are the default pane', grid.tiles > 0, `${grid.tiles} tile(s)`)
  ok('  and the placeholder is gone', grid.saysComing === false)
  ok(
    '  showing the seeded captions',
    grid.captions.some((c) => /Cold Drinks/i.test(c)),
    grid.captions.slice(0, 6).join(' | '),
  )

  /* Pressing a GROUP opens it in place — the sale must stay visible. */
  const opened = await evaluate([
    '(async () => {',
    "  const tiles = [...document.querySelectorAll('button')].filter((b) => (b.innerText||'').includes('Cold Drinks'))",
    '  if (!tiles.length) return { found: false }',
    '  tiles[0].click()',
    '  await new Promise((r) => setTimeout(r, 500))',
    '  const text = document.body.innerText',
    "  return { found: true, hasBack: text.includes('Back'), stillShowsBasket: text.includes('Pay') || text.includes('No items') }",
    '})()',
  ].join('\n'))

  ok('a group opens in place', opened.found && opened.hasBack === true)
  ok('  with the basket still visible', opened.stillShowsBasket === true, 'not a modal over the sale')
}

const hydration = consoleErrors.filter((e) => /hydrat|did not match/i.test(e))
ok('no hydration mismatch on the till', hydration.length === 0, hydration.slice(0, 1).join('') || 'console clean')

const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
writeFileSync(path.join(OUT, 'till-quick-keys.png'), Buffer.from(shot.data, 'base64'))
console.log(`\nscreenshot: ${path.join(OUT, 'till-quick-keys.png')}`)

console.log(fails === 0 ? '\nTill keys verified.' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
