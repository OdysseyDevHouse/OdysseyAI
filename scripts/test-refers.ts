/**
 * Refer codes — the two methods, and the pack that gets broken open.
 *
 * The rule that matters is that they are different rules:
 *
 *   subtract  the pack is a label. All stock lives on the single. Receiving
 *             ten cases puts 240 singles on the shelf and the case itself
 *             never moves.
 *   normal    the pack is real. Receiving ten cases puts ten CASES on the
 *             shelf, and selling one single breaks a case into six-packs and a
 *             six-pack into singles on demand.
 *
 * The headline case is the one a shop would recognise: ten cases of beer in,
 * one bottle sold, and the answer must be 9 cases / 3 six-packs / 5 singles.
 *
 * Σ stock_movements.qty_change must still equal stock_on_hand for every
 * product in both methods — a break-down is a balanced pair, not a correction.
 *
 *   npm run test:refers
 */
import { siteExecute, siteQueryOne, siteTransaction } from '../src/lib/siteDb'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument, voidDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { reconcileStock, listMovements, recordMovement } from '../src/lib/site/stockMovements'
import { saveRefer, getRefer, explodingProducts } from '../src/lib/site/productComposition'
import { receiveGoods } from '../src/lib/site/purchasePosting'
import { createSupplier } from '../src/lib/site/suppliers'
import { toNum } from '../src/lib/decimals'
import { toProductType } from '../src/lib/productTypes'
import { findSalesReasonByCode } from '../src/lib/site/salesReasons'

const SITE = 1

const actor = { userId: 1, userName: 'Refer Test' }

/*
 * The seeded reason code, resolved once. The ids are AUTO_INCREMENT and differ
 * per site, and 102 seeds the codes by name.
 */
let VOID_REASON_ID = 0

async function loadReasonIds() {
  const v = await findSalesReasonByCode(SITE, 'void', 'WRONG-ITEM')
  if (!v) throw new Error('Seeded void reason WRONG-ITEM is missing — run site-migrate for 102.')
  VOID_REASON_ID = v.id
}

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const stockOf = async (id: number) =>
  toNum((await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [id]))?.stock_on_hand)
const costOf = async (id: number) =>
  toNum((await siteQueryOne<any>(SITE, 'SELECT average_cost FROM products WHERE id=?', [id]))?.average_cost)

/** Codes this suite creates, so a crashed run can be swept on the next one. */
const CODE_PATTERN = '^(RSN|RSX|RSC|RNS|RNX|RNC)[0-9]{8}$'

async function sweepStrays() {
  const where = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  await siteExecute(SITE, `DELETE FROM product_refers WHERE product_id IN ${where} OR target_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM sales_document_lines WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM purchase_document_lines WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM product_suppliers WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
}

async function makeProduct(
  code: string, description: string, type: string, stock: number, cost: number, vatId: number | null,
): Promise<number> {
  const r = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,?,?,?,?,?,1)`,
    [code, description, type, stock, cost, cost, vatId])
  if (stock !== 0) {
    await siteExecute(SITE,
      "INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_id, user_name) VALUES (?,(SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1),'opening',?,?,?,'opening',1,'Refer Test')",
      [r.insertId, stock, stock, cost])
    await siteExecute(SITE,
      'INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) SELECT id, (SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1), stock_on_hand FROM products WHERE id=? ON DUPLICATE KEY UPDATE stock_on_hand=VALUES(stock_on_hand)',
      [r.insertId])
  }
  return r.insertId
}

