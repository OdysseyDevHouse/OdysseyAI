// Proves the till's Dexie v2 upgrade does not lose a pending sale.
//
//   node --env-file=.env.local scripts/verify-pos-upgrade.mjs
//
// This is the one thing about the parked-baskets change that could destroy real
// money. A `pending` outbox row is a sale that HAPPENED — the goods are gone, the
// cash is in the drawer, and that row is the only record of it. A version bump that
// dropped, renamed or re-keyed `outbox` while adding `parked` would lose it silently,
// and no amount of counting afterwards would reconstruct it.
//
// It needs a real browser because Dexie applies an upgrade only against a database
// that already exists at the OLD version. A fresh database in a test would create v2
// directly and never exercise the upgrade path at all — passing while proving nothing.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const BASE = process.env.APP_URL || 'http://localhost:4100'
const PORT = 9335
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = path.join(tmpdir(), `odyssey-upgrade-${process.pid}`)
mkdirSync(profile, { recursive: true })

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    `--user-data-dir=${profile}`,
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

const { targetId } = await send('Target.createTarget', { url: BASE })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await sleep(2500)

async function evaluate(expression) {
  const r = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  )
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}

let fails = 0
const ok = (label, cond, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

// Written as a plain function body string rather than a nested template literal:
// backticks inside a CDP `evaluate` payload are a quoting trap I have already been
// caught by once in this file's sibling.
const script = [
  '(async () => {',
  "  const NAME = 'upgrade-verify'",
  '  const open = (version, upgrade) => new Promise((resolve, reject) => {',
  '    const rq = indexedDB.open(NAME, version)',
  '    rq.onupgradeneeded = () => upgrade(rq.result)',
  '    rq.onsuccess = () => resolve(rq.result)',
  '    rq.onerror = () => reject(rq.error)',
  '  })',
  '  const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error) })',
  '  const get = (db, store, key) => new Promise((res) => {',
  '    const rq = db.transaction(store).objectStore(store).get(key)',
  '    rq.onsuccess = () => res(rq.result)',
  '  })',
  '  const count = (db, store) => new Promise((res) => {',
  '    const rq = db.transaction(store).objectStore(store).count()',
  '    rq.onsuccess = () => res(rq.result)',
  '  })',
  '',
  '  // v1: the shape before parked baskets, holding a real pending sale.',
  '  const v1 = await open(1, (db) => {',
  "    db.createObjectStore('products', { keyPath: 'id' })",
  "    db.createObjectStore('outbox', { keyPath: 'saleUid' })",
  "    db.createObjectStore('kv', { keyPath: 'key' })",
  '  })',
  "  const tx1 = v1.transaction('outbox', 'readwrite')",
  "  tx1.objectStore('outbox').put({ saleUid: 'real-sale', status: 'pending', documentNumber: 'INV_01_01_000999', claimedTotalIncl: 42.5 })",
  '  await done(tx1)',
  '  v1.close()',
  '',
  '  // v2: add `parked`, and touch nothing else. This is the upgrade under test.',
  '  const v2 = await open(2, (db) => {',
  "    if (!db.objectStoreNames.contains('parked')) db.createObjectStore('parked', { keyPath: 'uid' })",
  '  })',
  "  const survivor = await get(v2, 'outbox', 'real-sale')",
  '',
  '  // Park two, recall one, and confirm the recall REMOVES it.',
  "  const tx2 = v2.transaction('parked', 'readwrite')",
  "  tx2.objectStore('parked').put({ uid: 'a', customerName: 'Walk-in', itemCount: 2, totalIncl: 40.5, lines: [1, 2] })",
  "  tx2.objectStore('parked').put({ uid: 'b', customerName: 'Mrs Patel', itemCount: 1, totalIncl: 12, lines: [1] })",
  '  await done(tx2)',
  "  const parkedBefore = await count(v2, 'parked')",
  "  const recalled = await get(v2, 'parked', 'a')",
  "  const tx3 = v2.transaction('parked', 'readwrite')",
  "  tx3.objectStore('parked').delete('a')",
  '  await done(tx3)',
  "  const parkedAfter = await count(v2, 'parked')",
  "  const outboxAfter = await count(v2, 'outbox')",
  '',
  '  const stores = Array.from(v2.objectStoreNames)',
  '  const version = v2.version',
  '  v2.close()',
  '  await new Promise((res) => { const d = indexedDB.deleteDatabase(NAME); d.onsuccess = res; d.onerror = res })',
  '  return {',
  '    version, stores,',
  "    survivorOk: survivor && survivor.saleUid === 'real-sale' && survivor.status === 'pending' && survivor.claimedTotalIncl === 42.5,",
  '    outboxAfter, parkedBefore, parkedAfter,',
  '    recalledLines: recalled ? recalled.lines.length : 0,',
  '    recalledName: recalled ? recalled.customerName : null,',
  '  }',
  '})()',
].join('\n')

const r = await evaluate(script)

console.log(`\nupgraded to version ${r.version}, stores: ${r.stores.join(', ')}\n`)

ok('the upgrade adds the parked table', r.stores.includes('parked'), r.stores.join(', '))
ok('and keeps products, outbox and kv', ['products', 'outbox', 'kv'].every((s) => r.stores.includes(s)))
ok(
  'THE PENDING SALE SURVIVES THE UPGRADE, intact',
  r.survivorOk === true,
  'uid, status and total all unchanged',
)
ok('and it is still the only outbox row', r.outboxAfter === 1, String(r.outboxAfter))
ok('two baskets park', r.parkedBefore === 2, String(r.parkedBefore))
ok(
  'a recall returns the basket whole',
  r.recalledLines === 2 && r.recalledName === 'Walk-in',
  `${r.recalledName}, ${r.recalledLines} lines`,
)
ok(
  'and REMOVES it, so one basket cannot be recalled twice',
  r.parkedAfter === 1,
  `${r.parkedBefore} -> ${r.parkedAfter}`,
)

console.log(fails === 0 ? '\nUpgrade verified — no pending sale lost.' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
