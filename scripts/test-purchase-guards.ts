/**
 * The two guards at the moment a receipt is posted.
 *
 * Both exist for the same reason: a GRV is the ONLY act that writes
 * average_cost, and a keying error here is SILENT. It does not throw, nothing
 * reconciles short — it just prices next quarter's GP report wrong, and is
 * found when the supplier queries the payment or a margin looks odd.
 *
 *   1. INVOICE TOTAL. Type what their invoice says; the receipt is refused if
 *      the lines do not tie to it. Catches a transposed 91 for 19, a line keyed
 *      twice, a case cost entered as a unit cost.
 *   2. COST CHANGE. A warning only, computed in the grid, so what is tested
 *      here is the arithmetic it warns on.
 *
 *   npm run test:purchase-guards
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { receiveGoods } from '../src/lib/site/purchasePosting'
import { createSupplier } from '../src/lib/site/suppliers'
import { setSetting, getNumericSetting } from '../src/lib/site/settings'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { toNum, round } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Guard Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
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
    code: `GRD${stamp}`,
    name: 'Guard Test Supply',
    paymentTermsDays: 30,
  })
  if (!sup.ok) {
    console.log('setup failed:', sup.error)
    process.exit(1)
  }

  const mk = async (suffix: string, cost = 10) =>
    (
      await siteExecute(
        SITE,
        `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
         VALUES (?,?,'normal',0,?,?,1)`,
        [`GD${suffix}${stamp}`, `Guard test ${suffix}`, cost, cost],
      )
    ).insertId

  console.log('\n── The setting reads back ──')

  const tolerance = await getNumericSetting(SITE, 'purchase_invoice_tolerance')
  ok('a tolerance is configured', tolerance > 0, String(tolerance))
  const warnPct = await getNumericSetting(SITE, 'purchase_cost_change_warn_pct')
  ok('a cost-change threshold is configured', warnPct > 0, String(warnPct))

  console.log('\n── Invoice total: it ties ──')

  const p1 = await mk('A')
  // 100 at 10 = 1000 excl, plus VAT.
  const exact = round(1000 * (1 + rate / 100), 2)

  const tied = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    supplierInvoiceNo: `TIE-${stamp}`,
    supplierInvoiceTotal: exact,
    lines: [
      {
        productId: p1,
        description: 'Guard test A',
        qtyReceived: 100,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('*** a receipt that ties to their invoice posts ***', tied.ok, tied.ok ? '' : tied.error)

  let state = await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [p1])
  ok('  and the stock moved', toNum(state.stock_on_hand) === 100)

  console.log('\n── Invoice total: it does not tie ──')

  const p2 = await mk('B')
  // The classic: 19 keyed as 91. Lines come to far more than the invoice.
  const transposed = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    supplierInvoiceTotal: exact,
    lines: [
      {
        productId: p2,
        description: 'Guard test B',
        qtyReceived: 910,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok(
    '*** a transposed quantity is REFUSED ***',
    !transposed.ok,
    transposed.ok ? 'POSTED — the guard did nothing' : transposed.error,
  )

  state = await siteQueryOne<any>(SITE, 'SELECT stock_on_hand, average_cost FROM products WHERE id=?', [p2])
  ok(
    '*** and NOTHING moved — refused before any write ***',
    toNum(state.stock_on_hand) === 0 && toNum(state.average_cost) === 10,
    `stock ${state.stock_on_hand}, cost ${state.average_cost}`,
  )

  const short = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    supplierInvoiceTotal: exact,
    lines: [
      {
        productId: p2,
        description: 'Guard test B',
        qtyReceived: 50,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('a receipt UNDER their invoice is refused too', !short.ok, short.ok ? '' : short.error)
  ok(
    '  and the message says which way it is out',
    !short.ok && short.error.includes('less'),
    short.ok ? '' : short.error,
  )

  console.log('\n── Rounding is tolerated, real errors are not ──')

  const p3 = await mk('C')
  const ourFigure = round(1000 * (1 + rate / 100), 2)

  const penny = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    // A cent out, which is their rounding differing from ours — not an error.
    supplierInvoiceTotal: round(ourFigure + 0.01, 2),
    lines: [
      {
        productId: p3,
        description: 'Guard test C',
        qtyReceived: 100,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('*** a cent of rounding difference is accepted ***', penny.ok, penny.ok ? '' : penny.error)

  const p4 = await mk('D')
  const rand = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    supplierInvoiceTotal: round(ourFigure + 5, 2),
    lines: [
      {
        productId: p4,
        description: 'Guard test D',
        qtyReceived: 100,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('*** five rand out is NOT ***', !rand.ok, rand.ok ? 'accepted wrongly' : rand.error)

  console.log('\n── No total given: the check is skipped ──')

  const p5 = await mk('E')
  const noTotal = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [
      {
        productId: p5,
        description: 'Guard test E',
        qtyReceived: 100,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok(
    '*** receiving from a delivery note with no prices still works ***',
    noTotal.ok,
    noTotal.ok ? '' : noTotal.error,
  )

  const nullTotal = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    supplierInvoiceTotal: null,
    lines: [
      {
        productId: p5,
        description: 'Guard test E',
        qtyReceived: 1,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('  an explicit null is the same as omitting it', nullTotal.ok)

  console.log('\n── The total compared is what the GOODS supplier is owed ──')

  const carrier = await createSupplier(SITE, actor, {
    code: `GRC${stamp}`,
    name: 'Guard Test Couriers',
    paymentTermsDays: 30,
  })
  if (!carrier.ok) process.exit(1)

  const p6 = await mk('F')
  // A carrier's R200 is in landed cost but NOT on the goods invoice being
  // checked, so the tie must still hold at the goods figure alone.
  const withCarrier = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    supplierInvoiceTotal: exact,
    charges: [
      { supplierId: carrier.id, description: 'Courier', amountExcl: 200, vatRatePct: rate },
    ],
    lines: [
      {
        productId: p6,
        description: 'Guard test F',
        qtyReceived: 100,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok(
    "*** a carrier's separate invoice does NOT break the tie ***",
    withCarrier.ok,
    withCarrier.ok ? '' : withCarrier.error,
  )

  // But a charge the GOODS supplier billed IS on their invoice.
  const p7 = await mk('G')
  const ownCharge = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    supplierInvoiceTotal: exact,
    charges: [{ description: 'Delivery', amountExcl: 100, vatRatePct: rate }],
    lines: [
      {
        productId: p7,
        description: 'Guard test G',
        qtyReceived: 100,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok(
    '*** but their OWN delivery charge does — 100 more than the invoice ***',
    !ownCharge.ok,
    ownCharge.ok ? 'accepted wrongly' : ownCharge.error,
  )

  console.log('\n── The tolerance is configurable ──')

  const original = await getNumericSetting(SITE, 'purchase_invoice_tolerance')
  await setSetting(SITE, 'purchase_invoice_tolerance', '10.00')

  const p8 = await mk('H')
  const loose = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    supplierInvoiceTotal: round(ourFigure + 5, 2),
    lines: [
      {
        productId: p8,
        description: 'Guard test H',
        qtyReceived: 100,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok(
    '*** five rand passes once the tolerance is ten ***',
    loose.ok,
    loose.ok ? '' : loose.error,
  )

  await setSetting(SITE, 'purchase_invoice_tolerance', String(original))
  ok('  and the setting is put back', (await getNumericSetting(SITE, 'purchase_invoice_tolerance')) === original)

  console.log('\n── Cost-change arithmetic ──')

  // What the grid computes. Kept here as plain arithmetic because the warning
  // is presentational — what matters is that the percentage is right and the
  // edge cases do not divide by zero.
  const shift = (last: number, now: number) =>
    last > 0 && now > 0 ? round(((now - last) / last) * 100, 1) : 0

  ok('*** 10 to 12 is a 20% rise ***', shift(10, 12) === 20, String(shift(10, 12)))
  ok('*** 10 to 8 is a 20% fall ***', shift(10, 8) === -20, String(shift(10, 8)))
  ok('*** 100 keyed as 1000 is +900% ***', shift(100, 1000) === 900, String(shift(100, 1000)))
  ok('a product never bought before does not "change"', shift(0, 50) === 0)
  ok('a zero cost keyed does not divide by zero', shift(10, 0) === 0)
  ok('no movement is no warning', shift(10, 10) === 0)

  // The threshold comparison itself.
  const warns = (last: number, now: number, threshold: number) =>
    threshold > 0 && Math.abs(shift(last, now)) >= threshold

  ok('*** 20% moves at a 20% threshold ***', warns(10, 12, 20))
  ok('  19.9% does not', !warns(10, 11.99, 20))
  ok('*** a FALL warns too — it is still a keying error ***', warns(10, 5, 20))
  ok('*** zero switches the warning off entirely ***', !warns(10, 1000, 0))

  console.log('\n── Invariants ──')

  const ids = [p1, p2, p3, p4, p5, p6, p7, p8]
  const drift = (await reconcileStock(SITE)).filter((d) => ids.includes(d.productId))
  ok('*** zero stock drift ***', drift.length === 0, JSON.stringify(drift))

  console.log(`\n${fails === 0 ? 'All good.' : `${fails} FAILED`}\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
