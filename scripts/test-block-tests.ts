/**
 * Block tests — what a carcass actually cost, cut by cut (236).
 *
 * THE PROPERTY THIS EXISTS TO PROVE: value cannot leak. A carcass broken down
 * is worth exactly what it was worth whole, so Σ(allocated) must equal the
 * input cost — and where it deliberately does not, the shortfall must be
 * VISIBLE as variance rather than quietly gone.
 *
 * The cases a butchery pays for:
 *   - the published RPO example reconciles, and only under markup
 *   - normalising sums to the parent EXACTLY, to the cent, over many lines
 *   - no cut ever takes a negative cost
 *   - bone consumes weight and takes no value, so the yield tells the truth
 *   - a document that cannot be divided is refused rather than costing NaN
 *
 *   npm run test:block-tests
 */
import {
  allocateBlockTest,
  validateBlockTest,
  priceFromFactor,
  type BlockTestOutput,
} from '../src/lib/blockTestMath'
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'
import { postBlockTest, getBlockTest } from '../src/lib/site/blockTests'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { verifySequence } from '../src/lib/site/sequences'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Block Test' }
const CODE_PATTERN = '^ZBT[A-Z]?[0-9]{8}'

/**
 * Anything a previous run left, swept BEFORE this one as well as after.
 *
 * ⚠ The SEQUENCE has to be put back too, and that is not tidiness. Deleting a
 * posted block test while its number stays issued leaves a number with no
 * document — which is precisely what `verifySequence` reports as MISSING, the
 * one figure it exists to prove is zero. The next run then fails on the
 * previous run's litter, in an assertion that has nothing to do with what
 * broke. `restoreSequence` is snapshot-and-put-back, the same shape
 * test-batches uses.
 */
async function sweepStrays() {
  const where = "(SELECT id FROM products WHERE code REGEXP '" + CODE_PATTERN + "')"
  await siteExecute(SITE, 'DELETE btl FROM block_test_lines btl JOIN block_tests bt ON bt.id = btl.block_test_id WHERE bt.input_product_id IN ' + where)
  await siteExecute(SITE, 'DELETE FROM block_tests WHERE input_product_id IN ' + where)
  await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id IN ' + where)
  await siteExecute(SITE, 'DELETE FROM product_location_stock WHERE product_id IN ' + where)
  await siteExecute(SITE, "DELETE FROM products WHERE code REGEXP '" + CODE_PATTERN + "'")
}

async function snapshotSequence() {
  return siteQueryOne<any>(
    SITE,
    "SELECT next_number, last_issued_number FROM document_sequences WHERE terminal_id = 0 AND doc_type = 'block_test'",
  )
}

async function restoreSequence(snap: any) {
  if (!snap) return
  await siteExecute(
    SITE,
    "UPDATE document_sequences SET next_number = ?, last_issued_number = ? WHERE terminal_id = 0 AND doc_type = 'block_test'",
    [snap.next_number, snap.last_issued_number],
  )
}
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** The RPO's beef factors, for a realistic spread. */
const BEEF = {
  fillet: 2.38,
  rump: 1.62,
  sirloin: 1.45,
  chuck: 1.05,
  shortRib: 0.973,
  mince: 0.92,
}

