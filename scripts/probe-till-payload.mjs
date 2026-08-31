// What the till DOWNLOADS and how long it spends rendering.
//
//   node --env-file=.env.local scripts/probe-till-payload.mjs
//
// The round trip is only 154ms on normal shop wifi (probe-tap-latency), which
// does not explain "a few seconds" on a tablet. The two remaining suspects are
// the size of what crosses the wire — product IMAGES especially, which the JSON
// measurement did not count — and the cost of rendering it on an ARM CPU.
import { launchChrome, sleep } from './lib/cdp-chrome.mjs'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4100'

const { wsUrl, close: closeChrome } = await launchChrome('payload')
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
const events = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.method) { events.push(m); return }
  const entry = pending.get(m.id)
  if (!entry) return
  pending.delete(m.id)
  m.error ? entry.reject(new Error(JSON.stringify(m.error))) : entry.resolve(m.result)
}
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const n = ++id; pending.set(n, { resolve, reject })
    ws.send(JSON.stringify({ id: n, method, params, sessionId }))
  })

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)
await send('Network.enable', {}, sessionId)

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}
const goto = async (p) => { await send('Page.navigate', { url: BASE + p }, sessionId); await sleep(2500); return evaluate('location.pathname') }

await goto('/')
await evaluate(`
  (() => {
    const set = (sel, v) => { const el = document.querySelector(sel)
      Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('input[type=email]', ${JSON.stringify(EMAIL)})
    set('input[type=password]', ${JSON.stringify(PASSWORD)})
    document.querySelector('form').requestSubmit(); return true })()
`)
await sleep(4500)
const picked = await evaluate(`(() => { const h = [...document.querySelectorAll('button,a')].find(el => /Sea Point/i.test(el.innerText||'')); if (h) { h.click(); return true } return false })()`)
if (picked) await sleep(3000)

/* ── Cold load of the till, counting every byte ────────────────────────── */
events.length = 0
await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId)
const t0 = Date.now()
await goto('/pos')
const wall = Date.now() - t0

const byType = new Map()
let total = 0
for (const ev of events) {
  if (ev.method !== 'Network.loadingFinished' && ev.method !== 'Network.responseReceived') continue
  if (ev.method === 'Network.loadingFinished') total += ev.params.encodedDataLength || 0
}
for (const ev of events) {
  if (ev.method !== 'Network.responseReceived') continue
  const t = ev.params.type
  byType.set(t, (byType.get(t) || 0) + 1)
}
console.log(`\ncold /pos load: ${wall}ms wall, ${(total / 1024 / 1024).toFixed(2)} MB transferred`)
console.log('requests by type:')
for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(t).padEnd(12)} ${n}`)

const counts = await evaluate(`({ nodes: document.querySelectorAll('*').length, imgs: document.querySelectorAll('img').length })`)
console.log(`\nDOM: ${counts.nodes} nodes, ${counts.imgs} images`)

/* ── Render cost, simulated on a tablet-class CPU ──────────────────────── */
// 4x is roughly a mid-range Android tablet against a desktop; 6x a cheap one.
for (const rate of [1, 4, 6]) {
  await send('Emulation.setCPUThrottlingRate', { rate }, sessionId)
  const r = await evaluate(`
    (async () => {
      const t0 = performance.now()
      // Force a full style+layout pass over the whole page, the work a
      // re-render of PosShell triggers.
      document.body.getBoundingClientRect()
      const all = document.querySelectorAll('*')
      let acc = 0
      for (const el of all) acc += el.getBoundingClientRect().width
      return performance.now() - t0
    })()
  `)
  console.log(`layout pass over whole page @ ${rate}x CPU throttle: ${r.toFixed(0)}ms`)
}
await send('Emulation.setCPUThrottlingRate', { rate: 1 }, sessionId)

await closeChrome()
process.exit(0)
