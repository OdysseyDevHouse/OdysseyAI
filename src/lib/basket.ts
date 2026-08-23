import { round } from './decimals'
import { adjustPerUnit, type ChosenOption } from './instructionRules'
import type { TillProduct } from './site/tillSearch'

/**
 * A basket, and the pure functions that change one.
 *
 * ── WHY THIS IS ITS OWN MODULE ────────────────────────────────────────────
 *
 * `BasketLine` was declared inside sales/new/TillScreen.tsx and exported from
 * there. That was fine while one screen owned a basket; with two tills it is how
 * they silently diverge — a fix to how a discount ceiling is enforced, or to when
 * two scans merge into one line, lands in one and not the other, and nobody finds
 * out until a shop asks why the same product behaves differently on till 2.
 *
 * So the SHAPE and the RULES live here, once. Both screens import them.
 *
 * ── PURE, AND NO `server-only` ────────────────────────────────────────────
 *
 * Every function here is a plain value-in value-out transform: no React, no
 * fetch, no database. That is what lets the till run them offline in the browser,
 * lets a test exercise them with no database at all, and lets the reducer in the
 * POS be a switch statement over them rather than a pile of setState calls.
 *
 * Pricing arithmetic is NOT here — that is documentMath/tenderMath/specialsEngine,
 * which are already shared and already pure. This module only decides what is in
 * the basket.
 */

export type BasketLine = {
  /** Stable within the basket only — the database line id does not exist yet. */
  key: string
  productId: number | null
  productCode: string | null
  description: string
  productType: TillProduct['productType']
  departmentId: number | null
  qty: number
  unitPriceIncl: number
  discountPct: number
  vatRatePct: number
  unitCostExcl: number
  maxDiscountPct: number
  /**
   * The structure price, so a line modal can tell an override from the shelf
   * figure. Null when the product is priced at the counter, where there is no
   * shelf figure to differ from.
   */
  shelfPriceIncl: number | null
  allowFractions: boolean
  /**
   * The answers the cashier gave to this product's questions.
   *
   * Their price is FOLDED INTO `unitPriceIncl` above rather than kept apart, so
   * specials, discounts and VAT all see the item at the price it was actually
   * sold at. These rows are the breakdown of a figure that has already been
   * charged — adding them to the line total again would double-charge.
   *
   * Required rather than optional so every place that builds a line has to say
   * what it means, and forgetting is a compile error rather than a modifier that
   * silently vanishes between the till and the invoice.
   */
  instructions: ChosenOption[]
  /** A free-text note for this line — "no ice", "allergy: nuts". */
  note: string
  /**
   * When this line was FIRST rung, as epoch milliseconds.
   *
   * The till shows each line's age, so a waiter reopening a table can see how
   * long the customer has been waiting for a plate. That has to be the age of
   * the ORDER, which is why it rides on the line and is persisted across park
   * and recall (167) rather than being read off `created_at`: a table bill
   * rewrites its lines wholesale on every save, so the row's own timestamp is
   * the moment of the last save, not of the order.
   *
   * Optional, and absent is not an error. A line parked before 167, or restored
   * from an old offline basket, has no recorded order time and the card falls
   * back to when the line entered this basket — which is the best available
   * answer and still counts up honestly from there.
   */
  orderedAt?: number
  /**
   * How much of this line the kitchen has already been told about (142).
   *
   * A SNAPSHOT taken at recall, and read for one purpose: to show the waiter
   * that a line is already being cooked. It is deliberately NOT what decides
   * what prints — `kitchenDelta` runs server-side against the live column, so
   * that a second till adding a course cannot be blinded by this till's stale
   * copy. Wrong here costs a misleading badge; wrong there costs a duplicate
   * plate, which is why the two are kept apart.
   *
   * Absent on a freshly rung line, which the kitchen has by definition not seen.
   */
  kitchenSentQty?: number
  /** The card a gift-card line sells (147). Absent on ordinary lines. */
  giftCardCode?: string
  /**
   * The special that PUT this line in the basket, for a deal that hands
   * something over rather than reducing a price.
   *
   * ── WHY A REWARD IS A LINE AND NOT A DISCOUNT ────────────────────────────
   *
   * "Buy two pizzas, get a garlic bread" gives the customer a THIRD THING. It
   * cannot be expressed as a percentage off the pizzas: the slip has to show
   * the bread, the kitchen has to make it, and stock has to move for it. So the
   * engine returns rewards separately from line discounts, and they arrive here
   * as ordinary lines at zero price.
   *
   * ── IT IS ALSO WHAT MAKES RECONCILIATION SAFE ────────────────────────────
   *
   * The basket is re-priced on every keystroke. Without a mark saying "the
   * engine put this here", a recompute could not tell a reward it granted a
   * moment ago from a line the cashier rang up by hand — so it would either
   * duplicate the reward on every keypress or delete a real line. Everything
   * carrying this id is the engine's to add and remove; everything without it
   * belongs to the cashier and is never touched.
   *
   * Absent on every ordinary line, which is all of them until a deal fires.
   */
  rewardSpecialId?: number
}

