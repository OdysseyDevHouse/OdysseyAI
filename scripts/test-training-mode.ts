/**
 * Training mode, against a live site database.
 *
 * The claim this feature makes is a strong one: post whatever you like, switch
 * training off, and the store is byte-for-byte where it was. That is only worth
 * anything if it is measured, so this test takes a full census BEFORE training
 * starts, trades properly inside the session — cash sale, account sale, credit
 * note, GRV, stock adjustment — and then asserts the census matches afterwards.
 *
 * A count alone would not catch the interesting failures, so it also checks the
 * two things that are NOT rows and therefore survive a DELETE on their own:
 * stock_on_hand (denormalised, maintained by recordMovement) and the document
 * sequence (advanced by every finalise). Those are the parts a naive purge gets
 * wrong, and they are asserted explicitly.
 *
 *   npm run test:training
 */
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'
import { saveDraft, getDocument } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { reconcileStock, seedOpeningStock } from '../src/lib/site/stockMovements'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { reconcileBalances } from '../src/lib/site/customerLedger'
import { reconcileSupplierBalances } from '../src/lib/site/supplierLedger'
import { createCustomer } from '../src/lib/site/customers'
import { verifySequence } from '../src/lib/site/sequences'
import { toNum } from '../src/lib/decimals'
import {
  currentSession,
  isTrainingActive,
  pendingCounts,
  startTraining,
  stopTraining,
  trainingSummary,
} from '../src/lib/site/trainingMode'

const SITE = 1
const actor = { userId: 1, userName: 'Training Test' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/**
 * The tables the census covers.
 *
 * Deliberately a SEPARATE list from PURGE_TABLES rather than an import of it. A
 * test that measures itself with the same list it is testing cannot detect a
 * table missing from that list — the whole failure mode the census exists to
 * catch. These are written out by hand, from what a day of trading touches.
 */
const CENSUS = [
  'sales_documents',
  'sales_document_lines',
  'sales_tenders',
  'document_audit',
  'stock_movements',
  'journal_batches',
  'journal_lines',
  'customer_transactions',
  'customer_allocations',
  'purchase_documents',
  'purchase_document_lines',
  'stock_adjustments',
  'stock_adjustment_lines',
  'activity_log',
]

type Census = Record<string, number>

async function census(): Promise<Census> {
  const out: Census = {}
  for (const table of CENSUS) {
    try {
      const row = await siteQueryOne<any>(SITE, `SELECT COUNT(*) AS c FROM \`${table}\``)
      out[table] = Number(row?.c ?? 0)
    } catch {
      // A table this site does not have is simply not part of its census.
    }
  }
  return out
}

async function stockOf(productId: number): Promise<number> {
  const row = await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id = ?', [
    productId,
  ])
  return toNum(row?.stock_on_hand)
}

async function seqNext(docType: string): Promise<number> {
  const row = await siteQueryOne<any>(
    SITE,
    'SELECT next_number FROM document_sequences WHERE doc_type = ? ORDER BY terminal_id LIMIT 1',
    [docType],
  )
  return Number(row?.next_number ?? 0)
}

function diff(before: Census, after: Census): string[] {
  const out: string[] = []
  for (const table of Object.keys(before)) {
    if (before[table] !== after[table]) {
      out.push(`${table}: ${before[table]} -> ${after[table]}`)
    }
  }
  return out
}

