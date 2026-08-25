import { round } from './decimals'

/**
 * Splitting one carcass cost across the cuts that came off it.
 *
 * PURE — no database, no `server-only`. The capture screen recalculates this on
 * every keystroke as the butcher weighs cuts (that live panel IS the feature:
 * it is how they see whether this carcass broke down better than the last one),
 * and the posting engine runs the SAME function to write the figures. Two
 * implementations of this arithmetic would be two answers to "what did the
 * fillet cost", and the screen's would be the one somebody trusted.
 *
 * ── WHY NOT SPLIT BY SALES VALUE ─────────────────────────────────────────
 *
 * Because it is the textbook answer and it destroys the report. Market-value
 * allocation hands every cut an IDENTICAL gross margin — a computed 75kg
 * hindquarter returns 15.59% on fillet, mince and stewing beef alike — which
 * erases the per-cut comparison a block test exists to produce. It also has no
 * separable-cost advantage here: with no per-cut processing costs, market-value
 * and constant-gross-margin are mathematically the same thing.
 *
 * ── AND NOT BY WEIGHT ────────────────────────────────────────────────────
 *
 * Weight-proportional is the wrong answer that looks reasonable: it prices
 * fillet and bone-in shin identically. It is deliberately not offered, because
 * a butcher who picks it once will never notice.
 *
 * ── THE SA FACTOR METHOD ─────────────────────────────────────────────────
 *
 *     factor = cut's R/kg (ex-VAT, ex-margin) ÷ carcass R/kg
 *
 * Beef runs fillet 2.380 down to short rib 0.973 (RPO, published via
 * AgriOrbit). Apportionment is then Aptean's formula:
 *
 *     ratio_i = (qty_i × factor_i) / Σ(qty × factor)
 *
 * Note what the factor is NOT: a selling price. Deriving a price from it uses
 * margin as a MARKUP — `carcass × factor × (1 + margin) × (1 + vat)` — which
 * reproduces the published R208.80 to within a cent. Read as a GP divisor the
 * same inputs give R259.02, and every cut in the shop is mispriced. See
 * `priceFromFactor`.
 */

/** One cut coming off the carcass, as the arithmetic sees it. */
export type BlockTestOutput = {
  /** Weight out for this cut. */
  qty: number
  /** The SA factor. Zero is legitimate; negative is refused — see `validate`. */
  costFactor: number
  /**
   * Takes no share of the cost regardless of its factor.
   *
   * For a cut that is genuinely free of the carcass's value — a giveaway, or
   * something already costed elsewhere. It still consumes weight, so it still
   * counts against the yield.
   */
  excludeFromApportionment?: boolean
  /**
   * Bone, drip, trim in the bin.
   *
   * Consumes input weight and becomes no stock. It MUST consume weight or the
   * yield percentage lies, which is the one figure the document exists for.
   */
  isLoss?: boolean
}

export type BlockTestAllocation = {
  /** Per output, in the order given. */
  lines: {
    /** This cut's share of the carcass cost, ex VAT. */
    allocatedCostExcl: number
    /** allocated ÷ qty — what this cut is worth per kilo on the shelf. */
    unitCostExcl: number
    /** Its share of the whole, for the live panel. */
    sharePct: number
  }[]
  /** What went in. */
  inputCost: number
  /** Σ allocated. Equals inputCost exactly when normalising. */
  outputCost: number
  /**
   * The unrecovered remainder, when NOT normalising.
   *
   * Real and large: a published test table recovered only R3,992 of a R6,150
   * side, because bone and drip carry no factor. Where this is non-zero it must
   * reach a variance account — losing R2,158 of stock value silently is not an
   * option.
   */
  varianceCost: number
  /** Saleable weight out ÷ weight in, as a percentage. Losses excluded. */
  yieldPct: number
  /** Total weight out INCLUDING losses, which should approach the input. */
  totalQtyOut: number
}