/**
 * A key that is unique within one basket.
 *
 * The index is in there as well as the clock: two scans of the same barcode
 * inside the same millisecond are entirely possible with a scanner gun, and two
 * lines sharing a key makes React reuse the wrong row.
 */
export function basketKey(productId: number | null, index: number): string {
  return `${productId ?? 'x'}-${Date.now()}-${index}`
}

/**
 * A fresh line from a product, at the price the catalogue gave.
 *
 * `resolvedIncl` is that price AFTER any scheduled change whose moment has
 * come — see lib/priceSchedules. It defaults to the catalogue's own figure, so
 * every existing caller is unchanged and one that has not been taught about
 * scheduled prices is merely old-fashioned rather than wrong.
 *
 * It feeds the shelf price as well as the charged one, deliberately: they are
 * the same fact, and letting them disagree would make every scheduled line look
 * like a cashier had overridden it — which the line modal would flag and the
 * price guard would refuse.
 */
/**
 * An account's standing discount, capped at the product's own ceiling — the
 * cap that keeps a back-office setting from tripping checkPricing's refusal
 * at the till. Zero ceiling means "no ceiling set", the products.ts rule.
 */
export function accountDiscountFor(product: TillProduct, defaultDiscountPct: number): number {
  const wanted = round(Math.max(defaultDiscountPct, 0), 3)
  if (wanted === 0) return 0
  const ceiling = product.maxDiscountPct > 0 ? product.maxDiscountPct : 100
  return Math.min(wanted, ceiling)
}

export function lineFromProduct(
  product: TillProduct,
  qty: number,
  index: number,
  resolvedIncl: number = product.priceIncl,
  /** The attached account's standing discount. See accountDiscountFor. */
  defaultDiscountPct = 0,
): BasketLine {
  return {
    key: basketKey(product.id, index),
    productId: product.id,
    productCode: product.code,
    description: product.description,
    productType: product.productType,
    departmentId: product.departmentId,
    qty,
    // A scanned price wins: a variable-weight barcode carries the money in it.
    unitPriceIncl: product.scannedPrice ?? resolvedIncl,
    discountPct: accountDiscountFor(product, defaultDiscountPct),
    vatRatePct: product.vatRatePct,
    unitCostExcl: product.costExcl,
    maxDiscountPct: product.maxDiscountPct,
    shelfPriceIncl: product.askPriceAtSale ? null : resolvedIncl,
    allowFractions: product.allowFractions,
    instructions: [],
    note: '',
    // Rung NOW. Same clock the key already reads, so this adds no impurity that
    // was not here — and a line's age has to start from the moment it was rung.
    orderedAt: Date.now(),
    ...(product.giftCardCode ? { giftCardCode: product.giftCardCode } : {}),
  }
}

/** A product the basket has earned, as the specials engine reports it. */
export type EarnedReward = {
  specialId: number
  productId: number
  qty: number
}

