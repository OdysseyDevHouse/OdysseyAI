/**
 * A GRV re-prices the shelf (193).
 *
 * THE RULE: the buyer prices the delivery while the supplier's invoice is in
 * their hand, and posting the receipt is what makes that price real. The two
 * halves that matter are opposites, and both are silent when wrong:
 *
 *   a line the buyer PRICED must move the shelf, once the GRV posts;
 *   a line the buyer LEFT ALONE must not move it at all.
 *
 * The second is the dangerous one. The receiving grid seeds every line with the
 * product's current price so the Markup % and GP % columns have something to
 * read against, so a naive implementation sends that seed straight back and
 * re-prices the whole catalogue to itself on every delivery — undoing any price
 * change made between the order going out and the goods arriving, and leaving
 * a history row for a decision nobody made.
 *
 * The other half of "only once it is processed" is the draft: saving a delivery
 * must hold the price without applying it. A draft that moved a price would
 * have the till charging for goods the system says never arrived.
 *
 *   npm run test:grv-repricing
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { receiveGoods, saveDraftReceipt, voidReceipt } from '../src/lib/site/purchasePosting'
import { getPurchaseDocument } from '../src/lib/site/purchaseDocuments'
import { createSupplier } from '../src/lib/site/suppliers'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { reconcileSupplierBalances } from '../src/lib/site/supplierLedger'
import { toNum, round } from '../src/lib/decimals'
import { markupPercent, removeVat } from '../src/lib/pricing'
import { getCostBasis } from '../src/lib/site/lookups'

const SITE = 1
const actor = { userId: 1, userName: 'Reprice Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** The shelf price under the default structure — what the till would charge. */
const priceOf = async (productId: number, structureId: number) =>
  toNum(
    (
      await siteQueryOne<any>(
        SITE,
        'SELECT selling_price_incl FROM product_prices WHERE product_id=? AND price_structure_id=?',
        [productId, structureId],
      )
    )?.selling_price_incl,
  )

/**
 * The newest PRICE row for a product.
 *
 * kind='price' is load-bearing since 256: cost changes share this table, and a
 * GRV writes one for every line it receives. Without the filter the "no history
 * row was invented" assertions below read the delivery's own cost row and fail,
 * and the ones that assert source='grv' would pass on a cost row — proving
 * nothing about the price they are about to check.
 */
const historyFor = async (productId: number) =>
  await siteQueryOne<any>(
    SITE,
    `SELECT old_price_incl, new_price_incl, source, source_doc_id
       FROM product_price_history WHERE product_id=? AND kind='price'
      ORDER BY id DESC LIMIT 1`,
    [productId],
  )

/** The newest COST row — what 256 put on the record beside the price. */
const costHistoryFor = async (productId: number) =>
  await siteQueryOne<any>(
    SITE,
    `SELECT old_price_incl, new_price_incl, cost_column, source, source_doc_id
       FROM product_price_history WHERE product_id=? AND kind='cost'
      ORDER BY id DESC LIMIT 1`,
    [productId],
  )

const costOf = async (productId: number) =>
  (await siteQueryOne<any>(
    SITE,
    'SELECT stock_on_hand, average_cost, last_cost FROM products WHERE id=?',
    [productId],
  ))!

