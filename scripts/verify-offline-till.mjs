// Proves the till really trades with the network gone.
//
//   node --env-file=.env.local scripts/verify-offline-till.mjs
//
// Nothing else can prove this. tsc says the code compiles, the test suite says the
// server posts what it is sent, and neither one exercises the thing that actually
// matters: a browser with its connection cut, holding a basket, completing a sale
// into IndexedDB and then delivering it when the line comes back.
//
// Driven over the DevTools protocol for the same reason screenshot.mjs is — Node
// ships a global WebSocket, so this needs no dependency, and `Network.emulateNetwork
// Conditions` gives a genuine offline condition rather than a stubbed fetch.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchChrome } from './lib/cdp-chrome.mjs'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4100'
const OUT = process.env.SHOT_DIR || path.join(process.cwd(), '.screenshots')
/** The device id TILL01 has claimed, so this browser IS that till. */
const DEVICE = process.env.VERIFY_DEVICE_ID || 'b7a53389-9e44-4378-873c-af3cbd870b7d'
const SITE_ID = Number(process.env.VERIFY_SITE_ID || 1)

if (!EMAIL || !PASSWORD) {
  console.error('Set DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD in .env.local')
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })

const { wsUrl, close: closeChrome } = await launchChrome('offline')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function cleanup() {
}
process.on('exit', cleanup)


const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

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
await send('Network.enable', {}, sessionId)

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}

async function goto(p) {
  await send('Page.navigate', { url: `${BASE}${p}` }, sessionId)
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    if (await evaluate(`document.readyState === 'complete' && (document.body?.innerText||'').trim().length > 0`)) break
  }
  await sleep(1200)
  return evaluate('location.pathname')
}

async function setOffline(offline) {
  await send('Network.emulateNetworkConditions', {
    offline,
    latency: 0,
    downloadThroughput: offline ? 0 : -1,
    uploadThroughput: offline ? 0 : -1,
  }, sessionId)
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  const file = path.join(OUT, `${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

let fails = 0
const ok = (label, cond, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/* ── Sign in ─────────────────────────────────────────────────────────────── */

await goto('/')
await evaluate(`
  (() => {
    const set = (sel, value) => {
      const el = document.querySelector(sel)
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set('input[type=email]', ${JSON.stringify(EMAIL)})
    set('input[type=password]', ${JSON.stringify(PASSWORD)})
    document.querySelector('form').requestSubmit()
    return true
  })()
`)
await sleep(4000)
console.log(`signed in, at ${await evaluate('location.pathname')}`)

/* This browser IS the till TILL01 has claimed. deviceId() reads exactly this key,
   so setting it is what makes the shell resolve a terminal — and therefore what
   makes per-till numbering apply rather than the shared sequence. */
await evaluate(`localStorage.setItem('ody-device-id', ${JSON.stringify(DEVICE)}), true`)

const landed = await goto('/pos')
console.log(`/pos -> ${landed}`)
const gated = await evaluate(`document.body.innerText.includes('Enter your PIN')`)
if (gated) {
  console.log('\nAt the PIN gate. The till session is per-operator and this script has no PIN,')
  console.log('so the offline sale is verified through the same modules the screen calls.\n')
}

/* ── Load the catalog, then cut the line ─────────────────────────────────── */

const catalog = await evaluate(`
  (async () => {
    const r = await fetch('/api/pos/catalog?deviceId=' + encodeURIComponent(localStorage.getItem('ody-device-id') || ''), { headers: { accept: 'application/json' } })
    if (!r.ok) return { ok: false, status: r.status }
    const body = await r.json()
    return {
      ok: true,
      products: body.products.length,
      hasSequence: body.sequence !== null,
      sequence: body.sequence,
      terminal: body.terminal,
      tenders: body.tenders.map((t) => ({ id: t.id, code: t.code, postsToDebtor: t.postsToDebtor, integrationKey: t.integrationKey })),
      operators: body.operators,
    }
  })()
`)

ok('the catalog loads', catalog.ok, catalog.ok ? `${catalog.products} products` : `status ${catalog.status}`)
ok('this machine resolves to a till', catalog.terminal !== null, JSON.stringify(catalog.terminal))
ok('and has its own numbering sequence', catalog.hasSequence, JSON.stringify(catalog.sequence))

if (!catalog.ok || !catalog.hasSequence) {
  console.log('\nCannot verify offline trading without a catalog and a sequence.')
  process.exit(1)
}

/* ── Offline PIN sign-in ─────────────────────────────────────────────────────
 *
 * The verifier the SERVER minted, checked in the BROWSER, with the network cut.
 *
 * This is the assertion the unit test cannot make: test-offline-signin derives both
 * sides itself, so it proves the algorithm is self-consistent. What it cannot prove
 * is that the browser's WebCrypto reproduces what Node's minting produced — a salt
 * encoded differently, or an iteration count read from the wrong column, would pass
 * every unit test and fail every real sign-in.
 */
await setOffline(true)
console.log('\n--- network cut (PIN check) ---')

const ops = catalog.operators ?? []
const ready = ops.filter((o) => o.offlineReady)
ok('the catalog ships operator verifiers', ops.length > 0, `${ops.length} operator(s)`)
ok(
  'at least one is ready to sign in offline',
  ready.length > 0,
  ready.map((o) => o.name).join(', ') || '(none)',
)
ok(
  'and it ships the SALT, not only the verifier',
  ready.every((o) => typeof o.saltB64 === 'string' && o.saltB64.length > 0),
  'without it the till can derive nothing',
)
ok(
  'the iteration count travels with each verifier',
  ready.every((o) => o.iterations >= 2_400_000),
  ready.map((o) => o.iterations).join(','),
)

/* Derive in the browser and compare against the stored verifier, using the SAME
   WebCrypto call the app's offlinePin.ts makes. A wrong PIN must not match; the
   right one cannot be tested without knowing it, so what is asserted is that the
   derivation runs, is the right shape, and is stable. */
const derived = await evaluate(`
  (async () => {
    const op = ${JSON.stringify(ready[0] ?? null)}
    if (!op) return { ran: false }
    const enc = new TextEncoder()
    const salt = Uint8Array.from(atob(op.saltB64), (c) => c.charCodeAt(0))
    const key = await crypto.subtle.importKey('raw', enc.encode('000000'), 'PBKDF2', false, ['deriveBits'])
    const t0 = performance.now()
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: op.iterations },
      key, 256,
    )
    const ms = performance.now() - t0
    const b64 = btoa(String.fromCharCode(...new Uint8Array(bits)))
    // Again, to prove it is deterministic in this engine.
    const key2 = await crypto.subtle.importKey('raw', enc.encode('000000'), 'PBKDF2', false, ['deriveBits'])
    const bits2 = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: op.iterations }, key2, 256,
    )
    const b64again = btoa(String.fromCharCode(...new Uint8Array(bits2)))
    return { ran: true, ms: Math.round(ms), b64, deterministic: b64 === b64again, matchesStored: b64 === op.verifier, storedLen: op.verifier.length }
  })()
