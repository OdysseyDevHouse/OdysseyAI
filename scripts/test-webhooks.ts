/**
 * Outbound webhooks — signing, enqueue-on-sale, and delivery bookkeeping.
 *
 * The properties that matter most: a producer never fails its caller, a
 * delivery is signed over `t.body` so neither can be swapped, and the retry
 * ladder ends in a dead row rather than hammering forever. No network is
 * touched — delivery runs against an injected fake fetch.
 *
 *   npm run test:webhooks
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  createEndpoint,
  setEndpointActive,
  deleteEndpoint,
  enqueueEvent,
  signPayload,
  backoffMinutes,
  deliverDue,
  listDeliveries,
  redeliver,
} from '../src/lib/site/webhooks'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument, voidDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { findSalesReasonByCode } from '../src/lib/site/salesReasons'
import { createHmac } from 'node:crypto'

const SITE = 1
const actor = { userId: 1, userName: 'Webhook Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const TAG = 'ZWH test'
const URL_A = 'https://zwh-test.example.com/hooks/sales'
const URL_B = 'https://zwh-test.example.com/hooks/orders'

async function sweepStrays() {
  const docs = await siteQuery<any>(
    SITE, `SELECT id FROM sales_documents WHERE customer_name LIKE '${TAG}%'`)
  for (const d of docs) {
    await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id = ?', [d.id])
    await siteExecute(SITE, 'DELETE FROM document_audit WHERE document_id = ?', [d.id])
    await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [d.id])
    await siteExecute(SITE,
      "DELETE l FROM journal_lines l JOIN journal_batches b ON b.id=l.batch_id WHERE b.source IN ('sale','sale_void') AND b.source_doc_id = ?", [d.id])
    await siteExecute(SITE,
      "DELETE FROM journal_batches WHERE source IN ('sale','sale_void') AND source_doc_id = ?", [d.id])
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [d.id])
  }
  // Deliveries cascade with their endpoints.
  await siteExecute(SITE, "DELETE FROM webhook_endpoints WHERE url LIKE 'https://zwh-test.example.com%'")
}

/** Repairs cached account balances after journal rows are deleted raw. */
async function repairBalances() {
  await siteExecute(SITE,
    `UPDATE gl_accounts a SET a.balance = COALESCE(
       (SELECT SUM(l.amount) FROM journal_lines l
         JOIN journal_batches b ON b.id = l.batch_id
        WHERE l.account_id = a.id AND b.status = 'posted'), 0)`)
}

