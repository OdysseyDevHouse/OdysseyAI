// The department tap, timed in a real browser, both ways.
//
//   APP_URL=http://localhost:4200 node --env-file=.env.local scripts/probe-browse-inbrowser.mjs
//
// The till's PIN gate stands between a script and the real grid, so rather than
// forge a session this measures the two code paths the change is BETWEEN, in the
// page, over a seeded IndexedDB:
//
//   OLD: browseProductsAction  — a server action round trip, per tap
//   NEW: browseOffline         — an indexed read of this device's own catalogue
//
// It seeds Dexie the way refreshCatalog does, then times a Dexie read against a
// same-origin server round trip, under the network conditions a counter tablet
// actually has.
import { launchChrome, sleep } from './lib/cdp-chrome.mjs'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4200'

const { wsUrl, close: closeChrome } = await launchChrome('browsecmp')
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.method) return
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
await send('Page.navigate', { url: BASE + '/pos' }, sessionId); await sleep(3000)

/* Seed an IndexedDB store shaped like the till's products table: 305 rows with
   a departmentId index, which is what browseOffline reads. Raw IDB rather than
   importing Dexie, so this measures the STORAGE, not a bundler. */
const seeded = await evaluate(`
  (async () => {
    await new Promise((res) => { const r = indexedDB.deleteDatabase('probe-cat'); r.onsuccess = r.onerror = () => res() })
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('probe-cat', 1)
      req.onupgradeneeded = () => { const s = req.result.createObjectStore('products', { keyPath: 'id' }); s.createIndex('departmentId', 'departmentId') }
      req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error)
    })
    const tx = db.transaction('products', 'readwrite')
    const store = tx.objectStore('products')
    // 305 products over 14 departments, the shape of the café site.
    for (let i = 1; i <= 305; i++) {
      store.put({ id: i, departmentId: 7 + (i % 14), parentId: null, code: 'P' + i,
        description: 'Product number ' + i, priceIncl: 10 + (i % 90), sortOrder: i % 50,
        barcode: '600' + i, stockOnHand: 10, taxRateId: 1, departmentName: 'Dept' })
    }
    await new Promise((res) => { tx.oncomplete = res })
    return true
  })()
`)
console.log(`seeded IndexedDB: ${seeded}\n`)

async function timed(label, expr, runs = 9) {
  const r = await evaluate(`
    (async () => {
      const t = []
      for (let i = 0; i < ${runs}; i++) { const t0 = performance.now(); await (${expr}); t.push(performance.now() - t0) }
      t.sort((a, b) => a - b)
      return { median: t[Math.floor(t.length/2)], min: t[0], max: t[t.length-1] }
    })()
  `)
  console.log(`${label.padEnd(44)} median ${r.median.toFixed(1).padStart(7)}ms   (min ${r.min.toFixed(1)}, max ${r.max.toFixed(1)})`)
  return r
}

const READ = `(async () => {
  const db = await new Promise((res) => { const q = indexedDB.open('probe-cat', 1); q.onsuccess = () => res(q.result) })
  const rows = await new Promise((res) => {
    const q = db.transaction('products').objectStore('products').index('departmentId').getAll(7 + Math.floor(Math.random()*14))
    q.onsuccess = () => res(q.result)
  })
  rows.filter(p => p.parentId === null).sort((a,b) => a.sortOrder - b.sortOrder).slice(0, 200)
  db.close()
})()`
const ROUNDTRIP = `fetch(location.pathname, { headers: { RSC: '1' }, cache: 'no-store' })`

for (const [label, cond] of [
  ['no throttle', null],
  ['shop wifi (60ms RTT)', { latency: 60, down: 20_000_000, up: 5_000_000 }],
  ['busy wifi (150ms RTT)', { latency: 150, down: 1_500_000, up: 750_000 }],
]) {
  if (cond) await send('Network.emulateNetworkConditions', { offline: false, latency: cond.latency, downloadThroughput: cond.down/8, uploadThroughput: cond.up/8 }, sessionId)
  console.log(`--- ${label} ---`)
  await timed('  NEW  local IndexedDB read', READ)
  await timed('  OLD  server round trip', ROUNDTRIP, 5)
  console.log('')
}

await closeChrome()
process.exit(0)
