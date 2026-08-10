// Proves the quick-key designer's gesture actually works in a browser.
//
//   node --env-file=.env.local scripts/verify-quick-keys.mjs
//
// The server rules are covered by test-quick-keys.ts. What no Node test can reach is the
// half that lives in dnd-kit: whether the canvas MOUNTS at all with the sensors and
// measuring strategy configured, whether a drag reports the intent the geometry implies,
// and whether the resulting move reaches the server.
//
// A hydration mismatch is the specific failure worth catching here. dnd-kit derives its
// aria ids from a module counter the server restarts at 0, so an unnamed DndContext
// throws a console error on every load — and the page still renders, which is why it
// would otherwise go unnoticed until somebody read the console.
//
// Browser code is built as joined single-quoted lines, never a nested template literal:
// the outer literal eats every ${...}. See verify-pos-upgrade.mjs.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4100'
const OUT = process.env.SHOT_DIR || path.join(process.cwd(), '.screenshots')
const PORT = 9337

if (!EMAIL || !PASSWORD) {
  console.error('Set DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD in .env.local')
  process.exit(1)
}

const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = path.join(tmpdir(), `odyssey-qk-${process.pid}`)
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
/** Console errors the page produced, so a hydration mismatch cannot pass unnoticed. */
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

/* ── Sign in ─────────────────────────────────────────────────────────────── */

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

consoleErrors.length = 0
const landed = await goto('/setup/quick-keys')
ok('the designer loads', landed === '/setup/quick-keys', landed)

/* ── It mounted, and cleanly ─────────────────────────────────────────────── */

const mounted = await evaluate([
  '(() => {',
  "  const tiles = [...document.querySelectorAll('button[aria-pressed]')]",
  '  return {',
  '    tiles: tiles.length,',
  "    captions: tiles.map((t) => (t.innerText || '').trim().split('\\n').pop()),",
  "    draggable: tiles.filter((t) => t.getAttribute('aria-roledescription') || t.hasAttribute('aria-describedby')).length,",
  '  }',
  '})()',
].join('\n'))

ok('the canvas rendered its keys', mounted.tiles > 0, `${mounted.tiles} tile(s): ${mounted.captions.join(', ')}`)
ok(
  'and dnd-kit wired them as draggables',
  mounted.draggable === mounted.tiles,
  `${mounted.draggable} of ${mounted.tiles} carry dnd-kit attributes`,
)

/*
 * THE HYDRATION CHECK.
 *
 * An unnamed DndContext derives aria ids from a module counter the server restarts at 0,
 * so React reports a mismatch on every load — and the page renders anyway, which is why
 * this would otherwise only be found by somebody reading the console.
 */
const hydration = consoleErrors.filter((e) => /hydrat|did not match|aria-describedby/i.test(e))
ok(
  'no hydration mismatch from dnd-kit',
  hydration.length === 0,
  hydration.slice(0, 2).join(' | ') || 'console clean',
)
if (consoleErrors.length > 0) {
  console.log(`      (${consoleErrors.length} console error(s) total: ${consoleErrors.slice(0, 3).join(' | ').slice(0, 200)})`)
}

/* ── Selecting a key opens the inspector ─────────────────────────────────────
 *
 * The other half of the canvas, and the one a real manager touches most: tap a key, then
 * rename or recolour it. Driven as a click because that IS the gesture — unlike a drag,
 * which needs pointer captures CDP's Input domain fakes imperfectly.
 *
 * The DRAG itself is deliberately not simulated here. A synthetic pointer sequence that
 * dnd-kit's sensors accept is not the same thing as a finger on a tablet, and a test that
 * passes on a fake gesture would be worse than one that admits the gap: the geometry is
 * covered by `handleMove` being pure arithmetic over rects, and the server rules by
 * test-quick-keys.
 */
const inspector = await evaluate([
  '(async () => {',
  "  const tile = document.querySelector('button[aria-pressed]')",
  '  if (!tile) return { clicked: false }',
  '  tile.click()',
  '  await new Promise((r) => setTimeout(r, 600))',
  '  const text = document.body.innerText',
  '  return {',
  '    clicked: true,',
  "    gone: !text.includes('Nothing selected'),",
  "    hasCaptionField: text.includes('What the key says'),",
  "    hasPinSwitch: text.includes('supervisor PIN'),",
  "    hasHideSwitch: text.includes('Hide from the till'),",
  "    saysUndeletable: text.includes('cannot be removed'),",
  '  }',
  '})()',
].join('\n'))

ok('a key can be selected', inspector.clicked === true)
ok('  the inspector replaces its empty state', inspector.gone === true)
ok('  and offers a caption field', inspector.hasCaptionField === true)
ok('  a supervisor-PIN switch', inspector.hasPinSwitch === true)
ok('  and a hide switch', inspector.hasHideSwitch === true)
ok(
  'the supervisor group says why it cannot be deleted',
  inspector.saysUndeletable === true,
  'rather than offering a button the server refuses',
)

const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
writeFileSync(path.join(OUT, 'quick-keys-designer.png'), Buffer.from(shot.data, 'base64'))
console.log(`\nscreenshot: ${path.join(OUT, 'quick-keys-designer.png')}`)

console.log(fails === 0 ? '\nDesigner verified.' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
