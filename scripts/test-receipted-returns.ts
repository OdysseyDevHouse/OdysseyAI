/**
 * Receipted returns and the exchange built on them.
 *
 * The rules that matter:
 *
 *   THE CREDIT IS AT THE PRICE THEY PAID, AT THE COST THAT WAS EARNED. The
 *   original line supplies both — today's shelf price and today's average
 *   cost are irrelevant to goods sold last week.
 *
 *   THE EXCHANGE TENDER NETS TO ZERO. The credit note refunds INTO it, the
 *   replacement sale pays OUT of it, and across the pair it sums to nothing —
 *   the drawer carries only the difference in real money.
 *
 *   NOTHING DRIFTS. Stock, debtor balances and the GL all reconcile after
 *   both documents post.
 */

import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { saveDraft, getDocument } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { createCreditNote, creditableLines } from '../src/lib/site/salesReversal'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { reconcileBalances } from '../src/lib/site/customerLedger'
import { findSalesReasonByCode } from '../src/lib/site/salesReasons'
import { round, toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Exchange Test' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const rate = toNum(vat?.rate, 15)
  const reason = await findSalesReasonByCode(SITE, 'return', 'FAULTY')
  if (!reason) { console.log('seeded return reason missing'); process.exit(1) }

  const cash = await getTenderByCode(SITE, 'CASH')
  const exchange = await getTenderByCode(SITE, 'EXCHANGE')
  ok('*** the EXCHANGE tender exists (141) ***', exchange !== null)
  ok('…refundable, so a credit note can pay into it', exchange?.allowsRefund === true)
  ok('…and NOT drawer cash — nothing physical moves for the netted part',
      exchange?.countsAsDrawerCash === false)
  if (!cash || !exchange) process.exit(1)

  // Its own terminal + sequences so the site-wide runs are never consumed.
  const term = await siteExecute(SITE,
    'INSERT INTO terminals (code, name, till_number) VALUES (?,?,?)',
    [`EX${stamp}`.slice(0, 24), 'Exchange test till', 96])
  const terminalId = term.insertId
  for (const [docType, prefix] of [['invoice', 'INV'], ['credit_note', 'CRN']] as const) {
    await siteExecute(SITE,
      `INSERT INTO document_sequences (terminal_id, doc_type, prefix, next_number, padding)
       VALUES (?, ?, ?, 1, 6) ON DUPLICATE KEY UPDATE doc_type = doc_type`,
      [terminalId, docType, prefix])
  }

  /* Credit notes number from the SITE-WIDE CRN sequence — the row is
     terminal_id = 0, doc_type = 'credit_sale' (the sequences table's name for
     a credit note). Snapshot it: the docs are deleted at cleanup, and a
     sequence left advanced past deleted numbers makes verifySequence report
     them missing in an unrelated suite. */
  const crnSeqBefore = toNum(
    (await siteQueryOne<any>(SITE,
      `SELECT next_number FROM document_sequences WHERE terminal_id = 0 AND doc_type = 'credit_sale' LIMIT 1`,
    ))?.next_number,
  )

  const p = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'normal',100,10,10,?,1)`,
    [`EXG${stamp}`, `Exchange item ${stamp}`, vat?.id ?? null])
  const productId = p.insertId
  await siteExecute(SITE,
    "INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_id, user_name) VALUES (?,(SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1),'opening',100,100,10,'opening',1,'Exchange Test')",
    [productId])
  await siteExecute(SITE,
    'INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) SELECT id, (SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1), stock_on_hand FROM products WHERE id=? ON DUPLICATE KEY UPDATE stock_on_hand=VALUES(stock_on_hand)',
    [productId])

  console.log('\n── The original sale ───────────────────────────────────────\n')

  const draft = await saveDraft(SITE, actor, {
    docType: 'invoice', customerName: 'Walk-in',
    terminalId, terminalCode: `EX${stamp}`.slice(0, 24),
    lines: [{ productId, productCode: `EXG${stamp}`, description: 'Exchange item', productType: 'normal', qty: 6, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 10 }],
  })
  if (!draft.ok) { console.log(`draft: ${draft.error}`); process.exit(1) }
  const sold = await finaliseDocument(SITE, actor, {
    documentId: draft.id, tenders: [{ tenderTypeId: cash.id, amount: 690 }],
  })
  ok('the original sale posts', sold.ok, sold.ok ? sold.documentNumber : sold.error)
  if (!sold.ok) process.exit(1)

  // Prices and costs move AFTER the sale — the credit must ignore both.
  await siteExecute(SITE, 'UPDATE products SET average_cost = 25, last_cost = 25 WHERE id = ?', [productId])

  console.log('\n── Exchange: dearer replacement, balance in cash ───────────\n')

  const lines = await creditableLines(SITE, draft.id)
  const original = lines![0]

  // Return 2 (credit 230) toward 3 dearer units (450) — 220 cash to pay.
  const credited = await createCreditNote(SITE, actor, {
    invoiceId: draft.id, customerName: 'Walk-in',
    reasonId: reason.id, reasonPrefix: 'Exchange',
    terminalId, terminalCode: `EX${stamp}`.slice(0, 24),
    lines: [{ sourceLineId: original.id, productId, productCode: original.productCode, description: original.description, productType: 'normal', qty: 2, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: original.unitCostExcl }],
    refunds: [{ tenderTypeId: exchange.id, amount: 230 }],
  })
  ok('*** the credit note posts, refunded into EXCHANGE ***',
      credited.ok, credited.ok ? credited.documentNumber : credited.error)
  if (!credited.ok) process.exit(1)
  ok('worth what they PAID (230)', credited.total === 230, String(credited.total))

  const crn = await getDocument(SITE, credited.documentId)
  ok('*** the credit carries the ORIGINAL cost, not today’s 25 ***',
      crn?.lines[0].unitCostExcl === 10, String(crn?.lines[0].unitCostExcl))

  const saleDraft = await saveDraft(SITE, actor, {
    docType: 'invoice', customerName: 'Walk-in',
    terminalId, terminalCode: `EX${stamp}`.slice(0, 24),
    lines: [{ productId, description: 'Exchange item, dearer', productType: 'normal', qty: 3, unitPriceIncl: 150, vatRatePct: rate, unitCostExcl: 25 }],
  })
  if (!saleDraft.ok) { console.log(saleDraft.error); process.exit(1) }
  const resold = await finaliseDocument(SITE, actor, {
    documentId: saleDraft.id,
    tenders: [
      { tenderTypeId: exchange.id, amount: 230, reference: credited.documentNumber },
      { tenderTypeId: cash.id, amount: 220 },
    ],
  })
  ok('*** the replacement sale posts, paid with the credit + cash ***',
      resold.ok, resold.ok ? resold.documentNumber : resold.error)
  if (!resold.ok) process.exit(1)

  const exchangeNet = await siteQueryOne<any>(SITE,
    `SELECT COALESCE(SUM(t.amount - t.change_given), 0) AS net
       FROM sales_tenders t WHERE t.tender_type_id = ? AND t.document_id IN (?, ?)`,
    [exchange.id, credited.documentId, saleDraft.id])
  ok('*** the EXCHANGE tender nets to ZERO across the pair ***',
      Math.abs(toNum(exchangeNet?.net)) < 0.005, String(exchangeNet?.net))

  const cashNet = await siteQueryOne<any>(SITE,
    `SELECT COALESCE(SUM(t.amount - t.change_given), 0) AS net
       FROM sales_tenders t WHERE t.tender_type_id = ? AND t.document_id IN (?, ?)`,
    [cash.id, credited.documentId, saleDraft.id])
  ok('the drawer carries only the R220 difference', toNum(cashNet?.net) === 220, String(cashNet?.net))

  const stock = toNum((await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [productId]))?.stock_on_hand)
  ok('stock: 100 − 6 + 2 − 3 = 93', stock === 93, String(stock))

  console.log('\n── Exchange the other way: cheaper replacement, cash back ──\n')

  // Return 2 more (230 credit) toward 1 unit at 115 — 115 back in cash.
  const credited2 = await createCreditNote(SITE, actor, {
    invoiceId: draft.id, customerName: 'Walk-in',
    reasonId: reason.id, reasonPrefix: 'Exchange',
    terminalId, terminalCode: `EX${stamp}`.slice(0, 24),
    lines: [{ sourceLineId: original.id, productId, description: original.description, productType: 'normal', qty: 2, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 10 }],
    refunds: [
      { tenderTypeId: exchange.id, amount: 115 },
      { tenderTypeId: cash.id, amount: 115 },
    ],
  })
  ok('the credit splits: 115 to EXCHANGE, 115 back as cash', credited2.ok,
      credited2.ok ? credited2.documentNumber : credited2.error)
  if (!credited2.ok) process.exit(1)

  const saleDraft2 = await saveDraft(SITE, actor, {
    docType: 'invoice', customerName: 'Walk-in',
    terminalId, terminalCode: `EX${stamp}`.slice(0, 24),
    lines: [{ productId, description: 'Exchange item', productType: 'normal', qty: 1, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 25 }],
  })
  if (!saleDraft2.ok) { console.log(saleDraft2.error); process.exit(1) }
  const resold2 = await finaliseDocument(SITE, actor, {
    documentId: saleDraft2.id,
    tenders: [{ tenderTypeId: exchange.id, amount: 115, reference: credited2.documentNumber }],
  })
  ok('a sale paid ENTIRELY with exchange credit posts', resold2.ok,
      resold2.ok ? resold2.documentNumber : resold2.error)

  console.log('\n── The over-credit guard still holds across exchanges ──────\n')

  const left = await creditableLines(SITE, draft.id)
  ok('2 of the 6 remain creditable', left?.[0].creditable === 2, String(left?.[0].creditable))
  const tooMany = await createCreditNote(SITE, actor, {
    invoiceId: draft.id, customerName: 'Walk-in', reasonId: reason.id,
    lines: [{ sourceLineId: original.id, productId, description: original.description, productType: 'normal', qty: 3, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 10 }],
    refunds: [{ tenderTypeId: cash.id, amount: 345 }],
  })
  ok('*** a third return cannot exceed what is left ***', !tooMany.ok, tooMany.ok ? '' : tooMany.error)

  console.log('\n── Nothing drifts ──────────────────────────────────────────\n')

  ok('reconcileStock zero drift', (await reconcileStock(SITE)).length === 0)
  ok('reconcileBalances zero drift', (await reconcileBalances(SITE)).length === 0)

  console.log('\n── Cleanup ────────────────────────────────────────────────\n')

  const docs = await siteQuery<any>(SITE, 'SELECT id FROM sales_documents WHERE terminal_id = ?', [terminalId])
  for (const d of docs) {
    const batches = await siteQuery<any>(SITE,
      `SELECT id FROM journal_batches WHERE source IN ('sale','credit_sale') AND source_doc_id = ?`, [d.id])
    for (const b of batches) {
      await siteExecute(SITE, 'DELETE FROM journal_lines WHERE batch_id = ?', [b.id])
      await siteExecute(SITE, 'DELETE FROM journal_batches WHERE id = ?', [b.id])
    }
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE source_doc_id = ?', [d.id])
    await siteExecute(SITE, 'UPDATE sales_documents SET reverses_id = NULL WHERE reverses_id = ?', [d.id])
  }
  for (const d of docs) await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [d.id])
  await siteExecute(SITE,
    `UPDATE gl_accounts a SET a.balance = COALESCE((
        SELECT SUM(l.amount) FROM journal_lines l
          JOIN journal_batches b ON b.id = l.batch_id
         WHERE l.account_id = a.id AND b.status = 'posted'), 0)`)
  await siteExecute(SITE, 'DELETE FROM document_sequences WHERE terminal_id = ?', [terminalId])
  await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [terminalId])
  /* Wind the site CRN sequence back to where we found it — ONLY if nothing
     else advanced it beyond our two numbers while the suite ran. */
  const crnSeqAfter = toNum(
    (await siteQueryOne<any>(SITE,
      `SELECT next_number FROM document_sequences WHERE terminal_id = 0 AND doc_type = 'credit_sale' LIMIT 1`,
    ))?.next_number,
  )
  if (crnSeqBefore > 0 && crnSeqAfter === crnSeqBefore + 2) {
    await siteExecute(SITE,
      `UPDATE document_sequences
          SET next_number = ?, last_issued_number = ?
        WHERE terminal_id = 0 AND doc_type = 'credit_sale'`,
      [crnSeqBefore, crnSeqBefore - 1])
  }
  await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId])
  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])

  const leftOver = await siteQuery(SITE, 'SELECT id FROM products WHERE code LIKE ?', [`EXG${stamp}%`])
  ok('test data cleaned up', leftOver.length === 0)

  console.log(fails === 0 ? '\nAll exchange rules hold.\n' : `\n${fails} FAILURE(S)\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
