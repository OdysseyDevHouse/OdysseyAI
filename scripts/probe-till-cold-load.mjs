// How long the till takes to become USABLE, measured properly.
//
//   APP_URL=http://localhost:4200 node --env-file=.env.local scripts/probe-till-cold-load.mjs
//
// probe-till-payload's wall figure included its own fixed sleep, so it measured
// the harness. This waits on real signals instead — Page.loadEventFired and the
// first paint of till content — and runs each measurement three ways:
// unthrottled, then at tablet-class CPU and shop-wifi bandwidth.
//
// The question it answers: does a PRODUCTION build on a LAN still take seconds
// on a tablet, or was the weekend's lag the dev build?
import { launchChrome, sleep } from './lib/cdp-chrome.mjs'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4200'

const { wsUrl, close: closeChrome } = await launchChrome('coldload')
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
let onEvent = null
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.method) { onEvent?.(m); return }
  const entry = pending.get(m.id); if (!entry) return
  pending.delete(m.id)
  m.error ? entry.reject(new Error(JSON.stringify(m.error))) : entry.resolve(m.result)
}
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params, sessionId })) })

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
for (const d of ['Page', 'Runtime', 'Network']) await send(d + '.enable', {}, sessionId)

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}

/* Sign in */
await send('Page.navigate', { url: BASE + '/' }, sessionId); await sleep(3000)
await evaluate(`
  (() => { const set = (s, v) => { const el = document.querySelector(s)
      Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('input[type=email]', ${JSON.stringify(EMAIL)}); set('input[type=password]', ${JSON.stringify(PASSWORD)})
    document.querySelector('form').requestSubmit(); return true })()
`)
await sleep(4500)
if (await evaluate(`(() => { const h=[...document.querySelectorAll('button,a')].find(el=>/Sea Point/i.test(el.innerText||'')); if(h){h.click();return true} return false })()`)) await sleep(3000)

/** Navigate to /pos cold, and time until the till has actually painted. */
async function coldLoad(label, { cpu = 1, latency = 0, down = 0, up = 0 } = {}) {
  await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId)
  await send('Emulation.setCPUThrottlingRate', { rate: cpu }, sessionId)
  if (latency || down) {
    await send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: down / 8, uploadThroughput: up / 8 }, sessionId)
  }
  // Park somewhere else so /pos is a genuine cold navigation.
  await send('Page.navigate', { url: BASE + '/welcome' }, sessionId); await sleep(1500)

  let bytes = 0
  let loadFired = 0
  const t0 = Date.now()
  onEvent = (m) => {
    if (m.method === 'Network.loadingFinished') bytes += m.params.encodedDataLength || 0
    if (m.method === 'Page.loadEventFired' && !loadFired) loadFired = Date.now() - t0
  }
  await send('Page.navigate', { url: BASE + '/pos' }, sessionId)

  // Poll for the till actually showing something, rather than sleeping blindly.
  let painted = 0
  for (let i = 0; i < 200; i++) {
    await sleep(100)
    const ready = await evaluate(`(() => { const t = document.body?.innerText || ''; return t.length > 40 })()`).catch(() => false)
    if (ready) { painted = Date.now() - t0; break }
  }
  onEvent = null
  console.log(`${label.padEnd(38)} load ${String(loadFired || '-').padStart(5)}ms   content ${String(painted || 'timeout').padStart(6)}ms   ${(bytes / 1024 / 1024).toFixed(2)} MB`)
  await send('Emulation.setCPUThrottlingRate', { rate: 1 }, sessionId)
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId)
}

console.log(`\nagainst ${BASE}\n`)
await coldLoad('desktop, no throttle')
await coldLoad('tablet CPU (4x)', { cpu: 4 })
await coldLoad('tablet CPU + shop wifi (20Mbps)', { cpu: 4, latency: 15, down: 20_000_000, up: 5_000_000 })
await coldLoad('cheap tablet (6x) + wifi', { cpu: 6, latency: 25, down: 10_000_000, up: 3_000_000 })

await closeChrome()
process.exit(0)
