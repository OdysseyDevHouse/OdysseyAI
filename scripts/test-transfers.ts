/**
 * Stock transfers — moving goods between locations.
 *
 * THE PAIRED MOVEMENT RULE is what this exists to prove: every posted line
 * writes exactly two movements, equal and opposite, so
 *
 *   • the site total never changes    — the business owns the same goods
 *   • each pile changes by its half   — invariant (B)
 *   • the piles still sum to the total — invariant (C)
 *
 * A transfer that wrote one half would satisfy (A) and quietly break (C).
 * reconcileTransfers is the check that catches it, and it runs at the end.
 *
 *   npm run test:transfers
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { createLocation, setMainLocation, mainLocationId } from '../src/lib/site/stockLocations'
import {
  postTransfer,
  voidTransfer,
  getTransfer,
  listTransfers,
  validateTransfer,
  reconcileTransfers,
} from '../src/lib/site/stockTransfers'
import { reconcileStock, availableToSell } from '../src/lib/site/stockMovements'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Transfer Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const CODE_PATTERN = '^TRF[0-9]{8}$'
const LOC_PATTERN = 'YY%'

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

async function sweepStrays() {
  const products = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  const locs = `(SELECT id FROM stock_locations WHERE code LIKE '${LOC_PATTERN}')`

  await siteExecute(SITE, `DELETE FROM stock_transfer_lines WHERE product_id IN ${products}`)
  await siteExecute(
    SITE,
    `DELETE FROM stock_transfers WHERE from_location_id IN ${locs} OR to_location_id IN ${locs}`,
  )
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE location_id IN ${locs}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE location_id IN ${locs}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  await siteExecute(SITE, `DELETE FROM stock_locations WHERE code LIKE '${LOC_PATTERN}' AND is_main = 0`)
}

async function main() {
  await sweepStrays()

  const stamp = Date.now().toString().slice(-8)
  const stockDriftBefore = (await reconcileStock(SITE)).length
  const mainId = await mainLocationId(SITE)

  // ── The pure validation first, no database
  ok('*** a transfer to the SAME location is refused ***',
    validateTransfer({ fromLocationId: 1, toLocationId: 1, lines: [{ productId: 1, description: 'x', qty: 1 }] })
      !== null)
  ok('  a transfer with no lines is refused',
    validateTransfer({ fromLocationId: 1, toLocationId: 2, lines: [] }) !== null)
  ok('  a zero quantity is refused',
    validateTransfer({ fromLocationId: 1, toLocationId: 2, lines: [{ productId: 1, description: 'x', qty: 0 }] })
      !== null)
  ok('  a negative quantity is refused',
    validateTransfer({ fromLocationId: 1, toLocationId: 2, lines: [{ productId: 1, description: 'x', qty: -5 }] })
      !== null)
  ok('  a valid one passes',
    validateTransfer({ fromLocationId: 1, toLocationId: 2, lines: [{ productId: 1, description: 'x', qty: 5 }] })
      === null)

  // ── Fixtures: two rooms and a product sitting in one of them
  const wh = await createLocation(SITE, { code: `YYW${stamp}`, name: 'Transfer warehouse' })
  const shop = await createLocation(SITE, { code: `YYS${stamp}`, name: 'Transfer shop' })
  if (!wh.ok || !shop.ok) { console.log('location setup failed'); process.exit(1) }

  const vat = await siteQueryOne<any>(SITE, "SELECT id FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const p = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'normal',60,25,25,?,1)`,
    [`TRF${stamp}`, 'Transfer test widget', vat?.id ?? null])
  const widget = p.insertId

  // 60 units, all in the warehouse. Written directly because this is the
  // opening position, not something that moved.
  await siteExecute(SITE,
    `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) VALUES (?,?,60)`,
    [widget, wh.id])
  await siteExecute(SITE,
    `INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_id, user_name)
     VALUES (?,?,'opening',60,60,25,'opening',1,'Transfer Test')`,
    [widget, wh.id])

  ok('the warehouse starts with 60', (await pile(widget, wh.id)) === 60)
  ok('  and the shop with nothing', (await pile(widget, shop.id)) === 0)

  // ── Overdrawing is refused
  const tooMuch = await postTransfer(SITE, actor, {
    fromLocationId: wh.id, toLocationId: shop.id,
    lines: [{ productId: widget, productCode: `TRF${stamp}`, description: 'Too many', qty: 100 }],
  })
  ok('*** moving more than the pile holds is REFUSED ***', !tooMuch.ok, tooMuch.ok ? '' : tooMuch.error)
  ok('  and nothing moved on the refusal', (await pile(widget, wh.id)) === 60)
  ok('  and no document was left behind',
    (await listTransfers(SITE, { status: 'all' })).filter((t) => t.fromLocationId === wh.id).length === 0)

  // ── THE TRANSFER
  const moved = await postTransfer(SITE, actor, {
    fromLocationId: wh.id, toLocationId: shop.id,
    reference: 'Van 2',
    lines: [{ productId: widget, productCode: `TRF${stamp}`, description: 'Transfer test widget', qty: 15, unitCostExcl: 25 }],
  })
  ok('*** the transfer posts ***', moved.ok, moved.ok ? moved.documentNumber : moved.error)
  if (!moved.ok) { console.log('post failed'); process.exit(1) }

  ok('  it is numbered', /^TRF\d+$/.test(moved.documentNumber), moved.documentNumber)
  ok('*** the warehouse pile dropped to 45 ***', (await pile(widget, wh.id)) === 45, String(await pile(widget, wh.id)))
  ok('*** the shop pile rose to 15 ***', (await pile(widget, shop.id)) === 15, String(await pile(widget, shop.id)))
  ok('*** THE SITE TOTAL DID NOT MOVE — still 60 ***', (await total(widget)) === 60, String(await total(widget)))

  // Both halves, and only those two.
  const movements = await siteQueryOne<any>(SITE,
    `SELECT COUNT(*) c,
            SUM(movement_type='transfer_out') outs,
            SUM(movement_type='transfer_in')  ins
       FROM stock_movements WHERE source_doc_id=? AND source='transfer'`,
    [moved.id])
  ok('*** exactly TWO movements were written ***', Number(movements?.c) === 2, String(movements?.c))
  ok('  one out and one in', Number(movements?.outs) === 1 && Number(movements?.ins) === 1)

  const fetched = await getTransfer(SITE, moved.id)
  ok('the transfer reads back with its line', fetched?.lines.length === 1)
  ok('  and knows both ends', fetched?.fromLocationId === wh.id && fetched?.toLocationId === shop.id)
  ok('  and keeps the reference', fetched?.reference === 'Van 2')

  // ── The till follows main
  await setMainLocation(SITE, shop.id)
  const avail = await availableToSell(SITE, [widget])
  ok('*** the till sees the stock once it is in the main location ***',
    avail.get(widget)?.onHand === 15, String(avail.get(widget)?.onHand))
  ok('  while the business still owns all 60', avail.get(widget)?.onHandAllLocations === 60,
    String(avail.get(widget)?.onHandAllLocations))

  // ── Voiding sends it back
  const badVoid = await voidTransfer(SITE, actor, moved.id, '   ')
  ok('a void without a reason is refused', !badVoid.ok)

  const voided = await voidTransfer(SITE, actor, moved.id, 'Sent to the wrong room')
  ok('*** the transfer voids ***', voided.ok, voided.ok ? '' : voided.error)
  ok('*** the stock went BACK to the warehouse ***', (await pile(widget, wh.id)) === 60, String(await pile(widget, wh.id)))
  ok('  and the shop is empty again', (await pile(widget, shop.id)) === 0, String(await pile(widget, shop.id)))
  ok('  the total STILL has not moved', (await total(widget)) === 60, String(await total(widget)))
  ok('  voiding twice is refused', !(await voidTransfer(SITE, actor, moved.id, 'again')).ok)

  const afterVoid = await getTransfer(SITE, moved.id)
  ok('  the voided transfer KEEPS its number', afterVoid?.documentNumber === moved.documentNumber)
  ok('  and records the reason', afterVoid?.cancelReason === 'Sent to the wrong room')

  // ── Cannot pull back what has since gone
  const again = await postTransfer(SITE, actor, {
    fromLocationId: wh.id, toLocationId: shop.id,
    lines: [{ productId: widget, productCode: `TRF${stamp}`, description: 'Second move', qty: 10, unitCostExcl: 25 }],
  })
  if (!again.ok) { console.log('second post failed'); process.exit(1) }

  // Sell it out of the shop, so the destination no longer holds it.
  await siteExecute(SITE,
    `UPDATE product_location_stock SET stock_on_hand = 0 WHERE product_id=? AND location_id=?`,
    [widget, shop.id])
  await siteExecute(SITE, `UPDATE products SET stock_on_hand = stock_on_hand - 10 WHERE id=?`, [widget])
  await siteExecute(SITE,
    `INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_id, user_name)
     VALUES (?,?,'sale',-10,50,25,'sale',1,'Transfer Test')`,
    [widget, shop.id])

  const cannot = await voidTransfer(SITE, actor, again.id, 'Too late')
  ok('*** voiding is REFUSED once the goods have moved on ***', !cannot.ok, cannot.ok ? '' : cannot.error)

  // ── The invariants
  ok('*** reconcileTransfers returns ZERO drift ***', (await reconcileTransfers(SITE)).length === 0,
    JSON.stringify(await reconcileTransfers(SITE)))
  ok('*** reconcileStock returns ZERO drift ***', (await reconcileStock(SITE)).length === stockDriftBefore,
    JSON.stringify((await reconcileStock(SITE)).slice(0, 3)))

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
