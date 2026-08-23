/**
 * Posting-engine checks against a live site database.
 *
 * Exercises the one moment that matters: stock moves, tenders record what was
 * handed over, the number is issued last, and everything reconciles afterwards.
 *
 *   npm run test:posting
 */
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'
import { saveDraft, getDocument, saveForLaterDocument, recallDocument, discardDocument } from '../src/lib/site/salesDocuments'
import { finaliseDocument, voidDocument } from '../src/lib/site/salesPosting'
import { reconcileStock, listMovements, seedOpeningStock } from '../src/lib/site/stockMovements'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { reconcileBalances } from '../src/lib/site/customerLedger'
import { createCustomer, getCustomer } from '../src/lib/site/customers'
import { verifySequence } from '../src/lib/site/sequences'
import { toNum } from '../src/lib/decimals'
import { findSalesReasonByCode } from '../src/lib/site/salesReasons'

const SITE = 1

/*
 * The seeded reason codes, resolved once.
 *
 * Every void and credit note now names a row rather than carrying free text, so
 * these tests need real ids. Read from the site rather than hardcoded: the ids
 * are AUTO_INCREMENT and differ per site, and 102 seeds the codes by name.
 */
let VOID_REASON_ID = 0

async function loadReasonIds() {
  const v = await findSalesReasonByCode(SITE, 'void', 'WRONG-ITEM')
  if (!v) throw new Error('Seeded void reason WRONG-ITEM is missing — run site-migrate for 102.')
  VOID_REASON_ID = v.id
}

const actor = { userId: 1, userName: 'Posting Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function stockOf(productId: number): Promise<number> {
  const row = await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id = ?', [productId])
  return toNum(row?.stock_on_hand)
}