/**
 * The basket, with its earned rewards present exactly once each.
 *
 * ── WHY THIS IS A RECONCILIATION AND NOT AN "ADD" ────────────────────────
 *
 * The engine does not emit events. It answers, from scratch on every keystroke,
 * "what does this basket earn right now" — so the answer shrinks as well as
 * grows: removing a pizza takes the free garlic bread back. Something has to
 * turn that repeated full answer into the smallest set of changes, and doing it
 * by adding on earn and removing on un-earn would need change detection that is
 * wrong the first time two deals overlap.
 *
 * So: every engine-owned line is derived from the current answer, and every
 * cashier-owned line is left exactly as it is. Idempotent by construction —
 * running it twice on the same answer changes nothing the second time, which is
 * what makes it safe to call from a render.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────
 *
 * It never edits a line the cashier owns, and it never re-prices one. A reward
 * is a new zero-priced line beside the goods that earned it; the goods keep the
 * price they were rung at. That is what makes "buy two, get one free" show on
 * the slip as three items with one at nothing, which is what the customer sees
 * happening at the counter.
 *
 * `describe` resolves a product id to the line to add. It returns null when the
 * till has never heard of the product — a reward naming a since-deleted item is
 * simply not granted, rather than putting a blank line on the slip.
 */
export function withRewards(
  lines: BasketLine[],
  rewards: EarnedReward[],
  describe: (productId: number) => BasketLine | null,
): BasketLine[] {
  const own = lines.filter((line) => line.rewardSpecialId === undefined)
  // Nothing earned and nothing granted: return the SAME array, so a render
  // that depends on this reference does not re-run for a basket that did not
  // change. The common case, on every keystroke of every ordinary sale.
  if (rewards.length === 0) return own.length === lines.length ? lines : own

  const existing = new Map<string, BasketLine>()
  for (const line of lines) {
    if (line.rewardSpecialId !== undefined && line.productId !== null) {
      existing.set(`${line.rewardSpecialId}-${line.productId}`, line)
    }
  }

  const granted: BasketLine[] = []
  rewards.forEach((reward, index) => {
    if (reward.qty <= 0) return
    const id = `${reward.specialId}-${reward.productId}`
    const already = existing.get(id)
    if (already) {
      // Kept rather than rebuilt, so its key survives and React does not remount
      // the row — and so an unchanged quantity is genuinely the same object.
      granted.push(already.qty === reward.qty ? already : { ...already, qty: reward.qty })
      return
    }
    const fresh = describe(reward.productId)
    if (!fresh) return
    granted.push({
      ...fresh,
      key: `r${reward.specialId}-${basketKey(reward.productId, index)}`,
      qty: reward.qty,
      // Free means free. Not a 100% discount: a discount is something a person
      // chose to give and the price guard checks against their rights, while
      // this is the promotion paying out exactly as it was set up.
      unitPriceIncl: 0,
      discountPct: 0,
      rewardSpecialId: reward.specialId,
    })
  })

  /*
   * The SAME array back when nothing actually moved.
   *
   * This is what makes the function safe to call from an effect on every
   * keystroke: an identical answer produces an identical array, the reducer
   * returns the identical state, React re-renders nothing, and the effect does
   * not fire again.
   *
   * "Nothing moved" has to be identity on every granted line, not a count.
   * Comparing lengths alone would loop forever the first time a reward's
   * quantity changed — the rebuilt line is a new object, so the basket really
   * has changed, but a length check would call it unchanged and the old
   * quantity would stay on the slip.
   */
  const unchanged =
    own.length + granted.length === lines.length &&
    granted.every((line, index) => lines[own.length + index] === line)
  if (unchanged) return lines
  // Rewards sit at the BOTTOM, under the goods that earned them, which is the
  // order they happened in and the order a customer reads the slip in.
  return [...own, ...granted]
}

/** What this line's answers add to ONE of it, VAT-inclusive and signed. */
export function instructionAdjust(line: BasketLine): number {
  return adjustPerUnit(line.instructions)
}

/**
 * A line with its answers' price folded in.
 *
 * The one place that arithmetic happens, so the modal, the reducer and the
 * recall path cannot each fold it in slightly differently — or, worse, twice.
 */
