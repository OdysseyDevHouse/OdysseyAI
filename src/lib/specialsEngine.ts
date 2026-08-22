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
 * Every shape a promotion can take.
 *
 * ── ONE FLAT LIST, AND A FORM THAT STILL ASKS TWO QUESTIONS ──────────────
 *
 * These were once a `type` of four values, one of which ("combo") carried a
 * separate `mode`. The split described how a shopkeeper TALKS about a deal —
 * "it is a combo, buy three get one free" — and the form still asks it that
 * way, using SHAPE_GROUPS below.
 *
 * But no code ever worked in those terms. Every consumer collapsed the pair
 * back into one value on its first line, and five reconstructions of one fact
 * are five chances to reconstruct it differently. Worse, the pair could
 * disagree: a happy hour carrying a leftover combo mode was a row that read as
 * nonsense, and `saveSpecial` had to blank it by hand on every write.
 *
 * So the DATA is flat and the QUESTION stays in two steps, which is where it
 * always belonged.
 */
export const SPECIAL_SHAPES = [
  'happy_hour',
  'special_price',
  'cheapest_free',
  'free_item',
  'percent_off',
  'bundle_price',
  'multibuy',
  'spend',
  'quantity_break',
  'second_at_pct',
  'mix_and_match',
  'free_delivery',
  'bonus_points',
] as const
export type SpecialShape = (typeof SPECIAL_SHAPES)[number]

export const SHAPE_LABEL: Record<SpecialShape, string> = {
  happy_hour: 'Happy hour',
  special_price: 'Special price',
  cheapest_free: 'Buy X, cheapest % off',
  free_item: 'Buy these, get one free',
  percent_off: 'Buy these, get % off',
  bundle_price: 'Bundle price',
  multibuy: 'Multibuy tiers',
  spend: 'Spend & get',
  quantity_break: 'Quantity break',
  second_at_pct: 'Second one % off',
  mix_and_match: 'Mix & match',
  free_delivery: 'Free delivery',
  bonus_points: 'Bonus points',
}

/**
 * How the form groups the shapes into its two questions.
 *
 * PRESENTATION ONLY. Nothing in the engine reads this — the arithmetic switches
 * on the shape itself. It exists so the form can go on asking "what kind of
 * special?" and then, when the answer is a combo, "what does the combo do?",
 * without the database having to keep two columns that can contradict.
 */
export const SHAPE_GROUPS = [
  { key: 'happy_hour', label: 'Happy hour', shapes: ['happy_hour'] },
  { key: 'special_price', label: 'Special price', shapes: ['special_price'] },
  {
    key: 'combo',
    label: 'Combo deal',
    shapes: [
      'cheapest_free',
      'free_item',
      'percent_off',
      'bundle_price',
      'multibuy',
      'quantity_break',
      'second_at_pct',
      'mix_and_match',
    ],
  },
  { key: 'spend', label: 'Spend & get', shapes: ['spend', 'free_delivery', 'bonus_points'] },
] as const satisfies readonly {
  key: string
  label: string
  shapes: readonly SpecialShape[]
}[]

/** Which group a shape belongs to, for a form drawing the first question. */
export function groupOf(shape: SpecialShape): (typeof SHAPE_GROUPS)[number]['key'] {
  return (
    SHAPE_GROUPS.find((g) => (g.shapes as readonly string[]).includes(shape))?.key ?? 'happy_hour'
  )
}

/**
 * One rung of a quantity ladder.
 *
 * Two shapes ladder, and they ladder different things. `multibuy` prices a
 * quantity — three for R25 — and reads `priceIncl`. `quantity_break` discounts
 * one — ten or more at 5% off — and reads `discountPct`. Whichever the shape
 * does not use stays at zero.
 *
 * Two fields rather than one read differently depending on the parent: a single
 * column holding rands in some rows and percentages in others is a column every
 * reader must ask the parent about first, and the first reader that forgets
 * prices a deal at five rand instead of five percent.
 */
export type SpecialTier = {
  qty: number
  priceIncl: number
  discountPct: number
}

/** The shapes that read `tiers`. */
export const LADDERED: ReadonlySet<SpecialShape> = new Set(['multibuy', 'quantity_break'])

