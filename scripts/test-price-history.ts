/**
 * Price history (144) — every door a price changes through leaves a row.
 *
 * writePriceRows is the ONE definition of a price write; the history is its
 * side effect. What must hold:
 *
 *   A GENUINE change writes old → new with the source named. A save that
 *   restates the same price writes NOTHING — a seeded reprice must not
 *   manufacture forty thousand identical rows.
 *
 *   A first fill records old NULL; a removal records new NULL.
 */

import { siteExecute, siteQuery, siteQueryOne, siteTransaction } from '../src/lib/siteDb'
import { createProduct, updateProduct } from '../src/lib/site/products'
import { applyReprice, writePriceRows, recordPriceRemoval } from '../src/lib/site/reprice'
import { listPriceHistory } from '../src/lib/site/priceHistory'
import { toNum } from '../src/lib/decimals'

const SITE = 1

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
  ok('*** an unchanged save writes NOTHING ***', history.length === 2, String(history.length))

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

  const live = await siteQueryOne<any>(SITE,
    'SELECT COUNT(*) AS n FROM product_prices WHERE product_id = ?', [productId])
  ok('the live price row is genuinely gone', toNum(live?.n) === 0)

  console.log('\n── Cleanup ────────────────────────────────────────────────\n')

  await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId]).catch(() => {})
  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])
  const orphans = await siteQuery(SITE, 'SELECT id FROM product_price_history WHERE product_id = ?', [productId])
  ok('*** deleting the product cascades its history ***', orphans.length === 0)
  await siteExecute(SITE, 'DELETE FROM price_structures WHERE id = ?', [structureId])

  const left = await siteQuery(SITE, 'SELECT id FROM products WHERE code = ?', [`PH${stamp}`])
  ok('test data cleaned up', left.length === 0)

  console.log(fails === 0 ? '\nAll price-history rules hold.\n' : `\n${fails} FAILURE(S)\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