async function main() {
  await loadReasonIds()
  // ── Fixtures: a stocked product and a service, both disposable.
  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const vatRate = toNum(vat?.rate, 15)

  const mk = async (code: string, type: string, onHand: number, cost: number) => {
    const res = await siteExecute(
      SITE,
      `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id)
       VALUES (?,?,?,?,?,?,?)`,
      [code, `Test ${type} ${stamp}`, type, onHand.toFixed(3), cost.toFixed(4), cost.toFixed(4), vat?.id ?? null],
    )
    return res.insertId
  }

  const normalId = await mk(`TST${stamp}N`, 'normal', 100, 8)
  const serviceId = await mk(`TST${stamp}S`, 'service', 0, 0)
  const returnableId = await mk(`TST${stamp}R`, 'returnable', 50, 2)

  await seedOpeningStock(SITE, actor)
  ok('opening stock seeded (reconcile clean to start)', (await reconcileStock(SITE)).length === 0)

  // Baseline, so sequence integrity can be measured as a delta across this run
  // rather than against whatever history the database already carries.
  const seqBefore = await verifySequence(SITE, 'invoice')

  const cash = await getTenderByCode(SITE, 'CASH')
  const account = await getTenderByCode(SITE, 'ACCOUNT')
  const card = await getTenderByCode(SITE, 'CARD')
  if (!cash || !account || !card) { console.log('missing seeded tenders'); process.exit(1) }

  // ── A cash sale: the S1 milestone.
  const before = await stockOf(normalId)
  const draft = await saveDraft(SITE, actor, {
    docType: 'invoice',
    customerName: 'Walk-in',
    lines: [
      { productId: normalId, productCode: `TST${stamp}N`, description: 'Test normal', productType: 'normal', qty: 3, unitPriceIncl: 14.99, vatRatePct: vatRate, unitCostExcl: 8 },
      { productId: serviceId, productCode: `TST${stamp}S`, description: 'Test service', productType: 'service', qty: 1, unitPriceIncl: 50, vatRatePct: vatRate },
    ],
  })
  ok('draft saved', draft.ok, draft.ok ? '' : draft.error)
  if (!draft.ok) process.exit(1)

  const d = (await getDocument(SITE, draft.id))!
  ok('draft has no number yet', d.documentNumber === null)
  ok('totals balance on the draft', Math.round((d.subtotalExcl + d.vatTotal) * 100) === Math.round(d.totalIncl * 100), `${d.subtotalExcl}+${d.vatTotal} vs ${d.totalIncl}`)

  // Under-tender must be refused.
  const short = await finaliseDocument(SITE, actor, { documentId: draft.id, tenders: [{ tenderTypeId: cash.id, amount: 10 }] })
  ok('under-tender refused', !short.ok, !short.ok ? short.error : '')

  // R100 cash on a R94.97 sale.
  const fin = await finaliseDocument(SITE, actor, { documentId: draft.id, tenders: [{ tenderTypeId: cash.id, amount: 100 }] })
  ok('*** cash sale finalised ***', fin.ok, fin.ok ? fin.documentNumber : fin.error)
  if (!fin.ok) process.exit(1)

  ok('  number issued with INV prefix', fin.documentNumber.startsWith('INV'), fin.documentNumber)
  const posted = (await getDocument(SITE, draft.id))!
  ok('  status is finalised', posted.status === 'finalised')
  ok('  change is 100 - payable', Math.abs(fin.change - (100 - (posted.totalIncl + posted.roundingAdj))) < 0.005, `change=${fin.change} total=${posted.totalIncl} adj=${posted.roundingAdj}`)
  ok('  tendered records the GROSS 100, not the net', posted.tenderedTotal === 100, String(posted.tenderedTotal))
  ok('  5c rounding applied to the tender', posted.roundingAdj !== 0 || (posted.totalIncl * 100) % 5 === 0, `adj=${posted.roundingAdj}`)

  // Stock: the normal line moved, the service did not.
  ok('  stocked line reduced stock by 3', (await stockOf(normalId)) === before - 3, `${before} -> ${await stockOf(normalId)}`)
  ok('  service line moved no stock', (await stockOf(serviceId)) === 0)
  const moves = await listMovements(SITE, normalId, 10)
  ok('  a sale movement was written', moves.some((m) => m.movementType === 'sale' && m.qtyChange === -3), JSON.stringify(moves[0]?.qtyChange))
  ok('  movement records the source document', moves[0]?.sourceDocId === draft.id)

  // Re-finalising must be refused.
  const again = await finaliseDocument(SITE, actor, { documentId: draft.id, tenders: [{ tenderTypeId: cash.id, amount: 100 }] })
  ok('  re-finalising refused', !again.ok, !again.ok ? again.error : '')

  // ── Returnable: a sale puts stock IN.
  const rBefore = await stockOf(returnableId)
  const rDraft = await saveDraft(SITE, actor, {
    docType: 'invoice',
    customerName: 'Walk-in',
    lines: [{ productId: returnableId, productCode: `TST${stamp}R`, description: 'Crate deposit', productType: 'returnable', qty: 5, unitPriceIncl: 20, vatRatePct: vatRate, unitCostExcl: 2 }],
  })
  if (rDraft.ok) {
    const rFin = await finaliseDocument(SITE, actor, { documentId: rDraft.id, tenders: [{ tenderTypeId: cash.id, amount: 100 }] })
    ok('returnable sale finalised', rFin.ok, rFin.ok ? '' : rFin.error)
    ok('*** returnable INCREASED stock (deposit back) ***', (await stockOf(returnableId)) === rBefore + 5, `${rBefore} -> ${await stockOf(returnableId)}`)
  }

  // ── Account sale: credit limit enforced.
  const cust = await createCustomer(SITE, actor, { code: `TSTC${stamp}`, name: 'Posting Test Co', creditLimit: 100, paymentTermsDays: 30 })
  if (cust.ok) {
    const overDraft = await saveDraft(SITE, actor, {
      docType: 'invoice', customerId: cust.id, customerName: 'Posting Test Co',
      lines: [{ productId: normalId, productCode: `TST${stamp}N`, description: 'Big order', productType: 'normal', qty: 20, unitPriceIncl: 50, vatRatePct: vatRate, unitCostExcl: 8 }],
    })
    if (overDraft.ok) {
      const over = await finaliseDocument(SITE, actor, { documentId: overDraft.id, customerId: cust.id, tenders: [{ tenderTypeId: account.id, amount: 1000 }] })
      ok('*** over-limit account sale REFUSED ***', !over.ok, !over.ok ? over.error : '')
      const stillThere = await stockOf(normalId)
      ok('  and no stock moved on the refusal', stillThere === before - 3, `${stillThere}`)
      await discardDocument(SITE, overDraft.id)
    }

    // A sale within the limit posts to the ledger.
    const okDraft = await saveDraft(SITE, actor, {
      docType: 'invoice', customerId: cust.id, customerName: 'Posting Test Co',
      lines: [{ productId: serviceId, productCode: `TST${stamp}S`, description: 'Small service', productType: 'service', qty: 1, unitPriceIncl: 57.5, vatRatePct: vatRate }],
    })
    if (okDraft.ok) {
      const res = await finaliseDocument(SITE, actor, { documentId: okDraft.id, customerId: cust.id, tenders: [{ tenderTypeId: account.id, amount: 57.5 }] })
      ok('account sale within limit posted', res.ok, res.ok ? '' : res.error)
      const after = await getCustomer(SITE, cust.id)
      ok('*** balance moved to the debtor ledger ***', after?.balance === 57.5, String(after?.balance))
    }

    // Account tender needs a customer.
    const noCust = await saveDraft(SITE, actor, {
      docType: 'invoice', customerName: 'Walk-in',
      lines: [{ productId: serviceId, productCode: `TST${stamp}S`, description: 'Service', productType: 'service', qty: 1, unitPriceIncl: 10, vatRatePct: vatRate }],
    })
    if (noCust.ok) {
      const res = await finaliseDocument(SITE, actor, { documentId: noCust.id, tenders: [{ tenderTypeId: account.id, amount: 10 }] })
      ok('account tender without a customer refused', !res.ok, !res.ok ? res.error : '')
      await discardDocument(SITE, noCust.id)
    }
  }

  // ── Save and recall.
  const savedDraft = await saveDraft(SITE, actor, {
    docType: 'invoice', customerName: 'Walk-in',
    lines: [{ productId: serviceId, productCode: `TST${stamp}S`, description: 'Saved', productType: 'service', qty: 1, unitPriceIncl: 25, vatRatePct: vatRate }],
  })
  if (savedDraft.ok) {
    ok('save a sale', (await saveForLaterDocument(SITE, savedDraft.id)).ok)
    ok('  saved sale has status saved', (await getDocument(SITE, savedDraft.id))!.status === 'saved')
    ok('  saved sale has no number', (await getDocument(SITE, savedDraft.id))!.documentNumber === null)
    ok('recall it', (await recallDocument(SITE, savedDraft.id)).ok)
    ok('discard an unposted sale', (await discardDocument(SITE, savedDraft.id)).ok)
  }

  // ── Void: same day only, and it reverses stock.
  const beforeVoid = await stockOf(normalId)
  const voided = await voidDocument(SITE, actor, draft.id, { reasonId: VOID_REASON_ID, note: 'Rang up twice' })
  ok('*** same-day void accepted ***', voided.ok, voided.ok ? '' : voided.error)
  ok('  void returned the stock', (await stockOf(normalId)) === beforeVoid + 3, `${beforeVoid} -> ${await stockOf(normalId)}`)
  const afterVoid = (await getDocument(SITE, draft.id))!
  ok('  voided document KEEPS its number', afterVoid.documentNumber === fin.documentNumber, String(afterVoid.documentNumber))
  /* The stored text is the reason NAME and the note, not the note alone: the code
     is what a report groups by, and the free-text column has to keep reading
     correctly for every reader that predates the codes. */
  ok(
    '  and records the reason',
    afterVoid.cancelReason === 'Wrong item rung up — Rang up twice',
    String(afterVoid.cancelReason),
  )
  ok('  and links the reason code', afterVoid.cancelReasonId === VOID_REASON_ID, String(afterVoid.cancelReasonId))
  ok('  double void refused', !(await voidDocument(SITE, actor, draft.id, { reasonId: VOID_REASON_ID, note: 'again' })).ok)
  ok('  finalised document cannot be discarded', !(await discardDocument(SITE, draft.id)).ok)

  /*
   * ── A MIXED SLIP: GOODS BOUGHT, ONE ITEM HANDED BACK ─────────────────────
   *
   * The counter swap. A customer buys two of something and hands one of another
   * back in the same conversation, so it is ONE invoice with one total — the
   * refund line rides negative on the sale (see `refundArmed` in the till's sale
   * state, and the doc-type rule in validateDocument).
   *
   * What is being proved here is not that the numbers add up — documentMath was
   * always signed — but that the line MOVES STOCK THE OTHER WAY. A refund that
   * nets off the total while quietly taking another unit off the shelf is the
   * failure that would not show up until a stock take.
   */
  const mixBefore = await stockOf(normalId)
  const mixReturnBefore = await stockOf(returnableId)
  const mixDraft = await saveDraft(SITE, actor, {
    docType: 'invoice',
    customerName: 'Walk-in',
    lines: [
      { productId: normalId, productCode: `TST${stamp}N`, description: 'Test normal', productType: 'normal', qty: 2, unitPriceIncl: 30, vatRatePct: vatRate, unitCostExcl: 8 },
      // The one coming back. Negative on the same document.
      { productId: returnableId, productCode: `TST${stamp}R`, description: 'Test returnable', productType: 'returnable', qty: -1, unitPriceIncl: 20, vatRatePct: vatRate, unitCostExcl: 2 },
    ],
  })
  ok('*** an invoice ACCEPTS a negative line ***', mixDraft.ok, mixDraft.ok ? '' : mixDraft.error)

  if (mixDraft.ok) {
    const md = (await getDocument(SITE, mixDraft.id))!
    // 60 out, 20 back = 40 owed. The refund is netted, not a second document.
    ok('  the total nets the refund off the sale', Math.abs(md.totalIncl - 40) < 0.005, String(md.totalIncl))
    ok(
      '  and the document still balances',
      Math.round((md.subtotalExcl + md.vatTotal) * 100) === Math.round(md.totalIncl * 100),
      `${md.subtotalExcl}+${md.vatTotal} vs ${md.totalIncl}`,
    )

    const mixFin = await finaliseDocument(SITE, actor, {
      documentId: mixDraft.id,
      tenders: [{ tenderTypeId: cash.id, amount: 40 }],
    })
    ok('  it posts on a tender of the NET', mixFin.ok, mixFin.ok ? mixFin.documentNumber : mixFin.error)

    if (mixFin.ok) {
      ok('  the sold line took stock out', (await stockOf(normalId)) === mixBefore - 2, `${mixBefore} -> ${await stockOf(normalId)}`)
      /* THE assertion this whole case exists for. A `returnable` product's own
         direction is already inverted — selling one puts stock IN — so a NEGATIVE
         line on it must take stock OUT. Two sign flips that have to compose, on
         the one product type where getting it backwards still looks plausible. */
      ok(
        '*** and the refunded line moved stock the OTHER way ***',
        (await stockOf(returnableId)) === mixReturnBefore - 1,
        `${mixReturnBefore} -> ${await stockOf(returnableId)}`,
      )
      const mixMoves = await listMovements(SITE, returnableId, 10)
      ok(
        '  recorded as a return movement, not a sale',
        mixMoves.some((m) => m.movementType === 'sale_return' && m.sourceDocId === mixDraft.id),
        JSON.stringify(mixMoves[0]),
      )
    }
  }

  /*
   * A slip that pays money BACK is refused, with the way through.
   *
   * Not a limitation to be routed around later: this document has no refund
   * tender, no return reason and no supervisor against it, all of which a payout
   * needs. Left unrefused, `netPayable` clamps to zero and a cash tender is
   * recorded as CHANGE — money out of the drawer on a slip that says the
   * customer paid nothing. It balances, and it is wrong.
   */
  const payoutDraft = await saveDraft(SITE, actor, {
    docType: 'invoice',
    customerName: 'Walk-in',
    lines: [
      { productId: normalId, productCode: `TST${stamp}N`, description: 'Test normal', productType: 'normal', qty: 1, unitPriceIncl: 10, vatRatePct: vatRate, unitCostExcl: 8 },
      { productId: returnableId, productCode: `TST${stamp}R`, description: 'Test returnable', productType: 'returnable', qty: -2, unitPriceIncl: 50, vatRatePct: vatRate, unitCostExcl: 2 },
    ],
  })
  if (payoutDraft.ok) {
    const payout = await finaliseDocument(SITE, actor, {
      documentId: payoutDraft.id,
      tenders: [{ tenderTypeId: cash.id, amount: 0 }],
    })
    ok('*** a slip that owes the CUSTOMER money is refused ***', !payout.ok, !payout.ok ? payout.error : 'it posted')
    await discardDocument(SITE, payoutDraft.id)
  }

  /* A quote may still not carry one — it is a promise about a future sale, and
     cannot promise to take back what has not gone out. */
  const badQuote = await saveDraft(SITE, actor, {
    docType: 'quote',
    customerName: 'Walk-in',
    lines: [
      { productId: normalId, productCode: `TST${stamp}N`, description: 'Test normal', productType: 'normal', qty: -1, unitPriceIncl: 10, vatRatePct: vatRate, unitCostExcl: 8 },
    ],
  })
  ok('  a QUOTE still refuses a negative line', !badQuote.ok, badQuote.ok ? 'it saved' : badQuote.error)

  // ── The invariants.
  ok('*** reconcileStock returns ZERO drift ***', (await reconcileStock(SITE)).length === 0, JSON.stringify(await reconcileStock(SITE)))
  ok('*** reconcileBalances returns ZERO drift ***', (await reconcileBalances(SITE)).length === 0)

  // Sequence integrity is measured as a DELTA across this run, not as an
  // absolute. The test deletes its own documents afterwards, which leaves their
  // numbers issued with nothing to show for them — verifySequence rightly calls
  // that missing. Comparing before and after asks the real question: did THIS
  // run leave a hole? A repeatable test cannot assert on a shared database's
  // absolute history.
  const seq = await verifySequence(SITE, 'invoice')
  const issuedHere = seq.issued - seqBefore.issued
  const documentsHere = seq.live + seq.voided - (seqBefore.live + seqBefore.voided)
  ok(
    '*** every number this run issued has a document ***',
    issuedHere === documentsHere,
    `issued ${issuedHere}, documents ${documentsHere}`,
  )

  // ── Cleanup.
  //
  // Order matters, and the schema enforces it: sales_documents.customer_id is
  // ON DELETE RESTRICT, so the documents go before the customer they belong to.
  // (Discovering that here is the constraint doing its job — a customer with
  // sales history is not deletable, which is exactly the promise it makes.)
  const docs = await siteQuery<any>(
    SITE,
    'SELECT id FROM sales_documents WHERE customer_name LIKE ? OR customer_name = ? OR customer_id = ?',
    [`%${stamp}%`, 'Walk-in', cust.ok ? cust.id : 0],
  )
  for (const row of docs) {
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE source_doc_id = ?', [row.id])
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [row.id])
  }
  for (const id of [normalId, serviceId, returnableId]) {
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [id])
  }
  if (cust.ok) {
    await siteExecute(SITE, 'DELETE FROM customer_allocations WHERE debit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)', [cust.id])
    await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [cust.id])
    await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [cust.id])
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}
main()
