/**
 * What a basket is entitled to.
 *
 * Pure and free of `server-only`: the till runs this in the browser on every
 * keystroke, the storefront runs it on the server, and the tests run it with
 * no database at all. Two implementations would mean a till showing a price
 * the shop does not charge.
 *
 * ── IT RETURNS PERCENTAGES, NOT PRICES ───────────────────────────────────
 *
 * Every kind of special reduces to "this much off this line". Returning a
 * price would mean each caller rounding it, and a percentage composes with the
 * manual discount a cashier can already apply — see `effectiveDiscountPct`.
 *
 * ── PRIORITY ORDER, AND A LINE IS CLAIMED ONCE ───────────────────────────
 *
 * Specials fire lowest-priority-number first, and the first one to involve a
 * line owns it. Not best-price-wins: a three-for-two cannot be compared
 * against a straight discount without evaluating the whole basket both ways,
 * and a shop needs to be able to decide which promotion runs. Dragging the
 * list is how that decision is expressed.
 *
 * CLAIMING IS NOT THE SAME AS DISCOUNTING. A three-for-two claims every
 * qualifying line even though only the cheapest unit is free — otherwise a
 * lower-priority special would discount the two the customer is paying for.
 */

/**
 * The four shapes a promotion can take.
 *
 * A combo is one TYPE with four modes rather than four types, because the four
 * modes share everything that matters — they all count trigger products into
 * deals — and differ only in what the deal hands back. Flattening them into
 * six peers loses that, and makes a shopkeeper choose from a list of six when
 * the real question is "is this a straight discount, a marked price, a combo,
 * or a spend threshold".
 */
export const SPECIAL_TYPES = ['happy_hour', 'special_price', 'combo', 'spend'] as const
export type SpecialType = (typeof SPECIAL_TYPES)[number]

export const TYPE_LABEL: Record<SpecialType, string> = {
  happy_hour: 'Happy hour',
  special_price: 'Special price',
  combo: 'Combo deal',
  spend: 'Spend & get',
}

/** What a combo actually does. Only meaningful when the type is `combo`. */
export const COMBO_MODES = [
  'cheapest_free',
  'free_item',
  'percent_off',
  'bundle_price',
  'multibuy',
] as const
export type ComboMode = '' | (typeof COMBO_MODES)[number]

export const COMBO_MODE_LABEL: Record<Exclude<ComboMode, ''>, string> = {
  cheapest_free: 'Buy X, cheapest % off',
  free_item: 'Buy these, get one free',
  percent_off: 'Buy these, get % off',
  bundle_price: 'Bundle price',
  multibuy: 'Multibuy tiers',
}

/** One rung of a multibuy ladder: this many units for this much. */
export type SpecialTier = {
  qty: number
  priceIncl: number
}

export type SpecialRole = 'scope' | 'trigger' | 'reward'

export type SpecialItem = {
  role: SpecialRole
  /** Exactly one of these is set. */
  productId: number | null
  departmentId: number | null
  qty: number
  /** special_price only: what this product is marked down to. */
  priceIncl: number
}

export type Special = {
  id: number
  name: string
  type: SpecialType
  /** Only meaningful when the type is `combo`; '' otherwise. */
  comboMode: ComboMode
  isActive: boolean
  /** Local wall-clock, 'YYYY-MM-DDTHH:mm'. */
  startsAt: string
  endsAt: string
  /** 'HH:MM' or '' for all day. End before start means overnight. */
  dailyStart: string
  dailyEnd: string
  /** Seven characters of 0/1, MONDAY FIRST. */
  daysOfWeek: string
  discountPct: number
  appliesToAll: boolean
  triggerQty: number
  bundlePriceIncl: number
  spendAmountIncl: number
  priority: number
  items: SpecialItem[]
  /** multibuy only: the quantity ladder, e.g. 3 for R25, 6 for R45. */
  tiers: SpecialTier[]
  /**
   * The reward products, described well enough to put one on a slip.
   *
   * ── WHY THE DESCRIPTION TRAVELS WITH THE SPECIAL ─────────────────────────
   *
   * A reward names a product the customer never asked for, so the till has
   * typically never looked it up: it is not in the search results, not in the
   * browsed department, and asking for it would mean a round trip in the middle
   * of a keystroke — or, offline, an async read that a render cannot wait for.
   *
   * So the server sends what a free garlic bread IS along with the rule that
   * grants it. It rides in the catalogue payload the till already caches, which
   * is what lets a deal hand over a product with the network gone.
   *
   * Absent for every special that gives no product away, which is most of them
   * — and optional so that the many places building a Special for a test or a
   * form say nothing about rewards rather than each having to say "none".
   */
  rewardProducts?: RewardProduct[]
}