async function main() {
  const hasColumn = await siteQueryOne<any>(
    SITE,
    `SELECT 1 AS ok FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_document_lines'
        AND COLUMN_NAME='selling_price_incl' LIMIT 1`,
  )
  if (!hasColumn) {
    console.log('\nSKIP — 193_grv_selling_price.sql has not reached this site.')
    process.exit(0)
  }

  const structure = await siteQueryOne<any>(
    SITE,
    'SELECT id FROM price_structures WHERE is_default=1 ORDER BY position, id LIMIT 1',
  )
  if (!structure) {
    console.log('\nSKIP — this site has no default price structure.')
    process.exit(0)
  }
  const structureId = Number(structure.id)

  const stamp = Date.now().toString().slice(-8)
  const vat =
    (await siteQueryOne<any>(
      SITE,
      "SELECT rate FROM vat_rates WHERE vat_type='purchase' AND is_default=1 LIMIT 1",
    )) ??
    (await siteQueryOne<any>(
      SITE,
      "SELECT rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
    ))
  const rate = toNum(vat?.rate, 15)

  /*
   * The SELLING side, for the markup-fixed cases below.
   *
   * A markup is measured on the exclusive price, so a product needs a real
   * selling rate on it or the panel's arithmetic and this test's arithmetic
   * are reading two different numbers.
   */
  const sellingVatRow = await siteQueryOne<any>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )
  const sellingVatId = sellingVatRow ? Number(sellingVatRow.id) : null
  const sellingRate = toNum(sellingVatRow?.rate, 0)

  /*
   * Which cost column the reprice measured against — the site's own basis.
   * Asserting against the other one would fail on a correctly repriced
   * product for no reason but this test's choice of column.
   */
  const basis = await getCostBasis(SITE)
  const basisColumn = basis === 'last' ? 'last_cost' : 'average_cost'

  /** The markup a product is actually on, given a cost and an incl. price. */
  const markupOf = (costExcl: number, sellIncl: number) =>
    markupPercent(costExcl, removeVat(sellIncl, sellingRate))

  const sup = await createSupplier(SITE, actor, {
    code: `RPR${stamp}`,
    name: 'Repricing Test Distributors',
    paymentTermsDays: 30,
  })
  if (!sup.ok) {
    console.log('setup failed:', sup.error)
    process.exit(1)
  }

  /** A product on the shelf at a known price, so a move is unmistakable. */
  const mk = async (code: string, startingPrice: number) => {
    const id = (
      await siteExecute(
        SITE,
        `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
         VALUES (?,?,'normal',0,0,0,1)`,
        [code, `Reprice test ${code}`],
      )
    ).insertId
    await siteExecute(
      SITE,
      'INSERT INTO product_prices (product_id, price_structure_id, selling_price_incl) VALUES (?,?,?)',
      [id, structureId, startingPrice.toFixed(4)],
    )
    return id
  }

  console.log('\n── A priced line moves the shelf when the GRV posts ──')

  const p1 = await mk(`R1${stamp}`, 150)
  ok('starts at 150', (await priceOf(p1, structureId)) === 150)

  const posted = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    supplierInvoiceNo: `RPR-${stamp}`,
    lines: [
      {
        productId: p1,
        description: 'Repriced item',
        qtyReceived: 10,
        unitCostExcl: 100,
        vatRatePct: rate,
        // The supplier put their cost up, so the buyer puts the shelf up.
        sellingPriceIncl: 199.99,
      },
    ],
  })
  ok('the receipt posts', posted.ok, posted.ok ? posted.documentNumber : posted.error)
  if (!posted.ok) process.exit(1)

  ok(
    '*** the shelf price moved to what the GRV said ***',
    (await priceOf(p1, structureId)) === 199.99,
    String(await priceOf(p1, structureId)),
  )

  const cost = await costOf(p1)
  ok(
    '  and the cost moved too, as it always did',
    toNum(cost.average_cost) === 100,
    String(cost.average_cost),
  )

  const hist = await historyFor(p1)
  ok('*** the change is on the record as a GRV ***', hist?.source === 'grv', String(hist?.source))
  ok(
    '  naming the receipt that decided it',
    Number(hist?.source_doc_id) === posted.documentId,
    `${hist?.source_doc_id} vs ${posted.documentId}`,
  )
  ok('  with the price it moved from', toNum(hist?.old_price_incl) === 150, String(hist?.old_price_incl))

  const doc = await getPurchaseDocument(SITE, posted.documentId)
  ok(
    '  and the GRV itself records what it re-priced',
    toNum(doc?.lines[0].sellingPriceIncl) === 199.99,
    String(doc?.lines[0].sellingPriceIncl),
  )

  console.log('\n── An untouched line leaves the shelf alone ──')

  const p2 = await mk(`R2${stamp}`, 250)
  const untouched = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [
      {
        productId: p2,
        description: 'Not repriced',
        qtyReceived: 5,
        unitCostExcl: 80,
        vatRatePct: rate,
        // What the screen sends for a line the buyer never touched.
        sellingPriceIncl: null,
      },
    ],
  })
  ok('the receipt posts', untouched.ok)
  ok(
    '*** the shelf price did NOT move ***',
    (await priceOf(p2, structureId)) === 250,
    String(await priceOf(p2, structureId)),
  )
  ok('  no history row was invented', (await historyFor(p2)) === null)
  ok('  but the cost still moved', toNum((await costOf(p2)).average_cost) === 80)

  console.log('\n── A line that omits the field entirely behaves the same ──')

  const p3 = await mk(`R3${stamp}`, 320)
  const legacy = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [
      // No sellingPriceIncl at all — every caller that predates 193.
      {
        productId: p3,
        description: 'Legacy caller',
        qtyReceived: 3,
        unitCostExcl: 50,
        vatRatePct: rate,
      },
    ],
  })
  ok('the receipt posts', legacy.ok)
  ok(
    '*** an older caller cannot move a price by accident ***',
    (await priceOf(p3, structureId)) === 320,
    String(await priceOf(p3, structureId)),
  )

  console.log('\n── A DRAFT holds the price without applying it ──')

  const p4 = await mk(`R4${stamp}`, 400)
  const draft = await saveDraftReceipt(SITE, actor, {
    supplierId: sup.id,
    lines: [
      {
        productId: p4,
        description: 'Drafted',
        qtyReceived: 4,
        unitCostExcl: 90,
        vatRatePct: rate,
        sellingPriceIncl: 499,
      },
    ],
  })
  ok('the draft saves', draft.ok, draft.ok ? String(draft.id) : draft.error)
  if (draft.ok) {
    ok(
      '*** NOTHING was re-priced by saving a draft ***',
      (await priceOf(p4, structureId)) === 400,
      String(await priceOf(p4, structureId)),
    )
    ok('  and nothing was costed either', toNum((await costOf(p4)).average_cost) === 0)

    const held = await getPurchaseDocument(SITE, draft.id)
    ok(
      '*** but the decision survived being put down ***',
      toNum(held?.lines[0].sellingPriceIncl) === 499,
      String(held?.lines[0].sellingPriceIncl),
    )
  }

  console.log('\n── A zero price is a real instruction, not an absence ──')

  const p5 = await mk(`R5${stamp}`, 75)
  const freebie = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [
      {
        productId: p5,
        description: 'Giveaway',
        qtyReceived: 2,
        unitCostExcl: 10,
        vatRatePct: rate,
        sellingPriceIncl: 0,
      },
    ],
  })
  ok('the receipt posts', freebie.ok)
  ok(
    '*** 0 moved the price; it was not read as "leave it alone" ***',
    (await priceOf(p5, structureId)) === 0,
    String(await priceOf(p5, structureId)),
  )

  console.log('\n── A void leaves prices where they are ──')

  const p6 = await mk(`R6${stamp}`, 500)
  const toVoid = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [
      {
        productId: p6,
        description: 'Voided later',
        qtyReceived: 6,
        unitCostExcl: 120,
        vatRatePct: rate,
        sellingPriceIncl: 599,
      },
    ],
  })
  ok('the receipt posts', toVoid.ok)
  if (toVoid.ok) {
    ok('  the price moved', (await priceOf(p6, structureId)) === 599)
    const voided = await voidReceipt(SITE, actor, toVoid.documentId, 'Test void')
    ok('the void succeeds', voided.ok, voided.ok ? '' : (voided as { error: string }).error)
    // The same rule average_cost already follows: a reversal does not unwind a
    // price, because anything sold since has already gone out at it.
    ok(
      '*** the price stayed put, like the cost does ***',
      (await priceOf(p6, structureId)) === 599,
      String(await priceOf(p6, structureId)),
    )
  }

  /*
   * ── MARKUP FIXED: the price follows the cost ───────────────────────────
   *
   * products.price_calc is what a shop sets when a product is defined by its
   * MARGIN rather than its shelf price: "this sells at 20%". A delivery that
   * moves the cost and leaves the price alone quietly breaks that promise, and
   * nothing on the screen says so — the markup column simply reads lower, and
   * the shop finds out at month end.
   *
   * The setting was stored and editable for a long time without a single line
   * of pricing code reading it, so this is the case that was silently wrong on
   * every GRV.
   */
  console.log('\n── Markup fixed: an untouched line RE-PRICES itself ──')

  /** A product whose markup is the fixed figure, at a known starting margin. */
  const mkFixed = async (code: string, startingPrice: number, startCost: number) => {
    const id = (
      await siteExecute(
        SITE,
        `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos, price_calc, selling_vat_rate_id)
         VALUES (?,?,'normal',?,?,?,1,'markup',?)`,
        [code, `Markup fixed ${code}`, 0, startCost, startCost, sellingVatId],
      )
    ).insertId
    await siteExecute(
      SITE,
      'INSERT INTO product_prices (product_id, price_structure_id, selling_price_incl) VALUES (?,?,?)',
      [id, structureId, startingPrice.toFixed(4)],
    )
    return id
  }

  /* A real starting margin, not a clean zero: cost 100, 120 excl, i.e. 20%. */
  const startIncl = round(120 * (1 + sellingRate / 100), 4)
  const p7 = await mkFixed(`R7${stamp}`, startIncl, 100)
  ok('starts on a 20% markup', markupOf(100, await priceOf(p7, structureId)) === 20,
    String(markupOf(100, await priceOf(p7, structureId))))

  const fixedRun = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [
      {
        productId: p7,
        description: 'Markup fixed item',
        qtyReceived: 10,
        // The supplier put it up. Nothing is on hand (seeding stock without a
        // movement is drift, and reconcileStock is right to say so), so the
        // average lands squarely on what just arrived: 100 -> 140 on either
        // basis.
        unitCostExcl: 140,
        vatRatePct: rate,
        // The buyer typed NOTHING. This is exactly the line that used to drift.
        sellingPriceIncl: null,
      },
    ],
  })
  ok('the receipt posts', fixedRun.ok, fixedRun.ok ? '' : fixedRun.error)
  if (!fixedRun.ok) process.exit(1)

  const newCost = toNum((await costOf(p7))[basisColumn])
  const newPrice = await priceOf(p7, structureId)
  ok(
    '*** the shelf price MOVED, with nobody typing one ***',
    newPrice !== startIncl,
    `${startIncl} -> ${newPrice}`,
  )
  ok(
    '*** and the product is STILL on its 20% markup ***',
    Math.abs(markupOf(newCost, newPrice) - 20) < 0.01,
    `${markupOf(newCost, newPrice)}% on a cost of ${newCost}`,
  )

  const fixedHist = await historyFor(p7)
  ok('  the move is on the record as a GRV', fixedHist?.source === 'grv', String(fixedHist?.source))
  ok(
    '  naming the receipt that caused it',
    Number(fixedHist?.source_doc_id) === fixedRun.documentId,
  )

  console.log('\n── A typed price still beats the calculation ──')

  /* The buyer is the one holding the supplier's invoice. If they state a shelf
     price, that is a decision — the markup rule fills SILENCE, it does not
     overrule a person. */
  const p8 = await mkFixed(`R8${stamp}`, startIncl, 100)
  const overridden = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [
      {
        productId: p8,
        description: 'Markup fixed but priced by hand',
        qtyReceived: 10,
        unitCostExcl: 140,
        vatRatePct: rate,
        sellingPriceIncl: 175,
      },
    ],
  })
  ok('the receipt posts', overridden.ok)
  ok(
    '*** the buyer\u2019s own price won, not the computed one ***',
    (await priceOf(p8, structureId)) === 175,
    String(await priceOf(p8, structureId)),
  )

  console.log('\n── Selling price fixed is the other half ──')

  /* The same delivery against a 'selling' product must leave the shelf exactly
     where it is and let the MARGIN absorb the cost — which is what every
     product in this file did before, and must keep doing. */
  const p9 = await mkFixed(`R9${stamp}`, startIncl, 100)
  await siteExecute(SITE, "UPDATE products SET price_calc='selling' WHERE id=?", [p9])
  const heldRun = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [
      {
        productId: p9,
        description: 'Selling price fixed item',
        qtyReceived: 10,
        unitCostExcl: 140,
        vatRatePct: rate,
        sellingPriceIncl: null,
      },
    ],
  })
  ok('the receipt posts', heldRun.ok)
  ok(
    '*** the shelf price did NOT move ***',
    (await priceOf(p9, structureId)) === startIncl,
    String(await priceOf(p9, structureId)),
  )
  ok('  and no history row was invented', (await historyFor(p9)) === null)
  ok(
    '  the MARKUP absorbed the cost instead',
    markupOf(toNum((await costOf(p9))[basisColumn]), startIncl) < 20,
    String(markupOf(toNum((await costOf(p9))[basisColumn]), startIncl)),
  )

  console.log('\n── A markup-fixed product with no price stays unpriced ──')

  /* No product_prices row means no markup to hold. Inventing one would put a
     price on the shelf that nobody ever set. */
  const p10 = (
    await siteExecute(
      SITE,
      `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos, price_calc)
       VALUES (?,?,'normal',0,0,0,1,'markup')`,
      [`RA${stamp}`, 'Markup fixed, never priced'],
    )
  ).insertId
  const unpriced = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [
      {
        productId: p10,
        description: 'Never priced',
        qtyReceived: 4,
        unitCostExcl: 90,
        vatRatePct: rate,
        sellingPriceIncl: null,
      },
    ],
  })
  ok('the receipt posts', unpriced.ok)
  ok(
    '*** no price was invented for it ***',
    (await priceOf(p10, structureId)) === 0,
    String(await priceOf(p10, structureId)),
  )
  ok('  and the cost still moved', toNum((await costOf(p10)).last_cost) === 90)

  console.log('\n── Invariants ──')

  const ids = [p1, p2, p3, p4, p5, p6, p7, p8, p9, p10]
  const drift = (await reconcileStock(SITE)).filter((d) => ids.includes(d.productId))
  ok(
    '*** zero stock drift across every product this run touched ***',
    drift.length === 0,
    JSON.stringify(drift),
  )

  const balances = (await reconcileSupplierBalances(SITE)).filter((b) => b.id === sup.id)
  ok('*** zero supplier-balance drift ***', balances.length === 0, JSON.stringify(balances))

  console.log('\n── Cleanup ──')

  /*
   * Everything this run made, removed — and the supplier row is load-bearing.
   *
   * suppliers.balance is a stored running total, not a view. Deleting the
   * transactions beneath it would leave the supplier holding a figure nothing
   * adds up to, which is exactly what reconcileSupplierBalances() reports — and
   * that is a SITE-WIDE check, so a leaked supplier fails other suites for this
   * one's reasons rather than their own.
   *
   * The products go last: product_price_history cascades from them (144), so
   * deleting the product takes this run's price rows with it.
   */
  const idList = ids.join(',')
  const docs = await siteQuery<{ document_id: number }>(
    SITE,
    `SELECT DISTINCT document_id FROM purchase_document_lines WHERE product_id IN (${idList})`,
  )
  for (const d of docs) {
    const docId = Number(d.document_id)
    await siteExecute(SITE, 'DELETE FROM purchase_document_lines WHERE document_id = ?', [docId])
    await siteExecute(SITE, 'DELETE FROM purchase_document_charges WHERE document_id = ?', [
      docId,
    ]).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM purchase_document_audit WHERE document_id = ?', [
      docId,
    ]).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM purchase_documents WHERE id = ?', [docId]).catch(() => {})
  }
  await siteExecute(SITE, 'DELETE FROM supplier_transactions WHERE supplier_id = ?', [
    sup.id,
  ]).catch(() => {})
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN (${idList})`).catch(
    () => {},
  )
  await siteExecute(SITE, `DELETE FROM product_suppliers WHERE product_id IN (${idList})`).catch(
    () => {},
  )
  await siteExecute(SITE, `DELETE FROM product_prices WHERE product_id IN (${idList})`).catch(
    () => {},
  )
  await siteExecute(SITE, `DELETE FROM products WHERE id IN (${idList})`)
  await siteExecute(SITE, 'DELETE FROM suppliers WHERE id = ?', [sup.id]).catch(() => {})

  const leftProducts = await siteQuery(SITE, `SELECT id FROM products WHERE id IN (${idList})`)
  ok('every product this run made is gone', leftProducts.length === 0)
  const leftHistory = await siteQuery(
    SITE,
    `SELECT id FROM product_price_history WHERE product_id IN (${idList})`,
  )
  ok('  and its price history cascaded with it', leftHistory.length === 0)
  const leftDrift = (await reconcileSupplierBalances(SITE)).filter((b) => b.id === sup.id)
  ok(
    '*** no balance drift left behind for other suites ***',
    leftDrift.length === 0,
    JSON.stringify(leftDrift),
  )

  console.log(`\n${fails === 0 ? 'All good.' : `${fails} FAILED`}\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
