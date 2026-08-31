// What a department tap ACTUALLY costs the tablet, end to end.
//
//   node --env-file=.env.local scripts/probe-tap-latency.mjs
//
// probe-browse-cost.ts showed the DB query is 3-10ms, so the query is not the
// lag. This measures what the browser waits on instead: the whole server-action
// round trip (auth + tillLocation + query + RSC serialisation + network), which
// is what PosShell's browse effect does on EVERY department tap while online.
//
// Then it runs the same measurement under emulated shop-wifi latency, because a
// tablet on wifi to a remote host is the case that felt "like remote desktop"
// and localhost hides exactly that cost.
import path from 'node:path'
import { launchChrome, sleep } from './lib/cdp-chrome.mjs'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4100'
const SITE = Number(process.env.SITE || 33)

if (!EMAIL || !PASSWORD) {
  console.error('Set DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD in .env.local')
  process.exit(1)
}

const { wsUrl, close: closeChrome } = await launchChrome('taplat')
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  const entry = pending.get(m.id)
  if (!entry) return
  pending.delete(m.id)
  m.error ? entry.reject(new Error(JSON.stringify(m.error))) : entry.resolve(m.result)
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
await send('Network.enable', {}, sessionId)

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}
const goto = async (p) => {
  await send('Page.navigate', { url: BASE + p }, sessionId)
  await sleep(2500)
  return evaluate('location.pathname')
}

/* ── Sign in ──────────────────────────────────────────────────────────── */
await goto('/')
await evaluate(`
  (() => {
    const set = (sel, value) => {
      const el = document.querySelector(sel)
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
      setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set('input[type=email]', ${JSON.stringify(EMAIL)})
    set('input[type=password]', ${JSON.stringify(PASSWORD)})
    document.querySelector('form').requestSubmit(); return true
  })()
`)
await sleep(4500)
console.log(`signed in at ${await evaluate('location.pathname')}`)

/* A store picker stands between sign-in and any site page on a multi-store
   account, and it must be answered or every measurement below is of a dialog. */
const picked = await evaluate(`
  (() => {
    const hit = [...document.querySelectorAll('button, a')]
      .find(el => /Sea Point|Odyssey Cafe/i.test(el.innerText || ''))
    if (hit) { hit.click(); return hit.innerText.trim().slice(0, 40) }
    return null
  })()
`)
if (picked) { console.log(`store picker: chose "${picked}"`); await sleep(3000) }

/* ── The measurement ──────────────────────────────────────────────────── */
// The action is invoked the way the till invokes it: a POST to the current page
// carrying the Next-Action id. Rather than scrape that id, drive the REAL till
// page and time the browse effect through the network log, which is what the
// user actually waits on.
await goto('/pos')
const body = await evaluate('document.body.innerText.slice(0, 300)')
console.log(`\n/pos shows:\n${body.split('\n').slice(0, 6).map(l => '   ' + l).join('\n')}\n`)

async function timeActionRoundTrip(label) {
  // Times a bare POST to /pos — the same transport a server action uses, so it
  // captures auth + routing + RSC overhead without needing the action id.
  const r = await evaluate(`
    (async () => {
      const runs = []
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now()
        await fetch(location.pathname, { method: 'GET', headers: { 'RSC': '1' }, cache: 'no-store' })
        runs.push(performance.now() - t0)
      }
      runs.sort((a, b) => a - b)
      return { median: runs[2], min: runs[0], max: runs[4] }
    })()
  `)
  console.log(`${label.padEnd(34)} median ${r.median.toFixed(0).padStart(5)}ms   (min ${r.min.toFixed(0)}, max ${r.max.toFixed(0)})`)
  return r
}

console.log('An RSC request to the till route — auth + render, no throttling:')
await timeActionRoundTrip('  localhost, no throttle')

/* Shop wifi to a remote host. 60ms RTT is a normal ADSL/fibre hop to a
   datacentre; it is not a bad connection, it is a typical one. */
await send('Network.emulateNetworkConditions', {
  offline: false, latency: 60, downloadThroughput: 4_000_000 / 8, uploadThroughput: 1_000_000 / 8,
}, sessionId)
console.log('\nSame request at 60ms RTT / 4Mbps down — a tablet on shop wifi:')
await timeActionRoundTrip('  throttled')

await send('Network.emulateNetworkConditions', {
  offline: false, latency: 150, downloadThroughput: 1_500_000 / 8, uploadThroughput: 750_000 / 8,
}, sessionId)
console.log('\nAt 150ms RTT / 1.5Mbps — busy shop wifi, or a further host:')
await timeActionRoundTrip('  throttled hard')

await closeChrome()
process.exit(0)