/**
 * What is wrong with this document, in words, or null.
 *
 * Refuses rather than clamps. A negative factor could be silently floored at
 * zero, but that would change what somebody typed into something they did not
 * type — and the figure it produces (every other cut inflated to compensate)
 * looks perfectly plausible on the screen.
 */
export function validateBlockTest(input: {
  inputQty: number
  inputUnitCostExcl: number
  outputs: readonly BlockTestOutput[]
  normalise: boolean
}): string | null {
  if (!(input.inputQty > 0)) return 'Enter the weight that went in.'
  if (input.inputUnitCostExcl < 0) return 'The input cost cannot be negative.'
  if (input.outputs.length === 0) return 'Add at least one cut.'

  for (const [i, out] of input.outputs.entries()) {
    const where = `Line ${i + 1}`
    if (out.qty < 0) return `${where}: a weight cannot be negative.`
    if (out.costFactor < 0) {
      /*
       * A negative factor gives this cut a negative cost and inflates every
       * other line to compensate. Constant-gross-margin allocation is
       * documented producing exactly that (−R268.84 on bones), and a negative
       * inventory value is meaningless — so it is refused at the door rather
       * than clamped at posting.
       */
      return `${where}: a cost factor cannot be negative.`
    }
  }

  const sharing = input.outputs.filter((o) => !o.excludeFromApportionment && !o.isLoss)
  if (sharing.length === 0) {
    return 'At least one cut has to carry the cost — every line is marked as loss or excluded.'
  }

  const denominator = sharing.reduce((sum, o) => sum + o.qty * o.costFactor, 0)
  if (denominator <= 0) {
    /*
     * Every sharing line has a zero factor or a zero weight, so there is
     * nothing to divide by. Left unguarded this is a division by zero and the
     * whole document costs NaN — which posts as 0.0000 and looks like a free
     * carcass.
     */
    return 'Give at least one cut a weight and a cost factor above zero.'
  }

  return null
}

/**
 * Splits the carcass cost across the cuts.
 *
 * Assumes `validateBlockTest` has passed; callers that skip it get zeros rather
 * than NaN, because a screen recalculating on every keystroke passes through
 * half-typed states constantly and must not flash "NaN" at a butcher.
 */
