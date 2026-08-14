/**
 * Stock intelligence — true aging, ABC classes, turn and sell-through.
 *
 * THE ARITHMETIC THIS EXISTS TO PROVE is the newest-first peel: a pile of 10
 * against arrivals of [6 fresh, 8 a year old] is 6 fresh units and 4 stale
 * ones, because FIFO says the old stock is what already left. A report that
 * averaged the two dates would hide a dead layer under one fresh delivery,
 * and that hiding is exactly what the aging report is bought to prevent.
 *
 * The pure functions are proved with no database at all; the site queries are
 * then proved once against seeded movements, including that a product which
 * sold ONE unit yesterday still shows its old pile in the stale bands (the
 * thing the report-builder ageBand proxy cannot see).
 *
 *   npm run test:stock-intel
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  ageLayers,
  bandFor,
  classifyAbc,
  daysOfStock,
  sellThrough,
  stockTurn,
} from '../src/lib/stockIntel'
import { stockAgeReport, abcReport, stockTurnReport, sellThroughReport } from '../src/lib/site/stockIntelligence'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const CODE_PATTERN = '^ZSI[0-9]{8}'
const DEPT_NAME = 'ZSI intel dept'

async function sweepStrays() {
  const products = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  await siteExecute(SITE, `DELETE FROM departments WHERE name = '${DEPT_NAME}'`)
}

async function main() {
  /* ── 1. The peel, pure ───────────────────────────────────────────────── */

  const layers = ageLayers(
    10,
    [
      { date: '2026-08-10', qty: 6, unitCost: 12 },
      { date: '2025-08-01', qty: 8, unitCost: 10 },
    ],
    '2026-08-14',
  )
  ok('*** a pile of 10 against [6 fresh, 8 old] peels into 6 + 4 ***',
    layers.length === 2 && layers[0].qty === 6 && layers[1].qty === 4,
    JSON.stringify(layers.map((l) => l.qty)))
  ok('  the fresh layer is days old, the stale one is a year old',
    layers[0].days === 4 && layers[1].days !== null && layers[1].days > 360,
    `days=[${layers[0].days}, ${layers[1].days}]`)
  ok('  each layer keeps the cost it arrived at',
    layers[0].unitCost === 12 && layers[1].unitCost === 10)

  const overflow = ageLayers(12, [{ date: '2026-08-10', qty: 5, unitCost: 7 }], '2026-08-14')
  ok('*** stock beyond every arrival lands in an UNKNOWN layer, not dropped ***',
    overflow.length === 2 && overflow[1].qty === 7 && overflow[1].days === null,
    JSON.stringify(overflow))
  ok('  an empty history is one whole unknown layer',
    ageLayers(3, [], '2026-08-14').every((l) => l.days === null))
  ok('  zero on hand peels into nothing', ageLayers(0, [{ date: '2026-08-10', qty: 5, unitCost: 7 }], '2026-08-14').length === 0)

  ok('band edges: day 30 is the first band, day 31 the second',
    bandFor(30) === 'b30' && bandFor(31) === 'b60')
  ok('  day 365 is within the year, 366 is over it',
    bandFor(365) === 'b365' && bandFor(366) === 'older')
  ok('  an unknowable age is its own band', bandFor(null) === 'unknown')

  /* ── 2. ABC, pure ────────────────────────────────────────────────────── */

  // 50 + 30 = 80% exactly → both A. 15 → B (95% edge). 4 and 1 → C.
  const classes = classifyAbc([
    { id: 'p1', value: 50 },
    { id: 'p2', value: 30 },
    { id: 'p3', value: 15 },
    { id: 'p4', value: 4 },
    { id: 'p5', value: 1 },
  ])
  ok('*** the 80/95 cut lands A A B C C on a 50/30/15/4/1 file ***',
    classes.get('p1') === 'A' && classes.get('p2') === 'A' &&
      classes.get('p3') === 'B' && classes.get('p4') === 'C' && classes.get('p5') === 'C',
    ['p1', 'p2', 'p3', 'p4', 'p5'].map((p) => classes.get(p)).join(''))
  ok('  a single product that IS the whole file is still A',
    classifyAbc([{ id: 'only', value: 100 }]).get('only') === 'A')
  ok('  zero value is C outright, wherever the line was',
    classifyAbc([{ id: 'a', value: 10 }, { id: 'z', value: 0 }]).get('z') === 'C')

  /* ── 3. Turn and sell-through, pure ──────────────────────────────────── */

  ok('*** R900 sold in 90 days against R300 held turns 12.2 times a year ***',
    Math.abs((stockTurn(900, 300, 90) ?? 0) - 900 * (365 / 90) / 300) < 0.001,
    String(stockTurn(900, 300, 90)))
  ok('  an empty shelf has no turn, not an infinite one', stockTurn(900, 0, 90) === null)
  ok('  days of stock inverts it: R300 held at R10/day is 30 days',
    Math.abs((daysOfStock(900, 300, 90) ?? 0) - 30) < 0.001)
  ok('  nothing sold means the shelf lasts forever — null, not a division',
    daysOfStock(0, 300, 90) === null)
  ok('sell-through of 30 sold with 70 left is 30%',
    Math.abs((sellThrough(30, 70) ?? 0) - 0.3) < 0.0001)
  ok('  nothing available is null, not zero', sellThrough(0, 0) === null)

  /* ── 4. The site queries, against seeded movements ───────────────────── */

  await sweepStrays()
  const stamp = Date.now().toString().slice(-8)
  const dept = await siteExecute(SITE, 'INSERT INTO departments (name) VALUES (?)', [DEPT_NAME])
  const deptId = dept.insertId

  const locRow = await siteQueryOne<any>(SITE, 'SELECT id FROM stock_locations WHERE is_main = 1 ORDER BY id LIMIT 1')
  const locId = Number(locRow?.id ?? 1)

  const makeProduct = async (suffix: string, onHand: number, avgCost: number) => {
    const r = await siteExecute(SITE,
      `INSERT INTO products (code, description, product_type, department_id, stock_on_hand,
                             average_cost, last_cost)
       VALUES (?,?,'normal',?,?,?,?)`,
      [`ZSI${stamp}${suffix}`, `Intel ${suffix}`, deptId, onHand, avgCost, avgCost])
    await siteExecute(SITE,
      'INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) VALUES (?,?,?)',
      [r.insertId, locId, onHand])
    return r.insertId as number
  }

  const movement = async (
    productId: number, type: string, qty: number, cost: number, daysAgo: number,
  ) => {
    await siteExecute(SITE,
      `INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after,
                                    unit_cost_excl, source, user_id, user_name, created_at)
       VALUES (?,?,?,?,0,?,'test',1,'Stock Intel Test', NOW() - INTERVAL ? DAY)`,
      [productId, locId, type, qty, cost, daysAgo])
  }

  // The headline case: 10 on hand — 8 received ten months ago at R10, 6
  // received a week ago at R12, 4 of the old batch sold. One unit sold
  // YESTERDAY, so the last_sold_date proxy calls the whole product fresh.
  const layered = await makeProduct('A', 10, 11)
  await movement(layered, 'receipt', 8, 10, 300)
  await movement(layered, 'sale', -3, 10, 200)
  await movement(layered, 'receipt', 6, 12, 7)
  await movement(layered, 'sale', -1, 10, 1)

  // A clean seller for ABC/turn: high consumption, small pile.
  const runner = await makeProduct('B', 5, 20)
  await movement(runner, 'receipt', 45, 20, 30)
  await movement(runner, 'sale', -40, 20, 10)

  // Scoped to the fixture department: the shared dev database has thousands
  // of real products, and the site-wide top-200 stale list would truncate a
  // R40 fixture straight out of the assertion.
  const age = await stockAgeReport(SITE, { departmentId: deptId })
  const b30 = age.bands.find((b) => b.key === 'b30')
  const b365 = age.bands.find((b) => b.key === 'b365')
  const staleLine = age.stale.find((s) => s.productId === layered)
  ok('*** the layered product shows 6 fresh units and 4 in the year-old band ***',
    staleLine !== undefined && staleLine.staleQty === 4,
    `staleQty=${staleLine?.staleQty}`)
  ok('  despite having SOLD yesterday — the proxy would call it fresh',
    staleLine !== undefined)
  ok('  valued at the OLD layer cost: 4 × R10, not 4 × average',
    staleLine !== undefined && Math.abs(staleLine.staleValue - 40) < 0.005,
    `staleValue=${staleLine?.staleValue}`)
  // Exact now that the report is scoped to the fixture department: 6 fresh
  // layered units plus the runner's 5 (peeled from its 30-day receipt) = 11.
  ok('  the fresh band holds exactly the 11 new units', b30?.qty === 11, `b30=${b30?.qty}`)
  ok('  and the 181–365 band exactly the 4 ten-month-old ones', b365?.qty === 4, `b365=${b365?.qty}`)

  const abc = await abcReport(SITE, 90, { departmentId: deptId })
  const runnerRow = abc.rows.find((r) => r.productId === runner)
  const layeredRow = abc.rows.find((r) => r.productId === layered)
  ok('*** ABC ranks the runner (R800 consumed) above the layered product (R10) ***',
    runnerRow !== undefined && layeredRow !== undefined && runnerRow.value > layeredRow.value,
    `runner=${runnerRow?.value} layered=${layeredRow?.value}`)
  ok('  consumption is at cost: 40 × R20', Math.abs((runnerRow?.value ?? 0) - 800) < 0.005)
  ok('  the year-old sale stays outside the 90-day window',
    Math.abs((layeredRow?.value ?? 0) - 10) < 0.005, `value=${layeredRow?.value}`)

  const turn = await stockTurnReport(SITE, 90)
  const deptTurn = turn.rows.find((r) => r.department === DEPT_NAME)
  // COGS in window: runner 40×20=800, layered 1×10=10. Value: 10×11 + 5×20 = 210.
  ok('*** department turn is annualised COGS over current value ***',
    deptTurn !== undefined && Math.abs((deptTurn.turn ?? 0) - (810 * (365 / 90)) / 210) < 0.01,
    `turn=${deptTurn?.turn}`)

  const sell = await sellThroughReport(SITE, 90)
  const deptSell = sell.rows.find((r) => r.department === DEPT_NAME)
  // In window: sold 41, received 51, on hand 15 → 41/(41+15).
  ok('*** sell-through is sold over sold-plus-on-hand ***',
    deptSell !== undefined && Math.abs((deptSell.sellThroughPct ?? 0) - (41 / 56) * 100) < 0.01,
    `pct=${deptSell?.sellThroughPct}`)
  ok('  received in the window counts only the windowed receipts',
    deptSell?.unitsReceived === 51, `received=${deptSell?.unitsReceived}`)

  /* ── Clean up ────────────────────────────────────────────────────────── */

  await sweepStrays()
  const leftovers = await siteQuery<any>(
    SITE, `SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  ok('the run leaves nothing behind', leftovers.length === 0)

  console.log(fails === 0 ? '\nAll stock intelligence checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
