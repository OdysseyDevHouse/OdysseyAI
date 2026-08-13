/**
 * Lay-bys — goods put aside, paid off over time.
 *
 * Three rules from section 62 of the Consumer Protection Act shape this, and
 * each one is a thing that must be TRUE in the data rather than a comment:
 *
 *  1. The money stays the customer's. So a lay-by payment must never touch
 *     customers.balance, the age analysis or the credit limit.
 *  2. The goods stay put but are spoken for. Stock is reserved, never moved,
 *     so Σ qty_change still equals stock_on_hand.
 *  3. No sale until delivery. No invoice, no VAT and no stock movement until
 *     the final payment.
 *
 * Plus the cancellation arithmetic: a percentage of the FULL price, only after
 * 60 business days, never on death or hospitalisation, never if undisclosed.
 * The 60 days and the two exemptions are statutory; the percentage CEILING is
 * store policy, because 62(6) leaves the maximum to regulation and none is
 * set in the Act.
 *
 *   npm run test:laybys
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { createCustomer, getCustomer } from '../src/lib/site/customers'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { getDocument } from '../src/lib/site/salesDocuments'
import { listLedger, reconcileBalances } from '../src/lib/site/customerLedger'
import { reconcileStock, reservedQty, availableToSell } from '../src/lib/site/stockMovements'
import { setSetting } from '../src/lib/site/settings'
import {
  createLayby, getLayby, takePayment, completeLayby, cancelLayby,
  listLaybys, reconcileLaybys, expireStaleLaybys, cancellationFeePct,
} from '../src/lib/site/laybys'
import { verifySequence } from '../src/lib/site/sequences'
import {
  cancellationOutcome, clampFeePct, businessDaysBetween, outstanding,
  isSettled, percentPaid, paymentRefusal, DEFAULT_MAX_CANCELLATION_FEE_PCT,
} from '../src/lib/laybyRules'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Layby Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}
const stockOf = async (id: number) =>
  toNum((await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [id]))?.stock_on_hand)

const CODE_PATTERN = '^LBY[0-9]{8}$'
async function sweepStrays() {
  const where = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM layby_lines WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM sales_document_lines WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
}

function daysFromNow(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function main() {
  await sweepStrays()

  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const rate = toNum(vat?.rate, 15)

  const p = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'normal',20,600,600,?,1)`,
    [`LBY${stamp}`, 'Lay-by test bicycle', vat?.id ?? null])
  const bike = p.insertId
  await siteExecute(SITE,
    "INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_id, user_name) VALUES (?,(SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1),'opening',20,20,600,'opening',1,'Layby Test')",
    [bike])
  // The MAIN-location pile, which is what availableToSell reads — not
  // products.stock_on_hand. Seeded here because the opening movement above is
  // raw SQL rather than recordMovement, which would have created it.
  await siteExecute(SITE,
    `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand)
     SELECT ?, id, 20 FROM stock_locations WHERE is_main = 1
     ON DUPLICATE KEY UPDATE stock_on_hand = VALUES(stock_on_hand)`,
    [bike])

  const cash = await getTenderByCode(SITE, 'CASH')
  const cust = await createCustomer(SITE, actor, {
    code: `LBC${stamp}`, name: 'Lay-by Test Co', accountType: 'lay_by', creditLimit: 0,
  })
  if (!cash || !cust.ok) { console.log('setup failed'); process.exit(1) }

  const stockDriftBefore = (await reconcileStock(SITE)).length

  // ── The pure rules first
  // NOT a statutory figure. Section 62(6) lets the Minister prescribe a
  // maximum and none is set in the Act — 1% is this system's conservative
  // default, and a store can raise it via layby_max_fee_pct.
  ok('the default store ceiling is 1%', DEFAULT_MAX_CANCELLATION_FEE_PCT === 1)
  ok('  and it is overridable per store', clampFeePct(3, 5).pct === 3 && !clampFeePct(3, 5).clamped)
  ok('  a higher ceiling clamps at ITS value', clampFeePct(9, 5).pct === 5 && clampFeePct(9, 5).clamped)
  ok('*** a fee above 1% is clamped ***', clampFeePct(5).pct === 1 && clampFeePct(5).clamped)
  ok('  and the caller is told it was clamped', clampFeePct(2.5).clamped)
  ok('  a legal fee passes through', clampFeePct(0.5).pct === 0.5 && !clampFeePct(0.5).clamped)
  ok('  zero stays zero', clampFeePct(0).pct === 0)

  // Weekends excluded: Mon 3 Aug 2026 to Mon 10 Aug 2026 is 5 business days.
  ok('*** business days skip weekends ***', businessDaysBetween('2026-08-03', '2026-08-10') === 5,
    String(businessDaysBetween('2026-08-03', '2026-08-10')))
  ok('  a date in the past counts zero', businessDaysBetween('2026-08-10', '2026-08-03') === 0)

  ok('outstanding is total less paid', outstanding({ totalIncl: 1000, paidTotal: 300 }) === 700)
  ok('  never negative', outstanding({ totalIncl: 1000, paidTotal: 1200 }) === 0)
  ok('isSettled at exactly the total', isSettled({ totalIncl: 1000, paidTotal: 1000 }))
  ok('percentPaid caps at 100', percentPaid({ totalIncl: 1000, paidTotal: 1200 }) === 100)

  // ── THE CANCELLATION ARITHMETIC — where the law bites
  const base = { totalIncl: 10000, paidTotal: 3000, feePct: 1 }
  const longOverdue = { ...base, dueDate: '2026-01-01', asAt: '2026-08-05' }

  const full = cancellationOutcome(longOverdue)
  ok('*** the fee is 1% of the FULL price, not of what was paid ***', full.fee === 100,
    `fee ${full.fee} on a 10000 lay-by with 3000 paid`)
  ok('  and the rest goes back', full.refund === 2900, String(full.refund))

  const tooSoon = cancellationOutcome({ ...base, dueDate: daysFromNow(-5), asAt: daysFromNow(0) })
  ok('*** no fee before 60 business days ***', tooSoon.fee === 0, String(tooSoon.fee))
  ok('  the whole lot is refunded', tooSoon.refund === 3000)
  ok('  and it says why', (tooSoon.noFeeReason ?? '').includes('60 business days'), tooSoon.noFeeReason ?? '')

  ok('*** DEATH waives the fee entirely ***',
    cancellationOutcome({ ...longOverdue, waiverReason: 'death' }).fee === 0)
  ok('*** HOSPITALISATION waives it too ***',
    cancellationOutcome({ ...longOverdue, waiverReason: 'hospitalisation' }).fee === 0)
  ok('*** an UNDISCLOSED fee is not chargeable ***',
    cancellationOutcome({ ...longOverdue, waiverReason: 'not_disclosed' }).fee === 0)
  ok('  a store charging nothing refunds everything',
    cancellationOutcome({ ...longOverdue, feePct: 0 }).refund === 3000)
  ok('  no due date means no fee can ever apply',
    cancellationOutcome({ ...base, dueDate: null, asAt: '2026-08-05' }).fee === 0)
  ok('*** the fee never exceeds what was actually paid ***',
    cancellationOutcome({ totalIncl: 10000, paidTotal: 50, feePct: 1, dueDate: '2026-01-01', asAt: '2026-08-05' }).fee === 50)

  // ── Opening a lay-by: R2 300 of bicycle, R500 deposit
  const created = await createLayby(SITE, actor, {
    customerId: cust.id,
    dueDate: daysFromNow(60),
    lines: [{
      productId: bike, productCode: `LBY${stamp}`, description: 'Lay-by test bicycle',
      qty: 2, unitPriceIncl: 1150, vatRatePct: rate, unitCostExcl: 600,
    }],
    deposit: { amount: 500, tenderTypeId: cash.id, tenderName: 'Cash' },
  })
  ok('*** lay-by opened ***', created.ok, created.ok ? created.laybyNumber : created.error)
  if (!created.ok) { await sweepStrays(); process.exit(1) }

  ok('  numbered immediately, unlike a sale', created.laybyNumber.startsWith('LAY'), created.laybyNumber)
  ok('  worth 2300', created.totalIncl === 2300, String(created.totalIncl))
  ok('  1800 still to pay', created.outstanding === 1800, String(created.outstanding))

  // ── RULE 1: the money is the customer's, so the ledger must be untouched
  ok('*** the customer owes NOTHING — a deposit is not a debt ***',
    (await getCustomer(SITE, cust.id))?.balance === 0,
    String((await getCustomer(SITE, cust.id))?.balance))
  ok('*** and there is no debtor transaction at all ***',
    (await listLedger(SITE, cust.id)).length === 0)

  // ── RULE 2: the goods are spoken for but have not moved
  ok('*** stock has NOT moved ***', (await stockOf(bike)) === 20, String(await stockOf(bike)))
  ok('*** but 2 are reserved ***', (await reservedQty(SITE, bike)) === 2, String(await reservedQty(SITE, bike)))
  const avail = await availableToSell(SITE, [bike])
  ok('*** available to sell drops to 18 ***', avail.get(bike)?.available === 18,
    String(avail.get(bike)?.available))
  ok('*** Σ movements still equals stock_on_hand ***',
    (await reconcileStock(SITE)).length === stockDriftBefore)

  // ── RULE 3: no sale yet
  const layby = (await getLayby(SITE, created.laybyId))!
  ok('*** no invoice raised yet — VAT is not due ***', layby.invoiceDocId === null)
  ok('  the deposit is recorded as a deposit', layby.payments[0]?.kind === 'deposit')
  ok('  with the tender that took it', layby.payments[0]?.tenderName === 'Cash')

  // ── Instalments
  ok('*** overpaying is refused ***',
    !(await takePayment(SITE, actor, created.laybyId, {
      amount: 5000, tenderTypeId: cash.id, tenderName: 'Cash',
    })).ok)
  ok('  a zero payment is refused',
    !(await takePayment(SITE, actor, created.laybyId, {
      amount: 0, tenderTypeId: cash.id, tenderName: 'Cash',
    })).ok)

  const inst = await takePayment(SITE, actor, created.laybyId, {
    amount: 800, tenderTypeId: cash.id, tenderName: 'Cash',
  })
  ok('*** instalment taken ***', inst.ok, inst.ok ? `${inst.paidTotal} paid` : inst.error)
  ok('  1300 paid, 1000 left', inst.ok && inst.paidTotal === 1300 && inst.outstanding === 1000,
    inst.ok ? `${inst.paidTotal}/${inst.outstanding}` : '')
  ok('  not settled yet', inst.ok && !inst.settled)
  ok('*** STILL no debtor balance ***', (await getCustomer(SITE, cust.id))?.balance === 0)
  ok('  still no stock movement', (await stockOf(bike)) === 20)

  ok('*** completing before it is paid up is REFUSED ***',
    !(await completeLayby(SITE, actor, created.laybyId, cash.id)).ok)

  // ── The final payment, and the sale
  const finalPay = await takePayment(SITE, actor, created.laybyId, {
    amount: 1000, tenderTypeId: cash.id, tenderName: 'Cash',
  })
  ok('*** final payment settles it ***', finalPay.ok && finalPay.settled,
    finalPay.ok ? String(finalPay.outstanding) : finalPay.error)

  const completed = await completeLayby(SITE, actor, created.laybyId, cash.id)
  ok('*** goods handed over — invoice raised ***', completed.ok,
    completed.ok ? completed.documentNumber : completed.error)
  if (!completed.ok) { await sweepStrays(); process.exit(1) }

  // NOW everything happens at once
  ok('*** NOW the stock moves: 18 left ***', (await stockOf(bike)) === 18, String(await stockOf(bike)))
  ok('*** and the reservation is released ***', (await reservedQty(SITE, bike)) === 0,
    String(await reservedQty(SITE, bike)))
  ok('  available is 18, not 16 — it was never double-counted',
    (await availableToSell(SITE, [bike])).get(bike)?.available === 18)

  const invoice = await getDocument(SITE, completed.documentId)
  ok('*** the invoice carries the VAT ***', (invoice?.vatTotal ?? 0) > 0, String(invoice?.vatTotal))
  ok('  for the full 2300', invoice?.totalIncl === 2300, String(invoice?.totalIncl))
  ok('  and references the lay-by', invoice?.reference === created.laybyNumber)
  ok('*** the customer owes nothing — it was paid before delivery ***',
    (await getCustomer(SITE, cust.id))?.balance === 0,
    String((await getCustomer(SITE, cust.id))?.balance))

  const done = (await getLayby(SITE, created.laybyId))!
  ok('  the lay-by is completed', done.status === 'completed')
  ok('  and links to its invoice', done.invoiceDocId === completed.documentId)
  ok('  paying a completed lay-by is refused',
    !(await takePayment(SITE, actor, created.laybyId, { amount: 10, tenderTypeId: cash.id, tenderName: 'Cash' })).ok)
  ok('  completing twice is refused', !(await completeLayby(SITE, actor, created.laybyId, cash.id)).ok)

  // ── CANCELLATION: full refund when the store charges nothing
  await setSetting(SITE, 'layby_cancellation_fee_pct', '0')
  const toCancel = await createLayby(SITE, actor, {
    customerId: cust.id, dueDate: daysFromNow(30),
    lines: [{ productId: bike, productCode: `LBY${stamp}`, description: 'Lay-by test bicycle',
      qty: 1, unitPriceIncl: 1150, vatRatePct: rate, unitCostExcl: 600 }],
    deposit: { amount: 400, tenderTypeId: cash.id, tenderName: 'Cash' },
  })
  if (!toCancel.ok) { console.log('cancel setup failed'); await sweepStrays(); process.exit(1) }
  ok('a second lay-by reserves 1 more', (await reservedQty(SITE, bike)) === 1)

  const cancelled = await cancelLayby(SITE, actor, toCancel.laybyId, {
    reason: 'Customer changed their mind', tenderTypeId: cash.id, tenderName: 'Cash',
  })
  ok('*** cancelled with a FULL refund ***', cancelled.ok && cancelled.fee === 0 && cancelled.refund === 400,
    cancelled.ok ? `fee ${cancelled.fee}, refund ${cancelled.refund}` : cancelled.error)
  ok('  and the reservation is released', (await reservedQty(SITE, bike)) === 0)
  ok('*** cancelling moved NO stock ***', (await stockOf(bike)) === 18, String(await stockOf(bike)))
  ok('  the customer still owes nothing', (await getCustomer(SITE, cust.id))?.balance === 0)
  ok('  paid_total nets to zero after the refund',
    (await getLayby(SITE, toCancel.laybyId))?.paidTotal === 0,
    String((await getLayby(SITE, toCancel.laybyId))?.paidTotal))
  ok('  cancelling twice is refused',
    !(await cancelLayby(SITE, actor, toCancel.laybyId, { reason: 'again' })).ok)
  ok('  a reason is required',
    !(await cancelLayby(SITE, actor, created.laybyId, { reason: '  ' })).ok)

  // ── A fee that was never disclosed cannot be charged
  await setSetting(SITE, 'layby_cancellation_fee_pct', '1')
  await setSetting(SITE, 'layby_terms_text', '')
  const undisclosed = await createLayby(SITE, actor, {
    customerId: cust.id, dueDate: '2026-01-01',
    lines: [{ productId: bike, productCode: `LBY${stamp}`, description: 'Lay-by test bicycle',
      qty: 1, unitPriceIncl: 1150, vatRatePct: rate, unitCostExcl: 600 }],
    deposit: { amount: 600, tenderTypeId: cash.id, tenderName: 'Cash' },
  })
  if (undisclosed.ok) {
    const result = await cancelLayby(SITE, actor, undisclosed.laybyId, {
      reason: 'Never came back', tenderTypeId: cash.id, tenderName: 'Cash',
    })
    ok('*** an UNDISCLOSED fee is refused even when overdue ***',
      result.ok && result.fee === 0 && result.refund === 600,
      result.ok ? `fee ${result.fee}` : result.error)
    ok('  and the reason is recorded',
      (await getLayby(SITE, undisclosed.laybyId))?.feeWaivedReason !== null)
  }

  // ── A disclosed fee, properly overdue, IS charged
  await setSetting(SITE, 'layby_terms_text', 'A 1% cancellation fee applies after the due date.')
  const feeCase = await createLayby(SITE, actor, {
    customerId: cust.id, dueDate: '2026-01-01',
    lines: [{ productId: bike, productCode: `LBY${stamp}`, description: 'Lay-by test bicycle',
      qty: 2, unitPriceIncl: 1150, vatRatePct: rate, unitCostExcl: 600 }],
    deposit: { amount: 600, tenderTypeId: cash.id, tenderName: 'Cash' },
  })
  if (feeCase.ok) {
    const result = await cancelLayby(SITE, actor, feeCase.laybyId, {
      reason: 'Long overdue', tenderTypeId: cash.id, tenderName: 'Cash',
    })
    ok('*** a disclosed, overdue fee IS charged ***', result.ok && result.fee === 23,
      result.ok ? `fee ${result.fee} (1% of 2300)` : result.error)
    ok('  and the customer gets the rest back', result.ok && result.refund === 577,
      result.ok ? String(result.refund) : '')
    const row = (await getLayby(SITE, feeCase.laybyId))!
    ok('  the forfeit is its own row, findable for VAT',
      row.payments.some((x) => x.kind === 'forfeit' && x.amount === -23),
      JSON.stringify(row.payments.map((x) => `${x.kind}:${x.amount}`)))
    // paid_total means "money still HELD for this customer", so it nets to
    // zero: R577 went back, and the R23 stopped being the customer's money and
    // became the shop's revenue. Saying the shop still holds R23 for a lay-by
    // that no longer exists would be the wrong claim entirely — what was kept
    // is recorded on the forfeit row and on laybys.cancellation_fee.
    ok('  nothing is still held for the customer', row.paidTotal === 0, String(row.paidTotal))
    ok('  and what the shop kept is on the record', row.cancellationFee === 23,
      String(row.cancellationFee))
  }

  // ── Expiry sweeps, but does not spend the money
  const stale = await createLayby(SITE, actor, {
    customerId: cust.id, dueDate: '2026-01-01',
    lines: [{ productId: bike, productCode: `LBY${stamp}`, description: 'Lay-by test bicycle',
      qty: 1, unitPriceIncl: 1150, vatRatePct: rate, unitCostExcl: 600 }],
    deposit: { amount: 200, tenderTypeId: cash.id, tenderName: 'Cash' },
  })
  if (stale.ok) {
    const expired = await expireStaleLaybys(SITE, 30)
    ok('*** a long-overdue lay-by is swept ***', expired.some((e) => e.id === stale.laybyId))
    const row = (await getLayby(SITE, stale.laybyId))!
    ok('  marked expired, NOT cancelled', row.status === 'expired', row.status)
    ok('*** the money is still there — expiry spends nothing ***', row.paidTotal === 200,
      String(row.paidTotal))
    ok('  and it no longer reserves stock', (await reservedQty(SITE, bike)) === 0)
  }

  // ── Listing and settings
  const list = await listLaybys(SITE, { customerId: cust.id })
  ok('listLaybys returns them all', list.items.length >= 4, String(list.items.length))
  ok('  and can filter to open only',
    (await listLaybys(SITE, { customerId: cust.id, status: 'active' })).items.every((l) => l.status === 'open'))

  // The setting itself only sanity-checks; the STORE ceiling is what refuses a
  // high figure, and it is a policy the store owns rather than a statute.
  ok('  a nonsensical fee is refused',
    !(await setSetting(SITE, 'layby_cancellation_fee_pct', '150')).ok)
  ok('  a negative fee is refused',
    !(await setSetting(SITE, 'layby_cancellation_fee_pct', '-1')).ok)
  ok('  a fee within policy saves fine',
    (await setSetting(SITE, 'layby_cancellation_fee_pct', '1')).ok)
  ok('  the ceiling itself is a setting', (await setSetting(SITE, 'layby_max_fee_pct', '2')).ok)
  ok('*** raising the ceiling lets a higher fee through ***',
    (await setSetting(SITE, 'layby_cancellation_fee_pct', '2')).ok &&
      (await cancellationFeePct(SITE)).pct === 2,
    String((await cancellationFeePct(SITE)).pct))
  await setSetting(SITE, 'layby_max_fee_pct', '1')
  ok('*** lowering it clamps the fee back down ***',
    (await cancellationFeePct(SITE)).pct === 1 && (await cancellationFeePct(SITE)).clamped)
  await setSetting(SITE, 'layby_cancellation_fee_pct', '1')
  ok('  a silly default period is refused',
    !(await setSetting(SITE, 'layby_default_days', '0')).ok)
  ok('  and a sane one is accepted', (await setSetting(SITE, 'layby_default_days', '60')).ok)

  // Belt and braces: even if a bad value reached the database another way,
  // reading it back clamps.
  await siteExecute(SITE,
    "INSERT INTO settings (setting_key, setting_value) VALUES ('layby_cancellation_fee_pct','7') ON DUPLICATE KEY UPDATE setting_value='7'")
  ok('*** a bad stored value is still clamped on read ***',
    (await cancellationFeePct(SITE)).pct === 1 && (await cancellationFeePct(SITE)).clamped)

  // ── Invariants
  ok('*** reconcileLaybys zero drift ***', (await reconcileLaybys(SITE)).length === 0,
    JSON.stringify(await reconcileLaybys(SITE)))
  ok('*** reconcileStock zero drift ***', (await reconcileStock(SITE)).length === stockDriftBefore)
  ok('*** reconcileBalances zero drift ***', (await reconcileBalances(SITE)).length === 0)

  // ── Sequence registration (136): layby numbers live in laybys' own table,
  // and the register must prove none missing. Before 136 every layby ever
  // issued reported as missing, because the type fell back to sales_documents.
  const seq = await verifySequence(SITE, 'layby')
  ok('*** verifySequence(layby) reports no missing numbers ***', seq.missing === 0,
    JSON.stringify(seq))

  // ── Cleanup
  // Give the numbers back before deleting the documents, so the next run — and
  // verifySequence on a live site — sees no hole where these laybys used to be.
  const myNumbers = await siteQueryOne<any>(SITE,
    'SELECT COUNT(document_number) AS n FROM laybys WHERE customer_id = ?', [cust.id])
  const burnt = Number(myNumbers?.n ?? 0)
  if (burnt > 0) {
    await siteExecute(SITE,
      `UPDATE document_sequences
          SET next_number = next_number - ?,
              last_issued_number = CASE WHEN last_issued_number IS NULL THEN NULL
                                        ELSE GREATEST(last_issued_number - ?, 0) END
        WHERE doc_type = 'layby' AND next_number > ?`,
      [burnt, burnt, burnt]).catch(() => undefined)
  }
  await setSetting(SITE, 'layby_cancellation_fee_pct', '0')
  await setSetting(SITE, 'layby_max_fee_pct', '1')
  await setSetting(SITE, 'layby_default_days', '90')
  await setSetting(SITE, 'layby_terms_text', '')
  await siteExecute(SITE, 'DELETE FROM layby_payments WHERE layby_id IN (SELECT id FROM laybys WHERE customer_id = ?)', [cust.id])
  await siteExecute(SITE, 'DELETE FROM layby_lines WHERE layby_id IN (SELECT id FROM laybys WHERE customer_id = ?)', [cust.id])
  await siteExecute(SITE, 'DELETE FROM laybys WHERE customer_id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id IN (SELECT id FROM sales_documents WHERE customer_id = ?)', [cust.id])
  await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE customer_id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [cust.id])
  await sweepStrays()

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await setSetting(SITE, 'layby_cancellation_fee_pct', '0').catch(() => {})
  await setSetting(SITE, 'layby_terms_text', '').catch(() => {})
  await sweepStrays()
  console.log('\nCRASHED — strays swept')
  process.exit(1)
})
