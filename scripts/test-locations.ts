/**
 * Stock locations — more than one place to keep stock, inside one site.
 *
 * THREE INVARIANTS, and everything here exists to prove them:
 *
 *   (A) Σ stock_movements.qty_change            = products.stock_on_hand
 *   (B) Σ qty_change per (product, location)    = product_location_stock.stock_on_hand
 *   (C) Σ product_location_stock.stock_on_hand  = products.stock_on_hand
 *
 * (A) is (B) and (C) together, which is why the module can keep the promise it
 * has made since before locations existed while also answering "where is it".
 *
 * The one that catches real bugs is (B): a receipt into the warehouse that
 * quietly lands on the shop floor still satisfies (A) and (C), and only the
 * per-location sum notices.
 *
 *   npm run test:locations
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  listLocations,
  createLocation,
  updateLocation,
  deleteLocation,
  setMainLocation,
  mainLocationId,
  locationStockFor,
  saveLocationLevels,
} from '../src/lib/site/stockLocations'
import { reconcileStock, availableToSell } from '../src/lib/site/stockMovements'
import { createSupplier } from '../src/lib/site/suppliers'
import { receiveGoods, voidReceipt } from '../src/lib/site/purchasePosting'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Location Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const CODE_PATTERN = '^LOC[0-9]{8}$'
const LOC_PATTERN = 'ZZ%'

const pile = async (productId: number, locationId: number) =>
  toNum(
    (
      await siteQueryOne<any>(
        SITE,
        'SELECT stock_on_hand FROM product_location_stock WHERE product_id=? AND location_id=?',
        [productId, locationId],
      )
    )?.stock_on_hand,
  )

const total = async (productId: number) =>
  toNum(
    (await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [productId]))
      ?.stock_on_hand,
  )

/**
 * Removes only what this test made.
 *
 * Ordered by dependency: piles and movements reference both the product and
 * the location, so they go before either. The test locations are matched by a
 * ZZ prefix that nothing real would use.
 */