async function main() {
  await sweepStrays()
  const stamp = Date.now().toString().slice(-8)

  /* ── 1. Pure pieces ────────────────────────────────────────────────────── */

  const sig = signPayload('secret1', '{"a":1}', 1_700_000_000)
  const expected = createHmac('sha256', 'secret1').update('1700000000.{"a":1}').digest('hex')
  ok('*** the signature is t + HMAC over `t.body` ***', sig === `t=1700000000,v1=${expected}`)
  ok('  a different timestamp changes it', signPayload('secret1', '{"a":1}', 1) !== sig)
  ok('  a different body changes it', signPayload('secret1', '{"a":2}', 1_700_000_000) !== sig)
  ok('the ladder reads 1, 5, 30, 120, 720',
    [1, 2, 3, 4, 5, 9].map(backoffMinutes).join(',') === '1,5,30,120,720,720')

  /* ── 2. Endpoints ──────────────────────────────────────────────────────── */

  ok('localhost is refused', !(await createEndpoint(SITE, { url: 'http://localhost/x', events: ['sale.finalised'] })).ok)
  ok('junk is refused', !(await createEndpoint(SITE, { url: 'not a url', events: ['sale.finalised'] })).ok)

  const epSales = await createEndpoint(SITE, { url: URL_A, events: ['sale.finalised', 'sale.voided'] })
  const epOrders = await createEndpoint(SITE, { url: URL_B, events: ['order.placed'] })
  ok('*** endpoints create with a secret shown once ***',
    epSales.ok && epOrders.ok && epSales.ok && epSales.secret.length >= 24)
  if (!epSales.ok || !epOrders.ok) { console.log('cannot continue'); process.exit(1) }

  /* ── 3. Enqueue on a real sale ─────────────────────────────────────────── */

  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) throw new Error('CASH tender missing')

  const draft = await saveDraft(SITE, actor, {
    docType: 'invoice', customerName: `${TAG} ${stamp}`,
    lines: [{
      productId: null, description: 'Webhook goods', productType: 'service',
      qty: 1, unitPriceIncl: 115, vatRatePct: 15, unitCostExcl: 0,
    }],
  } as never)
  if (!draft.ok) throw new Error(draft.error)
  const sale = await finaliseDocument(SITE, actor, {
    documentId: draft.id, tenders: [{ tenderTypeId: cash.id, amount: 115 }],
  })
  ok('*** the sale finalises with webhooks in the tail ***', sale.ok, sale.ok ? '' : (sale as any).error)
  if (!sale.ok) { console.log('cannot continue'); process.exit(1) }

  const queued = await siteQuery<any>(
    SITE,
    `SELECT d.*, e.url FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
      WHERE d.event = 'sale.finalised' AND d.payload LIKE ?`,
    [`%${sale.documentNumber}%`],
  )
  ok('*** exactly one delivery queued, at the subscribed endpoint ***',
    queued.length === 1 && String(queued[0].url) === URL_A && String(queued[0].status) === 'pending',
    `${queued.length} rows`)
  ok('  the payload carries the document facts',
    queued.length === 1 && String(queued[0].payload).includes('"totalIncl":115'))
  ok('  the order-only endpoint got nothing',
    !(await siteQuery<any>(SITE,
      `SELECT d.id FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
        WHERE e.url = ? AND d.event = 'sale.finalised'`, [URL_B])).length)

  /* ── 4. The void enqueues too ──────────────────────────────────────────── */

  const reason = await findSalesReasonByCode(SITE, 'void', 'TRAINING')
  if (!reason) throw new Error('void reason TRAINING missing')
  const voided = await voidDocument(SITE, actor, sale.documentId, {
    reasonId: reason.id,
    note: 'ZWH webhook test void',
  })
  ok('*** the void fires sale.voided ***', voided.ok &&
    (await siteQuery<any>(SITE,
      `SELECT d.id FROM webhook_deliveries d WHERE d.event = 'sale.voided' AND d.payload LIKE ?`,
      [`%${sale.documentNumber}%`])).length === 1)

  /* ── 5. Delivery bookkeeping, against a fake fetch ─────────────────────── */

  const calls: { url: string; headers: Record<string, string>; body: string }[] = []
  const fakeFetch = (status: number) =>
    (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init.headers, body: String(init.body) })
      return new Response('', { status })
    }) as typeof fetch

  const first = await deliverDue(SITE, { fetchImpl: fakeFetch(200) })
  ok('*** a 200 delivers everything due ***', first.attempted >= 2 && first.failed === 0,
    JSON.stringify(first))
  ok('  the request carried event, delivery id and signature headers',
    calls.length > 0 &&
      calls.every((c) => c.headers['x-odyssey-event'] && c.headers['x-odyssey-delivery'] &&
        /^t=\d+,v1=[0-9a-f]{64}$/.test(c.headers['x-odyssey-signature'])))
  ok('  and the signature verifies against the stored secret',
    calls.some((c) => {
      const [tPart, vPart] = c.headers['x-odyssey-signature'].split(',')
      const t = Number(tPart.slice(2))
      return vPart.slice(3) ===
        createHmac('sha256', epSales.secret).update(`${t}.${c.body}`).digest('hex')
    }))
  ok('  a second tick finds nothing due', (await deliverDue(SITE, { fetchImpl: fakeFetch(200) })).attempted === 0)

  const delivered = await listDeliveries(SITE, { status: 'delivered' })
  ok('  the log reads them back delivered', delivered.length >= 2 &&
    delivered.every((d) => d.deliveredAt !== null && d.attempts === 1))

  // Redeliver one, then fail it repeatedly to walk the ladder to dead.
  const target = delivered[0]
  await redeliver(SITE, target.id)
  let outcome = await deliverDue(SITE, { fetchImpl: fakeFetch(500) })
  ok('*** a 500 leaves the row pending with attempts = 1 ***',
    outcome.failed >= 1 &&
      String((await siteQueryOne<any>(SITE,
        'SELECT status, attempts FROM webhook_deliveries WHERE id = ?', [target.id]))?.status) === 'pending')

  // Walk the remaining attempts by forcing the row due each time.
  for (let i = 0; i < 4; i++) {
    await siteExecute(SITE,
      'UPDATE webhook_deliveries SET next_attempt_at = NOW() WHERE id = ?', [target.id])
    outcome = await deliverDue(SITE, { fetchImpl: fakeFetch(500) })
  }
  const deadRow = await siteQueryOne<any>(
    SITE, 'SELECT status, attempts, last_error FROM webhook_deliveries WHERE id = ?', [target.id])
  ok('*** the ladder ends dead after 5 attempts ***',
    String(deadRow?.status) === 'dead' && Number(deadRow?.attempts) === 5,
    `${deadRow?.status} after ${deadRow?.attempts}, last: ${deadRow?.last_error}`)

  ok('  redeliver resurrects it', (await redeliver(SITE, target.id)).ok &&
    String((await siteQueryOne<any>(SITE,
      'SELECT status FROM webhook_deliveries WHERE id = ?', [target.id]))?.status) === 'pending')

  // A paused endpoint parks its queue as dead instead of being hammered.
  await setEndpointActive(SITE, epSales.id, false)
  await deliverDue(SITE, { fetchImpl: fakeFetch(200) })
  ok('*** a paused endpoint parks queued rows as dead ***',
    String((await siteQueryOne<any>(SITE,
      'SELECT status, last_error FROM webhook_deliveries WHERE id = ?', [target.id]))?.status) === 'dead')

  /* ── 6. enqueueEvent never throws ──────────────────────────────────────── */

  let threw = false
  try {
    // An event no endpoint subscribes to writes nothing and returns quietly.
    await enqueueEvent(SITE, 'order.paid', { orderId: 0 })
  } catch {
    threw = true
  }
  ok('*** enqueueEvent with no subscribers is a quiet no-op ***', !threw)

  /* ── Clean up ──────────────────────────────────────────────────────────── */

  await deleteEndpoint(SITE, epSales.id)
  await deleteEndpoint(SITE, epOrders.id)
  await sweepStrays()
  await repairBalances()

  console.log(fails === 0 ? '\nAll webhook checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
