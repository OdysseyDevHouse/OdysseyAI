/**
 * Bonus quantities — free units, and the divisor that must not be wrong.
 *
 * THE RULE: bonus units increase what arrived but not what is owed, so the
 * landed cost divides by received + bonus. Dividing by received alone
 * overstates the cost of every promotional buy — and because a GRV is the only
 * thing that writes products.average_cost, the error is BLENDED IN and
 * compounds with each subsequent receipt. It does not throw and it does not
 * reconcile short; it just prices next quarter's GP report wrong.
 *
 * Everything below is arranged around catching that one mistake, and the
 * several places it could hide: the stock movement, the average blend, the
 * serial count, the void, and what a supplier return may send back.
 *
 *   npm run test:purchase-bonus
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { receiveGoods, voidReceipt, validateReceive } from '../src/lib/site/purchasePosting'
import { returnableLines } from '../src/lib/site/purchaseReversal'
import { getPurchaseDocument, saveOrder, issueOrder } from '../src/lib/site/purchaseDocuments'
import { createSupplier, getSupplier } from '../src/lib/site/suppliers'
import { reconcileStock, listMovements } from '../src/lib/site/stockMovements'
import { reconcileSupplierBalances } from '../src/lib/site/supplierLedger'
import { toNum, round } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Bonus Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}
const product = async (id: number) =>
  (await siteQueryOne<any>(
    SITE,
    'SELECT stock_on_hand, average_cost, last_cost FROM products WHERE id=?',
    [id],
  ))!

async function main() {
  console.log('\n── Validation ──')

  const base = {
    supplierId: 1,
    lines: [
      { productId: null, description: 'x', qtyReceived: 10, unitCostExcl: 100, vatRatePct: 15 },
    ],
  }
  ok('a sound line passes', validateReceive(base) === null)
  ok(
    'a negative bonus is refused',
    validateReceive({
      ...base,
      lines: [{ ...base.lines[0], qtyBonus: -1 }],
    }) !== null,
  )
  ok(
    'a zero bonus is fine',
    validateReceive({ ...base, lines: [{ ...base.lines[0], qtyBonus: 0 }] }) === null,
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

  const sup = await createSupplier(SITE, actor, {
    code: `BON${stamp}`,
    name: 'Bonus Test Distributors',
    paymentTermsDays: 30,
  })
  if (!sup.ok) {
    console.log('setup failed:', sup.error)
    process.exit(1)
  }

  const hasBonus = await siteQueryOne<any>(
    SITE,
    `SELECT 1 AS ok FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_document_lines'
        AND COLUMN_NAME='qty_bonus' LIMIT 1`,
  )
  if (!hasBonus) {
    console.log('\nSKIP — 090_purchase_bonus_qty.sql has not reached this site.')
    process.exit(0)
  }

  const mk = async (code: string) =>
    (
      await siteExecute(
        SITE,
        `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
         VALUES (?,?,'normal',0,0,0,1)`,
        [code, `Bonus test ${code}`],
      )
    ).insertId

  console.log('\n── Buy 10, get 1 free ──')

  const p1 = await mk(`B1${stamp}`)
  const buy10 = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    supplierInvoiceNo: `BON-${stamp}`,
    lines: [
      {
        productId: p1,
        description: 'Bonus test item',
        qtyReceived: 10,
        qtyBonus: 1,
        unitCostExcl: 100,
        vatRatePct: rate,
      },
    ],
  })
  ok('the receipt posts', buy10.ok, buy10.ok ? buy10.documentNumber : buy10.error)
  if (!buy10.ok) process.exit(1)

  let state = await product(p1)
  ok('*** ELEVEN units went onto the shelf, not ten ***', toNum(state.stock_on_hand) === 11, String(state.stock_on_hand))

  const expectedLanded = round(1000 / 11, 4)
  ok(
    '*** average cost is 90.9091, NOT 100 ***',
    toNum(state.average_cost) === expectedLanded,
    `${state.average_cost} (wrong answer would be 100.0000)`,
  )
  ok('  last_cost matches the landed figure', toNum(state.last_cost) === expectedLanded, String(state.last_cost))

  let doc = await getPurchaseDocument(SITE, buy10.documentId)
  ok('  the line records 10 paid', toNum(doc?.lines[0]?.qtyReceived) === 10)
  ok('  and 1 free', toNum(doc?.lines[0]?.qtyBonus) === 1)
  ok('  arriving 11 in total', toNum(doc?.lines[0]?.qtyArrived) === 11)
  ok(
    '*** but the supplier is owed for TEN ***',
    toNum(doc?.subtotalExcl) === 1000,
    String(doc?.subtotalExcl),
  )

  const owed = await getSupplier(SITE, sup.id)
  ok(
    '  their ledger agrees',
    Math.abs(owed!.balance - round(1000 * (1 + rate / 100), 2)) < 0.02,
    String(owed!.balance),
  )

  const moves = await listMovements(SITE, p1, 3)
  ok(
    '*** the stock movement carries all 11, so a count reconciles ***',
    moves[0]?.qtyChange === 11,
    String(moves[0]?.qtyChange),
  )
  ok('  at the landed cost', toNum(moves[0]?.unitCostExcl) === expectedLanded)

  console.log('\n── Bonus AND freight together ──')

  const p2 = await mk(`B2${stamp}`)
  const withFreight = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    chargesExcl: 60,
    lines: [
      {
        productId: p2,
        description: 'Bonus with freight',
        qtyReceived: 10,
        qtyBonus: 2,
        unitCostExcl: 50,
        vatRatePct: rate,
      },
    ],
  })
  ok('it posts', withFreight.ok, withFreight.ok ? '' : (withFreight as any).error)

  state = await product(p2)
  const freightLanded = round((500 + 60) / 12, 4)
  ok(
    '*** freight spreads over paid AND free: (500+60)/12 ***',
    toNum(state.average_cost) === freightLanded,
    `${state.average_cost} vs ${freightLanded}`,
  )
  ok('  twelve on the shelf', toNum(state.stock_on_hand) === 12)

  console.log('\n── Blending into stock that is already there ──')

  // The compounding case. A second receipt at a bonus price must blend against
  // what the first one left, not against the invoice price.
  const second = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [
      {
        productId: p1,
        description: 'Bonus test item',
        qtyReceived: 10,
        qtyBonus: 1,
        unitCostExcl: 100,
        vatRatePct: rate,
      },
    ],
  })
  ok('a second promotional receipt posts', second.ok)
  state = await product(p1)
  ok('  stock is 22', toNum(state.stock_on_hand) === 22, String(state.stock_on_hand))
  ok(
    '*** the average stays at the landed figure, it does not drift up ***',
    Math.abs(toNum(state.average_cost) - expectedLanded) < 0.0002,
    `${state.average_cost} vs ${expectedLanded}`,
  )

  console.log('\n── An order filled partly with free stock ──')

  const p3 = await mk(`B3${stamp}`)
  const order = await saveOrder(SITE, actor, {
    supplierId: sup.id,
    lines: [
      { productId: p3, description: 'Ordered item', qtyOrdered: 100, unitCostExcl: 10, vatRatePct: rate },
    ],
  })
  ok('an order saves', order.ok)
  if (!order.ok) process.exit(1)
  await issueOrder(SITE, actor, order.id)

  const orderDoc = await getPurchaseDocument(SITE, order.id)
  const orderLineId = orderDoc!.lines[0].id

  await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    orderId: order.id,
    lines: [
      {
        orderLineId,
        productId: p3,
        description: 'Ordered item',
        qtyOrdered: 100,
        qtyReceived: 90,
        qtyBonus: 10,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })

  doc = await getPurchaseDocument(SITE, order.id)
  ok(
    '*** 90 paid + 10 free closes only 90 of the order ***',
    toNum(doc?.lines[0]?.qtyReceived) === 90,
    String(doc?.lines[0]?.qtyReceived),
  )
  ok(
    '*** 10 are STILL OUTSTANDING — a freebie does not fill an order ***',
    toNum(doc?.lines[0]?.qtyOutstanding) === 10,
    String(doc?.lines[0]?.qtyOutstanding),
  )
  ok(
    '  and the order is not marked received',
    doc?.fulfilmentStatus === 'part_received',
    String(doc?.fulfilmentStatus),
  )

  state = await product(p3)
  ok('  but 100 units are on the shelf', toNum(state.stock_on_hand) === 100, String(state.stock_on_hand))
  ok('  at 900/100 = 9 each', toNum(state.average_cost) === 9, String(state.average_cost))

  console.log('\n── What may be sent back ──')

  const returnable = await returnableLines(SITE, buy10.documentId)
  ok(
    '*** all 11 are returnable — a free unit can be faulty too ***',
    returnable?.[0]?.returnable === 11,
    String(returnable?.[0]?.returnable),
  )

  console.log('\n── The void ──')

  const p4 = await mk(`B4${stamp}`)
  const toVoid = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [
      {
        productId: p4,
        description: 'Void me',
        qtyReceived: 20,
        qtyBonus: 5,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('a promotional receipt posts', toVoid.ok)
  if (!toVoid.ok) process.exit(1)

  state = await product(p4)
  ok('  25 on the shelf', toNum(state.stock_on_hand) === 25, String(state.stock_on_hand))

  const voided = await voidReceipt(SITE, actor, toVoid.documentId, 'Wrong stock')
  ok('it voids', voided.ok, voided.ok ? '' : (voided as any).error)

  state = await product(p4)
  ok(
    '*** ALL 25 came back out — the free ones are not stranded ***',
    toNum(state.stock_on_hand) === 0,
    `${state.stock_on_hand} (a bonus-blind void would leave 5)`,
  )

  console.log('\n── Serial-tracked, with a free unit ──')

  const ps = (
    await siteExecute(
      SITE,
      `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
       VALUES (?,?,'serial',0,0,0,1)`,
      [`BS${stamp}`, `Bonus serial ${stamp}`],
    )
  ).insertId

  const tooFew = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [
      {
        productId: ps,
        description: 'Bonus serial',
        productType: 'serial',
        qtyReceived: 2,
        qtyBonus: 1,
        unitCostExcl: 500,
        vatRatePct: rate,
        serials: [`SN-${stamp}-A`, `SN-${stamp}-B`],
      },
    ],
  })
  ok(
    '*** 2 paid + 1 free needs THREE serials, not two ***',
    !tooFew.ok,
    tooFew.ok ? 'wrongly accepted' : tooFew.error,
  )

  const serialOk = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [
      {
        productId: ps,
        description: 'Bonus serial',
        productType: 'serial',
        qtyReceived: 2,
        qtyBonus: 1,
        unitCostExcl: 500,
        vatRatePct: rate,
        serials: [`SN-${stamp}-A`, `SN-${stamp}-B`, `SN-${stamp}-C`],
      },
    ],
  })
  ok('three serials is accepted', serialOk.ok, serialOk.ok ? '' : (serialOk as any).error)

  if (serialOk.ok) {
    const units = await siteQueryOne<any>(
      SITE,
      'SELECT COUNT(*) AS n FROM product_serials WHERE product_id=?',
      [ps],
    )
    ok('  three units exist, the free one included', Number(units?.n) === 3, String(units?.n))
    state = await product(ps)
    ok('  costed at 1000/3 each', toNum(state.average_cost) === round(1000 / 3, 4), String(state.average_cost))
  }

  console.log('\n── Edge cases ──')

  const p5 = await mk(`B5${stamp}`)
  const allFree = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [
      {
        productId: p5,
        description: 'Free sample',
        qtyReceived: 1,
        qtyBonus: 9,
        unitCostExcl: 0,
        vatRatePct: rate,
      },
    ],
  })
  ok('a giveaway at zero cost posts', allFree.ok, allFree.ok ? '' : (allFree as any).error)
  if (allFree.ok) {
    state = await product(p5)
    ok('  ten on the shelf', toNum(state.stock_on_hand) === 10, String(state.stock_on_hand))
    ok('  at zero cost, not NaN', toNum(state.average_cost) === 0, String(state.average_cost))
  }

  const p6 = await mk(`B6${stamp}`)
  const noBonus = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [
      { productId: p6, description: 'Plain', qtyReceived: 10, unitCostExcl: 100, vatRatePct: rate },
    ],
  })
  ok('*** a receipt with NO bonus behaves exactly as before ***', noBonus.ok)
  if (noBonus.ok) {
    state = await product(p6)
    ok('  ten on the shelf at 100', toNum(state.stock_on_hand) === 10 && toNum(state.average_cost) === 100)
  }

  console.log('\n── Invariants ──')

  const ids = [p1, p2, p3, p4, p5, p6, ps]
  const drift = (await reconcileStock(SITE)).filter((d) => ids.includes(d.productId))
  ok(
    '*** zero stock drift across every product this run touched ***',
    drift.length === 0,
    JSON.stringify(drift),
  )

  const balances = (await reconcileSupplierBalances(SITE)).filter(
    (b: any) => b.supplierId === sup.id,
  )
  ok('*** zero supplier-balance drift ***', balances.length === 0, JSON.stringify(balances))

  console.log(`\n${fails === 0 ? 'All good.' : `${fails} FAILED`}\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