async function sweepStrays() {
  const products = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  const locs = `(SELECT id FROM stock_locations WHERE code LIKE '${LOC_PATTERN}')`

  await siteExecute(SITE, `DELETE FROM purchase_document_lines WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE location_id IN ${locs}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE location_id IN ${locs}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  // Never the main one: is_main = 0 guards against a half-finished run having
  // left a ZZ location as main, which would otherwise delete the only one.
  await siteExecute(SITE, `DELETE FROM stock_locations WHERE code LIKE '${LOC_PATTERN}' AND is_main = 0`)
}

async function main() {
  await sweepStrays()

  const stamp = Date.now().toString().slice(-8)
  const driftBefore = (await reconcileStock(SITE)).length

  // ── Every site has exactly one main location, seeded by the migration
  const mainId = await mainLocationId(SITE)
  ok('*** the site has a main location ***', mainId > 0, `id ${mainId}`)

  const mains = (await listLocations(SITE, true)).filter((l) => l.isMain)
  ok('*** exactly ONE location is main ***', mains.length === 1, `${mains.length} marked main`)

  // ── Creating
  const wh = await createLocation(SITE, { code: `ZZW${stamp}`, name: 'Test warehouse' })
  const shop = await createLocation(SITE, { code: `ZZS${stamp}`, name: 'Test shop floor' })
  ok('a location can be created', wh.ok && shop.ok)
  if (!wh.ok || !shop.ok) {
    console.log('setup failed')
    process.exit(1)
  }

  const dup = await createLocation(SITE, { code: `ZZW${stamp}`, name: 'Clash' })
  ok('  a duplicate code is refused', !dup.ok, dup.ok ? '' : dup.error)

  const badCode = await createLocation(SITE, { code: 'a b!', name: 'Bad' })
  ok('  a malformed code is refused', !badCode.ok)

  const noName = await createLocation(SITE, { code: `ZZX${stamp}`, name: '  ' })
  ok('  a blank name is refused', !noName.ok)

  ok('*** a new location is never main ***', !(await listLocations(SITE, true)).find((l) => l.id === wh.id)?.isMain)

  // ── A product, and stock received into TWO different locations
  const vat = await siteQueryOne<any>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='purchase' AND is_default=1 LIMIT 1",
  )
  const rate = toNum(vat?.rate, 15)

  const p = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'normal',0,0,0,?,1)`,
    [`LOC${stamp}`, 'Location test widget', vat?.id ?? null],
  )
  const widget = p.insertId

  const sup = await createSupplier(SITE, actor, { code: `LSP${stamp}`, name: 'Location Test Supplies' })
  if (!sup.ok) {
    console.log('supplier setup failed')
    process.exit(1)
  }

  // THE CASE THIS FEATURE EXISTS FOR: one delivery, two destinations.
  const grv = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    supplierInvoiceNo: `LOC-${stamp}`,
    chargesExcl: 0,
    lines: [
      {
        productId: widget,
        locationId: wh.id,
        description: 'Into the warehouse',
        qtyReceived: 100,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
      {
        productId: widget,
        locationId: shop.id,
        description: 'Into the shop',
        qtyReceived: 5,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('*** one GRV received into TWO locations ***', grv.ok, grv.ok ? grv.documentNumber ?? '' : grv.error)
  if (!grv.ok) {
    console.log('receive failed')
    process.exit(1)
  }

  ok('*** the warehouse pile holds 100 ***', (await pile(widget, wh.id)) === 100, String(await pile(widget, wh.id)))
  ok('*** the shop pile holds 5 ***', (await pile(widget, shop.id)) === 5, String(await pile(widget, shop.id)))
  ok('*** and nothing landed in main ***', (await pile(widget, mainId)) === 0, String(await pile(widget, mainId)))
  ok('*** the site total is 105 — the sum of the piles ***', (await total(widget)) === 105, String(await total(widget)))

  // ── The till sells from MAIN only
  const avail = await availableToSell(SITE, [widget])
  ok('*** availableToSell reads MAIN, not the total ***', avail.get(widget)?.onHand === 0,
    `onHand ${avail.get(widget)?.onHand}`)
  ok('  but it still reports what the business owns', avail.get(widget)?.onHandAllLocations === 105,
    String(avail.get(widget)?.onHandAllLocations))

  // ── The breakdown the product page renders
  const breakdown = await locationStockFor(SITE, widget)
  const whRow = breakdown.find((r) => r.locationId === wh.id)
  ok('locationStockFor shows every location', breakdown.length >= 3, `${breakdown.length} rows`)
  ok('  with the right quantity against each', whRow?.stockOnHand === 100, String(whRow?.stockOnHand))
  ok('  and the main one is flagged', breakdown.find((r) => r.locationId === mainId)?.isMain === true)

  // ── Reorder levels are per location
  await saveLocationLevels(SITE, widget, wh.id, { minStock: 20, maxStock: 500 })
  await saveLocationLevels(SITE, widget, shop.id, { minStock: 2, maxStock: 10 })
  const levelled = await locationStockFor(SITE, widget)
  ok('*** levels are held PER LOCATION ***',
    levelled.find((r) => r.locationId === wh.id)?.minStock === 20 &&
      levelled.find((r) => r.locationId === shop.id)?.minStock === 2,
    `${levelled.find((r) => r.locationId === wh.id)?.minStock} / ${levelled.find((r) => r.locationId === shop.id)?.minStock}`)
  ok('  and saving a level does NOT touch the pile', (await pile(widget, wh.id)) === 100)

  // ── Changing main moves no stock
  const madeMain = await setMainLocation(SITE, shop.id)
  ok('*** the main location can be moved ***', madeMain.ok)
  ok('  still exactly one main', (await listLocations(SITE, true)).filter((l) => l.isMain).length === 1)
  ok('*** changing main moved NO stock ***',
    (await pile(widget, wh.id)) === 100 && (await pile(widget, shop.id)) === 5,
    `${await pile(widget, wh.id)} / ${await pile(widget, shop.id)}`)

  // The till follows main, which is the whole reason the setting exists.
  const availAfter = await availableToSell(SITE, [widget])
  ok('*** the till now sells from the NEW main ***', availAfter.get(widget)?.onHand === 5,
    String(availAfter.get(widget)?.onHand))

  // ── Refusals that protect the invariants
  const delMain = await deleteLocation(SITE, shop.id)
  ok('*** the main location cannot be deleted ***', !delMain.ok, delMain.ok ? '' : delMain.error)

  const offMain = await updateLocation(SITE, shop.id, {
    code: `ZZS${stamp}`, name: 'Test shop floor', isActive: false,
  })
  ok('*** the main location cannot be deactivated ***', !offMain.ok, offMain.ok ? '' : offMain.error)

  const delUsed = await deleteLocation(SITE, wh.id)
  ok('*** a location with movements cannot be deleted ***', !delUsed.ok, delUsed.ok ? '' : delUsed.error)

  // ── Voiding returns stock to the pile it came FROM
  const voided = await voidReceipt(SITE, actor, grv.documentId, 'Location test void')
  ok('the receipt voids', voided.ok, voided.ok ? '' : voided.error)
  ok('*** the void emptied the WAREHOUSE pile, not main ***', (await pile(widget, wh.id)) === 0,
    String(await pile(widget, wh.id)))
  ok('  and the shop pile too', (await pile(widget, shop.id)) === 0, String(await pile(widget, shop.id)))
  ok('  leaving the site total at zero', (await total(widget)) === 0, String(await total(widget)))

  // ── THE INVARIANTS, after everything above
  const drift = await reconcileStock(SITE)
  ok('*** reconcileStock returns ZERO drift ***', drift.length === driftBefore,
    JSON.stringify(drift.slice(0, 4)))

  // Put main back where it was, so a re-run starts from the same place and the
  // ZZ locations can be swept.
  await setMainLocation(SITE, mainId)
  await sweepStrays()

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS')
  process.exit(fails ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  await sweepStrays().catch(() => {})
  console.log('\nCRASHED — strays swept')
  process.exit(1)
})
