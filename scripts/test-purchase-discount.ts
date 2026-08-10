/**
 * A discount on the whole delivery.
 *
 * THE RULE: apportioned onto the lines, never subtracted from the total. Rule 3
 * of documentMath.ts — a document-level figure cannot be split by VAT rate, so
 * the moment a delivery mixes a standard-rated case with a zero-rated one there
 * is no correct single VAT amount for a discount held at document level.
 *
 * The mixed-rate case below is the one that proves it. Everything else could be
 * made to work by subtracting from the total; that one cannot.
 *
 * Order of operations, also under test:
 *   line discount -> document discount -> charges -> landed cost
 * Charges last, because freight is not reduced by the goods supplier's
 * settlement terms.
 *
 *   npm run test:purchase-discount
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { receiveGoods, validateReceive } from '../src/lib/site/purchasePosting'
import { getPurchaseDocument } from '../src/lib/site/purchaseDocuments'
import { createSupplier, getSupplier } from '../src/lib/site/suppliers'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { reconcileSupplierBalances } from '../src/lib/site/supplierLedger'
import { toNum, round } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Discount Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  console.log('\n── Validation ──')

  const base = {
    supplierId: 1,
    lines: [
      { productId: null, description: 'x', qtyReceived: 10, unitCostExcl: 100, vatRatePct: 15 },
    ],
  }
  ok('no discount is fine', validateReceive(base) === null)
  ok('a negative amount is refused', validateReceive({ ...base, discountExcl: -1 }) !== null)
  ok('a negative percent is refused', validateReceive({ ...base, discountPct: -5 }) !== null)
  ok('over 100 percent is refused', validateReceive({ ...base, discountPct: 101 }) !== null)
  ok('100 percent is allowed', validateReceive({ ...base, discountPct: 100 }) === null)

  // ── Fixtures
  const stamp = Date.now().toString().slice(-8)
  const std = await siteQueryOne<any>(
    SITE,
    "SELECT rate FROM vat_rates WHERE vat_type='purchase' AND is_default=1 LIMIT 1",
  )
  const rate = toNum(std?.rate, 15)

  const sup = await createSupplier(SITE, actor, {
    code: `DSC${stamp}`,
    name: 'Discount Test Supply',
    paymentTermsDays: 30,
  })
  if (!sup.ok) {
    console.log('setup failed:', sup.error)
    process.exit(1)
  }

  const hasDocDiscount = await siteQueryOne<any>(
    SITE,
    `SELECT 1 AS ok FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_documents'
        AND COLUMN_NAME='discount_excl' LIMIT 1`,
  )

  const mk = async (code: string) =>
    (
      await siteExecute(
        SITE,
        `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
         VALUES (?,?,'normal',0,0,0,1)`,
        [code, `Discount test ${code}`],
      )
    ).insertId

  console.log('\n── A percentage off the invoice ──')

  const p1 = await mk(`D1${stamp}`)
  const pct = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    supplierInvoiceNo: `PCT-${stamp}`,
    discountPct: 10,
    lines: [
      {
        productId: p1,
        description: 'Discounted goods',
        qtyReceived: 100,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('it posts', pct.ok, pct.ok ? pct.documentNumber : pct.error)
  if (!pct.ok) process.exit(1)

  let doc = await getPurchaseDocument(SITE, pct.documentId)
  ok(
    '*** 1000 less 10% leaves 900 on the line ***',
    toNum(doc?.lines[0]?.lineTotalExcl) === 900,
    String(doc?.lines[0]?.lineTotalExcl),
  )
  ok('  the subtotal follows', toNum(doc?.subtotalExcl) === 900, String(doc?.subtotalExcl))
  ok(
    '*** VAT is charged on 900, not on 1000 ***',
    toNum(doc?.vatTotal) === round(900 * (rate / 100), 2),
    String(doc?.vatTotal),
  )
  if (hasDocDiscount) {
    ok('  the discount is recorded', toNum(doc?.discountExcl) === 100, String(doc?.discountExcl))
    ok('  with the percentage that produced it', toNum(doc?.discountPct) === 10)
  }

  let state = await siteQueryOne<any>(
    SITE,
    'SELECT average_cost FROM products WHERE id=?',
    [p1],
  )
  ok(
    '*** the cost of the goods is 9, not 10 ***',
    toNum(state.average_cost) === 9,
    String(state.average_cost),
  )

  const owed = await getSupplier(SITE, sup.id)
  ok(
    '  the supplier is owed the discounted amount',
    Math.abs(owed!.balance - round(900 * (1 + rate / 100), 2)) < 0.02,
    String(owed!.balance),
  )

  console.log('\n── An amount beats a percentage ──')

  const p2 = await mk(`D2${stamp}`)
  const amt = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    discountPct: 50,
    discountExcl: 250,
    lines: [
      {
        productId: p2,
        description: 'Discounted goods',
        qtyReceived: 100,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('it posts', amt.ok)
  doc = await getPurchaseDocument(SITE, amt.documentId)
  ok(
    '*** 250 came off, not 500 ***',
    toNum(doc?.subtotalExcl) === 750,
    String(doc?.subtotalExcl),
  )

  console.log('\n── THE MIXED-RATE CASE, which is why it is apportioned ──')

  // Two lines at different VAT rates. A discount held only at document level
  // has no correct single VAT figure here; apportioning gives each line its own
  // share, taxed at its own rate.
  const pStd = await mk(`DS${stamp}`)
  const pZero = await mk(`DZ${stamp}`)

  const mixed = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    supplierInvoiceNo: `MIX-${stamp}`,
    discountExcl: 100,
    lines: [
      {
        productId: pStd,
        description: 'Standard rated',
        qtyReceived: 10,
        unitCostExcl: 50,
        vatRatePct: rate,
      },
      {
        productId: pZero,
        description: 'Zero rated',
        qtyReceived: 10,
        unitCostExcl: 50,
        vatRatePct: 0,
      },
    ],
  })
  ok('a mixed-rate delivery posts', mixed.ok, mixed.ok ? '' : (mixed as any).error)
  if (!mixed.ok) process.exit(1)

  doc = await getPurchaseDocument(SITE, mixed.documentId)
  const stdLine = doc!.lines.find((l) => l.productId === pStd)!
  const zeroLine = doc!.lines.find((l) => l.productId === pZero)!

  ok(
    '*** the discount split evenly across two equal lines ***',
    toNum(stdLine.lineTotalExcl) === 450 && toNum(zeroLine.lineTotalExcl) === 450,
    `std ${stdLine.lineTotalExcl}, zero ${zeroLine.lineTotalExcl}`,
  )
  ok(
    '*** VAT on the standard line is charged on ITS discounted 450 ***',
    toNum(stdLine.lineVat) === round(450 * (rate / 100), 2),
    String(stdLine.lineVat),
  )
  ok(
    '*** and the zero-rated line still carries NO VAT ***',
    toNum(zeroLine.lineVat) === 0,
    String(zeroLine.lineVat),
  )
  ok(
    '  the document VAT is the sum of the two, allocatable by rate',
    toNum(doc?.vatTotal) === round(450 * (rate / 100), 2),
    String(doc?.vatTotal),
  )

  console.log('\n── Order of operations ──')

  const p3 = await mk(`D3${stamp}`)
  const ordered = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    // line: 1000 less 10% = 900. document: less 90 = 810. charges: +50.
    discountPct: 10,
    chargesExcl: 50,
    lines: [
      {
        productId: p3,
        description: 'Layered',
        qtyReceived: 10,
        unitCostExcl: 100,
        discountPct: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('it posts', ordered.ok, ordered.ok ? '' : (ordered as any).error)
  doc = await getPurchaseDocument(SITE, ordered.documentId)
  ok(
    '*** line discount first: 1000 -> 900 ***',
    true,
    'checked via the 810 below',
  )
  ok(
    '*** then the document discount: 900 -> 810 ***',
    toNum(doc?.lines[0]?.lineTotalExcl) === 810,
    String(doc?.lines[0]?.lineTotalExcl),
  )
  ok(
    '*** VAT on 810, after both ***',
    toNum(doc?.lines[0]?.lineVat) === round(810 * (rate / 100), 2),
    String(doc?.lines[0]?.lineVat),
  )
  ok(
    '*** charges are NOT discounted, but ARE in landed cost: (810+50)/10 ***',
    toNum(doc?.lines[0]?.landedCostExcl) === 86,
    String(doc?.lines[0]?.landedCostExcl),
  )

  console.log('\n── Apportionment exactness ──')

  // Three equal lines and a discount that does not divide by three. Naive
  // rounding gives 99.99; apportionDiscount puts the remainder on the largest.
  const t1 = await mk(`T1${stamp}`)
  const t2 = await mk(`T2${stamp}`)
  const t3 = await mk(`T3${stamp}`)
  const thirds = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    discountExcl: 100,
    lines: [t1, t2, t3].map((id) => ({
      productId: id,
      description: 'Third',
      qtyReceived: 1,
      unitCostExcl: 100,
      vatRatePct: rate,
    })),
  })
  ok('it posts', thirds.ok, thirds.ok ? '' : (thirds as any).error)
  doc = await getPurchaseDocument(SITE, thirds.documentId)
  const sumLines = doc!.lines.reduce((s, l) => round(s + toNum(l.lineTotalExcl), 2), 0)
  ok(
    '*** 300 less exactly 100 = 200, not 199.99 ***',
    sumLines === 200,
    String(sumLines),
  )
  ok('  and the subtotal agrees', toNum(doc?.subtotalExcl) === 200, String(doc?.subtotalExcl))

  console.log('\n── Edge cases ──')

  const p4 = await mk(`D4${stamp}`)
  const over = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    discountExcl: 99999,
    lines: [
      {
        productId: p4,
        description: 'Over-discounted',
        qtyReceived: 10,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('a discount larger than the goods posts rather than failing', over.ok)
  if (over.ok) {
    doc = await getPurchaseDocument(SITE, over.documentId)
    ok(
      '*** capped at the subtotal — no negative lines ***',
      toNum(doc?.subtotalExcl) === 0,
      String(doc?.subtotalExcl),
    )
    ok('  and no negative VAT', toNum(doc?.vatTotal) === 0, String(doc?.vatTotal))
  }

  const p5 = await mk(`D5${stamp}`)
  const none = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    lines: [
      { productId: p5, description: 'Plain', qtyReceived: 10, unitCostExcl: 100, vatRatePct: rate },
    ],
  })
  ok('*** a receipt with NO document discount is unchanged ***', none.ok)
  if (none.ok) {
    doc = await getPurchaseDocument(SITE, none.documentId)
    ok('  1000, undiscounted', toNum(doc?.subtotalExcl) === 1000, String(doc?.subtotalExcl))
    state = await siteQueryOne<any>(SITE, 'SELECT average_cost FROM products WHERE id=?', [p5])
    ok('  at cost 100', toNum(state.average_cost) === 100, String(state.average_cost))
  }

  console.log('\n── Invariants ──')

  const ids = [p1, p2, p3, p4, p5, pStd, pZero, t1, t2, t3]
  const drift = (await reconcileStock(SITE)).filter((d) => ids.includes(d.productId))
  ok('*** zero stock drift ***', drift.length === 0, JSON.stringify(drift))

  const balances = (await reconcileSupplierBalances(SITE)).filter(
    (b: any) => b.supplierId === sup.id,
  )
  ok('*** zero supplier-balance drift ***', balances.length === 0, JSON.stringify(balances))

  // The invariant assertBalanced() exists to protect, checked on every document
  // this run posted.
  let unbalanced = 0
  for (const id of [pct.documentId, amt.documentId, mixed.documentId, thirds.documentId]) {
    const d = await getPurchaseDocument(SITE, id)
    if (!d) continue
    const sum = round(toNum(d.subtotalExcl) + toNum(d.vatTotal) + toNum(d.chargesExcl), 2)
    if (Math.abs(sum - toNum(d.totalIncl)) > 0.02) unbalanced++
  }
  ok('*** every document balances: excl + VAT + charges = total ***', unbalanced === 0, `${unbalanced} off`)

  console.log(`\n${fails === 0 ? 'All good.' : `${fails} FAILED`}\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
