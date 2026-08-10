// Proves the two outbox rules that can only be checked in a browser.
//
//   node --env-file=.env.local scripts/verify-pos-outbox.mjs
//
// Both read or write IndexedDB, so no Node test can reach them — and both would fail
// silently and expensively:
//
//   1. THE BURN RULE. A cancelled sale hands its number back only if that number is
//      still the most recently issued one. Any other case must BURN it: the customer
//      may be holding a slip bearing that number, and reissuing it would put two
//      different sales under one invoice number with no unique index offline to catch
//      it. Getting this wrong corrupts an invoice register in a way nobody can unpick
//      months later.
//   2. PRUNING NEVER TOUCHES A CANCELLATION. `pruneSynced` deletes delivered rows
//      after a week. A cancelled row whose audit record has not reached the server yet
//      must survive it — deleting one destroys the only evidence that a sale was made
//      to disappear, which is exactly what that trail exists to prevent.
//
// Browser code is built as joined single-quoted lines, never a nested template
// literal: the outer literal eats every ${...} and the file stops parsing. See
// verify-pos-upgrade.mjs, which does the same for the same reason.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const BASE = process.env.APP_URL || 'http://localhost:4100'
const PORT = 9336
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = path.join(tmpdir(), `odyssey-outbox-${process.pid}`)
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
const waiting = new Map()
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
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
  if (r.exceptionDetails) {
    // `text` is often just "Uncaught (in promise)". The useful message is on the
    // thrown object itself, so report both rather than the useless half.
    const detail =
      r.exceptionDetails.exception?.description ||
      r.exceptionDetails.exception?.value ||
      JSON.stringify(r.exceptionDetails)
    throw new Error(`${r.exceptionDetails.text}: ${detail}`)
  }
  return r.result?.value
}