export function allocateBlockTest(input: {
  inputQty: number
  inputUnitCostExcl: number
  outputs: readonly BlockTestOutput[]
  /**
   * Scale the factors so Σ(allocated) equals the input cost exactly.
   *
   * On, no value can leak. Off, the shortfall lands in `varianceCost` for a
   * shop that wants yield loss visible in the P&L rather than buried in cut
   * costs. An accounting-policy choice, not a technical one — which is why
   * both exist rather than one being "correct".
   */
  normalise: boolean
}): BlockTestAllocation {
  const inputQty = round(input.inputQty, 3)
  const inputCost = round(inputQty * input.inputUnitCostExcl, 4)

  const shares = input.outputs.map((o) =>
    o.excludeFromApportionment || o.isLoss ? 0 : Math.max(0, o.qty) * Math.max(0, o.costFactor),
  )
  const denominator = shares.reduce((sum, s) => sum + s, 0)

  /*
   * Nothing to divide by — every sharing line is zero-weight or zero-factor.
   * Zeros rather than NaN: `validateBlockTest` refuses this at posting, and a
   * live panel mid-typing must show nothing rather than nonsense.
   */
  if (denominator <= 0) {
    return {
      lines: input.outputs.map(() => ({ allocatedCostExcl: 0, unitCostExcl: 0, sharePct: 0 })),
      inputCost,
      outputCost: 0,
      varianceCost: inputCost,
      yieldPct: 0,
      totalQtyOut: round(
        input.outputs.reduce((sum, o) => sum + Math.max(0, o.qty), 0),
        3,
      ),
    }
  }

  /*
   * ── THE TWO METHODS ARE GENUINELY DIFFERENT ARITHMETIC ─────────────────
   *
   * NORMALISED divides the carcass cost by the sharing total, so the factors
   * act as RATIOS and the allocation sums to the parent by construction.
   *
   * UNNORMALISED reads each factor literally — `qty × factor × carcass R/kg`,
   * which is what the factor MEANS: this cut is worth 2.38 times the carcass
   * rate per kilo. Nothing makes those sum to the parent, and they do not: a
   * published test table recovered R3,992 of a R6,150 side, because bone and
   * drip carry no factor at all. That shortfall is the yield loss, and a shop
   * that wants it in the P&L rather than buried in cut costs wants exactly
   * this reading.
   *
   * Getting this wrong is invisible: dividing by the total either way makes
   * `normalise` a flag that changes nothing, every figure still looks
   * plausible, and the variance account silently stays empty forever.
   */
  const rate = inputQty > 0 ? inputCost / inputQty : 0
  const lines = input.outputs.map((o, i) => {
    const allocated = input.normalise
      ? round((inputCost * shares[i]!) / denominator, 4)
      : round(shares[i]! * rate, 4)
    const qty = Math.max(0, o.qty)
    return {
      allocatedCostExcl: allocated,
      unitCostExcl: qty > 0 ? round(allocated / qty, 4) : 0,
      sharePct: round((shares[i]! / denominator) * 100, 3),
    }
  })

  /*
   * Rounding drift lands on the LARGEST line, not the last.
   *
   * Four decimal places over twenty cuts leaves a cent or two unallocated, and
   * Σ(allocated) must equal the parent exactly or the stock value of the
   * carcass changes by being broken down. Putting it on the largest line makes
   * it proportionally invisible; on the last it could be a rounding error the
   * size of a whole bone line.
   */
  if (input.normalise && lines.length > 0) {
    const allocatedTotal = round(
      lines.reduce((sum, l) => sum + l.allocatedCostExcl, 0),
      4,
    )
    const drift = round(inputCost - allocatedTotal, 4)
    if (drift !== 0) {
      let biggest = 0
      for (let i = 1; i < lines.length; i++) {
        if (lines[i]!.allocatedCostExcl > lines[biggest]!.allocatedCostExcl) biggest = i
      }
      const line = lines[biggest]!
      line.allocatedCostExcl = round(line.allocatedCostExcl + drift, 4)
      const qty = Math.max(0, input.outputs[biggest]!.qty)
      line.unitCostExcl = qty > 0 ? round(line.allocatedCostExcl / qty, 4) : 0
    }
  }

  const outputCost = round(
    lines.reduce((sum, l) => sum + l.allocatedCostExcl, 0),
    4,
  )

  // Saleable weight only: bone in the bin is not yield.
  const saleableQty = round(
    input.outputs.reduce((sum, o) => sum + (o.isLoss ? 0 : Math.max(0, o.qty)), 0),
    3,
  )
  const totalQtyOut = round(
    input.outputs.reduce((sum, o) => sum + Math.max(0, o.qty), 0),
    3,
  )

  return {
    lines,
    inputCost,
    outputCost,
    varianceCost: round(inputCost - outputCost, 4),
    yieldPct: inputQty > 0 ? round((saleableQty / inputQty) * 100, 3) : 0,
    totalQtyOut,
  }
}

/**
 * A shelf price from a factor — the other half of the RPO method.
 *
 * ⚠ MARGIN IS A MARKUP HERE, NOT A GP DIVISOR. The published worked example
 * only reconciles this way:
 *
 *     98.31 × 1.283 × 1.44 × 1.15 = R208.87   (published R208.80)
 *
 * Read as `cost / (1 - margin)` the same inputs give R259.02 — a 24% error, in
 * the direction that loses the sale rather than the money, and entirely
 * invisible unless somebody checks it against a published table.
 */
export function priceFromFactor(input: {
  /** Carcass cost per kilo, ex VAT. */
  carcassCostExcl: number
  costFactor: number
  /** As a fraction: 0.44 for 44%. */
  marginPct: number
  /** As a fraction: 0.15 for 15%. */
  vatRatePct: number
}): number {
  const base = input.carcassCostExcl * input.costFactor
  return round(base * (1 + input.marginPct) * (1 + input.vatRatePct), 2)
}
