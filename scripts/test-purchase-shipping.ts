/**
 * Shipping on a receipt — landed cost for everyone, credit for the right one.
 *
 * The rule under test: EVERY charge is apportioned into landed cost, whoever
 * billed it, but only the goods supplier's share is added to what THEY are
 * owed. A courier's invoice must land on the courier's account.
 *
 * And the sharpest edge in the feature: a receipt can create more than one
 * creditor invoice, so a VOID must reverse every one of them. A void that
 * reverses the goods invoice and forgets the courier's leaves that account
 * permanently overstated, silently.
 *
 *   npm run test:purchase-shipping
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { receiveGoods, voidReceipt, chargesTotalFor } from '../src/lib/site/purchasePosting'
import { createSupplier, getSupplier } from '../src/lib/site/suppliers'
import { reconcileSupplierBalances, listSupplierLedger } from '../src/lib/site/supplierLedger'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { toNum, round } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Shipping Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  console.log('\n── The charge total, before any database ──')

  ok(
    'no charges at all is zero',
    chargesTotalFor({ supplierId: 1, lines: [] }) === 0,
  )
  ok(
    'a bare total is used when there are no rows',
    chargesTotalFor({ supplierId: 1, chargesExcl: 150, lines: [] }) === 150,
  )
  ok(
    '*** rows WIN over a bare total, so the two cannot disagree ***',
    chargesTotalFor({
      supplierId: 1,
      chargesExcl: 999,
      charges: [
        { description: 'Courier', amountExcl: 60 },
        { description: 'Duty', amountExcl: 40 },
      ],
      lines: [],
    }) === 100,
  )

  // ── Fixtures
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

  const goods = await createSupplier(SITE, actor, {
    code: `SHG${stamp}`,
    name: 'Shipping Test Wholesalers',
    paymentTermsDays: 30,
  })
  const carrier = await createSupplier(SITE, actor, {
    code: `SHC${stamp}`,
    name: 'Shipping Test Couriers',
    paymentTermsDays: 30,
  })
  if (!goods.ok || !carrier.ok) {
    console.log('setup failed')
    process.exit(1)
  }

  const p = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?,?,'normal',0,0,0,1)`,
    [`SP${stamp}`, `Shipping test item ${stamp}`],
  )
  const productId = p.insertId

  const hasCharges = await siteQueryOne<any>(
    SITE,
    `SELECT 1 AS ok FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_document_charges' LIMIT 1`,
  )
  if (!hasCharges) {
    console.log('\nSKIP — 088_purchase_charges.sql has not reached this site.')
    process.exit(0)
  }

  console.log('\n── A charge on the goods invoice (how it always worked) ──')

  const own = await receiveGoods(SITE, actor, {
    supplierId: goods.id,
    supplierInvoiceNo: `OWN-${stamp}`,
    charges: [{ description: 'Delivery', amountExcl: 100, vatRatePct: rate }],
    lines: [
      {
        productId,
        description: 'Shipping test item',
        qtyReceived: 100,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('a receipt with an own-invoice charge posts', own.ok, own.ok ? own.documentNumber : own.error)
  if (!own.ok) process.exit(1)

  let line = await siteQueryOne<any>(
    SITE,
    'SELECT charge_excl, landed_cost_excl FROM purchase_document_lines WHERE document_id=?',
    [own.documentId],
  )
  ok('  the charge reached the line', toNum(line.charge_excl) === 100, String(line.charge_excl))
  ok(
    '*** landed cost = invoice 10 + freight 1 ***',
    toNum(line.landed_cost_excl) === 11,
    String(line.landed_cost_excl),
  )

  let owed = await getSupplier(SITE, goods.id)
  const ownExpected = round((1000 + 100) * (1 + rate / 100), 2)
  ok(
    '*** the goods supplier IS owed their own charge ***',
    Math.abs(owed!.balance - ownExpected) < 0.02,
    `${owed!.balance} vs ${ownExpected}`,
  )

  console.log('\n── A charge billed by someone else ──')

  const split = await receiveGoods(SITE, actor, {
    supplierId: goods.id,
    supplierInvoiceNo: `SPLIT-${stamp}`,
    charges: [
      {
        supplierId: carrier.id,
        description: 'Courier',
        amountExcl: 200,
        vatRatePct: rate,
        theirInvoiceNo: `CUR-${stamp}`,
      },
    ],
    lines: [
      {
        productId,
        description: 'Shipping test item',
        qtyReceived: 100,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('a receipt with a carrier charge posts', split.ok, split.ok ? split.documentNumber : split.error)
  if (!split.ok) process.exit(1)

  line = await siteQueryOne<any>(
    SITE,
    'SELECT charge_excl, landed_cost_excl FROM purchase_document_lines WHERE document_id=?',
    [split.documentId],
  )
  ok(
    "*** the CARRIER's charge is STILL in landed cost ***",
    toNum(line.landed_cost_excl) === 12,
    String(line.landed_cost_excl),
  )

  const goodsBefore = ownExpected
  owed = await getSupplier(SITE, goods.id)
  const goodsExpected = round(goodsBefore + 1000 * (1 + rate / 100), 2)
  ok(
    "*** but is NOT on the goods supplier's account ***",
    Math.abs(owed!.balance - goodsExpected) < 0.02,
    `${owed!.balance} vs ${goodsExpected} (would be ${round(goodsExpected + 200 * (1 + rate / 100), 2)} if wrongly included)`,
  )

  const carrierOwed = await getSupplier(SITE, carrier.id)
  const carrierExpected = round(200 * (1 + rate / 100), 2)
  ok(
    '*** the CARRIER is owed it, on their own account ***',
    Math.abs(carrierOwed!.balance - carrierExpected) < 0.02,
    `${carrierOwed!.balance} vs ${carrierExpected}`,
  )

  const carrierLedger = await listSupplierLedger(SITE, carrier.id)
  ok(
    "  under THEIR invoice number, so a payment run can match it",
    carrierLedger[0]?.docNumber === `CUR-${stamp}`,
    String(carrierLedger[0]?.docNumber),
  )
  ok(
    '  and referencing our GRV, so it can be traced back',
    carrierLedger[0]?.reference === split.documentNumber,
    String(carrierLedger[0]?.reference),
  )

  const chargeRows = await siteQuery<any>(
    SITE,
    'SELECT supplier_id, description, amount_excl FROM purchase_document_charges WHERE document_id=?',
    [split.documentId],
  )
  ok('  the charge is itemised on the receipt', chargeRows.length === 1)
  ok('  naming who billed it', Number(chargeRows[0]?.supplier_id) === carrier.id)

  console.log('\n── Two carriers on one delivery ──')

  const carrier2 = await createSupplier(SITE, actor, {
    code: `SHD${stamp}`,
    name: 'Shipping Test Hauliers',
    paymentTermsDays: 30,
  })
  if (!carrier2.ok) process.exit(1)

  const multi = await receiveGoods(SITE, actor, {
    supplierId: goods.id,
    supplierInvoiceNo: `MULTI-${stamp}`,
    charges: [
      { description: 'Handling', amountExcl: 50, vatRatePct: rate },
      { supplierId: carrier.id, description: 'Courier leg 1', amountExcl: 80, vatRatePct: rate },
      { supplierId: carrier.id, description: 'Courier leg 2', amountExcl: 20, vatRatePct: rate },
      { supplierId: carrier2.id, description: 'Haulage', amountExcl: 150, vatRatePct: rate },
    ],
    lines: [
      {
        productId,
        description: 'Shipping test item',
        qtyReceived: 100,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('a receipt with three billers posts', multi.ok, multi.ok ? '' : (multi as any).error)
  if (!multi.ok) process.exit(1)

  line = await siteQueryOne<any>(
    SITE,
    'SELECT charge_excl, landed_cost_excl FROM purchase_document_lines WHERE document_id=?',
    [multi.documentId],
  )
  ok(
    '*** ALL 300 of charges is in landed cost ***',
    toNum(line.charge_excl) === 300 && toNum(line.landed_cost_excl) === 13,
    `charge ${line.charge_excl}, landed ${line.landed_cost_excl}`,
  )

  const doc = await siteQueryOne<any>(
    SITE,
    'SELECT charges_excl, total_incl FROM purchase_documents WHERE id=?',
    [multi.documentId],
  )
  ok(
    '  the document records the WHOLE charge figure',
    toNum(doc.charges_excl) === 300,
    String(doc.charges_excl),
  )
  ok(
    "*** but total_incl is only goods + the supplier's own 50 ***",
    Math.abs(toNum(doc.total_incl) - round(1050 * (1 + rate / 100), 2)) < 0.02,
    String(doc.total_incl),
  )

  const c1 = await getSupplier(SITE, carrier.id)
  ok(
    '*** two charges from ONE carrier become ONE invoice of 100 ***',
    Math.abs(c1!.balance - round((200 + 100) * (1 + rate / 100), 2)) < 0.02,
    String(c1!.balance),
  )
  const c2 = await getSupplier(SITE, carrier2.id)
  ok(
    '  and the second carrier gets their own',
    Math.abs(c2!.balance - round(150 * (1 + rate / 100), 2)) < 0.02,
    String(c2!.balance),
  )

  console.log('\n── THE VOID: every invoice must come back ──')

  const carrierBeforeVoid = c1!.balance
  const carrier2BeforeVoid = c2!.balance

  const voided = await voidReceipt(SITE, actor, multi.documentId, 'Wrong delivery')
  ok('the receipt voids', voided.ok, voided.ok ? '' : (voided as any).error)

  const goodsAfter = await getSupplier(SITE, goods.id)
  ok(
    "the goods supplier's invoice reversed",
    Math.abs(goodsAfter!.balance - goodsExpected) < 0.02,
    String(goodsAfter!.balance),
  )

  const c1After = await getSupplier(SITE, carrier.id)
  ok(
    '*** THE CARRIER IS NO LONGER OWED THE VOIDED FREIGHT ***',
    Math.abs(c1After!.balance - round(carrierBeforeVoid - 100 * (1 + rate / 100), 2)) < 0.02,
    `${c1After!.balance}, was ${carrierBeforeVoid}`,
  )

  const c2After = await getSupplier(SITE, carrier2.id)
  ok(
    '*** and neither is the second ***',
    Math.abs(c2After!.balance - round(carrier2BeforeVoid - 150 * (1 + rate / 100), 2)) < 0.02,
    `${c2After!.balance}, was ${carrier2BeforeVoid}`,
  )
  ok(
    '  the second carrier is now owed nothing at all',
    Math.abs(c2After!.balance) < 0.02,
    String(c2After!.balance),
  )

  console.log('\n── Refusals ──')

  const noDesc = await receiveGoods(SITE, actor, {
    supplierId: goods.id,
    charges: [{ description: '   ', amountExcl: 50 }],
    lines: [
      { productId, description: 'x', qtyReceived: 1, unitCostExcl: 1, vatRatePct: rate },
    ],
  })
  ok('a charge with no description is refused', !noDesc.ok, noDesc.ok ? '' : noDesc.error)

  const negative = await receiveGoods(SITE, actor, {
    supplierId: goods.id,
    charges: [{ description: 'Courier', amountExcl: -10 }],
    lines: [
      { productId, description: 'x', qtyReceived: 1, unitCostExcl: 1, vatRatePct: rate },
    ],
  })
  ok('a negative charge is refused', !negative.ok)

  const emptyCarrier = await receiveGoods(SITE, actor, {
    supplierId: goods.id,
    charges: [{ supplierId: carrier.id, description: 'Courier', amountExcl: 0 }],
    lines: [
      { productId, description: 'x', qtyReceived: 1, unitCostExcl: 1, vatRatePct: rate },
    ],
  })
  ok(
    "*** a zero charge on someone else's account is refused, not silently skipped ***",
    !emptyCarrier.ok,
    emptyCarrier.ok ? '' : emptyCarrier.error,
  )

  console.log('\n── Backwards compatibility ──')

  const oldStyle = await receiveGoods(SITE, actor, {
    supplierId: goods.id,
    supplierInvoiceNo: `OLD-${stamp}`,
    chargesExcl: 100,
    lines: [
      {
        productId,
        description: 'Shipping test item',
        qtyReceived: 100,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('*** a caller passing only chargesExcl still works ***', oldStyle.ok)
  if (oldStyle.ok) {
    line = await siteQueryOne<any>(
      SITE,
      'SELECT charge_excl, landed_cost_excl FROM purchase_document_lines WHERE document_id=?',
      [oldStyle.documentId],
    )
    ok('  apportioned exactly as before', toNum(line.landed_cost_excl) === 11, String(line.landed_cost_excl))
    const rows = await siteQuery<any>(
      SITE,
      'SELECT id FROM purchase_document_charges WHERE document_id=?',
      [oldStyle.documentId],
    )
    ok('  and writes no charge rows, since none were itemised', rows.length === 0)
  }

  console.log('\n── Invariants ──')

  const drift = (await reconcileStock(SITE)).filter((d) => d.productId === productId)
  ok('*** zero stock drift on this run\'s product ***', drift.length === 0, JSON.stringify(drift))

  const balances = (await reconcileSupplierBalances(SITE)).filter((b: any) =>
    [goods.id, carrier.id, carrier2.id].includes(b.supplierId),
  )
  ok(
    "*** zero supplier-balance drift across goods AND carriers ***",
    balances.length === 0,
    JSON.stringify(balances),
  )

  console.log(`\n${fails === 0 ? 'All good.' : `${fails} FAILED`}\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