export function withInstructions(
  line: BasketLine,
  instructions: ChosenOption[],
  note = line.note,
): BasketLine {
  const base = line.shelfPriceIncl ?? line.unitPriceIncl - instructionAdjust(line)
  return {
    ...line,
    instructions,
    note,
    unitPriceIncl: round(base + adjustPerUnit(instructions), 4),
  }
}

/**
 * Adds a product, merging with an existing line where that is what a cashier
 * would expect.
 *
 * Four products never merge, and each rule is one somebody will otherwise
 * "simplify" away:
 *
 *   · a line carrying a DISCOUNT, because merging would silently apply that
 *     discount to the newly-scanned unit as well;
 *   · a product PRICED AT THE COUNTER, because the second one may be a different
 *     price and merging would charge the first one's;
 *   · a line whose price was OVERRIDDEN off the shelf figure, for the same
 *     reason — the override was a decision about those units, not about the
 *     product;
 *   · a line carrying ANSWERS OR A NOTE. Two burgers are only the same line if
 *     they are the same burger, and a second one rung up without being asked
 *     the questions is not. Deep-comparing the answer sets would let identical
 *     ones merge, but a wrong match there is a wrong plate leaving the kitchen,
 *     and the cost of not merging is one extra row on screen.
 */
export function addToBasket(
  lines: BasketLine[],
  product: TillProduct,
  qty = 1,
  /** The price after any scheduled change that is due. See `lineFromProduct`. */
  resolvedIncl: number = product.priceIncl,
  /** The attached account's standing discount. See accountDiscountFor. */
  defaultDiscountPct = 0,
): BasketLine[] {
  const applied = accountDiscountFor(product, defaultDiscountPct)
  const mergeable = lines.findIndex(
    (l) =>
      l.productId === product.id &&
      /*
       * A refund line never absorbs a sale.
       *
       * Without this, a customer handing back a shirt and then buying the same
       * shirt in another size — same product code — would have the +1 folded
       * into the −1 and BOTH would vanish into a qty-0 line. That line is not
       * merely invisible: `validateDocument` refuses a zero quantity, so the
       * whole sale would fail at the tender with an error naming a line the
       * cashier cannot see anything wrong with.
       *
       * Refunds do not merge with each other either — see the ADD case in
       * useSaleState, which never routes an armed refund through here at all.
       * This is the guard for the scan that comes AFTER one.
       */
      !isRefundLine(l) &&
      /*
       * A discounted line never merges with a NEW unit — unless the discount
       * is exactly the account's standing one the new unit would get anyway.
       * The original rule protects a per-line decision from leaking onto
       * fresh stock; a standing account discount is not per-line, so merging
       * identical ones is the behaviour a cashier expects.
       */
      l.discountPct === applied &&
      l.shelfPriceIncl !== null &&
      l.unitPriceIncl === l.shelfPriceIncl &&
      // Stated rather than left to the price test above. A folded answer moves
      // `unitPriceIncl` off the shelf figure and so would fail that test anyway
      // — but only for answers that cost something, and "no onions" costs
      // nothing while still meaning this is a different burger.
      l.instructions.length === 0 &&
      l.note === '',
  )

  // A gift card never merges: each line names ITS card, and two cards folded
  // into one qty-2 line would leave one of them a code with no line behind it.
  if (
    mergeable !== -1 &&
    !product.askPriceAtSale &&
    product.scannedPrice == null &&
    product.productType !== 'gift_card'
  ) {
    const next = [...lines]
    // round to 3: quantities are DECIMAL(_,3) and a weighed item adds fractions,
    // so repeated addition without rounding drifts into 2.9999999999999996.
    next[mergeable] = { ...next[mergeable], qty: round(next[mergeable].qty + qty, 3) }
    return next
  }

  return [...lines, lineFromProduct(product, qty, lines.length, resolvedIncl, defaultDiscountPct)]
}

/** Replaces fields on one line. Unknown keys are ignored, not created. */
export function updateBasketLine(
  lines: BasketLine[],
  key: string,
  changes: Partial<BasketLine>,
): BasketLine[] {
  return lines.map((l) => (l.key === key ? { ...l, ...changes } : l))
}

export function removeBasketLine(lines: BasketLine[], key: string): BasketLine[] {
  return lines.filter((l) => l.key !== key)
}

