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
import { siteQuery } from '../src/lib/siteDb'

const SITE = 1
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

  const { verifySequence } = await import('../src/lib/site/sequences')
  const check = await verifySequence(SITE, 'block_test')
  ok(
    '*** and verifySequence finds its OWN table, not sales_documents ***',
    check.missing === 0,
    `missing=${check.missing} issued=${check.issued}`,
  )

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