async function main() {
  await loadReasonIds()
  await sweepStrays()

  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const rate = toNum(vat?.rate, 15)
  const vatId = vat?.id ?? null

  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) { console.log('setup failed — no CASH tender'); process.exit(1) }

  const sup = await createSupplier(SITE, actor, {
    code: `REF${stamp}`, name: 'Refer Test Wholesalers', paymentTermsDays: 30,
  })
  if (!sup.ok) { console.log('setup failed —', sup.error); process.exit(1) }

  const driftBefore = (await reconcileStock(SITE)).length

  /*
   * The line's product_type is read from the PRODUCT, not hardcoded.
   *
   * It used to pass 'refer' for every line, including sales of the base — which
   * is a `normal` product. That fixture disagreed with the schema and hid a real
   * bug: the posting path gated the pack-breakdown on the line type, so selling
   * a base in production never opened a case, while this test sold one under a
   * type real data never carries and passed. A fixture that lies about its own
   * data proves nothing.
   */
  const sale = async (productId: number, code: string, desc: string, qty: number, price: number) => {
    const typeRow = await siteQueryOne<any>(SITE, 'SELECT product_type FROM products WHERE id = ?', [productId])
    const productType = toProductType(typeRow?.product_type)
    const draft = await saveDraft(SITE, actor, {
      docType: 'invoice', customerName: 'Walk-in',
      lines: [{ productId, productCode: code, description: desc, productType, qty, unitPriceIncl: price, vatRatePct: rate, unitCostExcl: 0 }],
    })
    if (!draft.ok) throw new Error('draft failed')
    const done = await finaliseDocument(SITE, actor, {
      documentId: draft.id, tenders: [{ tenderTypeId: cash.id, amount: price * qty }],
    })
    return { draftId: draft.id, result: done }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SUBTRACT PACK — the behaviour that already existed, which must not move.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n── Subtract pack ──')

  const sSingle = await makeProduct(`RSN${stamp}`, 'Sub single', 'normal', 0, 0, vatId)
  const sSix = await makeProduct(`RSX${stamp}`, 'Sub six-pack', 'refer', 0, 0, vatId)
  const sCase = await makeProduct(`RSC${stamp}`, 'Sub case', 'refer', 0, 0, vatId)

  ok('a refer cannot point at itself', !(await saveRefer(SITE, sSix, sSix, 6, 'subtract')).ok)
  ok('a zero factor is refused', !(await saveRefer(SITE, sSix, sSingle, 0, 'subtract')).ok)

  ok('*** six-pack linked to single, subtract ***',
    (await saveRefer(SITE, sSix, sSingle, 6, 'subtract')).ok)
  ok('*** case linked to six-pack, subtract ***',
    (await saveRefer(SITE, sCase, sSix, 4, 'subtract')).ok)
  ok('  method reads back', (await getRefer(SITE, sSix))?.method === 'subtract')
  ok('  and defaults to subtract when unspecified',
    (await saveRefer(SITE, sSix, sSingle, 6)).ok && (await getRefer(SITE, sSix))?.method === 'subtract')

  ok('a subtract pack still explodes at the till',
    (await explodingProducts(SITE, [sSix])).has(sSix))

  // GRV: 10 cases of 24 -> 240 singles, and the case holds nothing.
  const sGrv = await receiveGoods(SITE, actor, {
    supplierId: sup.id, supplierInvoiceNo: `RS-${stamp}`,
    lines: [{ productId: sCase, productCode: `RSC${stamp}`, description: 'Sub case', productType: 'refer', qtyReceived: 10, unitCostExcl: 240, vatRatePct: rate }],
  })
  ok('*** subtract GRV posted ***', sGrv.ok, sGrv.ok ? sGrv.documentNumber : sGrv.error)

  ok('*** 10 cases of 24 became 240 SINGLES ***', (await stockOf(sSingle)) === 240, String(await stockOf(sSingle)))
  ok('  the case itself holds nothing', (await stockOf(sCase)) === 0, String(await stockOf(sCase)))
  ok('  the six-pack holds nothing', (await stockOf(sSix)) === 0, String(await stockOf(sSix)))
  ok('*** cost divided by the chain: 240/24 = 10 ***', (await costOf(sSingle)) === 10, String(await costOf(sSingle)))

  // Selling a six-pack takes 6 singles.
  const sSale = await sale(sSix, `RSX${stamp}`, 'Sub six-pack', 2, 120)
  ok('*** a subtract six-pack sells ***', sSale.result.ok, sSale.result.ok ? '' : sSale.result.error)
  ok('*** 2 six-packs took 12 singles (240 -> 228) ***', (await stockOf(sSingle)) === 228, String(await stockOf(sSingle)))
  ok('  and the six-pack still never moved', (await stockOf(sSix)) === 0, String(await stockOf(sSix)))

  // Voiding it puts the components back — the bug this fixes.
  const sVoid = await voidDocument(SITE, actor, sSale.draftId, {
    reasonId: VOID_REASON_ID, note: 'Refer void test',
  })
  ok('*** voiding a subtract sale is allowed ***', sVoid.ok, sVoid.ok ? '' : sVoid.error)
  ok('*** the void RETURNED the 12 singles (228 -> 240) ***',
    (await stockOf(sSingle)) === 240, String(await stockOf(sSingle)))

  // ═══════════════════════════════════════════════════════════════════════
  // NORMAL REFERS — the beer case.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n── Normal refers ──')

  const nSingle = await makeProduct(`RNS${stamp}`, 'Beer single', 'normal', 0, 0, vatId)
  const nSix = await makeProduct(`RNX${stamp}`, 'Beer six-pack', 'refer', 0, 0, vatId)
  const nCase = await makeProduct(`RNC${stamp}`, 'Beer case', 'refer', 0, 0, vatId)

  ok('*** six-pack linked to single, normal (factor 6) ***',
    (await saveRefer(SITE, nSix, nSingle, 6, 'normal')).ok)
  ok('*** case linked to six-pack, normal (factor 4) ***',
    (await saveRefer(SITE, nCase, nSix, 4, 'normal')).ok)
  ok('  method reads back', (await getRefer(SITE, nCase))?.method === 'normal')

  ok('*** a normal refer does NOT explode at the till ***',
    !(await explodingProducts(SITE, [nCase])).has(nCase))

  // GRV: 10 cases stay 10 cases.
  const nGrv = await receiveGoods(SITE, actor, {
    supplierId: sup.id, supplierInvoiceNo: `RN-${stamp}`,
    lines: [{ productId: nCase, productCode: `RNC${stamp}`, description: 'Beer case', productType: 'refer', qtyReceived: 10, unitCostExcl: 240, vatRatePct: rate }],
  })
  ok('*** normal GRV posted ***', nGrv.ok, nGrv.ok ? nGrv.documentNumber : nGrv.error)

  ok('*** 10 cases received are 10 CASES ***', (await stockOf(nCase)) === 10, String(await stockOf(nCase)))
  ok('  the six-pack is still empty', (await stockOf(nSix)) === 0, String(await stockOf(nSix)))
  ok('  the single is still empty', (await stockOf(nSingle)) === 0, String(await stockOf(nSingle)))
  ok('  the case carries the full cost', (await costOf(nCase)) === 240, String(await costOf(nCase)))

  // ── THE HEADLINE: sell one single out of ten cases.
  const beerSale = await sale(nSingle, `RNS${stamp}`, 'Beer single', 1, 15)
  ok('*** selling one single is allowed ***', beerSale.result.ok, beerSale.result.ok ? '' : beerSale.result.error)

  const cases = await stockOf(nCase)
  const sixes = await stockOf(nSix)
  const singles = await stockOf(nSingle)
  console.log(`      -> ${cases} cases / ${sixes} six-packs / ${singles} singles`)

  ok('*** CASES  10 -> 9 ***', cases === 9, String(cases))
  ok('*** SIXES   0 -> 3 ***', sixes === 3, String(sixes))
  ok('*** SINGLES 0 -> 5 ***', singles === 5, String(singles))

  ok('*** cost cascaded: a six-pack is 60 ***', (await costOf(nSix)) === 60, String(await costOf(nSix)))
  ok('*** cost cascaded: a single is 10 ***', (await costOf(nSingle)) === 10, String(await costOf(nSingle)))

  const singleMoves = await listMovements(SITE, nSingle, 5)
  ok('  the single gained 6 by unpack_in',
    singleMoves.some((m) => m.movementType === 'unpack_in' && m.qtyChange === 6))
  const caseMoves = await listMovements(SITE, nCase, 5)
  ok('  the case lost 1 by unpack_out',
    caseMoves.some((m) => m.movementType === 'unpack_out' && m.qtyChange === -1))

  // ── Selling from the remainder opens nothing new.
  const again = await sale(nSingle, `RNS${stamp}`, 'Beer single', 3, 15)
  ok('*** three more singles sell from the open six-pack ***', again.result.ok)
  ok('  singles 5 -> 2, nothing else opened',
    (await stockOf(nSingle)) === 2 && (await stockOf(nSix)) === 3 && (await stockOf(nCase)) === 9,
    `${await stockOf(nCase)}/${await stockOf(nSix)}/${await stockOf(nSingle)}`)

  // ── Selling a six-pack directly takes it off its own pile.
  const sixSale = await sale(nSix, `RNX${stamp}`, 'Beer six-pack', 1, 80)
  ok('*** a normal six-pack sells off its OWN pile ***', sixSale.result.ok)
  ok('  six-packs 3 -> 2, singles untouched',
    (await stockOf(nSix)) === 2 && (await stockOf(nSingle)) === 2,
    `${await stockOf(nSix)}/${await stockOf(nSingle)}`)

  // ── Cascading two levels: ask for more singles than one six-pack holds.
  const bulk = await sale(nSingle, `RNS${stamp}`, 'Beer single', 14, 15)
  ok('*** 14 singles cascade through six-packs and a case ***', bulk.result.ok, bulk.result.ok ? '' : bulk.result.error)
  const afterBulk = { c: await stockOf(nCase), x: await stockOf(nSix), s: await stockOf(nSingle) }
  console.log(`      -> ${afterBulk.c} cases / ${afterBulk.x} six-packs / ${afterBulk.s} singles`)
  ok('  it opened only what it needed (2 six-packs, no case)',
    afterBulk.c === 9 && afterBulk.x === 0 && afterBulk.s === 0,
    `${afterBulk.c}/${afterBulk.x}/${afterBulk.s}`)

  /*
   * ── THE BASE IS A `normal` PRODUCT, AND IT STILL BREAKS PACKS OPEN ──────
   *
   * The regression that put this section here. The pack-breakdown used to be
   * gated on `line.productType === 'refer'`, but the base of a ladder is a
   * `normal` product BY DESIGN — createReferRange forces it, because a refer
   * with nothing under it is refused on every sale. So the single at the
   * bottom, the rung a case exists to refill, was the one product that could
   * never be refilled: a real shop sold one and watched it go to -1 with ten
   * full cases on the shelf.
   *
   * Asserted on the stored type rather than on behaviour alone, because the
   * fixture that hid this bug was one that passed 'refer' for every line.
   */
  const baseType = String((await siteQueryOne<any>(SITE,
    'SELECT product_type FROM products WHERE id=?', [nSingle]))?.product_type)
  ok('*** the base of a normal-refer ladder is a `normal` product ***',
    baseType === 'normal', baseType)

  // Put a case back so there is something to open, then sell the base again.
  // Captured for the teardown: a GRV left behind keeps its supplier alive, and
  // the orphan ledger rows fail reconcileSupplierBalances in another suite.
  const baseGrv = await receiveGoods(SITE, actor, {
    supplierId: sup.id, supplierInvoiceNo: `RN2-${stamp}`,
    lines: [{ productId: nCase, productCode: `RNC${stamp}`, description: 'Beer case', productType: 'refer', qtyReceived: 1, unitCostExcl: 240, vatRatePct: rate }],
  })
  const beforeBase = { c: await stockOf(nCase), x: await stockOf(nSix), s: await stockOf(nSingle) }
  const baseSale = await sale(nSingle, `RNS${stamp}`, 'Beer single', 1, 15)
  ok('*** selling the `normal` BASE opens a case, it does not go negative ***',
    baseSale.result.ok, baseSale.result.ok ? '' : baseSale.result.error)
  const afterBase = { c: await stockOf(nCase), x: await stockOf(nSix), s: await stockOf(nSingle) }
  console.log(`      -> ${beforeBase.c}/${beforeBase.x}/${beforeBase.s}  =>  ${afterBase.c}/${afterBase.x}/${afterBase.s}`)
  ok('  the case was opened (one fewer)', afterBase.c === beforeBase.c - 1,
    `${beforeBase.c} -> ${afterBase.c}`)
  ok('*** and the single is POSITIVE, not -1 ***', afterBase.s === 5,
    String(afterBase.s))

  /*
   * ── An empty chain lets stock go negative rather than refusing the sale.
   *
   * Emptied through recordMovement rather than an UPDATE, because writing
   * stock_on_hand directly is exactly what breaks Σ qty_change = stock_on_hand
   * — the invariant this suite asserts a few lines below.
   */
  await siteTransaction(SITE, async (tx) => {
    for (const id of [nCase, nSix, nSingle]) {
      const held = await stockOf(id)
      if (held === 0) continue
      await recordMovement(tx, actor, {
        productId: id, movementType: 'adjustment', qtyChange: -held,
        source: 'test', note: 'Empty the chain',
      })
    }
  })

  const dry = await sale(nSingle, `RNS${stamp}`, 'Beer single', 1, 15)
  ok('*** an empty chain still SELLS (never refuses the till) ***', dry.result.ok, dry.result.ok ? '' : dry.result.error)
  ok('  and the single simply goes negative', (await stockOf(nSingle)) === -1, String(await stockOf(nSingle)))

  // ═══════════════════════════════════════════════════════════════════════
  // The invariant, across everything above.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n── Invariant ──')
  const driftAfter = await reconcileStock(SITE)
  ok('*** no stock drift introduced (Σ qty_change = stock_on_hand) ***',
    driftAfter.length === driftBefore,
    `${driftBefore} before, ${driftAfter.length} after`)

  // ── Cleanup.
  await sweepStrays()
  const docIds = [sSale.draftId, beerSale.draftId, again.draftId, sixSale.draftId, bulk.draftId, baseSale.draftId, dry.draftId]
  await siteExecute(SITE, `DELETE FROM sales_tenders WHERE document_id IN (${docIds.map(() => '?').join(',')})`, docIds)
  await siteExecute(SITE, `DELETE FROM document_audit WHERE document_id IN (${docIds.map(() => '?').join(',')})`, docIds)
  await siteExecute(SITE, `UPDATE sales_documents SET reverses_id = NULL WHERE id IN (${docIds.map(() => '?').join(',')})`, docIds)
  await siteExecute(SITE, `DELETE FROM sales_documents WHERE id IN (${docIds.map(() => '?').join(',')})`, docIds)

  /*
   * The GRVs and the supplier they were bought from. Left behind, the ledger rows
   * make reconcileSupplierBalances fail in an unrelated suite.
   *
   * BY SUPPLIER, not by a list of ids. A named list only removes the documents the
   * author remembered: on 2026-08-12 a fourth GRV (GRV003258) escaped it, held this
   * supplier alive through its FK, and made the DELETE below **fail silently** —
   * leaving a balance of R5 796 behind a document worth R276. That one row then
   * failed test:purchasing, test:opening-balances and test:payment-runs, none of
   * which have anything to do with refers.
   */
  await siteExecute(
    SITE,
    `DELETE l FROM purchase_document_lines l
       JOIN purchase_documents d ON d.id = l.document_id
      WHERE d.supplier_id = ?`,
    [sup.id],
  )
  await siteExecute(SITE, 'DELETE FROM purchase_documents WHERE supplier_id = ?', [sup.id])
  await siteExecute(SITE, 'DELETE FROM supplier_transactions WHERE supplier_id = ?', [sup.id])
  await siteExecute(SITE, 'DELETE FROM product_suppliers WHERE supplier_id = ?', [sup.id])
  await siteExecute(SITE, 'DELETE FROM suppliers WHERE id = ?', [sup.id])

  /*
   * And SAY SO if the supplier survived. A silent failed delete is what turned one
   * stranded row into three unrelated suites failing for a fortnight; a suite that
   * cannot clean up after itself must fail rather than leave the mess for the next.
   */
  const supLeft = await siteQueryOne<any>(SITE, 'SELECT id FROM suppliers WHERE id = ?', [sup.id])
  ok(
    '*** the suite removed its own supplier — a survivor breaks other suites ***',
    supLeft === null || supLeft === undefined,
    supLeft ? 'still there, something references it' : '',
  )

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

// A crash must not leave stock drift behind for the next suite to trip over.
main().catch(async (error) => {
  console.error(error)
  await sweepStrays()
  console.log('\nCRASHED — strays swept')
  process.exit(1)
})