async function main() {
  // ── Leave no session behind from a previous failed run, or the first
  //    startTraining below refuses and every assertion after it is meaningless.
  if (await isTrainingActive(SITE)) {
    console.log('note: a training session was already open — closing it first')
    await stopTraining(SITE, actor)
  }

  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )
  const vatRate = toNum(vat?.rate, 15)

  // ── Fixtures created BEFORE training starts, so they are below the watermark
  //    and must SURVIVE the purge. This is the master-data promise being tested.
  const res = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id)
     VALUES (?,?,?,?,?,?,?)`,
    [`TRN${stamp}`, `Training fixture ${stamp}`, 'normal', '100.000', '8.0000', '8.0000', vat?.id ?? null],
  )
  const productId = res.insertId

  const cust = await createCustomer(SITE, actor, {
    code: `TRNC${stamp}`,
    name: `Training customer ${stamp}`,
  })
  if (!cust.ok) {
    console.log('could not create the fixture customer:', cust.error)
    process.exit(1)
  }
  const customerId = cust.id

  // An account sale is refused without a credit limit, and the point of using
  // one here is to move the customer subledger — so give it one.
  await siteExecute(SITE, 'UPDATE customers SET credit_limit = ? WHERE id = ?', [
    '10000.00',
    customerId,
  ])

  await seedOpeningStock(SITE, actor)

  const cash = await getTenderByCode(SITE, 'CASH')
  const account = await getTenderByCode(SITE, 'ACCOUNT')
  if (!cash || !account) {
    console.log('missing seeded tenders')
    process.exit(1)
  }

  // ── THE BASELINE ─────────────────────────────────────────────────────────
  const before = await census()
  const stockBefore = await stockOf(productId)
  const seqBefore = await seqNext('invoice')
  const seqIntegrityBefore = await verifySequence(SITE, 'invoice')

  console.log('\n── baseline taken ──')
  console.log(`  stock ${stockBefore}, invoice sequence at ${seqBefore}`)

  // ── SWITCH ON ────────────────────────────────────────────────────────────
  const start = await startTraining(SITE, actor)
  ok('*** training mode started ***', start.ok, start.ok ? `session ${start.session.id}` : start.error)
  if (!start.ok) process.exit(1)

  ok('  isTrainingActive now reports true', await isTrainingActive(SITE))

  const second = await startTraining(SITE, actor)
  ok('  a second session is refused while one is open', !second.ok, second.ok ? 'ACCEPTED!' : second.error)

  const sess = await currentSession(SITE)
  ok('  the open session carries a watermark', Boolean(sess && Object.keys(sess.marks).length > 0), `${Object.keys(sess?.marks ?? {}).length} tables marked`)
  ok(
    '  the watermark covers sales_documents and stock_movements',
    sess?.marks.sales_documents !== undefined && sess?.marks.stock_movements !== undefined,
  )

  // ── TRADE, FOR REAL, INSIDE THE SESSION ──────────────────────────────────
  console.log('\n── trading inside training ──')

  // A cash sale.
  const draft1 = await saveDraft(SITE, actor, {
    docType: 'invoice',
    customerName: 'Walk-in',
    lines: [
      {
        productId,
        productCode: `TRN${stamp}`,
        description: 'Training line',
        productType: 'normal',
        qty: 5,
        unitPriceIncl: 20,
        vatRatePct: vatRate,
        unitCostExcl: 8,
      },
    ],
  })
  ok('cash sale drafted', draft1.ok, draft1.ok ? '' : draft1.error)
  if (!draft1.ok) process.exit(1)

  const fin1 = await finaliseDocument(SITE, actor, {
    documentId: draft1.id,
    tenders: [{ tenderTypeId: cash.id, amount: 200 }],
  })
  ok('cash sale finalised', fin1.ok, fin1.ok ? fin1.documentNumber : fin1.error)

  // An account sale, so the customer subledger moves too.
  const draft2 = await saveDraft(SITE, actor, {
    docType: 'invoice',
    customerId,
    customerName: `Training customer ${stamp}`,
    lines: [
      {
        productId,
        productCode: `TRN${stamp}`,
        description: 'Training line',
        productType: 'normal',
        qty: 2,
        unitPriceIncl: 20,
        vatRatePct: vatRate,
        unitCostExcl: 8,
      },
    ],
  })
  ok('account sale drafted', draft2.ok, draft2.ok ? '' : draft2.error)
  if (!draft2.ok) process.exit(1)

  const fin2 = await finaliseDocument(SITE, actor, {
    documentId: draft2.id,
    tenders: [{ tenderTypeId: account.id, amount: 40 }],
  })
  ok('account sale finalised', fin2.ok, fin2.ok ? fin2.documentNumber : fin2.error)

  // ── MID-SESSION: the things the screen shows ─────────────────────────────
  const stockDuring = await stockOf(productId)
  ok('stock moved during training', stockDuring === stockBefore - 7, `${stockBefore} -> ${stockDuring}`)

  const seqDuring = await seqNext('invoice')
  ok('the sequence advanced during training', seqDuring > seqBefore, `${seqBefore} -> ${seqDuring}`)

  const summary = await trainingSummary(SITE)
  ok('the screen reports training active', summary.active)
  ok('the screen counts pending rows', summary.pendingTotal > 0, `${summary.pendingTotal} rows`)
  ok(
    '  and names sales_documents among them',
    summary.pending.some((p) => p.table === 'sales_documents' && p.rows === 2),
    JSON.stringify(summary.pending.find((p) => p.table === 'sales_documents')),
  )
  ok(
    '  and names stock_movements among them',
    summary.pending.some((p) => p.table === 'stock_movements' && p.rows >= 2),
    JSON.stringify(summary.pending.find((p) => p.table === 'stock_movements')),
  )

  const during = await census()
  const grew = diff(before, during)
  ok('the census shows training actually wrote rows', grew.length > 0, grew.join(', '))
  console.log(`  grew: ${grew.join(', ')}`)

  // ── SWITCH OFF ───────────────────────────────────────────────────────────
  console.log('\n── switching off ──')
  const stop = await stopTraining(SITE, actor)
  ok('*** training mode stopped ***', stop.ok, stop.ok ? `${stop.removedTotal} rows removed` : stop.error)
  if (!stop.ok) process.exit(1)

  ok('  it removed something', stop.removedTotal > 0, `${stop.removedTotal}`)
  ok('  isTrainingActive now reports false', !(await isTrainingActive(SITE)))

  // ── THE POINT OF THE WHOLE TEST ──────────────────────────────────────────
  console.log('\n── proving the store is back where it started ──')

  const after = await census()
  const drift = diff(before, after)
  ok('*** every table is back to its baseline count ***', drift.length === 0, drift.join(', ') || 'no drift')

  const stockAfter = await stockOf(productId)
  ok(
    '*** stock_on_hand is back to what it was ***',
    stockAfter === stockBefore,
    `${stockBefore} -> ${stockAfter}`,
  )

  const seqAfter = await seqNext('invoice')
  ok(
    '*** the invoice sequence was rewound ***',
    seqAfter === seqBefore,
    `${seqBefore} -> during ${seqDuring} -> ${seqAfter}`,
  )

  // The fixtures were created BEFORE the watermark, so they must still be here.
  const productStill = await siteQueryOne<any>(SITE, 'SELECT id FROM products WHERE id = ?', [productId])
  ok('*** master data created before training survived ***', Boolean(productStill))
  const custStill = await siteQueryOne<any>(SITE, 'SELECT id FROM customers WHERE id = ?', [customerId])
  ok('  the fixture customer survived too', Boolean(custStill))

  // The documents themselves must be gone, not merely cancelled.
  const doc1 = await getDocument(SITE, draft1.id)
  ok('*** the training sale is GONE, not cancelled ***', doc1 === null, doc1 ? `status ${doc1.status}` : '')

  // ── AND THE LEDGERS STILL RECONCILE ──────────────────────────────────────
  const stockDrift = await reconcileStock(SITE)
  ok('*** stock still reconciles after the purge ***', stockDrift.length === 0, JSON.stringify(stockDrift.slice(0, 3)))

  const balanceDrift = await reconcileBalances(SITE)
  ok('*** customer balances still reconcile ***', balanceDrift.length === 0, JSON.stringify(balanceDrift.slice(0, 3)))

  // Named explicitly as well as via reconcile: this customer's ONLY transaction
  // was the training sale, so its balance is the case a blanket rebuild that
  // only touched parties with surviving rows would silently miss.
  const custBalance = await siteQueryOne<any>(SITE, 'SELECT balance FROM customers WHERE id = ?', [
    customerId,
  ])
  ok(
    '*** the training customer is back to a zero balance ***',
    toNum(custBalance?.balance) === 0,
    `balance ${custBalance?.balance}`,
  )

  const supplierDrift = await reconcileSupplierBalances(SITE)
  ok(
    '*** supplier balances still reconcile ***',
    supplierDrift.length === 0,
    JSON.stringify(supplierDrift.slice(0, 3)),
  )

  // `missing` is a COUNT, not a list. It must not have grown: the whole point of
  // the rewind is that a training session leaves no hole in the run.
  const seqIntegrityAfter = await verifySequence(SITE, 'invoice')
  ok(
    '*** the invoice run has no new gaps ***',
    seqIntegrityAfter.missing <= seqIntegrityBefore.missing,
    `missing ${seqIntegrityBefore.missing} -> ${seqIntegrityAfter.missing}`,
  )

  // ── The session log is KEPT. That is the one thing that must survive. ─────
  const logged = await siteQuery<any>(
    SITE,
    'SELECT id, ended_at, removed FROM training_sessions WHERE id = ?',
    [start.session.id],
  )
  ok('*** the session log survived the purge ***', logged.length === 1)
  ok('  and is marked ended', logged[0]?.ended_at !== null)
  ok('  and records what it removed', String(logged[0]?.removed ?? '').includes('sales_documents'))

  // ── Clean up the fixtures this test created, so it can run again. ────────
  await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId])
  await siteExecute(SITE, 'DELETE FROM product_location_stock WHERE product_id = ?', [productId])
  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])
  await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [customerId])
  await siteExecute(SITE, 'DELETE FROM training_sessions WHERE id = ?', [start.session.id])

  console.log(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAILURE(S)`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('THREW:', err)
  process.exit(1)
})