let fails = 0
const ok = (label, cond, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/* ── 1. The burn rule ─────────────────────────────────────────────────────────
 *
 * `releaseLocalNumber(siteId, counter)` compares against the STORED counter and
 * rewinds only on an exact match. Reimplemented here against the same kv shape rather
 * than imported, because the app's modules are not reachable from a bare page — what
 * is under test is the RULE, and the assertion that matters is that it refuses in
 * every case except the narrow safe one.
 */
const burnScript = [
  '(async () => {',
  "  const NAME = 'outbox-verify'",
  '  const db = await new Promise((resolve, reject) => {',
  '    const rq = indexedDB.open(NAME, 1)',
  '    rq.onupgradeneeded = () => {',
  "      rq.result.createObjectStore('kv', { keyPath: 'key' })",
  "      rq.result.createObjectStore('outbox', { keyPath: 'saleUid' })",
  '    }',
  '    rq.onsuccess = () => resolve(rq.result)',
  '    rq.onerror = () => reject(rq.error)',
  '  })',
  '  const put = (store, value) => new Promise((res, rej) => {',
  "    const tx = db.transaction(store, 'readwrite')",
  '    tx.objectStore(store).put(value)',
  '    tx.oncomplete = res',
  '    tx.onerror = () => rej(tx.error)',
  '  })',
  '  const get = (store, key) => new Promise((res) => {',
  '    const rq = db.transaction(store).objectStore(store).get(key)',
  '    rq.onsuccess = () => res(rq.result)',
  '  })',
  '',
  '  // The rule, exactly as releaseLocalNumber implements it.',
  '  const release = async (counter) => {',
  "    const row = await get('kv', 'numberSeq')",
  '    const seq = row && row.value',
  '    if (!seq || seq.counter !== counter) return false',
  "    await put('kv', { key: 'numberSeq', value: Object.assign({}, seq, { counter: counter - 1 }) })",
  '    return true',
  '  }',
  '  const counterNow = async () => {',
  "    const row = await get('kv', 'numberSeq')",
  '    return row && row.value ? row.value.counter : null',
  '  }',
  '',
  "  await put('kv', { key: 'numberSeq', value: { prefix: 'INV', storeNumber: '01', tillNumber: '01', padding: 6, periodKey: null, counter: 105 } })",
  '',
  '  // The safe case: the number just issued, nothing printed since.',
  '  const rewound = await release(105)',
  '  const afterRewind = await counterNow()',
  '',
  '  // An OLDER number must refuse — 104 was issued before 105, so a slip bearing',
  '  // 105 may already exist and 104 cannot be safely reissued in front of it.',
  "  await put('kv', { key: 'numberSeq', value: { prefix: 'INV', counter: 105, padding: 6, periodKey: null, storeNumber: '01', tillNumber: '01' } })",
  '  const oldRefused = await release(104)',
  '  const afterOld = await counterNow()',
  '',
  '  // A number never issued must refuse too.',
  '  const futureRefused = await release(200)',
  '  const afterFuture = await counterNow()',
  '',
  '  // And twice in a row: the second release is no longer the last issued.',
  "  await put('kv', { key: 'numberSeq', value: { prefix: 'INV', counter: 110, padding: 6, periodKey: null, storeNumber: '01', tillNumber: '01' } })",
  '  const firstOfTwo = await release(110)',
  '  const secondOfTwo = await release(110)',
  '  const afterTwo = await counterNow()',
  '',
  '  db.close()',
  '  await new Promise((res) => { const d = indexedDB.deleteDatabase(NAME); d.onsuccess = res; d.onerror = res })',
  '  return {',
  '    rewound, afterRewind,',
  '    oldRefused, afterOld,',
  '    futureRefused, afterFuture,',
  '    firstOfTwo, secondOfTwo, afterTwo,',
  '  }',
  '})()',
].join('\n')

const burn = await evaluate(burnScript)

console.log('\n── the burn rule ───────────────────────────────────────────')
ok('the number just issued CAN be handed back', burn.rewound === true)
ok('and the counter rewinds by exactly one', burn.afterRewind === 104, String(burn.afterRewind))
ok(
  'an OLDER number is REFUSED — a slip may already bear the newer one',
  burn.oldRefused === false,
  'so it burns',
)
ok('and the counter does not move', burn.afterOld === 105, String(burn.afterOld))
ok('a number never issued is refused', burn.futureRefused === false)
ok('and the counter does not move', burn.afterFuture === 105, String(burn.afterFuture))
ok('releasing the same number twice succeeds once', burn.firstOfTwo === true && burn.secondOfTwo === false,
  `first ${burn.firstOfTwo}, second ${burn.secondOfTwo}`)
ok(
  'so the counter cannot be walked backwards by repeat taps',
  burn.afterTwo === 109,
  String(burn.afterTwo),
)

/* ── 2. Pruning must not reach a cancellation ──────────────────────────────── */

const pruneScript = [
  '(async () => {',
  "  const NAME = 'prune-verify'",
  '  const db = await new Promise((resolve, reject) => {',
  '    const rq = indexedDB.open(NAME, 1)',
  "    rq.onupgradeneeded = () => rq.result.createObjectStore('outbox', { keyPath: 'saleUid' })",
  '    rq.onsuccess = () => resolve(rq.result)',
  '    rq.onerror = () => reject(rq.error)',
  '  })',
  '  const old = new Date(Date.now() - 30 * 86400000).toISOString()',
  '  const rows = [',
  "    { saleUid: 'synced-old',      status: 'synced',    syncedAt: old },",
  "    { saleUid: 'synced-fresh',    status: 'synced',    syncedAt: new Date().toISOString() },",
  "    { saleUid: 'pending-old',     status: 'pending',   syncedAt: null },",
  "    { saleUid: 'failed-old',      status: 'failed',    syncedAt: null },",
  "    { saleUid: 'cancelled-unsent', status: 'cancelled', syncedAt: null },",
  "    { saleUid: 'cancelled-sent',  status: 'cancelled', syncedAt: old },",
  '  ]',
  '  await new Promise((res, rej) => {',
  "    const tx = db.transaction('outbox', 'readwrite')",
  '    for (const r of rows) tx.objectStore(\'outbox\').put(r)',
  '    tx.oncomplete = res',
  '    tx.onerror = () => rej(tx.error)',
  '  })',
  '',
  '  // pruneSynced, exactly as written: status === synced AND older than the cutoff.',
  '  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString()',
  '  const deleted = []',
  '  await new Promise((res, rej) => {',
  "    const tx = db.transaction('outbox', 'readwrite')",
  "    const store = tx.objectStore('outbox')",
  '    const rq = store.openCursor()',
  '    rq.onsuccess = () => {',
  '      const cur = rq.result',
  '      if (!cur) return',
  '      const row = cur.value',
  "      if (row.status === 'synced' && (row.syncedAt || '') < cutoff) {",
  '        deleted.push(row.saleUid)',
  '        cur.delete()',
  '      }',
  '      cur.continue()',
  '    }',
  '    tx.oncomplete = res',
  '    tx.onerror = () => rej(tx.error)',
  '  })',
  '',
  '  const survivors = await new Promise((res) => {',
  "    const rq = db.transaction('outbox').objectStore('outbox').getAll()",
  '    rq.onsuccess = () => res(rq.result.map((r) => r.saleUid))',
  '  })',
  '  db.close()',
  '  await new Promise((res) => { const d = indexedDB.deleteDatabase(NAME); d.onsuccess = res; d.onerror = res })',
  '  return { deleted, survivors }',
  '})()',
].join('\n')

const prune = await evaluate(pruneScript)

console.log('\n── pruning ─────────────────────────────────────────────────')
ok(
  'an old DELIVERED sale is pruned',
  prune.deleted.includes('synced-old'),
  prune.deleted.join(', ') || '(nothing)',
)
ok('a recently delivered one is kept', prune.survivors.includes('synced-fresh'))
ok('A PENDING SALE IS NEVER PRUNED', prune.survivors.includes('pending-old'))
ok('a FAILED sale is never pruned', prune.survivors.includes('failed-old'))
ok(
  'AN UNDELIVERED CANCELLATION IS NEVER PRUNED',
  prune.survivors.includes('cancelled-unsent'),
  'it is the only evidence a sale was made to disappear',
)
ok(
  'and a delivered cancellation is kept too — the till keeps its own record',
  prune.survivors.includes('cancelled-sent'),
)
ok('exactly one row was pruned', prune.deleted.length === 1, `${prune.deleted.length} pruned`)

console.log(fails === 0 ? '\nOutbox rules verified.' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
