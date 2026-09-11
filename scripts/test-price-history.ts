/**
 * Price history (144) and cost history (256) — every door a figure changes
 * through leaves a row.
 *
 * writePriceRows is the ONE definition of a price write; writeCostHistory is
 * the one definition of a cost note. What must hold:
 *
 *   A GENUINE change writes old → new with the source named. A save that
 *   restates the same figure writes NOTHING — a seeded reprice must not
 *   manufacture forty thousand identical rows, and a weekly delivery at an
 *   unchanged cost must not fill the screen with rows saying so.
 *
 *   A first fill records old NULL; a removal records new NULL.
 *
 *   A cost row names WHICH column moved, because a site reads whichever its
 *   cost_basis names.
 */

import { siteExecute, siteQuery, siteQueryOne, siteTransaction } from '../src/lib/siteDb'
import { createProduct, updateProduct, quickUpdateProduct, setDerivedCost } from '../src/lib/site/products'
import {
  applyReprice,
  writePriceRows,
  recordPriceRemoval,
  writeCostHistory,
} from '../src/lib/site/reprice'
import { listPriceHistory } from '../src/lib/site/priceHistory'
import { toNum } from '../src/lib/decimals'

/*
 * Site 53 (the demo master) by default, overridable as an argument.
 *
 * Not site 1: that store has no VAT number on file, so createProduct refuses
 * every product it is asked to put on a VAT rate — the suite then fails on its
 * first fixture with a message about store setup, which says nothing about
 * whether a price or a cost was recorded. Following test-recipe-cost-cascade,
 * which parameterises for the same reason.
 */