async function main() {
  /* ── 1. The published example, and the reading it rules out ───────────── */

  const published = priceFromFactor({
    carcassCostExcl: 98.31,
    costFactor: 1.283,
    marginPct: 0.44,
    vatRatePct: 0.15,
  })
  ok(
    '*** the RPO worked example reconciles — margin is a MARKUP ***',
    Math.abs(published - 208.8) < 0.1,
    `${published} vs published 208.80`,
  )

  // The same inputs read as a GP divisor, to show how far off it lands.
  const asDivisor = (98.31 * 1.283) / (1 - 0.44) * 1.15
  ok(
    '  and reading margin as a GP divisor is wrong by ~24%',
    Math.abs(asDivisor - 208.8) > 40,
    `divisor gives ${asDivisor.toFixed(2)}`,
  )

  /* ── 2. Value cannot leak ─────────────────────────────────────────────── */

  const side: BlockTestOutput[] = [
    { qty: 3.2, costFactor: BEEF.fillet },
    { qty: 8.6, costFactor: BEEF.rump },
    { qty: 7.1, costFactor: BEEF.sirloin },
    { qty: 14.4, costFactor: BEEF.chuck },
    { qty: 9.3, costFactor: BEEF.shortRib },
    { qty: 12.7, costFactor: BEEF.mince },
    // Bone and drip: weight out, no factor, no stock.
    { qty: 18.4, costFactor: 0, isLoss: true },
  ]
  const normalised = allocateBlockTest({
    inputQty: 73.7,
    inputUnitCostExcl: 83.45,
    outputs: side,
    normalise: true,
  })

  ok(
    '*** normalising sums to the parent EXACTLY ***',
    normalised.outputCost === normalised.inputCost,
    `${normalised.outputCost} vs ${normalised.inputCost}`,
  )
  ok(
    '  so there is no variance to account for',
    normalised.varianceCost === 0,
    String(normalised.varianceCost),
  )
  ok(
    '*** no cut takes a negative cost ***',
    normalised.lines.every((l) => l.allocatedCostExcl >= 0),
    normalised.lines.map((l) => l.allocatedCostExcl).join(', '),
  )
  ok(
    '*** bone takes no value at all ***',
    normalised.lines[6]!.allocatedCostExcl === 0,
    String(normalised.lines[6]!.allocatedCostExcl),
  )
  ok(
    '  but bone still counts against the yield',
    normalised.yieldPct > 70 && normalised.yieldPct < 80,
    `${normalised.yieldPct}% of 73.7kg`,
  )
  ok(
    '  and the weight out balances the weight in',
    Math.abs(normalised.totalQtyOut - 73.7) < 0.05,
    `${normalised.totalQtyOut} vs 73.7`,
  )

  /*
   * The whole reason factors need normalising: read faithfully, they
   * under-recover, because bone and drip carry none. A published test table
   * recovered R3,992 of a R6,150 side — losing that silently is the failure
   * this feature exists to prevent.
   */
  const raw = allocateBlockTest({
    inputQty: 73.7,
    inputUnitCostExcl: 83.45,
    outputs: side,
    normalise: false,
  })
  ok(
    '*** UNNORMALISED under-recovers — the factors do not self-balance ***',
    raw.outputCost < raw.inputCost && raw.outputCost > 0,
    `recovered ${raw.outputCost} of ${raw.inputCost}`,
  )
  ok(
    '  and the shortfall is VISIBLE as variance, not lost',
    raw.varianceCost > 0 &&
      Math.abs(raw.inputCost - raw.outputCost - raw.varianceCost) < 0.01,
    `variance ${raw.varianceCost}`,
  )
  ok(
    '*** so the two methods genuinely differ — normalise is not a no-op ***',
    raw.outputCost !== normalised.outputCost,
    `raw ${raw.outputCost} vs normalised ${normalised.outputCost}`,
  )
  ok(
    '  unnormalised reads the factor LITERALLY: fillet at 2.38× the carcass rate',
    Math.abs(raw.lines[0]!.unitCostExcl - 83.45 * BEEF.fillet) < 0.01,
    `${raw.lines[0]!.unitCostExcl} vs ${(83.45 * BEEF.fillet).toFixed(4)}`,
  )

  /* ── 3. The fillet costs more per kilo than the mince ─────────────────── */

  const fillet = normalised.lines[0]!.unitCostExcl
  const mince = normalised.lines[5]!.unitCostExcl
  ok(
    '*** the point of the whole exercise: fillet costs more per kilo than mince ***',
    fillet > mince * 2,
    `fillet R${fillet}/kg vs mince R${mince}/kg`,
  )
  ok(
    '  and the ratio tracks the FACTORS, not the weights',
    Math.abs(fillet / mince - BEEF.fillet / BEEF.mince) < 0.01,
    `${(fillet / mince).toFixed(3)} vs ${(BEEF.fillet / BEEF.mince).toFixed(3)}`,
  )

  /* ── 4. Rounding drift has nowhere to hide ────────────────────────────── */

  // Twenty lines and an awkward cost, to force fourth-decimal drift.
  const many: BlockTestOutput[] = Array.from({ length: 20 }, (_, i) => ({
    qty: 1.111 + i * 0.037,
    costFactor: 0.83 + i * 0.061,
  }))
  const drifty = allocateBlockTest({
    inputQty: 40,
    inputUnitCostExcl: 77.77,
    outputs: many,
    normalise: true,
  })
  ok(
    '*** twenty lines and an awkward cost still sum EXACTLY ***',
    drifty.outputCost === drifty.inputCost,
    `${drifty.outputCost} vs ${drifty.inputCost}`,
  )

  /* ── 5. What must be refused ──────────────────────────────────────────── */

  const bad = (label: string, input: Parameters<typeof validateBlockTest>[0]) => {
    const err = validateBlockTest(input)
    ok(label, err !== null, err ?? 'ACCEPTED — it should not have been')
  }

  bad('no input weight is refused', {
    inputQty: 0,
    inputUnitCostExcl: 80,
    outputs: [{ qty: 5, costFactor: 1 }],
    normalise: true,
  })
  bad('*** a NEGATIVE factor is refused, not clamped ***', {
    inputQty: 10,
    inputUnitCostExcl: 80,
    outputs: [
      { qty: 5, costFactor: 2 },
      { qty: 5, costFactor: -1 },
    ],
    normalise: true,
  })
  bad('*** every line being loss or excluded is refused ***', {
    inputQty: 10,
    inputUnitCostExcl: 80,
    outputs: [
      { qty: 5, costFactor: 0, isLoss: true },
      { qty: 5, costFactor: 1, excludeFromApportionment: true },
    ],
    normalise: true,
  })
  bad('*** all-zero factors are refused — that is a divide by zero ***', {
    inputQty: 10,
    inputUnitCostExcl: 80,
    outputs: [
      { qty: 5, costFactor: 0 },
      { qty: 5, costFactor: 0 },
    ],
    normalise: true,
  })
  ok(
    'a legitimate document passes',
    validateBlockTest({
      inputQty: 73.7,
      inputUnitCostExcl: 83.45,
      outputs: side,
      normalise: true,
    }) === null,
  )

  /*
   * The undivideable case must still RETURN, not throw — a live panel
   * recalculates on every keystroke and passes through half-typed states
   * constantly. Zeros are readable; NaN posts as 0.0000 and reads as a free
   * carcass.
   */
  const empty = allocateBlockTest({
    inputQty: 10,
    inputUnitCostExcl: 80,
    outputs: [{ qty: 5, costFactor: 0 }],
    normalise: true,
  })
  ok(
    '*** an undivideable document gives ZEROS, never NaN ***',
    empty.lines.every((l) => Number.isFinite(l.allocatedCostExcl)) &&
      empty.lines.every((l) => l.allocatedCostExcl === 0),
    JSON.stringify(empty.lines),
  )
  ok(
    '  and its whole cost shows as variance rather than vanishing',
    empty.varianceCost === empty.inputCost,
    `${empty.varianceCost} of ${empty.inputCost}`,
  )

  /* ── 6. The schema is registered where numbering can see it ───────────── */

  const seq = await siteQuery<any>(
    SITE,
    "SELECT prefix, padding FROM document_sequences WHERE doc_type = 'block_test' AND terminal_id = 0",
  )
  ok('the block_test sequence exists', seq.length === 1, JSON.stringify(seq[0] ?? null))

  const status = await siteQuery<any>(SITE, "SHOW COLUMNS FROM block_tests LIKE 'status'")
  ok(
    "*** block_tests.status carries 'cancelled' — verifySequence hard-codes it ***",
    String(status[0]?.Type ?? '').includes("'cancelled'"),
    String(status[0]?.Type),
  )

  const check = await verifySequence(SITE, 'block_test')
  ok(
    '*** and verifySequence finds its OWN table, not sales_documents ***',
    check.missing === 0,
    `missing=${check.missing} issued=${check.issued}`,
  )

  /* ── 7. Posting: the carcass out, the cuts in ─────────────────────────── */

  await sweepStrays()
  const seqBefore = await snapshotSequence()
  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(
    SITE,
    "SELECT id FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )

  const driftBefore = (await reconcileStock(SITE)).length

  const mk = async (code: string, desc: string, stock: number, cost: number) => {
    const res = await siteExecute(
      SITE,
      `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id)
       VALUES (?,?,'normal',?,?,?,?)`,
      [code, desc, stock, cost, cost, vat?.id ?? null],
    )
    const id = (res as any).insertId as number
    if (stock !== 0) {
      await siteExecute(
        SITE,
        "INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_id, user_name) VALUES (?,(SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1),'opening',?,?,?,'opening',1,'Block Test')",
        [id, stock, stock, cost],
      )
      await siteExecute(
        SITE,
        'INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) SELECT id,(SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1),stock_on_hand FROM products WHERE id=? ON DUPLICATE KEY UPDATE stock_on_hand=VALUES(stock_on_hand)',
        [id],
      )
    }
    return id
  }

  // A hindquarter at R83.45/kg, and the cuts that come off it.
  const carcass = await mk(`ZBT${stamp}`, `Hindquarter ${stamp}`, 73.7, 83.45)
  const filletId = await mk(`ZBTF${stamp}`, `Fillet ${stamp}`, 0, 0)
  // Mince already has stock at a DIFFERENT cost, so the blend has something to
  // weigh against rather than trivially taking the new figure.
  const minceId = await mk(`ZBTM${stamp}`, `Mince ${stamp}`, 10, 60)

  const posted = await postBlockTest(SITE, actor, {
    documentDate: new Date().toISOString().slice(0, 10),
    species: 'beef',
    carcassNo: `CN${stamp}`,
    inputProductId: carcass,
    inputQty: 73.7,
    lines: [
      { productId: filletId, description: `Fillet ${stamp}`, qty: 3.2, costFactor: BEEF.fillet },
      { productId: minceId, description: `Mince ${stamp}`, qty: 51.9, costFactor: BEEF.mince },
      { productId: null, description: 'Bone and drip', qty: 18.6, costFactor: 0, isLoss: true },
    ],
  })
  ok('*** a block test posts ***', posted.ok, posted.ok ? posted.documentNumber : posted.error)
  if (!posted.ok) {
    console.log(`\n${++fails} FAILURE(S)`)
    process.exit(1)
  }

  const stockOf = async (id: number) =>
    toNum((await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [id]))?.stock_on_hand)
  const costOf = async (id: number) =>
    toNum((await siteQueryOne<any>(SITE, 'SELECT average_cost FROM products WHERE id=?', [id]))?.average_cost)

  ok('*** the carcass is CONSUMED ***', (await stockOf(carcass)) === 0, String(await stockOf(carcass)))
  ok('*** the fillet arrived ***', (await stockOf(filletId)) === 3.2, String(await stockOf(filletId)))
  ok(
    '  and bone became no stock at all — it is not a product',
    (await siteQuery<any>(SITE, "SELECT id FROM products WHERE description = 'Bone and drip'")).length === 0,
  )

  /*
   * The whole commercial point: the fillet is worth more per kilo than the
   * carcass it came out of, and the mince less. If both came out at the
   * carcass rate the document has done nothing.
   */
  const stored = await getBlockTest(SITE, posted.id)

  const filletCost = await costOf(filletId)
  ok(
    '*** the fillet costs MORE per kilo than the carcass did ***',
    filletCost > 83.45 * 2,
    `R${filletCost}/kg vs carcass R83.45/kg`,
  )

  /*
   * Mince had 10kg at R60 before; 51.9kg arrives cheaper than the carcass
   * rate. The blend must land between the two, not simply take the new figure.
   */
  /*
   * Mince held 10kg at R60 and receives 51.9kg from this carcass. The blended
   * figure must sit strictly BETWEEN the two, which is the whole property —
   * taking the arriving cost outright would throw away what the shop already
   * paid for the stock on the shelf.
   *
   * Note the arriving cost is ABOVE the carcass rate here, not below: with
   * bone taking a quarter of the weight and only two cuts sharing, normalising
   * inflates every surviving factor. That is correct — the meat has to carry
   * the bone's cost — and it is why this asserts against the ARRIVING figure
   * rather than against a guess at the carcass rate.
   */
  const minceCost = await costOf(minceId)
  const minceArrived = stored?.lines.find((l) => l.productId === minceId)?.unitCostExcl ?? 0
  ok(
    '*** and the mince BLENDS against what was already there ***',
    minceCost > 60 && minceCost < minceArrived,
    `R${minceCost}/kg, between the old R60 and the arriving R${minceArrived}/kg`,
  )

  const movements = await siteQuery<any>(
    SITE,
    `SELECT movement_type, qty_change FROM stock_movements
      WHERE source = 'block_test' AND source_doc_id = ? ORDER BY id`,
    [posted.id],
  )
  ok(
    '*** the movements are a BALANCED PAIR, not adjustments ***',
    movements.length === 3 &&
      movements[0].movement_type === 'block_test_out' &&
      movements.slice(1).every((m: any) => m.movement_type === 'block_test_in'),
    movements.map((m: any) => `${m.movement_type} ${m.qty_change}`).join(', '),
  )
  ok(
    '  the carcass goes out FIRST, so nothing briefly exists twice',
    toNum(movements[0]?.qty_change) < 0,
    String(movements[0]?.qty_change),
  )

  ok('the document reads back', !!stored, stored ? stored.test.documentNumber ?? '' : 'null')
  ok(
    '  with the yield it computed',
    !!stored && stored.test.yieldPct > 70 && stored.test.yieldPct < 80,
    String(stored?.test.yieldPct),
  )
  ok(
    '*** and Σ(allocated) equals what the carcass cost ***',
    !!stored && Math.abs(stored.test.outputCost - stored.test.inputCost) < 0.005,
    `${stored?.test.outputCost} vs ${stored?.test.inputCost}`,
  )

  ok(
    '*** stock invariants hold after posting ***',
    (await reconcileStock(SITE)).length === driftBefore,
    `${driftBefore} -> ${(await reconcileStock(SITE)).length}`,
  )

  const seqCheck = await verifySequence(SITE, 'block_test')
  ok(
    '*** and the number it issued is not reported missing ***',
    seqCheck.missing === 0,
    `missing=${seqCheck.missing} issued=${seqCheck.issued}`,
  )

  /* ── 8. What posting must refuse ──────────────────────────────────────── */

  const noProduct = await postBlockTest(SITE, actor, {
    documentDate: new Date().toISOString().slice(0, 10),
    inputProductId: carcass,
    inputQty: 10,
    lines: [{ productId: null, description: 'Nameless cut', qty: 5, costFactor: 1 }],
  })
  ok(
    '*** a cut with no product is refused — there is nothing to receive into ***',
    !noProduct.ok,
    noProduct.ok ? 'it posted' : noProduct.error,
  )

  const noAccount = await postBlockTest(SITE, actor, {
    documentDate: new Date().toISOString().slice(0, 10),
    inputProductId: carcass,
    inputQty: 10,
    normalise: false,
    lines: [
      { productId: filletId, description: 'Fillet', qty: 3, costFactor: 1 },
      { productId: null, description: 'Bone', qty: 7, costFactor: 0, isLoss: true },
    ],
  })
  ok(
    '*** an under-recovering test with NO variance account is refused ***',
    !noAccount.ok,
    noAccount.ok ? 'it posted, losing the residual silently' : noAccount.error,
  )

  /* ── Cleanup ──────────────────────────────────────────────────────────── */

  await sweepStrays()
  await restoreSequence(seqBefore)
  const left = await siteQuery<any>(SITE, `SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  ok('the run leaves nothing behind', left.length === 0, `${left.length} left`)
  ok(
    'and no drift behind it either',
    (await reconcileStock(SITE)).length === driftBefore,
    String((await reconcileStock(SITE)).length),
  )

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