/**
 * Steps a line's quantity, removing it at zero.
 *
 * Removing at zero rather than clamping is deliberate: a cashier pressing − on a
 * single unit means "take it off", and leaving a zero-quantity line behind gives
 * them a row that shows nothing and posts nothing.
 *
 * A product that does not allow fractions steps by whole units however small the
 * step asked for, so a − on a 1kg line of tinned beans cannot leave 0.5 of a tin.
 *
 * ── A REFUND LINE STEPS THE OTHER WAY ─────────────────────────────────────
 *
 * A line with a negative quantity is an item coming BACK (see `refundArmed` in
 * useSaleState). On such a line + and − mean what they say on the screen — "more
 * of this refunded", "less of it" — so the step is applied in the line's own
 * direction rather than the basket's, and a cashier pressing + on a −1 shirt gets
 * −2 rather than watching the refund cancel itself.
 *
 * Removal is therefore "crossed zero", not "reached zero or below": the test is
 * on the SIGN changing, which catches −1 stepped to 0 and 1 stepped to 0 alike,
 * and never deletes a refund line for the crime of being negative.
 */
export function stepQty(lines: BasketLine[], key: string, delta: number): BasketLine[] {
  const line = lines.find((l) => l.key === key)
  if (!line) return lines
  const magnitude = line.allowFractions
    ? Math.abs(delta)
    : Math.max(1, Math.round(Math.abs(delta)))
  // The line's own direction, so a refund grows downwards.
  const direction = line.qty < 0 ? -1 : 1
  const step = Math.sign(delta) * magnitude * direction
  const next = round(line.qty + step, 3)
  // Stepped down to nothing, or through it: the cashier means "take it off".
  if (next === 0 || Math.sign(next) !== direction) return removeBasketLine(lines, key)
  return updateBasketLine(lines, key, { qty: next })
}

/**
 * Whether this line is goods coming BACK rather than going out.
 *
 * One predicate rather than `l.qty < 0` written out at each call site, because
 * "negative quantity" and "this is a refund" are the same fact here and only one
 * of those two phrasings survives being read six months later. Everything that
 * renders, prices or posts a basket asks this.
 */
export function isRefundLine(line: Pick<BasketLine, 'qty'>): boolean {
  return line.qty < 0
}

/**
 * Whether a discount is within what this line permits.
 *
 * The ceiling is the product's own `maxDiscountPct`, which the catalogue carries.
 * Zero means "no discount allowed at all", NOT "unlimited" — the opposite reading
 * is the one that would quietly let staff discount protected lines to nothing.
 */
export function discountAllowed(line: BasketLine, pct: number): boolean {
  if (pct === 0) return true
  return pct > 0 && pct <= line.maxDiscountPct
}

/**
 * Whether this price differs from what the shelf says.
 *
 * The answers' price is backed out before comparing. It was FOLDED INTO
 * `unitPriceIncl` on purpose, so without this every burger with bacon on it
 * would wear a "price changed" badge and read as though a cashier had overridden
 * it — which is exactly what this flag exists to make visible, and would then
 * mean nothing.
 */
export function isPriceOverridden(line: BasketLine): boolean {
  if (line.shelfPriceIncl === null) return false
  return round(line.unitPriceIncl - instructionAdjust(line), 4) !== round(line.shelfPriceIncl, 4)
}

/**
 * How many individual items are in the basket — the count on the header chip.
 *
 * MAGNITUDES, so a refund line counts as an item rather than against one.
 *
 * Netting was what a plain sum did, and it answers a question nobody asked. A
 * basket of one shirt sold and one handed back would have read "0 items", which
 * to a cashier glancing at the chip is an EMPTY basket — with two lines on the
 * screen and a customer waiting. Worse, it is the chip they check a bag against.
 *
 * The value of a refund is negative and belongs in the total, which is where it
 * is. The COUNT is answering "how many things are we handling", and the answer
 * is two.
 */
export function basketCount(lines: BasketLine[]): number {
  return lines.reduce((sum, l) => sum + Math.abs(l.qty), 0)
}
