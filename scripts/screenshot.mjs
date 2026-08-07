// Logs in and screenshots app screens, so a change can be looked at rather
// than only compiled.
//
//   node --env-file=.env.local scripts/screenshot.mjs /sales/invoicing [more paths...]
//
// Credentials come from DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD in .env.local,
// which is gitignored. Nothing is written to disk but the PNGs.
//
// Chrome is driven over the DevTools protocol rather than through Playwright:
// Node ships a global WebSocket, so this needs no dependency at all, and a
// verification tool that installs a browser toolchain is a tool nobody runs.
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4100'
const OUT = process.env.SHOT_DIR || path.join(process.cwd(), '.screenshots')
const PORT = 9333

if (!EMAIL || !PASSWORD) {
  console.error(
    'Set DEV_LOGIN_EMAIL and DEV_LOGIN_PASSWORD in .env.local, then run with\n' +
      '  node --env-file=.env.local scripts/screenshot.mjs <path> [...]',
  )
  process.exit(1)
}

const paths = process.argv.slice(2)
if (!paths.length) {
  console.error('Give at least one path, e.g. /sales/invoicing')
  process.exit(1)
}

const CHROME =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const profile = path.join(tmpdir(), `odyssey-shot-${process.pid}`)
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

function cleanup() {
  try { chrome.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

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
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})

let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  const entry = pending.get(msg.id)
  if (!entry) return
  pending.delete(msg.id)
  msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
}
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const n = ++id
    pending.set(n, { resolve, reject })
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}

async function goto(p) {
  await send('Page.navigate', { url: `${BASE}${p}` }, sessionId)
  // A fixed wait under-shoots when the dev server is compiling the route for
  // the first time (blank white PNGs). Poll until the page has painted real
  // content, then settle briefly for data that streams in after the shell.
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const ready = await evaluate(
      `document.readyState === 'complete' && (document.body?.innerText || '').trim().length > 0`,
    )
    if (ready) break
  }
  await sleep(1500)
  return evaluate('location.pathname')
}

// ── Sign in ─────────────────────────────────────────────────────────────
// The form posts a server action, not a plain endpoint, so it has to be
// driven as a user: React ignores a raw `.value =`, hence the native setter
// plus an input event.
await goto('/login')
const submitted = await evaluate(`(() => {
  const set = (el, v) => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
      .set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const email = document.querySelector('input[name="email"]')
  const pass = document.querySelector('input[name="password"]')
  if (!email || !pass) return false
  set(email, ${JSON.stringify(EMAIL)})
  set(pass, ${JSON.stringify(PASSWORD)})
  email.closest('form').querySelector('button[type="submit"]').click()
  return true
})()`)

if (!submitted) {
  console.error('Could not find the login fields — has the form changed?')
  process.exit(1)
}

await sleep(4500)
const landed = await evaluate('location.pathname')
if (landed === '/' || landed.startsWith('/login')) {
  const message = await evaluate(
    `(document.querySelector('[role="alert"]') || {}).textContent || 'no message shown'`,
  )
  console.error('Sign-in failed:', message.trim())
  process.exit(1)
}
console.log('signed in, landed on', landed)

// ── Shoot ───────────────────────────────────────────────────────────────
// SHOT_CLICK="Finalise" clicks the button with that label before capturing, so
// a dialog can be looked at too — plenty of screens only show the thing worth
// checking once something has been pressed.
const CLICK = process.env.SHOT_CLICK

for (const p of paths) {
  const at = await goto(p)

  if (CLICK) {
    const clicked = await evaluate(`(() => {
      const wanted = ${JSON.stringify(CLICK)}.trim().toLowerCase()
      const el = [...document.querySelectorAll('button, [role="button"], a')]
        .find((b) => (b.textContent || '').trim().toLowerCase().includes(wanted))
      if (!el) return false
      el.click()
      return true
    })()`)
    if (!clicked) console.warn(`  (no control matching "${CLICK}" on ${p})`)
    await sleep(2500)
  }

  // The dev error overlay (<nextjs-portal>) paints above the whole app, so a
  // single console warning would otherwise blot out every capture. Remove it —
  // this inspects the screen, not the console.
  await evaluate(`document.querySelectorAll('nextjs-portal').forEach((el) => el.remove())`)

  // captureBeyondViewport paints black past the first couple of viewports on
  // long pages under the software rasterizer. Resizing the emulated viewport
  // to the document height (capped so a huge page still rasterises) and
  // capturing plainly is reliable.
  const fullHeight = await evaluate(
    `Math.min(Math.max(document.documentElement.scrollHeight, 1000), 12000)`,
  )
  await send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1600, height: fullHeight, deviceScaleFactor: 1, mobile: false },
    sessionId,
  )
  await sleep(400)

  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  await send('Emulation.clearDeviceMetricsOverride', {}, sessionId)
  const name = (p.replace(/^\//, '').replace(/[^\w.-]+/g, '-') || 'root') + '.png'
  const file = path.join(OUT, name)
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`${p} -> ${at} -> ${file}`)
}

ws.close()
cleanup()