/** Who a promotion is for. See 212. */
export const AUDIENCES = ['everyone', 'account', 'member', 'group'] as const
export type Audience = (typeof AUDIENCES)[number]

export const AUDIENCE_LABEL: Record<Audience, string> = {
  everyone: 'Everyone',
  account: 'Account customers',
  member: 'Loyalty members',
  group: 'One customer group',
}

/** Where a sale is happening, for the channel switches. */
export type Channel = 'in_store' | 'online'

/**
 * Who the sale is for, so a targeted special knows whether to fire.
 *
 * ── OPTIONAL, AND ABSENT MEANS "A WALK-IN AT THE COUNTER" ────────────────
 *
 * Every caller that predates targeting passes nothing, and gets exactly the
 * behaviour it had: an untargeted special fires, a targeted one does not. That
 * is the safe direction — a promotion meant for account customers must not
 * leak to a walk-in because a screen forgot to say who was standing there.
 */
export type PricingContext = {
  /** The account attached to the sale, if any. */
  accountType?: string | null
  /** Which customer group that account is in. */
  groupId?: number | null
  /** Whether a loyalty member is attached. */
  isMember?: boolean
  /** Defaults to in-store. */
  channel?: Channel
}

/**
 * May this special fire for this sale?
 *
 * Exported because the till wants to EXPLAIN a promotion the customer nearly
 * qualified for — "attach the account and this applies" is worth saying, and
 * cannot be said by a function that only returns a price.
 */
export function specialReaches(special: Special, context: PricingContext | undefined): boolean {
  const channel = context?.channel ?? 'in_store'
  if (channel === 'in_store' && special.runsInStore === false) return false
  if (channel === 'online' && special.runsOnline === false) return false

  switch (special.audience ?? 'everyone') {
    case 'everyone':
      return true
    case 'account':
      /*
       * An account, not merely a name typed on the sale.
       *
       * A cash account is still an account — the shop opened a record for that
       * customer, which is what "account customers only" means to the person
       * setting the promotion up. `accountType` is present exactly when a real
       * customer row is attached, so its presence IS the test.
       */
      return !!context?.accountType
    case 'member':
      return !!context?.isMember
    case 'group':
      // A special aimed at a group nobody is in reaches nobody, which is what
      // a deleted group leaves behind (212 sets the id to NULL rather than
      // deleting the promotion).
      return (
        special.audienceGroupId != null && context?.groupId === special.audienceGroupId
      )
  }
}


export type SpecialRole = 'scope' | 'trigger' | 'reward'

/**
 * Which item roles each shape actually reads.
 *
 * A table rather than a chain of conditionals, so adding a shape is a line here
 * and a compile error if it is forgotten — where a chain silently falls through
 * to whatever its last branch happened to be.
 *
 * In the pure engine so the FORM and the SERVER read the same table. Both drop
 * the rows a shape does not use — the form on the way out, the server on the
 * way in — and two copies of this list would be two answers to "does a bundle
 * keep its scope rows".
 */
export const ROLES_USED: Record<SpecialShape, SpecialRole[]> = {
  // A scope of nothing means the whole store, so these two carry scope only.
  happy_hour: ['scope'],
  special_price: ['scope'],

  // The combos count trigger products into deals.
  cheapest_free: ['trigger'],
  percent_off: ['trigger'],
  bundle_price: ['trigger'],
  multibuy: ['trigger'],
  quantity_break: ['trigger'],
  second_at_pct: ['trigger'],
  mix_and_match: ['trigger'],
  // The one combo that also hands something back.
  free_item: ['trigger', 'reward'],

  // The threshold deals ask nothing of WHICH products, only of the total.
  spend: ['reward'],
  free_delivery: [],
  bonus_points: [],
}

export type SpecialItem = {
  role: SpecialRole
  /** Exactly one of these is set. */
  productId: number | null
  departmentId: number | null
  qty: number
  /** special_price only: what this product is marked down to. */
  priceIncl: number
}

