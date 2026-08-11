/**
 * Recipe and refer products — what actually leaves the shelf.
 *
 * The rule that matters: a composed product moves its COMPONENTS and never
 * itself. Selling a burger deducts a patty, a bun and cheese; the burger has
 * no pile of stock to deduct from. So Σ stock_movements.qty_change must still
 * equal stock_on_hand for every real product, and the burger must never
 * accumulate a phantom negative.
 *
 *   npm run test:composition
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { saveDraft, getDocument } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { createCreditNote } from '../src/lib/site/salesReversal'
import { reconcileStock, listMovements } from '../src/lib/site/stockMovements'
import {
  saveRecipe, saveRefer, listRecipe, getRefer, resolveComponents,
  compositionCost, buildableQty, usedInRecipes, clearRefer,
} from '../src/lib/site/productComposition'
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
let RETURN_REASON_ID = 0

async function loadReasonIds() {
  const r = await findSalesReasonByCode(SITE, 'return', 'FAULTY')
  if (!r) throw new Error('Seeded return reason FAULTY is missing — run site-migrate for 102.')
  RETURN_REASON_ID = r.id
}

const actor = { userId: 1, userName: 'Composition Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}
const stockOf = async (id: number) =>
  toNum((await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [id]))?.stock_on_hand)

/** Codes this suite creates, so a crashed run can be swept on the next one. */
const CODE_PATTERN = '^(PAT|BUN|CHE|BRG|BEE|SIX|BOX|LPA|LPB)[0-9]{8}$'

async function sweepStrays() {
  const where = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  await siteExecute(SITE, `DELETE FROM product_recipes WHERE parent_id IN ${where} OR component_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM product_refers WHERE product_id IN ${where} OR target_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM sales_document_lines WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${where}`)
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
      "INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_id, user_name) VALUES (?,(SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1),'opening',?,?,?,'opening',1,'Composition Test')",
      [r.insertId, stock, stock, cost])
    // The opening movement is seeded with raw SQL rather than recordMovement, so
    // the MAIN-location pile has to be seeded too — availableToSell reads that,
    // not products.stock_on_hand.
    await siteExecute(SITE,
      'INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) SELECT id, (SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1), stock_on_hand FROM products WHERE id=? ON DUPLICATE KEY UPDATE stock_on_hand=VALUES(stock_on_hand)',
      [r.insertId])
  }
  return r.insertId
}