/** Enough of a product to put a granted line on a slip. */
export type RewardProduct = {
  productId: number
  code: string
  description: string
  departmentId: number | null
  vatRatePct: number
  /** What it would have cost. Recorded on the line so the giveaway is costed. */
  costExcl: number
  /**
   * Carried rather than assumed.
   *
   * A reward line is a real sale line and its type decides real behaviour —
   * whether stock moves for it, whether it can be returned. Defaulting it to
   * "normal" would silently move stock for a service, so the type travels with
   * the product. Typed as a string here because this module is pure and must
   * not import the product-type table; the till narrows it on the way in.
   */
  productType: string
}

/** What the engine needs to know about one thing in the basket. */
export type BasketLine = {
  productId: number
  departmentId: number | null
  /** Unit price including VAT, before any discount. */
  priceIncl: number
  qty: number
}

/** What a line ended up entitled to. */
export type AppliedSpecial = { specialId: number; name: string; pct: number }

/** A product the basket has earned for nothing. */
export type SpecialReward = {
  specialId: number
  name: string
  productId: number
  qty: number
}

export type SpecialsResult = {
  /** Index-aligned with the lines passed in. Undefined means nothing applied. */
  lineSpecials: (AppliedSpecial | undefined)[]
  rewards: SpecialReward[]
}

export type SpecialItemInput = {
  role: SpecialRole
  productId: number | null
  departmentId: number | null
  qty: number
  priceIncl: number
}

export type SpecialInput = {
  /** Null to create. */
  id: number | null
  name: string
  type: SpecialType
  comboMode: ComboMode
  isActive: boolean
  startsAt: string
  endsAt: string
  dailyStart: string
  dailyEnd: string
  daysOfWeek: string
  discountPct: number
  appliesToAll: boolean
  triggerQty: number
  bundlePriceIncl: number
  spendAmountIncl: number
  items: SpecialItemInput[]
  tiers: SpecialTier[]
}

/**
 * Everything wrong with this special, or null.
 *
 * Returns the FIRST problem rather than a list: a form that reports six things
 * at once is a form nobody reads. Each message names what to do, not what is
 * wrong — "Add the products this applies to", not "items must not be empty".
 */
