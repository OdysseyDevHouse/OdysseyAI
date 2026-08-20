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
import { toNum } from '../src/lib/decimals'

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

const historyFor = async (productId: number) =>
  await siteQueryOne<any>(
    SITE,
    `SELECT old_price_incl, new_price_incl, source, source_doc_id
       FROM product_price_history WHERE product_id=? ORDER BY id DESC LIMIT 1`,
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

  console.log('\n── Invariants ──')

  const ids = [p1, p2, p3, p4, p5, p6]
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