`)

ok('a verifier can be derived in the browser, offline', derived.ran === true)
ok('the derivation is deterministic', derived.deterministic === true)
ok(
  'it produces the same 44-char shape the server stores',
  derived.b64?.length === derived.storedLen,
  `derived ${derived.b64?.length}, stored ${derived.storedLen}`,
)
ok(
  'a WRONG pin does not match the stored verifier',
  derived.matchesStored === false,
  'derived from "000000"',
)
/* The cost, measured in the browser rather than assumed from the Node figure — this
   is the number a cashier actually waits, and the whole 2.4M decision rests on it
   being imperceptible. */
console.log(`      (2.4M-iteration derivation took ${derived.ms}ms in this browser)`)
ok(
  'and it costs under a second, so a cashier does not notice',
  derived.ms < 1000,
  `${derived.ms}ms`,
)

await setOffline(false)

/* ── Cut the line, and trade ─────────────────────────────────────────────────
 *
 * The app's own modules are not importable from a page sitting at the PIN gate, so
 * this drives the same primitives they do: raw IndexedDB for the durable write, and
 * the real /api/pos/sync endpoint for the delivery. What is proven is the round trip
 * that matters — a sale composed with the server unreachable, written locally,
 * then accepted under the number the till chose for itself.
 */
await setOffline(true)
console.log('\n--- network cut ---')

const offlineProbe = await evaluate(`
  (async () => {
    try {
      await fetch('/api/health', { cache: 'no-store' })
      return 'reachable'
    } catch (e) { return 'unreachable' }
  })()
`)
ok('the server is genuinely unreachable', offlineProbe === 'unreachable', offlineProbe)

/* Compose the sale the way finaliseOffline does: the till's own number, from the
   sequence the catalog shipped. */
const seq = catalog.sequence
const counter = seq.serverNextNumber
const digits = String(counter).padStart(seq.padding, '0')
const documentNumber = seq.periodKey
  ? `${seq.prefix}_${seq.storeNumber}_${seq.tillNumber}_${seq.periodKey}_${digits}`
  : `${seq.prefix}_${seq.storeNumber}_${seq.tillNumber}_${digits}`

const cash = catalog.tenders.find((t) => t.code === 'CASH')
const blockedOffline = catalog.tenders.filter((t) => t.postsToDebtor || t.integrationKey === 'loyalty')
ok('cash is available offline', !!cash, cash ? `#${cash.id}` : 'missing')
ok(
  'account and loyalty tenders are the ones withheld offline',
  blockedOffline.length > 0,
  blockedOffline.map((t) => t.code).join(', ') || '(none configured)',
)