/**
 * The ceilings a promotion is held to.
 *
 * ── THEY CLAMP RATHER THAN CANCEL ────────────────────────────────────────
 *
 * When a guard bites, the discount is REDUCED and the line is still claimed.
 * Cancelling the special instead would release the line to whatever promotion
 * sits below it — very likely the one the guard was protecting against. A
 * smaller discount is a bad day; a different, unguarded special firing in its
 * place is a worse one.
 *
 * ── AND THEY NEED WHAT THE TILL ALREADY HAS ──────────────────────────────
 *
 * The margin guards read `unitCostExcl` and `maxDiscountPct` off the basket
 * line. Both already ride on every till line and are cached offline, so this
 * costs no new plumbing — but a caller that does not supply them (the
 * storefront, a test) has those guards SKIPPED rather than guessed at. Refusing
 * to discount because a cost is unknown would silently stop promotions on the
 * shop front.
 */
export type SpecialGuards = {
  /** How many times one sale may complete this deal. 0 is unlimited. */
  maxDealsPerSale: number
  /** Hold the discount to the product's own `maxDiscountPct` ceiling. */
  respectMaxDiscount: boolean
  /** Never take a line below this gross margin. 0 is off. */
  minMarginPct: number
  /** Never sell below cost. */
  neverBelowCost: boolean
}