async function main() {
  await loadReasonIds()
  // A crash mid-test used to leave products whose stock had moved but whose
  // movements were already deleted, which shows up as drift in EVERY later
  // suite. Cleanup now runs in a finally, and this sweeps anything an older
  // crashed run left behind.
  await sweepStrays()

  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const rate = toNum(vat?.rate, 15)
  const vatId = vat?.id ?? null

  // Ingredients, a burger that uses them, a single beer and a six-pack.
  const patty = await makeProduct(`PAT${stamp}`, 'Beef patty', 'normal', 100, 12, vatId)
  const bun = await makeProduct(`BUN${stamp}`, 'Burger bun', 'normal', 100, 3, vatId)
  const cheese = await makeProduct(`CHE${stamp}`, 'Cheese slice', 'normal', 100, 2, vatId)
  const burger = await makeProduct(`BRG${stamp}`, 'Cheeseburger', 'recipe', 0, 0, vatId)
  const beer = await makeProduct(`BEE${stamp}`, 'Beer 340ml', 'normal', 120, 8, vatId)
  const sixpack = await makeProduct(`SIX${stamp}`, 'Beer six-pack', 'refer', 0, 0, vatId)

  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) { console.log('setup failed'); process.exit(1) }

  const driftBefore = (await reconcileStock(SITE)).length

  // ── An unbuilt recipe refuses to sell, naming the product
  const unbuilt = await saveDraft(SITE, actor, {
    docType: 'invoice', customerName: 'Walk-in',
    lines: [{ productId: burger, productCode: `BRG${stamp}`, description: 'Cheeseburger', productType: 'recipe', qty: 1, unitPriceIncl: 60, vatRatePct: rate, unitCostExcl: 0 }],
  })
  if (!unbuilt.ok) { console.log('draft failed'); process.exit(1) }
  const refused = await finaliseDocument(SITE, actor, { documentId: unbuilt.id, tenders: [{ tenderTypeId: cash.id, amount: 60 }] })
  ok('*** an unbuilt recipe refuses to sell ***', !refused.ok, !refused.ok ? refused.error : '')
  ok('  and names the product, not the whole type',
    !refused.ok && refused.error.includes('Cheeseburger'), !refused.ok ? refused.error : '')

  // ── Setting up the recipe
  ok('a recipe cannot contain itself',
    !(await saveRecipe(SITE, burger, [{ componentId: burger, qty: 1 }])).ok)
  ok('the same ingredient twice is refused',
    !(await saveRecipe(SITE, burger, [{ componentId: patty, qty: 1 }, { componentId: patty, qty: 1 }])).ok)
  ok('a zero quantity is refused',
    !(await saveRecipe(SITE, burger, [{ componentId: patty, qty: 0 }])).ok)
  ok('wastage of 100% is refused',
    !(await saveRecipe(SITE, burger, [{ componentId: patty, qty: 1, wastagePct: 100 }])).ok)
  ok('a normal product cannot have a recipe',
    !(await saveRecipe(SITE, patty, [{ componentId: bun, qty: 1 }])).ok)

  const built = await saveRecipe(SITE, burger, [
    { componentId: patty, qty: 2 },              // a double
    { componentId: bun, qty: 1 },
    { componentId: cheese, qty: 1, wastagePct: 10 },
  ])
  ok('*** recipe saved ***', built.ok, built.ok ? '' : built.error)
  ok('  three ingredients', (await listRecipe(SITE, burger)).length === 3)

  const resolved = await resolveComponents(SITE, burger, 'recipe')
  ok('*** resolves to three real products ***', resolved.ok && resolved.components.length === 3)
  if (resolved.ok) {
    const p = resolved.components.find((c) => c.productId === patty)
    const c = resolved.components.find((c) => c.productId === cheese)
    ok('  two patties per burger', p?.qtyPerUnit === 2, String(p?.qtyPerUnit))
    ok('*** wastage is ON TOP: 1 cheese at 10% = 1.1 ***', c?.qtyPerUnit === 1.1, String(c?.qtyPerUnit))
  }

  const cost = await compositionCost(SITE, burger, 'recipe')
  ok('*** cost is what went in: 2×12 + 3 + 1.1×2 = 29.2 ***', cost === 29.2, String(cost))

  const buildable = await buildableQty(SITE, burger, 'recipe')
  ok('*** buildable is limited by the binding ingredient ***', buildable === 50, String(buildable))

  // ── Selling the recipe
  const sale = await saveDraft(SITE, actor, {
    docType: 'invoice', customerName: 'Walk-in',
    lines: [{ productId: burger, productCode: `BRG${stamp}`, description: 'Cheeseburger', productType: 'recipe', qty: 3, unitPriceIncl: 60, vatRatePct: rate, unitCostExcl: 29.2 }],
  })
  if (!sale.ok) { console.log('sale draft failed'); process.exit(1) }
  const posted = await finaliseDocument(SITE, actor, { documentId: sale.id, tenders: [{ tenderTypeId: cash.id, amount: 180 }] })
  ok('*** three burgers sold ***', posted.ok, posted.ok ? posted.documentNumber : posted.error)

  ok('*** 6 patties gone (3 × 2) ***', (await stockOf(patty)) === 94, String(await stockOf(patty)))
  ok('*** 3 buns gone ***', (await stockOf(bun)) === 97, String(await stockOf(bun)))
  ok('*** 3.3 cheese gone (wastage included) ***', (await stockOf(cheese)) === 96.7, String(await stockOf(cheese)))
  ok('*** the BURGER itself never moved ***', (await stockOf(burger)) === 0, String(await stockOf(burger)))

  const burgerMoves = await listMovements(SITE, burger)
  ok('*** and has NO movements at all ***', burgerMoves.length === 0, String(burgerMoves.length))

  const pattyMoves = await listMovements(SITE, patty)
  ok('  the component movement names the parent',
    pattyMoves.some((m) => (m.note ?? '').includes(`BRG${stamp}`)),
    pattyMoves[0]?.note ?? '')

  ok('*** Σ movements STILL equals stock_on_hand ***', (await reconcileStock(SITE)).length === driftBefore,
    `${(await reconcileStock(SITE)).length} drift rows`)

  // ── Refer products
  ok('a refer cannot point at itself', !(await saveRefer(SITE, sixpack, sixpack, 6)).ok)
  ok('a zero factor is refused', !(await saveRefer(SITE, sixpack, beer, 0)).ok)
  ok('a normal product cannot be a refer', !(await saveRefer(SITE, patty, beer, 1)).ok)

  const linked = await saveRefer(SITE, sixpack, beer, 6)
  ok('*** refer linked: one six-pack is six beers ***', linked.ok, linked.ok ? '' : linked.error)
  ok('  and reads back', (await getRefer(SITE, sixpack))?.factor === 6)

  const sixSale = await saveDraft(SITE, actor, {
    docType: 'invoice', customerName: 'Walk-in',
    lines: [{ productId: sixpack, productCode: `SIX${stamp}`, description: 'Beer six-pack', productType: 'refer', qty: 2, unitPriceIncl: 120, vatRatePct: rate, unitCostExcl: 48 }],
  })
  if (!sixSale.ok) { console.log('six draft failed'); process.exit(1) }
  const sixPosted = await finaliseDocument(SITE, actor, { documentId: sixSale.id, tenders: [{ tenderTypeId: cash.id, amount: 240 }] })
  ok('*** two six-packs sold ***', sixPosted.ok, sixPosted.ok ? sixPosted.documentNumber : sixPosted.error)
  ok('*** 12 singles gone (2 × 6) ***', (await stockOf(beer)) === 108, String(await stockOf(beer)))
  ok('*** the six-pack itself never moved ***', (await stockOf(sixpack)) === 0, String(await stockOf(sixpack)))
  ok('  Σ movements still clean', (await reconcileStock(SITE)).length === driftBefore)

  // ── A credit note puts components BACK, through the real reversal path
  const invoiceLineId = posted.ok
    ? (await getDocument(SITE, sale.id))!.lines[0].id
    : 0
  const credit = await createCreditNote(SITE, actor, {
    invoiceId: sale.id,
    reasonId: RETURN_REASON_ID, note: 'Customer sent it back',
    lines: [{
      sourceLineId: invoiceLineId,
      productId: burger,
      productCode: `BRG${stamp}`,
      description: 'Cheeseburger',
      productType: 'recipe',
      qty: 1,
      unitPriceIncl: 60,
      vatRatePct: rate,
      unitCostExcl: 29.2,
    }],
    refunds: [{ tenderTypeId: cash.id, amount: 60 }],
  })
  ok('*** a returned burger credits ***', credit.ok, credit.ok ? credit.documentNumber : credit.error)
  if (credit.ok) {
    ok('*** and puts 2 patties BACK ***', (await stockOf(patty)) === 96, String(await stockOf(patty)))
    ok('  1 bun back', (await stockOf(bun)) === 98, String(await stockOf(bun)))
    ok('  1.1 cheese back', (await stockOf(cheese)) === 97.8, String(await stockOf(cheese)))
    ok('  the burger STILL has no movements', (await listMovements(SITE, burger)).length === 0)
    ok('*** and still reconciled ***', (await reconcileStock(SITE)).length === driftBefore,
      `${(await reconcileStock(SITE)).length} drift rows`)
  }

  // ── Nesting: a refer to a recipe multiplies through
  const burgerBox = await makeProduct(`BOX${stamp}`, 'Burger 4-pack', 'refer', 0, 0, vatId)
  await saveRefer(SITE, burgerBox, burger, 4)
  const nested = await resolveComponents(SITE, burgerBox, 'refer')
  ok('*** a refer to a recipe resolves through ***', nested.ok && nested.components.length === 3)
  if (nested.ok) {
    ok('  4 burgers × 2 patties = 8', nested.components.find((c) => c.productId === patty)?.qtyPerUnit === 8,
      String(nested.components.find((c) => c.productId === patty)?.qtyPerUnit))
  }

  // ── Cycles are refused rather than hanging the till
  const loopA = await makeProduct(`LPA${stamp}`, 'Loop A', 'refer', 0, 0, vatId)
  const loopB = await makeProduct(`LPB${stamp}`, 'Loop B', 'refer', 0, 0, vatId)
  await siteExecute(SITE, 'INSERT INTO product_refers (product_id, target_id, factor) VALUES (?,?,1)', [loopA, loopB])
  await siteExecute(SITE, 'INSERT INTO product_refers (product_id, target_id, factor) VALUES (?,?,1)', [loopB, loopA])
  const cycle = await resolveComponents(SITE, loopA, 'refer')
  ok('*** a cycle is refused, not hung ***', !cycle.ok, !cycle.ok ? cycle.error : '')

  // ── Deleting an ingredient in use
  const used = await usedInRecipes(SITE, patty)
  ok('an ingredient knows what uses it', used.some((u) => u.id === burger), JSON.stringify(used.map((u) => u.code)))
  let restricted = false
  try {
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [patty])
  } catch {
    restricted = true
  }
  ok('*** deleting an in-use ingredient is REFUSED by the database ***', restricted)

  // ── Cleanup: links first, then movements, then products.
  await siteExecute(SITE, 'DELETE FROM product_refers WHERE product_id IN (?,?,?,?)', [sixpack, burgerBox, loopA, loopB])
  await siteExecute(SITE, 'DELETE FROM product_recipes WHERE parent_id = ?', [burger])
  const all = [patty, bun, cheese, burger, beer, sixpack, burgerBox, loopA, loopB]
  const docIds = [unbuilt.id, sale.id, sixSale.id, credit.ok ? credit.documentId : 0]
  await siteExecute(SITE, `DELETE FROM sales_tenders WHERE document_id IN (${docIds.map(() => '?').join(',')})`, docIds)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN (${all.map(() => '?').join(',')})`, all)
  await siteExecute(SITE, `DELETE FROM sales_document_lines WHERE product_id IN (${all.map(() => '?').join(',')})`, all)
  await siteExecute(SITE, `DELETE FROM document_audit WHERE document_id IN (${docIds.map(() => '?').join(',')})`, docIds)
  await siteExecute(SITE, `UPDATE sales_documents SET reverses_id = NULL WHERE id IN (${docIds.map(() => '?').join(',')})`, docIds)
  await siteExecute(SITE, `DELETE FROM sales_documents WHERE id IN (${docIds.map(() => '?').join(',')})`, docIds)
  await siteExecute(SITE, `DELETE FROM products WHERE id IN (${all.map(() => '?').join(',')})`, all)

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