export function validateSpecial(input: SpecialInput): string | null {
  if (!input.name.trim()) return 'A name for the special is required'
  if (!(SPECIAL_TYPES as readonly string[]).includes(input.type)) return 'Unknown special type'
  if (input.type === 'combo' && !(COMBO_MODES as readonly string[]).includes(input.comboMode)) {
    return 'Choose what the combo does'
  }

  const start = input.startsAt.trim()
  const end = input.endsAt.trim()
  if (!start) return 'A start date and time is required'
  if (!end) return 'An end date and time is required'
  if (end <= start) return 'The special must end after it starts'

  // Both or neither: half a band is a window nobody meant to set.
  const hasFrom = !!input.dailyStart.trim()
  const hasTo = !!input.dailyEnd.trim()
  if (hasFrom !== hasTo) return 'Set both daily times, or leave both blank for all day'
  if (hasFrom && !/^\d{1,2}:\d{2}$/.test(input.dailyStart.trim())) {
    return 'Daily start time must look like 17:00'
  }
  if (hasTo && !/^\d{1,2}:\d{2}$/.test(input.dailyEnd.trim())) {
    return 'Daily end time must look like 18:00'
  }

  if (!/^[01]{7}$/.test(input.daysOfWeek) || !input.daysOfWeek.includes('1')) {
    return 'Pick at least one day of the week'
  }

  const scope = input.items.filter((i) => i.role === 'scope')
  const triggers = input.items.filter((i) => i.role === 'trigger')
  const rewards = input.items.filter((i) => i.role === 'reward')
  const pct = 'The discount must be between 0 and 100 percent'

  const shape = input.type === 'combo' ? input.comboMode : input.type

  switch (shape) {
    case 'happy_hour':
      if (input.discountPct <= 0 || input.discountPct > 100) return pct
      if (!input.appliesToAll && scope.length === 0) {
        return 'Add the products or departments the special applies to'
      }
      break

    case 'special_price':
      if (scope.length === 0) return 'Add the products or departments and their special prices'
      if (scope.some((i) => i.priceIncl <= 0)) return 'Every row needs its special price'
      break

    case 'cheapest_free':
      if (input.triggerQty < 2) return 'Buy quantity must be at least 2'
      if (input.discountPct <= 0 || input.discountPct > 100) return pct
      if (triggers.length === 0) return 'Add the products that count towards the deal'
      break

    case 'free_item':
      if (triggers.length === 0) return 'Add the products the customer must buy'
      if (rewards.length === 0) return 'Add the free product the customer gets'
      break

    case 'percent_off':
      if (input.discountPct <= 0 || input.discountPct > 100) return pct
      if (triggers.length === 0) return 'Add the products the customer must buy'
      break

    case 'bundle_price':
      if (input.bundlePriceIncl <= 0) return "Set the bundle's selling price"
      if (triggers.length === 0) return 'Add the products that make up the bundle'
      break

    case 'multibuy': {
      if (triggers.length === 0) return 'Add the products the tiers apply to'
      if (input.tiers.length === 0) return 'Add at least one tier — a quantity and its price'
      if (input.tiers.some((t) => Math.floor(t.qty) < 2)) {
        return 'A tier needs at least 2 units — one unit is just the shelf price'
      }
      if (input.tiers.some((t) => t.priceIncl <= 0)) return 'Every tier needs its price'
      const qtys = input.tiers.map((t) => Math.floor(t.qty))
      if (new Set(qtys).size !== qtys.length) {
        return 'Two tiers name the same quantity — keep one of them'
      }
      break
    }

    case 'spend':
      if (input.spendAmountIncl <= 0) return 'Set the amount the customer must spend'
      if (input.discountPct <= 0 && rewards.length === 0) {
        return 'Give the special a reward — a discount, a free product, or both'
      }
      if (input.discountPct > 100) return pct
      break
  }

  return null
}

/* ── Time windows ─────────────────────────────────────────────────────────── */

/**
 * Parse 'YYYY-MM-DDTHH:mm' as LOCAL time.
 *
 * `new Date(string)` treats a bare date as UTC, which in South Africa would
 * start a special two hours late and end it two hours early. A shop means its
 * own clock when it says the sale starts at nine.
 */
function parseLocal(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value ?? '')
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
}

const minutesOf = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '')
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * Is this special running at this moment?
 *
 * Four gates, all of which must pass. Evaluated here rather than in SQL so a
 * till that cached its catalogue at ten to five still starts the five o'clock
 * happy hour on time.
 */
export function specialActiveAt(special: Special, now: Date): boolean {
  if (!special.isActive) return false

  const start = parseLocal(special.startsAt)
  const end = parseLocal(special.endsAt)
  if (!start || !end) return false
  // Both ends inclusive: a special ending at 17:00 includes 17:00 exactly.
  if (now < start || now > end) return false

  // JS counts from Sunday; a shop counts from Monday.
  if (/^[01]{7}$/.test(special.daysOfWeek)) {
    const mondayFirst = (now.getDay() + 6) % 7
    if (special.daysOfWeek[mondayFirst] !== '1') return false
  }

  const from = minutesOf(special.dailyStart)
  const to = minutesOf(special.dailyEnd)
  // Both or neither. One alone is a half-configured band, and guessing the
  // other end would invent a window nobody asked for.
  if (from !== null && to !== null) {
    const mins = now.getHours() * 60 + now.getMinutes()
    if (from <= to) {
      if (mins < from || mins > to) return false
    } else {
      // Overnight: 22:00–02:00 means late OR early, not "between".
      if (mins < from && mins > to) return false
    }
  }

  return true
}

/* ── Matching ─────────────────────────────────────────────────────────────── */

