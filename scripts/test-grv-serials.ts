/**
 * Serial numbers captured on a GRV.
 *
 * The rule that matters: the quantity and the serials move in ONE transaction.
 * A receipt that moved three phones but recorded two serials would break the
 * invariant reconcileSerials exists to prove — in-stock serials equal stock on
 * hand — and there would be no way afterwards to tell which figure was right.
 *
 * So the interesting cases here are the REFUSALS, and what the database looks
 * like after one: a rejected receipt must leave no stock, no serials and no
 * document behind.
 *
 *   npm run test:grv-serials
 */
import { siteExecute, siteQueryOne, siteQuery } from '../src/lib/siteDb'
import { createSupplier } from '../src/lib/site/suppliers'
import { receiveGoods, voidReceipt } from '../src/lib/site/purchasePosting'
import { listSerials, reconcileSerials } from '../src/lib/site/serials'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'GRV Serial Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const PRODUCT_PATTERN = '^(GSER|GNRM)[0-9]{8}$'

async function sweepStrays() {
  const products = `(SELECT id FROM products WHERE code REGEXP '${PRODUCT_PATTERN}')`
  await siteExecute(SITE, `DELETE FROM serial_movements WHERE serial_id IN (SELECT id FROM product_serials WHERE product_id IN ${products})`)
  await siteExecute(SITE, `DELETE FROM product_serials WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM product_suppliers WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${PRODUCT_PATTERN}'`)

  // The supplier is left behind on purpose. Its GRVs are real posted documents
  // in a numbered sequence, and deleting the account they belong to would
  // either fail on the foreign key or — worse, if it were cascaded — punch a
  // hole in the document trail to tidy up a test.
}

const stockOf = async (id: number) =>
  toNum((await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [id]))?.stock_on_hand)

const serialCount = async (productId: number) =>
  Number((await siteQueryOne<any>(SITE, 'SELECT COUNT(*) n FROM product_serials WHERE product_id=?', [productId]))?.n ?? 0)