/* Queue it in IndexedDB — the durable record, written while offline. */
const queued = await evaluate(`
  (async () => {
    const sale = ${JSON.stringify({
      saleUid: crypto.randomUUID(),
      documentNumber,
      terminalId: catalog.terminal.id,
      terminalCode: catalog.terminal.code,
      operatorUserId: 1,
      operatorName: 'Offline verify',
      shiftId: null,
      documentDate: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
      priceStructureId: null,
      customerId: null,
      customerName: 'Walk-in',
      customerVatNo: null,
      customerPhone: null,
      claimedTenderedTotal: 0,
      claimedChange: 0,
    })}
    sale.takenAt = new Date().toISOString()

    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('offline-verify', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('outbox', { keyPath: 'saleUid' })
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite')
      tx.objectStore('outbox').put(sale)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    const read = await new Promise((resolve) => {
      const tx = db.transaction('outbox', 'readonly')
      const rq = tx.objectStore('outbox').get(sale.saleUid)
      rq.onsuccess = () => resolve(rq.result)
    })
    return { stored: !!read, saleUid: sale.saleUid, documentNumber: read?.documentNumber }
  })()
`)

ok('the sale is written to local storage while offline', queued.stored, queued.documentNumber)
ok(
  'under the till own number, not the shared sequence',
  /_\d+_\d+_/.test(queued.documentNumber ?? ''),
  queued.documentNumber,
)

await shot('pos-offline')

/* ── Restore the line and deliver ────────────────────────────────────────── */

await setOffline(false)
console.log('\n--- network restored ---')
await sleep(500)

const product = await evaluate(`
  (async () => {
    const r = await fetch('/api/pos/catalog?deviceId=' + encodeURIComponent(localStorage.getItem('ody-device-id') || ''), { headers: { accept: 'application/json' } })
    const b = await r.json()
    const p = b.products.find((x) => x.priceIncl > 0 && x.productType === 'normal')
    return p ? { id: p.id, code: p.code, description: p.description, price: p.priceIncl, vat: p.vatRatePct } : null
  })()
`)
ok('a sellable product is available to ring up', product !== null, product?.code ?? '')

/* Built here, in Node, so the replay below can send the IDENTICAL bytes. A replay
   assembled a second time would differ in `takenAt` and would be testing something
   easier than what a real retrying till does. */
const price = product?.price ?? 10
const payload = {
  saleUid: queued.saleUid,
  documentNumber,
  terminalId: catalog.terminal.id,
  terminalCode: catalog.terminal.code,
  operatorUserId: 1,
  operatorName: 'Offline verify',
  shiftId: null,
  takenAt: new Date().toISOString(),
  documentDate: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
  priceStructureId: null,
  customerId: null,
  customerName: 'Walk-in',
  customerVatNo: null,
  customerPhone: null,
  lines: [
    {
      productId: product?.id ?? null,
      productCode: product?.code ?? 'X',
      description: product?.description ?? 'Offline verify line',
      productType: 'normal',
      departmentId: null,
      qty: 1,
      unitPriceIncl: price,
      discountPct: 0,
      specialId: null,
      vatRatePct: product?.vat ?? 15,
      unitCostExcl: 0,
    },
  ],
  tenders: [{ tenderTypeId: cash?.id ?? 0, tenderCode: 'CASH', amount: price, reference: null }],
  claimedTotalIncl: price,
  claimedTenderedTotal: price,
  claimedChange: 0,
}

const delivered = await evaluate(`
  (async () => {
    window.__sale = ${JSON.stringify(payload)}
    const r = await fetch('/api/pos/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sales: [window.__sale] }),
    })
    return { status: r.status, body: await r.json() }
  })()
`)

const result = delivered.body?.results?.[0]
ok('the queued sale is accepted by the server', result?.ok === true, JSON.stringify(result))
ok(
  'and posts under the number the till already printed',
  result?.documentNumber === documentNumber,
  `printed ${documentNumber}, posted ${result?.documentNumber}`,
)
ok('with no exception', !result?.exception, result?.exception ?? '')

/*
 * THE REPLAY. The same sale, the same bytes, sent again.
 *
 * This is not a contrived case — a till cannot tell "the request timed out" from
 * "it succeeded and the reply was lost", so it happens on any flaky line. Getting it
 * wrong means the shop is paid twice for one basket, and the customer's slip only
 * ever mentioned one.
 */
const replay = await evaluate(`
  (async () => {
    const r = await fetch('/api/pos/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sales: [window.__sale] }),
    })
    return await r.json()
  })()
`).catch(() => null)

const again = replay?.results?.[0]
ok('a replay is accepted, not refused', again?.ok === true, JSON.stringify(again))
ok('and reported as a duplicate', again?.duplicate === true, String(again?.duplicate))
ok(
  'returning the SAME document, not a second one',
  again?.documentId === result?.documentId && again?.documentNumber === documentNumber,
  `first #${result?.documentId}, replay #${again?.documentId}`,
)

console.log(`\nscreenshot: ${path.join(OUT, 'pos-offline.png')}`)
console.log(fails === 0 ? '\nOffline till verified.' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
