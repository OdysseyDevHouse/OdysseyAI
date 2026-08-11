/**
 * Serial numbers — knowing which individual unit went where.
 *
 * The rule that matters: for a serial product, stock_on_hand must equal the
 * number of serials marked 'in_stock'. That is a SECOND invariant alongside
 * Σ qty_change = stock_on_hand, and a sale that moved stock without marking a
 * serial — or the reverse — breaks it. Both are checked here.
 *
 *   npm run test:serials
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { createCustomer } from '../src/lib/site/customers'
import { saveDraft, getDocument } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { createCreditNote } from '../src/lib/site/salesReversal'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { createLocation, mainLocationId } from '../src/lib/site/stockLocations'
import { postTransfer, voidTransfer } from '../src/lib/site/stockTransfers'
import {
  addSerials, listSerials, availableSerials, findSerial, markReturned,
  writeOffSerial, reconcileSerials, serialHistory, checkSellable,
} from '../src/lib/site/serials'
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

const actor = { userId: 1, userName: 'Serial Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}
const stockOf = async (id: number) =>
  toNum((await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [id]))?.stock_on_hand)

const CODE_PATTERN = '^(SER|NRM)[0-9]{8}$'
async function sweepStrays() {
  const where = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  await siteExecute(SITE, `DELETE FROM product_serials WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM sales_document_lines WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
}

async function main() {
  await loadReasonIds()
  await sweepStrays()

  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const rate = toNum(vat?.rate, 15)

  // A phone: serial-tracked, and stock arrives with the serials.
  const p = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'serial',3,4000,4000,?,1)`,
    [`SER${stamp}`, `Smartphone ${stamp}`, vat?.id ?? null])
  const phone = p.insertId
  await siteExecute(SITE,
    "INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_id, user_name) VALUES (?,(SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1),'opening',3,3,4000,'opening',1,'Serial Test')",
    [phone])
  await siteExecute(SITE,
    'INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) SELECT id, (SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1), stock_on_hand FROM products WHERE id=? ON DUPLICATE KEY UPDATE stock_on_hand=VALUES(stock_on_hand)',
    [phone])

  const n = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'normal',10,50,50,?,1)`,
    [`NRM${stamp}`, `Phone case ${stamp}`, vat?.id ?? null])
  const phoneCase = n.insertId
  await siteExecute(SITE,
    "INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_id, user_name) VALUES (?,(SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1),'opening',10,10,50,'opening',1,'Serial Test')",
    [phoneCase])
  await siteExecute(SITE,
    'INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) SELECT id, (SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1), stock_on_hand FROM products WHERE id=? ON DUPLICATE KEY UPDATE stock_on_hand=VALUES(stock_on_hand)',
    [phoneCase])

  const cash = await getTenderByCode(SITE, 'CASH')
  const cust = await createCustomer(SITE, actor, { code: `SRC${stamp}`, name: 'Serial Test Co', creditLimit: 100000, paymentTermsDays: 30 })
  if (!cash || !cust.ok) { console.log('setup failed'); process.exit(1) }

  const driftBefore = (await reconcileStock(SITE)).length

  // ── Capturing serials
  ok('a normal product cannot carry serials',
    !(await addSerials(SITE, actor, phoneCase, ['X1'])).ok)
  ok('an empty list is refused', !(await addSerials(SITE, actor, phone, ['  '])).ok)

  const added = await addSerials(SITE, actor, phone, [`IMEI-${stamp}-A`, `IMEI-${stamp}-B`, `IMEI-${stamp}-C`], {
    costExcl: 4000, warrantyUntil: '2028-01-01',
  })
  ok('*** three serials captured ***', added.ok && added.added === 3, added.ok ? String(added.added) : added.error)

  const again = await addSerials(SITE, actor, phone, [`IMEI-${stamp}-A`, `IMEI-${stamp}-D`])
  ok('*** a duplicate is SKIPPED and named, not fatal ***',
    again.ok && again.added === 1 && again.skipped.length === 1,
    again.ok ? `added ${again.added}, skipped ${again.skipped.join()}` : again.error)

  // D was extra, so remove it to keep stock and serials agreeing.
  const extra = (await listSerials(SITE, { productId: phone })).items.find((s) => s.serial.endsWith('-D'))!
  await siteExecute(SITE, 'DELETE FROM product_serials WHERE id = ?', [extra.id])

  ok('*** serials match stock: 3 in, 3 on hand ***', (await reconcileSerials(SITE)).length === 0)
  ok('  three are available to sell', (await availableSerials(SITE, phone)).length === 3)

  // ── Selling without choosing a serial is refused
  const noPick = await saveDraft(SITE, actor, {
    docType: 'invoice', customerName: 'Walk-in',
    lines: [{ productId: phone, productCode: `SER${stamp}`, description: `Smartphone ${stamp}`, productType: 'serial', qty: 1, unitPriceIncl: 6900, vatRatePct: rate, unitCostExcl: 4000 }],
  })
  if (!noPick.ok) { console.log('draft failed'); process.exit(1) }
  const refused = await finaliseDocument(SITE, actor, { documentId: noPick.id, tenders: [{ tenderTypeId: cash.id, amount: 6900 }] })
  ok('*** selling without a serial is REFUSED ***', !refused.ok, !refused.ok ? refused.error : '')
  ok('  and says how many are needed', !refused.ok && refused.error.includes('choose 1'), !refused.ok ? refused.error : '')
  ok('  nothing moved', (await stockOf(phone)) === 3, String(await stockOf(phone)))

  const available = await availableSerials(SITE, phone)
  const lineId = (await getDocument(SITE, noPick.id))!.lines[0].id

  ok('too many serials refused',
    !(await finaliseDocument(SITE, actor, { documentId: noPick.id, tenders: [{ tenderTypeId: cash.id, amount: 6900 }], serials: { [lineId]: [available[0].id, available[1].id] } })).ok)
  ok('the same serial twice refused',
    !(await finaliseDocument(SITE, actor, { documentId: noPick.id, tenders: [{ tenderTypeId: cash.id, amount: 6900 }], serials: { [lineId]: [available[0].id, available[0].id] } })).ok)

  // ── A real sale
  const sold = await finaliseDocument(SITE, actor, {
    documentId: noPick.id, customerId: cust.id,
    tenders: [{ tenderTypeId: cash.id, amount: 6900 }],
    serials: { [lineId]: [available[0].id] },
  })
  ok('*** sold with a serial chosen ***', sold.ok, sold.ok ? sold.documentNumber : sold.error)
  ok('*** stock dropped to 2 ***', (await stockOf(phone)) === 2, String(await stockOf(phone)))
  ok('*** and serials still agree with stock ***', (await reconcileSerials(SITE)).length === 0)
  ok('  Σ movements still equals stock_on_hand', (await reconcileStock(SITE)).length === driftBefore)

  const soldOne = (await listSerials(SITE, { productId: phone, status: 'sold' })).items[0]
  ok('*** the sold serial knows its invoice ***', soldOne?.soldDocNumber !== null, String(soldOne?.soldDocNumber))
  ok('*** and knows WHO bought it — the warranty question ***',
    soldOne?.customerName === 'Serial Test Co', String(soldOne?.customerName))
  ok('  and its warranty date', soldOne?.warrantyUntil === '2028-01-01', String(soldOne?.warrantyUntil))
  ok('  only two left available', (await availableSerials(SITE, phone)).length === 2)

  ok('*** selling the SAME serial again is refused ***',
    !(await checkSellable(SITE, phone, [soldOne.id])).ok,
    JSON.stringify(await checkSellable(SITE, phone, [soldOne.id])))

  const found = await findSerial(SITE, soldOne.serial)
  ok('*** the warranty desk can find it by number alone ***', found.length === 1 && found[0].id === soldOne.id)

  const history = await serialHistory(SITE, soldOne.id)
  ok('  with its full history', history.length === 2, `${history.map((h) => h.action).join(',')}`)

  // ── A faulty return: comes back, but NOT resellable
  const invoiceLine = (await getDocument(SITE, noPick.id))!.lines[0]
  const credit = await createCreditNote(SITE, actor, {
    invoiceId: noPick.id,
    customerId: cust.id,
    reasonId: RETURN_REASON_ID, note: 'Faulty screen',
    lines: [{
      sourceLineId: invoiceLine.id, productId: phone, productCode: `SER${stamp}`,
      description: `Smartphone ${stamp}`, productType: 'serial', qty: 1,
      unitPriceIncl: 6900, vatRatePct: rate, unitCostExcl: 4000,
    }],
    refunds: [{ tenderTypeId: cash.id, amount: 6900 }],
  })
  ok('*** a faulty phone credits ***', credit.ok, credit.ok ? credit.documentNumber : credit.error)
  ok('  stock came back to 3', (await stockOf(phone)) === 3, String(await stockOf(phone)))

  const returned = await markReturned(SITE, actor, [soldOne.id], {
    resellable: false, documentId: credit.ok ? credit.documentId : null, note: 'Faulty screen',
  })
  ok('*** marked returned, NOT resellable ***', returned.ok, returned.ok ? '' : returned.error)
  ok('  it is not available to sell', (await availableSerials(SITE, phone)).length === 2)

  // THIS is the drift the second invariant exists to catch: stock says 3,
  // sellable serials say 2, because the faulty unit is back on the shelf but
  // must not go out again.
  const drift = await reconcileSerials(SITE)
  ok('*** and reconcileSerials CATCHES the mismatch ***', drift.length === 1, JSON.stringify(drift))
  ok('  naming stock 3 vs 2 sellable',
    drift[0]?.stockOnHand === 3 && drift[0]?.inStockSerials === 2,
    `${drift[0]?.stockOnHand}/${drift[0]?.inStockSerials}`)

  // Writing it off resolves it — the faulty unit leaves stock for good.
  await siteExecute(SITE,
    "INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_id, user_name, note) VALUES (?,(SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1),'adjustment',-1,2,4000,'adjustment',1,'Serial Test','Faulty unit written off')",
    [phone])
  await siteExecute(SITE, 'UPDATE products SET stock_on_hand = 2 WHERE id = ?', [phone])
    await siteExecute(SITE, 'UPDATE product_location_stock SET stock_on_hand = 2 WHERE product_id = ? AND location_id = (SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1)', [phone])
  const written = await writeOffSerial(SITE, actor, soldOne.id, 'Faulty — returned to supplier')
  ok('*** writing it off resolves the drift ***', written.ok && (await reconcileSerials(SITE)).length === 0)
  ok('  and Σ movements still reconciles', (await reconcileStock(SITE)).length === driftBefore)
  ok('  writing off twice refused', !(await writeOffSerial(SITE, actor, soldOne.id, 'again')).ok)
  ok('  a reason is required', !(await writeOffSerial(SITE, actor, available[1].id, '  ')).ok)

  // ── A resellable return goes straight back
  const second = await saveDraft(SITE, actor, {
    docType: 'invoice', customerName: 'Walk-in',
    lines: [{ productId: phone, productCode: `SER${stamp}`, description: `Smartphone ${stamp}`, productType: 'serial', qty: 1, unitPriceIncl: 6900, vatRatePct: rate, unitCostExcl: 4000 }],
  })
  if (second.ok) {
    const secondLine = (await getDocument(SITE, second.id))!.lines[0].id
    const nowAvailable = await availableSerials(SITE, phone)
    const sale2 = await finaliseDocument(SITE, actor, {
      documentId: second.id, tenders: [{ tenderTypeId: cash.id, amount: 6900 }],
      serials: { [secondLine]: [nowAvailable[0].id] },
    })
    ok('a second phone sells', sale2.ok, sale2.ok ? '' : sale2.error)

    const back = await markReturned(SITE, actor, [nowAvailable[0].id], { resellable: true })
    ok('*** a resellable return goes straight back to in_stock ***', back.ok)
    ok('  and it is sellable again', (await availableSerials(SITE, phone)).some((s) => s.id === nowAvailable[0].id))
    ok('  a serial that was not sold cannot be returned',
      !(await markReturned(SITE, actor, [nowAvailable[1].id], { resellable: true })).ok)

    // Stock has to come back too, or the invariant breaks.
    await siteExecute(SITE,
      "INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_id, user_name, note) VALUES (?,(SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1),'sale_return',1,2,4000,'credit_sale',1,'Serial Test','Returned resellable')",
      [phone])
    await siteExecute(SITE, 'UPDATE products SET stock_on_hand = 2 WHERE id = ?', [phone])
    await siteExecute(SITE, 'UPDATE product_location_stock SET stock_on_hand = 2 WHERE product_id = ? AND location_id = (SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1)', [phone])
    ok('*** serials and stock agree again ***', (await reconcileSerials(SITE)).length === 0)
    ok('  and Σ movements too', (await reconcileStock(SITE)).length === driftBefore)
  }

  // ── Normal products are untouched by any of this
  ok('a normal product has no serial rows', (await listSerials(SITE, { productId: phoneCase })).total === 0)
  ok('  and does not appear in reconcileSerials', !(await reconcileSerials(SITE)).some((d) => d.productId === phoneCase))

  // ── WHERE each unit is ───────────────────────────────────────────────────
  //
  // The per-location invariant (S2): the units in a room must equal the pile
  // in that room. What it catches, and (S1) never could, is a transfer that
  // moves the quantity and leaves the serials behind.
  {
    const room = await createLocation(SITE, { code: `SVL${stamp}`, name: 'Serial test room' })
    if (!room.ok) { console.log('location setup failed'); process.exit(1) }
    const mainId = await mainLocationId(SITE)

    const inStock = (await listSerials(SITE, { productId: phone, status: 'in_stock' })).items
    ok('*** an in-stock serial knows which room it is in ***',
      inStock.every((s) => s.locationId !== null), `${inStock.filter((s) => s.locationId === null).length} unplaced`)
    ok('  and it is the main one', inStock.every((s) => s.locationId === mainId))

    const sold = (await listSerials(SITE, { productId: phone, status: 'sold' })).items
    ok('*** a SOLD serial is in no room at all ***',
      sold.every((s) => s.locationId === null), `${sold.filter((s) => s.locationId !== null).length} still placed`)

    // The till must not offer a unit that is in another building.
    const here = await availableSerials(SITE, phone)
    const anywhere = await availableSerials(SITE, phone, null)
    ok('availableSerials defaults to the MAIN room', here.every((s) => s.locationId === mainId))
    ok('  and can be asked for every room', anywhere.length >= here.length)
    ok('  the other room is empty for now', (await availableSerials(SITE, phone, room.id)).length === 0)

    // ── Moving a serialised product REQUIRES naming the units
    const unit = here[0]
    if (unit) {
      const noSerials = await postTransfer(SITE, actor, {
        fromLocationId: mainId, toLocationId: room.id,
        lines: [{ productId: phone, description: 'No units named', qty: 1 }],
      })
      ok('*** transferring a serial product without naming units is REFUSED ***',
        !noSerials.ok, noSerials.ok ? '' : noSerials.error)

      const wrongCount = await postTransfer(SITE, actor, {
        fromLocationId: mainId, toLocationId: room.id,
        lines: [{ productId: phone, description: 'Count mismatch', qty: 2, serialIds: [unit.id] }],
      })
      ok('  and so is a count that does not match the units', !wrongCount.ok)

      // ── The real thing
      const moved = await postTransfer(SITE, actor, {
        fromLocationId: mainId, toLocationId: room.id,
        lines: [{ productId: phone, productCode: `SER${stamp}`, description: 'Moving one unit', qty: 1, serialIds: [unit.id] }],
      })
      ok('*** a serialised transfer posts ***', moved.ok, moved.ok ? moved.documentNumber : moved.error)

      if (moved.ok) {
        const after = (await listSerials(SITE, { productId: phone, status: 'in_stock' })).items
        const movedUnit = after.find((s) => s.id === unit.id)
        ok('*** THE UNIT FOLLOWED THE QUANTITY ***', movedUnit?.locationId === room.id,
          `unit is in ${movedUnit?.locationCode ?? 'nowhere'}`)
        ok('  it is now offered in that room', (await availableSerials(SITE, phone, room.id)).length === 1)
        ok('  and no longer at the counter', !(await availableSerials(SITE, phone)).some((s) => s.id === unit.id))

        // THE CHECK THAT MATTERS: units and piles agree in every room.
        ok('*** reconcileSerials returns ZERO drift after the move ***',
          (await reconcileSerials(SITE)).length === 0,
          JSON.stringify(await reconcileSerials(SITE)))

        // ── Voiding sends the unit back too
        const undone = await voidTransfer(SITE, actor, moved.id, 'Wrong room')
        ok('*** voiding a serialised transfer returns the UNIT ***', undone.ok, undone.ok ? '' : undone.error)
        const back = (await listSerials(SITE, { productId: phone, status: 'in_stock' })).items
        ok('  the unit is back in the main room', back.find((s) => s.id === unit.id)?.locationId === mainId)
        ok('*** and reconcileSerials is still clean ***', (await reconcileSerials(SITE)).length === 0,
          JSON.stringify(await reconcileSerials(SITE)))
      }
    }

    // serial_movements references the room from BOTH ends, so the history has
    // to go before the room does — the FK is doing exactly what it should.
    await siteExecute(SITE,
      `DELETE FROM serial_movements WHERE from_location_id = ? OR to_location_id = ?`, [room.id, room.id])
    await siteExecute(SITE, `DELETE FROM stock_transfer_lines WHERE product_id = ?`, [phone])
    await siteExecute(SITE,
      `DELETE FROM stock_transfers WHERE from_location_id = ? OR to_location_id = ?`, [room.id, room.id])
    await siteExecute(SITE, `DELETE FROM stock_movements WHERE location_id = ?`, [room.id])
    await siteExecute(SITE, `DELETE FROM product_location_stock WHERE location_id = ?`, [room.id])
    await siteExecute(SITE, `DELETE FROM stock_locations WHERE id = ?`, [room.id])
  }

  await sweepStrays()
  await siteExecute(SITE, 'DELETE FROM customer_allocations WHERE debit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?) OR credit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)', [cust.id, cust.id])
  await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [cust.id])
  await siteExecute(SITE, "DELETE FROM sales_tenders WHERE document_id IN (SELECT id FROM sales_documents WHERE customer_id = ? OR customer_name = 'Walk-in' AND id = ?)", [cust.id, noPick.id])
  await siteExecute(SITE, 'DELETE FROM document_audit WHERE document_id = ?', [noPick.id])
  await siteExecute(SITE, 'UPDATE sales_documents SET reverses_id = NULL WHERE reverses_id = ?', [noPick.id])
  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE customer_id = ? OR id = ? OR id = ?',
    [cust.id, noPick.id, second.ok ? second.id : 0])
  await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [cust.id])

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await sweepStrays()
  console.log('\nCRASHED — strays swept')
  process.exit(1)
})