async function main() {
  await sweepStrays()
  const stamp = Date.now().toString().slice(-8)

  const vat =
    (await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='purchase' AND is_default=1 LIMIT 1")) ??
    (await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1"))
  const rate = toNum(vat?.rate, 15)

  const sup = await createSupplier(SITE, actor, {
    code: `GSUP${stamp}`,
    name: 'Serial Goods Wholesalers',
    paymentTermsDays: 30,
  })
  if (!sup.ok) {
    console.log('setup failed:', sup.error)
    process.exit(1)
  }

  await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost)
     VALUES (?,?, 'serial', 0, 0)`,
    [`GSER${stamp}`, `Serial Handset ${stamp}`],
  )
  const phoneId = Number(
    (await siteQueryOne<any>(SITE, 'SELECT id FROM products WHERE code=?', [`GSER${stamp}`]))!.id,
  )

  await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost)
     VALUES (?,?, 'normal', 0, 0)`,
    [`GNRM${stamp}`, `Plain Widget ${stamp}`],
  )
  const widgetId = Number(
    (await siteQueryOne<any>(SITE, 'SELECT id FROM products WHERE code=?', [`GNRM${stamp}`]))!.id,
  )

  const line = (over: Record<string, unknown> = {}) => ({
    productId: phoneId,
    productCode: `GSER${stamp}`,
    description: `Serial Handset ${stamp}`,
    productType: 'serial',
    qtyReceived: 3,
    unitCostExcl: 1000,
    vatRatePct: rate,
    serials: [`SN-${stamp}-A`, `SN-${stamp}-B`, `SN-${stamp}-C`],
    ...over,
  })

  console.log('\n── Refusals leave NOTHING behind ───────────────────────────────\n')

  const tooFew = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [line({ serials: [`SN-${stamp}-A`, `SN-${stamp}-B`] })],
  })
  ok('*** 3 units with 2 serials is refused ***', !tooFew.ok, tooFew.ok ? '' : tooFew.error)

  const tooMany = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [line({ serials: [`SN-${stamp}-A`, `SN-${stamp}-B`, `SN-${stamp}-C`, `SN-${stamp}-D`] })],
  })
  ok('3 units with 4 serials is refused', !tooMany.ok, tooMany.ok ? '' : tooMany.error)

  const none = await receiveGoods(SITE, actor, { supplierId: sup.id, lines: [line({ serials: [] })] })
  ok('a serial product with no serials at all is refused', !none.ok, none.ok ? '' : none.error)

  const dupe = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [line({ serials: [`SN-${stamp}-A`, `SN-${stamp}-A`, `SN-${stamp}-B`] })],
  })
  ok('the same serial twice on one line is refused', !dupe.ok, dupe.ok ? '' : dupe.error)

  const fractional = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [line({ qtyReceived: 2.5, serials: [`SN-${stamp}-A`, `SN-${stamp}-B`] })],
  })
  ok('*** half a serialised unit is refused ***', !fractional.ok, fractional.ok ? '' : fractional.error)

  ok('*** no stock moved on any refusal ***', (await stockOf(phoneId)) === 0, String(await stockOf(phoneId)))
  ok('and no serial rows were written', (await serialCount(phoneId)) === 0)
  const docsAfterRefusals = await siteQuery<any>(
    SITE,
    'SELECT id FROM purchase_documents WHERE supplier_id=?',
    [sup.id],
  )
  ok('*** and no GRV document was left behind ***', docsAfterRefusals.length === 0, `${docsAfterRefusals.length} docs`)

  console.log('\n── A good receipt ──────────────────────────────────────────────\n')

  const good = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    supplierInvoiceNo: `INV-${stamp}`,
    lines: [line({ warrantyUntil: '2030-01-01' })],
  })
  ok('*** 3 units with 3 serials posts ***', good.ok, good.ok ? good.documentNumber : good.error)
  if (!good.ok) {
    await sweepStrays()
    console.log('\ncannot continue')
    process.exit(1)
  }

  ok('*** stock moved to 3 ***', (await stockOf(phoneId)) === 3, String(await stockOf(phoneId)))
  const captured = await listSerials(SITE, { productId: phoneId })
  ok('*** and exactly 3 serials are on file ***', captured.total === 3, String(captured.total))
  ok('all in stock', captured.items.every((s) => s.status === 'in_stock'))
  ok('*** each knows the GRV it arrived on ***',
    (await siteQuery<any>(SITE, 'SELECT COUNT(*) n FROM product_serials WHERE received_doc_id=?', [good.documentId]))[0].n === 3)
  ok('the warranty date is carried onto every unit',
    captured.items.every((s) => String(s.warrantyUntil).startsWith('2030-01-01')),
    String(captured.items[0]?.warrantyUntil))
  ok('*** cost_excl is the LANDED cost, not the invoice cost ***',
    captured.items.every((s) => s.costExcl === 1000), String(captured.items[0]?.costExcl))
  ok('and each got a received movement',
    (await siteQuery<any>(SITE, `SELECT COUNT(*) n FROM serial_movements m JOIN product_serials s ON s.id=m.serial_id WHERE s.product_id=? AND m.action='received'`, [phoneId]))[0].n === 3)

  // The invariant this whole feature exists to protect.
  const drift = (await reconcileSerials(SITE)).filter((d) => d.productId === phoneId)
  ok('*** in-stock serials equal stock on hand ***', drift.length === 0, JSON.stringify(drift))
  const stockDrift = (await reconcileStock(SITE)).filter((d: any) => d.productId === phoneId)
  ok('and Σ movements still equals stock_on_hand', stockDrift.length === 0, JSON.stringify(stockDrift))

  console.log('\n── Receiving the same serial twice ─────────────────────────────\n')

  const again = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [line({ qtyReceived: 1, serials: [`SN-${stamp}-A`] })],
  })
  ok('*** a serial already on file is REFUSED, not skipped ***', !again.ok, again.ok ? '' : again.error)
  ok('stock is still 3 after that refusal', (await stockOf(phoneId)) === 3, String(await stockOf(phoneId)))
  ok('and still only 3 serials', (await serialCount(phoneId)) === 3)

  console.log('\n── Landed cost, and a mixed delivery ───────────────────────────\n')

  const mixed = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    chargesExcl: 100,
    lines: [
      line({ qtyReceived: 2, serials: [`SN-${stamp}-D`, `SN-${stamp}-E`], unitCostExcl: 1000 }),
      {
        productId: widgetId,
        productCode: `GNRM${stamp}`,
        description: `Plain Widget ${stamp}`,
        productType: 'normal',
        qtyReceived: 10,
        unitCostExcl: 50,
        vatRatePct: rate,
      },
    ],
  })
  ok('*** a serial line and a normal line post together ***', mixed.ok, mixed.ok ? mixed.documentNumber : mixed.error)
  ok('the widget needed no serials', (await stockOf(widgetId)) === 10, String(await stockOf(widgetId)))
  ok('the phone is now 5', (await stockOf(phoneId)) === 5, String(await stockOf(phoneId)))

  const withFreight = await listSerials(SITE, { productId: phoneId, q: `SN-${stamp}-D` })
  ok('*** freight is in the serial cost — landed, not invoice ***',
    (withFreight.items[0]?.costExcl ?? 0) > 1000, String(withFreight.items[0]?.costExcl))

  const drift2 = (await reconcileSerials(SITE)).filter((d) => d.productId === phoneId)
  ok('*** serials still agree with stock after a mixed receipt ***', drift2.length === 0, JSON.stringify(drift2))

  console.log('\n── Voiding takes the units back out ────────────────────────────\n')

  const voided = await voidReceipt(SITE, actor, mixed.ok ? mixed.documentId : 0, 'Wrong delivery')
  ok('the mixed receipt voids', voided.ok, voided.ok ? '' : voided.error)
  ok('*** stock came back down to 3 ***', (await stockOf(phoneId)) === 3, String(await stockOf(phoneId)))
  ok('*** and its 2 serials are GONE, not written off ***', (await serialCount(phoneId)) === 3, String(await serialCount(phoneId)))
  ok('the widget went back too', (await stockOf(widgetId)) === 0, String(await stockOf(widgetId)))

  const drift3 = (await reconcileSerials(SITE)).filter((d) => d.productId === phoneId)
  ok('*** serials STILL agree with stock after the void ***', drift3.length === 0, JSON.stringify(drift3))
  const stockDrift3 = (await reconcileStock(SITE)).filter((d: any) => d.productId === phoneId)
  ok('and so does Σ movements', stockDrift3.length === 0, JSON.stringify(stockDrift3))

  // A voided serial's number must be free to use again — the units never
  // actually arrived, so the number is not taken.
  const reReceive = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [line({ qtyReceived: 1, serials: [`SN-${stamp}-D`] })],
  })
  ok('*** a voided serial number can be received again ***', reReceive.ok, reReceive.ok ? '' : reReceive.error)

  await sweepStrays()

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await sweepStrays()
  console.log('\nCRASHED — strays swept')
  process.exit(1)
})