export type Special = {
  id: number
  name: string
  shape: SpecialShape
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
  triggerQty: number
  bundlePriceIncl: number
  spendAmountIncl: number
  priority: number
  /**
   * What stops this promotion running away. See 211.
   *
   * All of it optional so that a Special built by a test or a form says nothing
   * about guards rather than each having to say "none", and absent always means
   * "no limit" — the behaviour before any of this existed.
   */
  guards?: SpecialGuards
  /**
   * Who it is for, and where it runs. See 212 and `specialReaches`.
   *
   * All optional, and absent means the behaviour before targeting existed:
   * everyone, both channels. `runsInStore`/`runsOnline` are checked against
   * `=== false` precisely so that `undefined` reads as "yes".
   */
  audience?: Audience
  audienceGroupId?: number | null
  runsInStore?: boolean
  runsOnline?: boolean
  /**
   * `free_item` only: does the reward scale with the number of deals? See 214.
   *
   * Absent means yes, which is what the code did before the flag existed.
   */
  rewardPerDeal?: boolean
  /**
   * `bonus_points` only: how much faster loyalty points accrue. See 213.
   *
   * Absent, and 1, both mean "no change" — every other shape leaves it alone.
   */
  pointsMultiplier?: number
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
  /**
   * What one of these cost, EXCLUDING VAT. For the margin guards.
   *
   * Optional, and absent means those guards are skipped rather than guessed at
   * — the storefront prices a shelf without costs in hand, and refusing to
   * discount because a cost is unknown would silently stop promotions there.
   * The till already carries this on every line, cached offline.
   */
  costExcl?: number
  /**
   * The product's own discount ceiling, as the line editor enforces it.
   *
   * Read only when a special asks for it. Zero means "no discount allowed" for
   * a cashier — the products.ts rule — so a guard reading zero holds the
   * special to nothing, which is exactly what that setting says.
   */
  maxDiscountPct?: number
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
  /**
   * A `free_delivery` special cleared its threshold.
   *
   * Reported rather than applied, because the delivery fee is not part of the
   * basket this engine prices — it is worked out from the address at checkout.
   * The caller waives the fee exactly where a free-delivery discount code
   * already does.
   */
  freeDelivery: boolean
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
  shape: SpecialShape
  isActive: boolean
  startsAt: string
  endsAt: string
  dailyStart: string
  dailyEnd: string
  daysOfWeek: string
  discountPct: number
  triggerQty: number
  bundlePriceIncl: number
  spendAmountIncl: number
  /** See SpecialGuards. Absent means no limits, as it did before 211. */
  guards?: SpecialGuards
  /** How many times the promotion may be used in total. Null is unlimited. */
  maxRedemptions?: number | null
  /** Who it is for, and where it runs. See 212. */
  audience?: Audience
  audienceGroupId?: number | null
  runsInStore?: boolean
  runsOnline?: boolean
  /** `bonus_points` only. See 213. */
  pointsMultiplier?: number
  /** `free_item` only. See 214. */
  rewardPerDeal?: boolean
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
  if (!(SPECIAL_SHAPES as readonly string[]).includes(input.shape)) return 'Unknown special type'

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

  /*
   * The guards. Checked before the shape, because a nonsensical ceiling is
   * wrong whatever kind of deal it is guarding.
   */
  if (input.guards) {
    const g = input.guards
    if (g.maxDealsPerSale < 0 || !Number.isFinite(g.maxDealsPerSale)) {
      return 'The deals-per-sale limit cannot be negative — use 0 for no limit'
    }
    if (g.minMarginPct < 0 || g.minMarginPct >= 100) {
      return 'The minimum margin must be between 0 and 100 percent'
    }
  }
  if (input.maxRedemptions !== null && input.maxRedemptions !== undefined) {
    if (input.maxRedemptions < 1 || !Number.isFinite(input.maxRedemptions)) {
      // Zero would be a promotion that is switched on and cannot fire, which is
      // what the Active switch is for and says far more clearly.
      return 'The total-uses limit must be at least 1 — leave it blank for no limit'
    }
  }

  const scope = input.items.filter((i) => i.role === 'scope')
  const triggers = input.items.filter((i) => i.role === 'trigger')
  const rewards = input.items.filter((i) => i.role === 'reward')
  const pct = 'The discount must be between 0 and 100 percent'

  switch (input.shape) {
    case 'happy_hour':
      if (input.discountPct <= 0 || input.discountPct > 100) return pct
      /* An empty scope IS "the whole store" — see 210 for why the old
         applies_to_all flag went. So there is nothing to refuse here: a happy
         hour naming nothing is a store-wide one, which is a real thing to want
         and used to need a separate switch to say. */
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

    case 'bonus_points':
      if (!input.pointsMultiplier || input.pointsMultiplier <= 1) {
        // Exactly 1 is not a promotion, it is the ordinary rate — and below 1
        // would take points away from someone who was already owed them.
        return 'Set how much faster points are earned — 2 for double points'
      }
      if (input.pointsMultiplier > 100) return 'That points multiplier is too large'
      break

    case 'quantity_break': {
      if (triggers.length === 0) return 'Add the products the quantity breaks apply to'
      if (input.tiers.length === 0) return 'Add at least one break — a quantity and its discount'
      if (input.tiers.some((t) => Math.floor(t.qty) < 2)) {
        return 'A break needs at least 2 units — one unit is just the shelf price'
      }
      if (input.tiers.some((t) => t.discountPct <= 0 || t.discountPct > 100)) {
        return 'Every break needs a discount between 0 and 100 percent'
      }
      const qtys = input.tiers.map((t) => Math.floor(t.qty))
      if (new Set(qtys).size !== qtys.length) {
        return 'Two breaks name the same quantity — keep one of them'
      }
      break
    }

    case 'second_at_pct':
      if (input.discountPct <= 0 || input.discountPct > 100) return pct
      if (triggers.length === 0) return 'Add the products the deal applies to'
      break

    case 'mix_and_match':
      if (input.bundlePriceIncl <= 0) return 'Set the price for the group'
      if (input.triggerQty < 2) return 'How many must they pick? At least 2'
      if (triggers.length === 0) return 'Add the products they can choose from'
      break

    case 'free_delivery':
      if (input.spendAmountIncl <= 0) return 'Set the amount the customer must spend'
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

/** How many deals this special is allowed to complete on one sale. */
function capDeals(deals: number, guards: SpecialGuards | undefined): number {
  const cap = Math.floor(guards?.maxDealsPerSale ?? 0)
  // Zero is "unlimited", not "none" — a shop that has set no limit has not
  // asked for a promotion that never fires.
  return cap > 0 ? Math.min(deals, cap) : deals
}

/**
 * The discount this line may actually be given, after the guards.
 *
 * ── IT RETURNS A SMALLER NUMBER, NEVER ZERO-BY-REFUSAL ───────────────────
 *
 * A guard that bites reduces the percentage. The caller still claims the line,
 * so the promotion below does not inherit it — see SpecialGuards on why that
 * matters more than it looks.
 *
 * ── A MISSING FACT SKIPS ITS GUARD ───────────────────────────────────────
 *
 * The margin guards need a cost, and the ceiling guard needs the product's own
 * limit. Where the caller has not supplied one — the storefront pricing a shelf
 * — that guard is skipped rather than assumed. Treating an unknown cost as zero
 * would refuse every discount on the shop front; treating it as infinite would
 * be a guard that never guards. Skipping is the honest third answer, and the
 * till, which is where money actually changes hands, always has both.
 */
function guardPct(
  pct: number,
  line: BasketLine | undefined,
  guards: SpecialGuards | undefined,
): number {
  let held = clampPct(pct)
  if (held <= 0 || !guards || !line) return held

  if (guards.respectMaxDiscount && line.maxDiscountPct !== undefined) {
    // Zero means "no discount allowed" for a cashier — the products.ts rule —
    // so a special asked to respect it is held to nothing as well. A shop that
    // set that ceiling and then asked for it to be respected has said this
    // twice.
    held = Math.min(held, Math.max(line.maxDiscountPct, 0))
  }

  const cost = line.costExcl
  if (cost !== undefined && cost > 0 && line.priceIncl > 0) {
    /*
     * The margin guards work in the line's own inclusive money.
     *
     * `costExcl` excludes VAT and `priceIncl` includes it, so comparing them
     * directly would understate the margin by the VAT rate and refuse
     * discounts a shop is perfectly happy with. The engine does not know the
     * rate — it deals in percentages, by design — so the comparison is made
     * against the ratio the caller can actually verify: cost against what the
     * customer pays. That is CONSERVATIVE, protecting slightly more margin
     * than asked for, which is the right direction for a guard to be wrong in.
     */
    const floorFromCost = guards.neverBelowCost ? cost : 0
    const floorFromMargin =
      guards.minMarginPct > 0 ? cost / (1 - Math.min(guards.minMarginPct, 99.9) / 100) : 0
    const floor = Math.max(floorFromCost, floorFromMargin)

    if (floor > 0) {
      // The most that can come off before the price reaches the floor. Negative
      // when the shelf price is already under it, and then nothing may come off
      // at all — the shop is already selling at a loss, and a promotion must
      // not deepen it.
      const allowed = ((line.priceIncl - floor) / line.priceIncl) * 100
      held = Math.min(held, Math.max(allowed, 0))
    }
  }

  return held
}

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
  /**
   * Who the sale is for. Omitted means a walk-in at the counter — see
   * PricingContext on why that is the safe default rather than a permissive one.
   */
  context?: PricingContext,
): SpecialsResult {
  const lineSpecials: (AppliedSpecial | undefined)[] = new Array(lines.length).fill(undefined)
  const rewards: SpecialReward[] = []
  let freeDelivery = false
  /** A line a higher-priority special has already involved. */
  const claimed = new Array(lines.length).fill(false)

  const ordered = [...specials].sort((a, b) => a.priority - b.priority || a.id - b.id)

  for (const special of ordered) {
    if (!specialActiveAt(special, now)) continue
    /*
     * Not for this customer, or not for this channel.
     *
     * `continue` rather than any kind of partial application, and crucially
     * WITHOUT claiming: a promotion the shopper does not qualify for must leave
     * its lines free for the next one down. That is the opposite of the guards
     * above, which clamp and claim — because a guarded special did fire and
     * this one never applied at all.
     */
    if (!specialReaches(special, context)) continue

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
    if (available.length === 0 && special.shape !== 'spend') continue

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
      if (!Number.isFinite(deals)) return 0
      // "Limit 2 per customer". Without it a combo repeats without end, and
      // three hundred tins earns a hundred free ones.
      return capDeals(deals, special.guards)
    }

    const claim = (entries: { index: number }[]) => {
      for (const { index } of entries) claimed[index] = true
    }

    const give = (index: number, pct: number) => {
      /*
       * EVERY discount this engine grants passes through here, which is why the
       * guards live here rather than in each of the nine shapes. A guard added
       * to `happy_hour` and forgotten in `multibuy` would be a ceiling that
       * holds until somebody picks the other shape.
       */
      const held = guardPct(pct, lines[index], special.guards)
      if (held <= 0) return
      lineSpecials[index] = keepBest(lineSpecials[index], {
        specialId: special.id,
        name: special.name,
        pct: held,
      })
    }

    switch (special.shape) {
      case 'happy_hour': {
        const pct = clampPct(special.discountPct)
        if (pct <= 0) break
        // No scope at all means the whole store. The rows someone picked are
        // the limit; picking none is not picking nothing, it is picking
        // everything — which is what a store-wide sale is.
        const hit = scope.length === 0 ? available : matching(scope)
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

      /*
       * "Second one half price" IS "buy 2, cheapest at 50% off".
       *
       * The same arithmetic, reached by a name a shopkeeper actually uses. It
       * was always possible to express with cheapest_free at quantity 2, and
       * nobody ever found it there — which is a discoverability problem, not an
       * arithmetic one, so it is fixed with a label rather than a second
       * implementation that could disagree about the edges.
       */
      case 'second_at_pct':
      case 'cheapest_free': {
        const need =
          special.shape === 'second_at_pct' ? 2 : Math.floor(special.triggerQty)
        if (need < 2) break
        // 0 reads as "free": a shop setting up "buy 3 get 1" thinks in terms
        // of the free one, not of a 100% discount.
        const raw = clampPct(special.discountPct)
        const dealPct = raw > 0 ? raw : 100

        const qualifying = matching(triggers)
        const totalQty = qualifying.reduce((sum, { line }) => sum + Math.max(line.qty, 0), 0)
        // Capped here as well as in dealCount(): this shape counts its own
        // groups rather than going through that helper, so the limit has to be
        // applied on both paths or "limit 2" would hold for a bundle and not
        // for a three-for-two.
        let dealUnits = capDeals(Math.floor(totalQty / need), special.guards)
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
       * "Any 3 from this shelf for R100."
       *
       * ── WHY IT IS NOT bundle_price WITH ONE ROW ──────────────────────────
       *
       * It nearly is, and that was the argument for not building it: a bundle
       * with a single department row at quantity 3 already does this. But
       * nobody found it — a shopkeeper looking for "mix and match" does not
       * think to express it as a one-row bundle, and a feature nobody can find
       * is a feature the shop does not have.
       *
       * It differs in one real way as well. A bundle requires EVERY row in its
       * quantity — bread AND milk. This counts across all its rows together, so
       * three of anything named qualifies, which is what "any three" means and
       * what a bundle cannot say however its rows are arranged.
       */
      case 'mix_and_match': {
        const need = Math.floor(special.triggerQty)
        if (need < 2 || special.bundlePriceIncl <= 0) break

        const qualifying = matching(triggers)
        const totalQty = qualifying.reduce((sum, { line }) => sum + Math.max(line.qty, 0), 0)
        const groups = capDeals(Math.floor(totalQty / need), special.guards)
        if (groups < 1) break

        /*
         * Allocate CHEAPEST first, the same house rule every other combo
         * follows: the deal spends the least valuable units, so the customer
         * pays the group price for the cheapest things that qualify and the
         * expensive ones stay at shelf price. Filling with the dearest units
         * would hand away more than the shop intended on every mixed basket.
         */
        const pool = [...qualifying].sort((a, b) => a.line.priceIncl - b.line.priceIncl)
        let want = groups * need
        let allocatedValue = 0
        const used = new Map<number, number>()
        for (const { line, index } of pool) {
          if (want <= 0) break
          const take = Math.min(want, Math.max(line.qty, 0))
          if (take <= 0) continue
          used.set(index, take)
          allocatedValue += take * line.priceIncl
          want -= take
        }

        const groupTotal = groups * special.bundlePriceIncl
        // Costs more than buying them separately — do not fire, and do not
        // claim, so a lower-priority special still gets its chance.
        if (allocatedValue <= groupTotal) break

        const fraction = 1 - groupTotal / allocatedValue
        for (const [index, units] of used) {
          const line = lines[index]
          if (line.qty > 0) give(index, (units / line.qty) * fraction * 100)
        }
        // EVERY qualifying line, including units paying shelf price — the same
        // rule as cheapest_free, for the same reason.
        claim(qualifying)
        break
      }

      /*
       * A ladder of PERCENTAGES rather than prices: 10 or more at 5% off, 50 or
       * more at 10%. How trade and wholesale actually price, and not
       * expressible by multibuy, which ladders a price for an exact quantity.
       *
       * Unlike multibuy it does not consume units into groups. A break is a
       * threshold: cross it and EVERY qualifying unit gets that rate. Buying 11
       * against a 10-break discounts all eleven, not ten with one at shelf
       * price — which is what a customer buying in bulk expects, and what the
       * word "break" means in a trade price list.
       */
      case 'quantity_break': {
        const breaks = [...special.tiers]
          .filter((t) => Math.floor(t.qty) >= 2 && t.discountPct > 0)
          // Biggest threshold first, so the best rate the basket has earned is
          // the one found.
          .sort((a, b) => b.qty - a.qty)
        if (breaks.length === 0) break

        const qualifying = matching(triggers)
        const totalQty = qualifying.reduce((sum, { line }) => sum + Math.max(line.qty, 0), 0)
        const earned = breaks.find((t) => totalQty >= Math.floor(t.qty))
        if (!earned) break

        const rate = clampPct(earned.discountPct)
        if (rate <= 0) break
        for (const { index } of qualifying) give(index, rate)
        claim(qualifying)
        break
      }

      /*
       * "Free delivery over R500."
       *
       * It touches no line — delivery is not goods, and the fee is not part of
       * the basket the engine sees. So this claims nothing and discounts
       * nothing; it only reports, through `freeDelivery` on the result, that
       * the threshold was cleared. The checkout honours it exactly where a
       * free-delivery discount code already is (storefront.ts).
       *
       * In store it does nothing, which is correct: nobody delivers a sale
       * they carried out of the shop.
       */
      case 'free_delivery': {
        if (special.spendAmountIncl <= 0) break
        // The WHOLE basket at normal prices, the same measure `spend` uses —
        // an earlier discount should not push a customer back under a
        // threshold they cleared.
        const gross = lines.reduce((sum, l) => sum + l.priceIncl * Math.max(l.qty, 0), 0)
        if (gross < special.spendAmountIncl) break
        freeDelivery = true
        break
      }

      /*
       * Changes points, not prices. Answered by `pointsMultiplierFor` against
       * the same list, and deliberately inert here: with no line to claim it
       * must take none, or it would block a real discount beneath it from
       * reaching the same goods.
       */
      case 'bonus_points':
        break

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
        /*
         * How many rungs may still fire, across every tier.
         *
         * A ladder repeats: nine units against a three-for tier is three
         * groups, and nothing stopped ninety units becoming thirty. The cap
         * counts RUNGS rather than tiers, so "limit 2" means two groups at the
         * laddered price and the rest at shelf price — which is what a shop
         * setting that limit means by it.
         */
        let rungsLeft = capDeals(Number.MAX_SAFE_INTEGER, special.guards)

        for (const tier of tiers) {
          const need = Math.floor(tier.qty)
          while (unitsLeft >= need && rungsLeft > 0) {
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
            rungsLeft -= 1
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
            /*
             * Scales with the deal count by default (214): six pizzas against a
             * buy-two deal is three breads. Switched off, the reward is handed
             * over ONCE however many deals the basket completes — which is what
             * "have a coffee on us" means, and what a shop running a
             * thank-you rather than a bulk offer intends.
             */
            qty: (special.rewardPerDeal === false ? 1 : deals) * Math.max(row.qty, 1),
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

  return { lineSpecials, rewards, freeDelivery }
}

/**
 * How much faster points accrue right now, from any running bonus promotion.
 *
 * ── IT DOES NOT GO THROUGH computeSpecials ───────────────────────────────
 *
 * A bonus-points special discounts nothing and gives no product away, so it has
 * no line to claim and must never take one — claiming would block a real
 * promotion beneath it from reaching the same goods. It is answered separately,
 * from the same list, against the same clock and audience rules.
 *
 * ── AND TWO RUNNING AT ONCE TAKE THE BIGGER, NOT THE PRODUCT ─────────────
 *
 * Unlike the tier multiplier, which stacks with this (see computeEarn), two
 * promotions are two attempts at the same thing. A shop running a
 * double-points weekend and a triple-points launch over one Saturday means the
 * better of the two, not six times — the same "one promotion wins" rule the
 * rest of the engine follows.
 */
export function pointsMultiplierFor(
  specials: Special[],
  now: Date,
  context?: PricingContext,
): number {
  let best = 1
  for (const special of specials) {
    if (special.shape !== 'bonus_points') continue
    if (!specialActiveAt(special, now)) continue
    if (!specialReaches(special, context)) continue
    // Below 1 is a misconfiguration, not a promotion — a bonus cannot take
    // points away from someone who was already owed them.
    best = Math.max(best, Number(special.pointsMultiplier) || 1)
  }
  return best
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