const SITE = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 53)

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stamp = Date.now().toString().slice(-8)

  const structure = await siteExecute(SITE,
    `INSERT INTO price_structures (position, name) VALUES (99, ?)`, [`PH Test ${stamp}`])
  const structureId = structure.insertId

  console.log('\n── The editor path ─────────────────────────────────────────\n')

  const created = await createProduct(SITE, {
    code: `PH${stamp}`,
    description: `Price history test ${stamp}`,
    productType: 'service',
    prices: { [structureId]: 100 },
  } as never, { source: 'editor', userName: 'Ruth' })
  if (!created.ok) { console.log(created.error); process.exit(1) }
  const productId = created.id

  let history = await listPriceHistory(SITE, productId)
  ok('*** a first fill records old NULL → 100, source editor ***',
      history.length === 1 && history[0].oldPriceIncl === null &&
      history[0].newPriceIncl === 100 && history[0].source === 'editor',
      JSON.stringify(history[0]))
  ok('…named to the person', history[0]?.userName === 'Ruth')
  ok('…and it is a PRICE row', history[0]?.kind === 'price' && history[0]?.costColumn === null)

  const updated = await updateProduct(SITE, productId, {
    code: `PH${stamp}`,
    description: `Price history test ${stamp}`,
    productType: 'service',
    prices: { [structureId]: 120 },
  } as never, { source: 'editor', userName: 'Ruth' })
  ok('the change saves', updated.ok, updated.ok ? '' : updated.error)

  history = await listPriceHistory(SITE, productId)
  ok('*** the change records 100 → 120 ***',
      history[0]?.oldPriceIncl === 100 && history[0]?.newPriceIncl === 120,
      JSON.stringify(history[0]))

  await updateProduct(SITE, productId, {
    code: `PH${stamp}`,
    description: `Price history test ${stamp}`,
    productType: 'service',
    prices: { [structureId]: 120 },
  } as never, { source: 'editor', userName: 'Ruth' })
  history = await listPriceHistory(SITE, productId)
  ok('*** an unchanged save writes NOTHING ***',
      history.filter((h) => h.kind === 'price').length === 2,
      String(history.filter((h) => h.kind === 'price').length))

  console.log('\n── The reprice path ────────────────────────────────────────\n')

  const applied = await applyReprice(SITE, structureId, [
    { productId, changed: true, newIncl: 150 } as never,
  ], 'Manager Mo')
  ok('the reprice applies', applied.ok && applied.written === 1)

  history = await listPriceHistory(SITE, productId)
  ok('*** the reprice records 120 → 150, source reprice, named ***',
      history[0]?.oldPriceIncl === 120 && history[0]?.newPriceIncl === 150 &&
      history[0]?.source === 'reprice' && history[0]?.userName === 'Manager Mo',
      JSON.stringify(history[0]))

  console.log('\n── Removal, and the batch write ────────────────────────────\n')

  await siteTransaction(SITE, async (tx) => {
    await writePriceRows(tx, [
      { productId, priceStructureId: structureId, priceIncl: 90 },
    ], { source: 'schedule', sourceDocId: 42, userName: 'Schedule' })
  })
  history = await listPriceHistory(SITE, productId)
  ok('a schedule-sourced write carries its schedule id',
      history[0]?.source === 'schedule' && history[0]?.sourceDocId === 42)

  await siteTransaction(SITE, async (tx) => {
    await tx.execute('DELETE FROM product_prices WHERE product_id = ? AND price_structure_id = ?',
      [productId, structureId] as never)
    await recordPriceRemoval(tx, [
      { productId, priceStructureId: structureId, oldPriceIncl: 90 },
    ], { source: 'revert', sourceDocId: 42, userName: 'Ruth' })
  })
  history = await listPriceHistory(SITE, productId)
  ok('*** a removal records new NULL, source revert ***',
      history[0]?.newPriceIncl === null && history[0]?.source === 'revert',
      JSON.stringify(history[0]))
  ok('…still a price row', history[0]?.kind === 'price')

  const live = await siteQueryOne<any>(SITE,
    'SELECT COUNT(*) AS n FROM product_prices WHERE product_id = ?', [productId])
  ok('the live price row is genuinely gone', toNum(live?.n) === 0)

  console.log('\n── COST (256): the editor ──────────────────────────────────\n')

  /* A stocked product, because cost is the figure a stocked product has. The
     service above never had one. */
  const costCreated = await createProduct(SITE, {
    code: `PHC${stamp}`,
    description: `Cost history test ${stamp}`,
    productType: 'normal',
    lastCost: 50,
  } as never, { source: 'editor', userName: 'Ruth' })
  if (!costCreated.ok) { console.log(costCreated.error); process.exit(1) }
  const costProductId = costCreated.id

  let costHistory = await listPriceHistory(SITE, costProductId)
  ok('*** CREATING a product records no cost change ***',
      costHistory.length === 0,
      'a new product has no prior cost, so 0 → 50 would be a fiction: ' + JSON.stringify(costHistory))

  const costEdit = await updateProduct(SITE, costProductId, {
    code: `PHC${stamp}`,
    description: `Cost history test ${stamp}`,
    productType: 'normal',
    lastCost: 75,
  } as never, { source: 'editor', userName: 'Ruth' })
  ok('the cost edit saves', costEdit.ok, costEdit.ok ? '' : costEdit.error)

  costHistory = await listPriceHistory(SITE, costProductId)
  ok('*** typing a new cost records 50 → 75 ***',
      costHistory[0]?.kind === 'cost' && costHistory[0]?.oldPriceIncl === 50 &&
      costHistory[0]?.newPriceIncl === 75 && costHistory[0]?.source === 'editor',
      JSON.stringify(costHistory[0]))
  ok('…naming WHICH cost column moved', costHistory[0]?.costColumn === 'last')
  ok('…and the person who moved it', costHistory[0]?.userName === 'Ruth')
  ok('…with no price structure attached', costHistory[0]?.priceStructureId === null)

  await updateProduct(SITE, costProductId, {
    code: `PHC${stamp}`,
    description: `Cost history test ${stamp}`,
    productType: 'normal',
    lastCost: 75,
  } as never, { source: 'editor', userName: 'Ruth' })
  costHistory = await listPriceHistory(SITE, costProductId)
  ok('*** an unchanged cost writes NOTHING ***', costHistory.length === 1, String(costHistory.length))

  console.log('\n── COST: the quick-edit panel ──────────────────────────────\n')

  const quick = await quickUpdateProduct(SITE, costProductId, { lastCost: 80 }, { userName: 'Panel Pat' })
  ok('the quick edit saves', quick.ok, quick.ok ? '' : quick.error)

  costHistory = await listPriceHistory(SITE, costProductId)
  ok('*** the quick panel records 75 → 80, named ***',
      costHistory[0]?.kind === 'cost' && costHistory[0]?.oldPriceIncl === 75 &&
      costHistory[0]?.newPriceIncl === 80 && costHistory[0]?.userName === 'Panel Pat',
      JSON.stringify(costHistory[0]))

  console.log('\n── COST: a derived (recipe) cost moves BOTH columns ────────\n')

  await setDerivedCost(SITE, costProductId, 95, { userName: 'Recipe Rita' })
  costHistory = await listPriceHistory(SITE, costProductId)
  const derived = costHistory.filter((h) => h.source === 'derived')
  ok('*** a derived cost records both last and average ***',
      derived.length === 2 &&
      derived.some((d) => d.costColumn === 'last') &&
      derived.some((d) => d.costColumn === 'average'),
      JSON.stringify(derived))
  ok('…each carrying the new figure',
      derived.every((d) => d.newPriceIncl === 95), JSON.stringify(derived))

  console.log('\n── COST: a delivery, and the ordering rule ─────────────────\n')

  /* The rule that makes the whole thing work: writeCostHistory reads the OLD
     figure from products, so it must be called BEFORE the update. Called after,
     it would compare the new cost against itself and write nothing. */
  await siteTransaction(SITE, async (tx) => {
    await writeCostHistory(tx, [
      { productId: costProductId, column: 'average', costExcl: 110 },
      { productId: costProductId, column: 'last', costExcl: 110 },
    ], { source: 'grv', sourceDocId: 7, userName: 'Buyer Bev' })
    await tx.execute('UPDATE products SET average_cost = ?, last_cost = ? WHERE id = ?',
      ['110.0000', '110.0000', costProductId] as never)
  })
  costHistory = await listPriceHistory(SITE, costProductId)
  const grv = costHistory.filter((h) => h.source === 'grv')
  ok('*** a delivery records the cost move, with its receipt id ***',
      grv.length === 2 && grv.every((g) => g.newPriceIncl === 110 && g.sourceDocId === 7),
      JSON.stringify(grv))
  ok('…from 95, the figure that was actually there',
      grv.every((g) => g.oldPriceIncl === 95), JSON.stringify(grv))

  // And the same delivery again at the same cost — the no-change rule.
  const beforeRepeat = (await listPriceHistory(SITE, costProductId)).length
  await siteTransaction(SITE, async (tx) => {
    await writeCostHistory(tx, [
      { productId: costProductId, column: 'average', costExcl: 110 },
      { productId: costProductId, column: 'last', costExcl: 110 },
    ], { source: 'grv', sourceDocId: 8, userName: 'Buyer Bev' })
  })
  const afterRepeat = (await listPriceHistory(SITE, costProductId)).length
  ok('*** a repeat delivery at an UNCHANGED cost writes nothing ***',
      afterRepeat === beforeRepeat, `${beforeRepeat} → ${afterRepeat}`)

  console.log('\n── The two kinds are one story ─────────────────────────────\n')

  const mixed = await listPriceHistory(SITE, costProductId)
  ok('cost and price rows read from ONE list, newest first',
      mixed.length > 0 && mixed.every((m, i) => i === 0 || mixed[i - 1].id > m.id),
      'ids: ' + mixed.map((m) => m.id).join(','))
  ok('every cost row names a column, every price row names none',
      mixed.every((m) => (m.kind === 'cost') === (m.costColumn !== null)))

  console.log('\n── Cleanup ────────────────────────────────────────────────\n')

  for (const id of [productId, costProductId]) {
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [id]).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [id])
  }
  const orphans = await siteQuery(SITE,
    'SELECT id FROM product_price_history WHERE product_id IN (?,?)', [productId, costProductId])
  ok('*** deleting the product cascades its history ***', orphans.length === 0)
  await siteExecute(SITE, 'DELETE FROM price_structures WHERE id = ?', [structureId])

  const left = await siteQuery(SITE, 'SELECT id FROM products WHERE code IN (?,?)',
    [`PH${stamp}`, `PHC${stamp}`])
  ok('test data cleaned up', left.length === 0)

  console.log(fails === 0 ? '\nAll price- and cost-history rules hold.\n' : `\n${fails} FAILURE(S)\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
