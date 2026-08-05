/**
 * Voiding a sale — the same-day undo.
 *
 * A void says the sale should never have happened, so EVERYTHING it did must
 * come back: the stock, the debtor's balance, and the individual serial units.
 *
 * The bug this suite exists to prevent: void used to reverse stock but NOT the
 * debtor ledger, so voiding an account sale left the customer owing money for
 * goods that were back on the shelf. Their balance, statement and age analysis
 * were all wrong, and nothing reported it.
 *
 *   npm run test:void
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { createCustomer, getCustomer } from '../src/lib/site/customers'
import { saveDraft, getDocument } from '../src/lib/site/salesDocuments'
import { finaliseDocument, voidDocument } from '../src/lib/site/salesPosting'
import { createCreditNote, creditableLines } from '../src/lib/site/salesReversal'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { listLedger, reconcileBalances, postTransaction, allocate } from '../src/lib/site/customerLedger'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { addSerials, availableSerials, listSerials, reconcileSerials } from '../src/lib/site/serials'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Void Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}
const stockOf = async (id: number) =>
  toNum((await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [id]))?.stock_on_hand)

const CODE_PATTERN = '^(VDN|VDS)[0-9]{8}$'
async function sweepStrays() {
  const where = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  await siteExecute(SITE, `DELETE FROM product_serials WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM sales_document_lines WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
}

async function main() {
  await sweepStrays()

  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const rate = toNum(vat?.rate, 15)

  const p = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'normal',100,40,40,?,1)`,
    [`VDN${stamp}`, 'Void test widget', vat?.id ?? null])
  const widget = p.insertId
  await siteExecute(SITE,
    "INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_id, user_name) VALUES (?,(SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1),'opening',100,100,40,'opening',1,'Void Test')",
    [widget])
  await siteExecute(SITE,
    'INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) SELECT id, (SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1), stock_on_hand FROM products WHERE id=? ON DUPLICATE KEY UPDATE stock_on_hand=VALUES(stock_on_hand)',
    [widget])

  const s = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'serial',2,4000,4000,?,1)`,
    [`VDS${stamp}`, 'Void test phone', vat?.id ?? null])
  const phone = s.insertId
  await siteExecute(SITE,
    "INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_id, user_name) VALUES (?,(SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1),'opening',2,2,4000,'opening',1,'Void Test')",
    [phone])
  await siteExecute(SITE,
    'INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) SELECT id, (SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1), stock_on_hand FROM products WHERE id=? ON DUPLICATE KEY UPDATE stock_on_hand=VALUES(stock_on_hand)',
    [phone])
  await addSerials(SITE, actor, phone, [`VS-${stamp}-A`, `VS-${stamp}-B`], { costExcl: 4000 })

  const account = await getTenderByCode(SITE, 'ACCOUNT')
  const cash = await getTenderByCode(SITE, 'CASH')
  const cust = await createCustomer(SITE, actor, { code: `VDC${stamp}`, name: 'Void Test Co', creditLimit: 500000, paymentTermsDays: 30 })
  if (!account || !cash || !cust.ok) { console.log('setup failed'); process.exit(1) }

  const stockDriftBefore = (await reconcileStock(SITE)).length

  // ── THE BUG: voiding an ACCOUNT sale must reverse the debtor ledger
  const draft = await saveDraft(SITE, actor, {
    docType: 'invoice', customerId: cust.id, customerName: 'Void Test Co',
    lines: [{ productId: widget, productCode: `VDN${stamp}`, description: 'Void test widget', productType: 'normal', qty: 5, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 40 }],
  })
  if (!draft.ok) { console.log('draft failed'); process.exit(1) }
  const posted = await finaliseDocument(SITE, actor, {
    documentId: draft.id, customerId: cust.id,
    tenders: [{ tenderTypeId: account.id, amount: 575 }],
  })
  ok('account sale posted', posted.ok, posted.ok ? posted.documentNumber : posted.error)

  ok('  customer owes 575', (await getCustomer(SITE, cust.id))?.balance === 575,
    String((await getCustomer(SITE, cust.id))?.balance))
  ok('  stock dropped to 95', (await stockOf(widget)) === 95, String(await stockOf(widget)))

  const voided = await voidDocument(SITE, actor, draft.id, 'Rang up on the wrong account')
  ok('*** voided ***', voided.ok, voided.ok ? '' : voided.error)

  ok('*** stock came back to 100 ***', (await stockOf(widget)) === 100, String(await stockOf(widget)))
  ok('*** AND the balance came back to ZERO ***', (await getCustomer(SITE, cust.id))?.balance === 0,
    String((await getCustomer(SITE, cust.id))?.balance))
  ok('*** reconcileBalances zero drift ***', (await reconcileBalances(SITE)).length === 0)
  ok('  Σ movements still equals stock_on_hand', (await reconcileStock(SITE)).length === stockDriftBefore)

  const ledger = await listLedger(SITE, cust.id)
  ok('  the ledger shows the invoice AND its reversal', ledger.length === 2,
    ledger.map((l) => `${l.docType}:${l.amountSigned}`).join(' '))
  ok('  the reversal links back', ledger.some((l) => l.reversesId !== null))
  ok('  and nothing is left outstanding', ledger.every((l) => l.amountOutstanding === 0),
    ledger.map((l) => l.amountOutstanding).join(','))

  const doc = await getDocument(SITE, draft.id)
  ok('  the document is cancelled but KEEPS its number', doc?.status === 'cancelled' && doc?.documentNumber !== null,
    `${doc?.status} ${doc?.documentNumber}`)
  ok('  with a stated reason', (doc?.voidReason ?? '').includes('wrong account'), doc?.voidReason ?? '')

  // ── An allocated payment must BLOCK the void, not strand the allocation
  const second = await saveDraft(SITE, actor, {
    docType: 'invoice', customerId: cust.id, customerName: 'Void Test Co',
    lines: [{ productId: widget, productCode: `VDN${stamp}`, description: 'Void test widget', productType: 'normal', qty: 2, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 40 }],
  })
  if (!second.ok) { console.log('second draft failed'); process.exit(1) }
  const posted2 = await finaliseDocument(SITE, actor, {
    documentId: second.id, customerId: cust.id,
    tenders: [{ tenderTypeId: account.id, amount: 230 }],
  })
  ok('a second account sale posted', posted2.ok)

  const invoiceTxn = (await listLedger(SITE, cust.id)).find((l) => l.sourceDocId === second.id)!
  const payment = await postTransaction(SITE, actor, {
    customerId: cust.id, docType: 'payment', amount: 100, docNumber: `VP${stamp}`,
  })
  if (payment.ok) {
    await allocate(SITE, actor, invoiceTxn.id, payment.id, 100)
    const blocked = await voidDocument(SITE, actor, second.id, 'Try to void a part-paid sale')
    ok('*** a sale with an allocated payment REFUSES to void ***', !blocked.ok,
      !blocked.ok ? blocked.error : '')
    ok('  and the sale is still finalised, stock still out',
      (await getDocument(SITE, second.id))?.status === 'finalised' && (await stockOf(widget)) === 98,
      String(await stockOf(widget)))
    ok('  the balance is untouched by the refusal',
      (await getCustomer(SITE, cust.id))?.balance === 130,
      String((await getCustomer(SITE, cust.id))?.balance))
  }

  // ── A CASH sale voids without touching the ledger at all
  const cashDraft = await saveDraft(SITE, actor, {
    docType: 'invoice', customerName: 'Walk-in',
    lines: [{ productId: widget, productCode: `VDN${stamp}`, description: 'Void test widget', productType: 'normal', qty: 1, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 40 }],
  })
  if (cashDraft.ok) {
    await finaliseDocument(SITE, actor, { documentId: cashDraft.id, tenders: [{ tenderTypeId: cash.id, amount: 115 }] })
    const balanceBefore = (await getCustomer(SITE, cust.id))?.balance
    const cashVoid = await voidDocument(SITE, actor, cashDraft.id, 'Wrong item')
    ok('*** a cash sale voids cleanly ***', cashVoid.ok, cashVoid.ok ? '' : cashVoid.error)
    ok('  and no ledger entry was touched', (await getCustomer(SITE, cust.id))?.balance === balanceBefore)
    ok('  stock back', (await stockOf(widget)) === 98, String(await stockOf(widget)))
  }

  // ── Voiding a SERIAL sale returns the individual units
  const serialDraft = await saveDraft(SITE, actor, {
    docType: 'invoice', customerName: 'Walk-in',
    lines: [{ productId: phone, productCode: `VDS${stamp}`, description: 'Void test phone', productType: 'serial', qty: 1, unitPriceIncl: 6900, vatRatePct: rate, unitCostExcl: 4000 }],
  })
  if (serialDraft.ok) {
    const lineId = (await getDocument(SITE, serialDraft.id))!.lines[0].id
    const pick = (await availableSerials(SITE, phone))[0]
    const sold = await finaliseDocument(SITE, actor, {
      documentId: serialDraft.id, tenders: [{ tenderTypeId: cash.id, amount: 6900 }],
      serials: { [lineId]: [pick.id] },
    })
    ok('a serial phone sold', sold.ok, sold.ok ? '' : sold.error)
    ok('  one serial is marked sold', (await availableSerials(SITE, phone)).length === 1)

    const serialVoid = await voidDocument(SITE, actor, serialDraft.id, 'Customer changed their mind')
    ok('*** voiding returns the SERIAL to stock ***', serialVoid.ok, serialVoid.ok ? '' : serialVoid.error)
    ok('  both units sellable again', (await availableSerials(SITE, phone)).length === 2,
      String((await availableSerials(SITE, phone)).length))
    ok('  the serial no longer points at the voided invoice',
      (await listSerials(SITE, { productId: phone })).items.every((x) => x.soldDocId === null))
    ok('*** and reconcileSerials is clean ***', (await reconcileSerials(SITE)).length === 0,
      JSON.stringify(await reconcileSerials(SITE)))
  }

  // ── The refusals that were already right
  ok('voiding twice refused', !(await voidDocument(SITE, actor, draft.id, 'again')).ok)
  ok('a reason is required', !(await voidDocument(SITE, actor, second.id, '  ')).ok)

  // ── The duplicate-document-number guard
  //
  // This is what let a payment be posted as an invoice bearing the SAME number
  // as a real sale, pushing a balance up instead of down.
  const dupNumber = `DUP${stamp}`
  const first = await postTransaction(SITE, actor, {
    customerId: cust.id, docType: 'invoice', amount: 50, docNumber: dupNumber,
  })
  ok('a numbered transaction posts', first.ok, first.ok ? '' : first.error)
  const dup = await postTransaction(SITE, actor, {
    customerId: cust.id, docType: 'invoice', amount: 75, docNumber: dupNumber,
  })
  ok('*** the SAME number twice is REFUSED ***', !dup.ok, !dup.ok ? dup.error : '')
  ok('  and it names the clashing document', !dup.ok && dup.error.includes(dupNumber))
  ok('  a different TYPE with that number is allowed',
    (await postTransaction(SITE, actor, {
      customerId: cust.id, docType: 'payment', amount: 50, docNumber: dupNumber,
    })).ok)

  // ── Crediting a WHOLE sale in one step
  //
  // The one-click path credits everything still outstanding, and "still
  // outstanding" is the load-bearing word: after a partial credit it must
  // credit the REMAINDER, never the original quantity again.
  const whole = await saveDraft(SITE, actor, {
    docType: 'invoice', customerId: cust.id, customerName: 'Void Test Co',
    lines: [{ productId: widget, productCode: `VDN${stamp}`, description: 'Void test widget', productType: 'normal', qty: 10, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 40 }],
  })
  if (whole.ok) {
    await finaliseDocument(SITE, actor, {
      documentId: whole.id, customerId: cust.id,
      tenders: [{ tenderTypeId: account.id, amount: 1150 }],
    })
    const stockAfterSale = await stockOf(widget)

    // Credit 3 of the 10 first, the partial way.
    const wholeLine = (await getDocument(SITE, whole.id))!.lines[0]
    await createCreditNote(SITE, actor, {
      invoiceId: whole.id, customerId: cust.id, reason: 'Three faulty',
      lines: [{
        sourceLineId: wholeLine.id, productId: widget, productCode: `VDN${stamp}`,
        description: 'Void test widget', productType: 'normal', qty: 3,
        unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 40,
      }],
    })
    ok('a partial credit of 3 posts', (await stockOf(widget)) === stockAfterSale + 3)

    // Now the one-click path: it must credit 7, not 10.
    const left = (await creditableLines(SITE, whole.id))!.filter((l) => l.creditable > 0)
    ok('*** creditableLines reports the REMAINDER, not the original ***',
      left.length === 1 && left[0].creditable === 7, String(left[0]?.creditable))

    const rest = await createCreditNote(SITE, actor, {
      invoiceId: whole.id, customerId: cust.id, reason: 'Rest returned',
      lines: left.map((l) => ({
        sourceLineId: l.id, productId: l.productId, productCode: l.productCode,
        description: l.description, productType: l.productType, departmentId: l.departmentId,
        qty: l.creditable, unitPriceIncl: l.unitPriceIncl, vatRatePct: l.vatRatePct,
        unitCostExcl: l.unitCostExcl,
      })),
    })
    ok('*** crediting the whole remainder posts ***', rest.ok, rest.ok ? rest.documentNumber : rest.error)
    ok('  all 10 are back on the shelf', (await stockOf(widget)) === stockAfterSale + 10,
      String(await stockOf(widget)))
    ok('*** and nothing is left creditable ***',
      (await creditableLines(SITE, whole.id))!.every((l) => l.creditable === 0))
    ok('  a further credit is refused',
      !(await createCreditNote(SITE, actor, {
        invoiceId: whole.id, customerId: cust.id, reason: 'Again',
        lines: [{
          sourceLineId: wholeLine.id, productId: widget, productCode: `VDN${stamp}`,
          description: 'Void test widget', productType: 'normal', qty: 1,
          unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 40,
        }],
      })).ok)
  }

  // ── Final invariants
  ok('*** reconcileStock clean at the end ***', (await reconcileStock(SITE)).length === stockDriftBefore)
  ok('*** reconcileBalances clean at the end ***', (await reconcileBalances(SITE)).length === 0)
  ok('*** reconcileSerials clean at the end ***', (await reconcileSerials(SITE)).length === 0)

  // ── Cleanup
  await siteExecute(SITE, 'DELETE FROM customer_allocations WHERE debit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?) OR credit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)', [cust.id, cust.id])
  await siteExecute(SITE, 'UPDATE customer_transactions SET reverses_id = NULL WHERE customer_id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [cust.id])
  await siteExecute(SITE, "DELETE FROM sales_tenders WHERE document_id IN (SELECT id FROM sales_documents WHERE customer_id = ? OR id IN (?,?))",
    [cust.id, cashDraft.ok ? cashDraft.id : 0, serialDraft.ok ? serialDraft.id : 0])
  await siteExecute(SITE, "DELETE FROM document_audit WHERE document_id IN (SELECT id FROM sales_documents WHERE customer_id = ? OR id IN (?,?))",
    [cust.id, cashDraft.ok ? cashDraft.id : 0, serialDraft.ok ? serialDraft.id : 0])
  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE customer_id = ? OR id IN (?,?)',
    [cust.id, cashDraft.ok ? cashDraft.id : 0, serialDraft.ok ? serialDraft.id : 0])
  await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [cust.id])
  await sweepStrays()

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await sweepStrays()
  console.log('\nCRASHED — strays swept')
  process.exit(1)
})