function matches(item: SpecialItem, line: BasketLine): boolean {
  if (item.productId !== null) return item.productId === line.productId
  if (item.departmentId !== null) return item.departmentId === line.departmentId
  return false
}

const clampPct = (n: number) => Math.min(Math.max(Number(n) || 0, 0), 100)

/**
 * Keep whichever entitlement is worth more.
 *
 * Only reachable WITHIN one special — two of its trigger rows hitting the same
 * line. Across specials, claiming makes it unreachable, which is the point.
 */
function keepBest(
  current: AppliedSpecial | undefined,
  candidate: AppliedSpecial,
): AppliedSpecial {
  return !current || candidate.pct > current.pct ? candidate : current
}

/* ── The engine ───────────────────────────────────────────────────────────── */

/**
 * Work out what every line in the basket is entitled to.
 *
 * `lines` must NOT include reward lines a previous run added — feeding them
 * back in inflates the spend threshold and the deal counts, which cascades
 * into more rewards on every recompute.
 */
export function computeSpecials(
  lines: BasketLine[],
  specials: Special[],
  now: Date,
): SpecialsResult {
  const lineSpecials: (AppliedSpecial | undefined)[] = new Array(lines.length).fill(undefined)
  const rewards: SpecialReward[] = []
  /** A line a higher-priority special has already involved. */
  const claimed = new Array(lines.length).fill(false)

  const ordered = [...specials].sort((a, b) => a.priority - b.priority || a.id - b.id)

  for (const special of ordered) {
    if (!specialActiveAt(special, now)) continue

    /*
     * A line is available if no higher-priority special has claimed it AND
     * there is actually something on it.
     *
     * The quantity guard matters for refunds. A returned line arrives with a
     * quantity of zero — it has to keep its slot so the results stay aligned
     * with the basket — but goods coming back must neither complete a deal nor
     * be credited at a promotional price. Without this, a `percent_off`
     * discounts any line it matches whatever the quantity, so a refund would
     * be paid out at the special price.
     */
    const available = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line, index }) => !claimed[index] && line.qty > 0)
    if (available.length === 0 && special.type !== 'spend') continue

    const scope = special.items.filter((i) => i.role === 'scope')
    const triggers = special.items.filter((i) => i.role === 'trigger')
    const rewardRows = special.items.filter((i) => i.role === 'reward')

    /** Every available line this special's triggers (or scope) touch. */
    const matching = (rows: SpecialItem[]) =>
      available.filter(({ line }) => rows.some((r) => matches(r, line)))

    /** How many complete deals the basket supports, across all trigger rows. */
    const dealCount = () => {
      if (triggers.length === 0) return 0
      let deals = Infinity
      for (const row of triggers) {
        const have = available
          .filter(({ line }) => matches(row, line))
          .reduce((sum, { line }) => sum + Math.max(line.qty, 0), 0)
        deals = Math.min(deals, Math.floor(have / Math.max(row.qty, 1)))
      }
      return Number.isFinite(deals) ? deals : 0
    }

    const claim = (entries: { index: number }[]) => {
      for (const { index } of entries) claimed[index] = true
    }

    const give = (index: number, pct: number) => {
      if (pct <= 0) return
      lineSpecials[index] = keepBest(lineSpecials[index], {
        specialId: special.id,
        name: special.name,
        pct,
      })
    }

    const shape =
      special.type === 'combo' ? special.comboMode || 'cheapest_free' : special.type

    switch (shape) {
      case 'happy_hour': {
        const pct = clampPct(special.discountPct)
        if (pct <= 0) break
        const hit = special.appliesToAll ? available : matching(scope)
        if (hit.length === 0) break
        for (const { index } of hit) give(index, pct)
        claim(hit)
        break
      }

      /*
       * A combo's percent-off, which is NOT the same as a happy hour despite
       * both taking a percentage. This one only pays out once every trigger
       * row is on the slip in its quantity — buy the bread AND the milk, then
       * both are discounted. A happy hour asks nothing of the basket.
       */
      case 'percent_off': {
        const pct = clampPct(special.discountPct)
        if (pct <= 0) break
        const deals = dealCount()
        if (deals < 1) break

        for (const row of triggers) {
          let want = deals * Math.max(row.qty, 1)
          const pool = available
            .filter(({ line }) => matches(row, line))
            .sort((a, b) => a.line.priceIncl - b.line.priceIncl)
          for (const { line, index } of pool) {
            if (want <= 0) break
            const here = Math.min(want, line.qty)
            // A partial line: four of five units at 10% is 8% off the line.
            give(index, (here / line.qty) * pct)
            want -= here
          }
        }
        claim(matching(triggers))
        break
      }

      case 'special_price': {
        const touched: { index: number }[] = []
        for (const { line, index } of available) {
          if (line.priceIncl <= 0) continue
          const rows = scope.filter((r) => matches(r, line))
          if (rows.length === 0) continue
          // A row naming the product beats one naming its whole department:
          // the specific instruction is the one the shop meant.
          const row = rows.find((r) => r.productId !== null) ?? rows[0]
          // A "special price" at or above the shelf price is not a special.
          // It must NOT claim the line — a lower-priority deal may be real.
          if (row.priceIncl <= 0 || row.priceIncl >= line.priceIncl) continue
          give(index, (1 - row.priceIncl / line.priceIncl) * 100)
          touched.push({ index })
        }
        claim(touched)
        break
      }

      case 'cheapest_free': {
        const need = Math.floor(special.triggerQty)
        if (need < 2) break
        // 0 reads as "free": a shop setting up "buy 3 get 1" thinks in terms
        // of the free one, not of a 100% discount.
        const raw = clampPct(special.discountPct)
        const dealPct = raw > 0 ? raw : 100

        const qualifying = matching(triggers)
        const totalQty = qualifying.reduce((sum, { line }) => sum + Math.max(line.qty, 0), 0)
        let dealUnits = Math.floor(totalQty / need)
        if (dealUnits < 1) break

        // Cheapest first — the customer gets the deal on the least valuable
        // units, which is what "the cheapest is free" means.
        const cheapestFirst = [...qualifying].sort((a, b) => a.line.priceIncl - b.line.priceIncl)
        for (const { line, index } of cheapestFirst) {
          if (dealUnits < 1) break
          if (line.qty <= 0) continue
          const here = Math.min(dealUnits, line.qty)
          // A partial line: three of five units free is 60% of that line.
          give(index, (here / line.qty) * dealPct)
          dealUnits -= here
        }
        // EVERY qualifying line, including the ones paying full price.
        claim(qualifying)
        break
      }

      case 'bundle_price': {
        const deals = dealCount()
        if (deals < 1 || special.bundlePriceIncl <= 0) break

        // Allocate units cheapest-first, without letting two trigger rows
        // spend the same unit twice.
        const used = new Map<number, number>()
        let allocatedValue = 0
        for (const row of triggers) {
          let want = deals * Math.max(row.qty, 1)
          const pool = available
            .filter(({ line }) => matches(row, line))
            .sort((a, b) => a.line.priceIncl - b.line.priceIncl)
          for (const { line, index } of pool) {
            if (want <= 0) break
            const spare = Math.max(line.qty, 0) - (used.get(index) ?? 0)
            if (spare <= 0) continue
            const take = Math.min(want, spare)
            used.set(index, (used.get(index) ?? 0) + take)
            allocatedValue += take * line.priceIncl
            want -= take
          }
        }

        const bundleTotal = deals * special.bundlePriceIncl
        // The bundle costs more than buying the items — do not fire, and do
        // not claim, so a lower-priority special still gets its chance.
        if (allocatedValue <= bundleTotal) break

        const fraction = 1 - bundleTotal / allocatedValue
        for (const [index, units] of used) {
          const line = lines[index]
          if (line.qty > 0) give(index, (units / line.qty) * fraction * 100)
        }
        claim(matching(triggers))
        break
      }

      /*
       * A quantity ladder: 3 for R25, 6 for R45. Greedy LARGEST tier first —
       * nine units against those tiers is one six and one three, not three
       * threes — because the bigger tier is the better deal and the ladder is
       * priced assuming it fills first. Whatever falls below the smallest
       * tier pays the shelf price.
       */
      case 'multibuy': {
        const tiers = [...special.tiers]
          .filter((t) => Math.floor(t.qty) >= 2 && t.priceIncl > 0)
          .sort((a, b) => b.qty - a.qty)
        if (tiers.length === 0) break

        const qualifying = matching(triggers)
        // Cheapest units first, the same house rule as every other combo: the
        // deal spends the least valuable units, so the discount is smallest.
        const pool = [...qualifying].sort((a, b) => a.line.priceIncl - b.line.priceIncl)
        const remaining = new Map<number, number>()
        let unitsLeft = 0
        for (const { line, index } of pool) {
          const qty = Math.max(line.qty, 0)
          remaining.set(index, qty)
          unitsLeft += qty
        }

        /** Value saved per line index, summed across every tier fired. */
        const savings = new Map<number, number>()
        let fired = false

        for (const tier of tiers) {
          const need = Math.floor(tier.qty)
          while (unitsLeft >= need) {
            const alloc: { index: number; units: number; priceIncl: number }[] = []
            let want = need
            let value = 0
            for (const { line, index } of pool) {
              if (want <= 0) break
              const spare = remaining.get(index) ?? 0
              if (spare <= 0) continue
              const take = Math.min(want, spare)
              alloc.push({ index, units: take, priceIncl: line.priceIncl })
              value += take * line.priceIncl
              want -= take
            }
            // A tier at or above what the units cost is not a deal. Do not
            // fire it — and since the units are allocated cheapest-first,
            // no later bundle of this tier would fare better.
            if (value <= tier.priceIncl) break
            const fraction = 1 - tier.priceIncl / value
            for (const a of alloc) {
              savings.set(a.index, (savings.get(a.index) ?? 0) + a.units * a.priceIncl * fraction)
              remaining.set(a.index, (remaining.get(a.index) ?? 0) - a.units)
            }
            unitsLeft -= need
            fired = true
          }
        }

        if (!fired) break
        for (const [index, saved] of savings) {
          const line = lines[index]
          const lineValue = line.priceIncl * line.qty
          if (lineValue > 0) give(index, (saved / lineValue) * 100)
        }
        // EVERY qualifying line, including units paying shelf price — the
        // same rule as cheapest_free, for the same reason.
        claim(qualifying)
        break
      }

      case 'free_item': {
        const deals = dealCount()
        if (deals < 1) break
        for (const row of rewardRows) {
          // Rewards are products. "A free department" has no meaning.
          if (row.productId === null) continue
          rewards.push({
            specialId: special.id,
            name: special.name,
            productId: row.productId,
            qty: deals * Math.max(row.qty, 1),
          })
        }
        // The triggers are claimed but not discounted — the reward IS the deal.
        claim(matching(triggers))
        break
      }

      case 'spend': {
        if (special.spendAmountIncl <= 0) break
        /*
         * Measured on the WHOLE basket at normal prices, including lines a
         * higher-priority special already claimed. What the customer brought
         * to the till is what they spent; an earlier discount should not push
         * them back under the threshold they cleared.
         */
        const gross = lines.reduce((sum, l) => sum + l.priceIncl * Math.max(l.qty, 0), 0)
        if (gross < special.spendAmountIncl) break

        const pct = clampPct(special.discountPct)
        if (pct > 0) {
          const payable = available.filter(({ line }) => line.qty > 0)
          for (const { index } of payable) give(index, pct)
          claim(payable)
        }
        for (const row of rewardRows) {
          if (row.productId === null) continue
          // NOT multiplied by how many times the threshold was cleared: a
          // R1000 basket against a R500 special is one deal, not two.
          rewards.push({
            specialId: special.id,
            name: special.name,
            productId: row.productId,
            qty: Math.max(row.qty, 1),
          })
        }
        break
      }
    }
  }

  return { lineSpecials, rewards }
}

/**
 * What actually comes off a line.
 *
 * A special and a cashier's manual discount do NOT compound — 20% by hand on
 * top of a 10% special is 20%, not 28%. Compounding is how a staff discount
 * during a promotion quietly sells below cost.
 */
export function effectiveDiscountPct(
  manualPct: number | null | undefined,
  special: AppliedSpecial | undefined,
): number {
  return Math.max(manualPct ?? 0, special?.pct ?? 0)
}
