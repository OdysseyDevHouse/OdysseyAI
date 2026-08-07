import { round } from './decimals'

/**
 * The loyalty rules, as pure functions.
 *
 * Split out of site/loyalty.ts for the reason tenderMath.ts is split out of
 * site/tenderTypes.ts: that module is `server-only` because it talks to the
 * database, while the till has to show "this basket earns 42 points" and
 * "1 240 points is worth R124" as the cashier rings items up. Duplicating the
 * arithmetic on the client is how the slip and the ledger end up disagreeing
 * about what a customer earned.
 *
 * Everything here is deterministic and takes its inputs explicitly. No dates
 * are read from the clock — `now` is always a parameter, so a test can place
 * itself in time and an expiry run is reproducible.
 */

/* ── Settings ────────────────────────────────────────────────────────────── */

/** Whole balance lapses after idle months | each batch lapses on its own age. */
export type ExpiryMode = 'never' | 'activity' | 'earn'
/** Tier standing measured over a moving window, or over everything ever spent. */
export type TierBasis = 'rolling' | 'lifetime'

export type LoyaltySettings = {
  enabled: boolean
  /**
   * Rand of spend that earns ONE point. 1 means R1 = 1 point.
   *
   * Kept as "rand per point" rather than "points per rand" because that is how
   * a shop owner states it out loud, and an inverted rate here silently
   * multiplies every award by 100.
   */
  earnRate: number
  /**
   * Points needed to fund R1 off a sale. 10 means a point is worth 10c, so a
   * programme earning 1 point per rand returns 10% to the customer.
   */
  redeemRate: number
  /** A floor, so the till is not asked to spend three points. 0 = no floor. */
  minRedeemPoints: number
  /** Whether a discounted line still earns. Off means promotions do not stack. */
  earnOnDiscounted: boolean
  expiryMode: ExpiryMode
  expiryMonths: number
  tierBasis: TierBasis
  tierWindowMonths: number
  /** Months an already-earned tier survives a fall in qualifying spend. */
  tierGraceMonths: number
}

export const LOYALTY_DEFAULTS: LoyaltySettings = {
  enabled: false,
  earnRate: 1,
  redeemRate: 10,
  minRedeemPoints: 0,
  earnOnDiscounted: true,
  expiryMode: 'activity',
  expiryMonths: 12,
  tierBasis: 'rolling',
  tierWindowMonths: 12,
  tierGraceMonths: 12,
}

/* ── Tiers ───────────────────────────────────────────────────────────────── */

export type LoyaltyTier = {
  id: number
  name: string
  step: number
  qualifyingSpend: number
  multiplier: number
  discountPct: number
  color: string
  isActive: boolean
}

/**
 * The highest tier the given spend qualifies for.
 *
 * Walks the ladder from the top down so a customer always lands in the best
 * tier they have earned, regardless of the order rows arrive in.
 */
export function tierForSpend(tiers: readonly LoyaltyTier[], qualifyingSpend: number): LoyaltyTier | null {
  const ladder = tiers
    .filter((t) => t.isActive)
    .slice()
    .sort((a, b) => b.qualifyingSpend - a.qualifyingSpend)

  return ladder.find((t) => qualifyingSpend >= t.qualifyingSpend) ?? null
}

/** The next rung up, and what it would take to reach it. Null at the top. */
export function nextTier(
  tiers: readonly LoyaltyTier[],
  qualifyingSpend: number,
): { tier: LoyaltyTier; shortfall: number } | null {
  const above = tiers
    .filter((t) => t.isActive && t.qualifyingSpend > qualifyingSpend)
    .sort((a, b) => a.qualifyingSpend - b.qualifyingSpend)

  const tier = above[0]
  return tier ? { tier, shortfall: round(tier.qualifyingSpend - qualifyingSpend, 2) } : null
}

/* ── Earning ─────────────────────────────────────────────────────────────── */

/** One basket line, reduced to only what earning cares about. */
export type EarnLine = {
  /** Post-discount, VAT-inclusive value of the line. */
  lineTotalIncl: number
  /** Whether the line was discounted at all. */
  discounted: boolean
}

export type EarnResult = {
  /** Points to grant. Always a whole number. */
  points: number
  /** The rand value they were earned on — what tier standing sums. */
  basisAmount: number
}

/**
 * What a basket earns.
 *
 * TWO RULES worth stating, because both are easy to get subtly wrong:
 *
 *   POINTS ROUND DOWN. A customer who expected 12 and got 13 has been given
 *   money; one who expected 12 and got 12 is simply correct. Rounding up on
 *   every sale is a real, compounding cost.
 *
 *   THE PART PAID WITH POINTS EARNS NOTHING. Otherwise points buy points, and a
 *   large enough balance funds itself forever. `fundedAmount` is that slice —
 *   points redeemed plus any rand-value voucher — and it comes off the basis
 *   before anything is multiplied.
 */
export function computeEarn(
  lines: readonly EarnLine[],
  settings: LoyaltySettings,
  tier: LoyaltyTier | null,
  fundedAmount = 0,
): EarnResult {
  if (!settings.enabled || settings.earnRate <= 0) return { points: 0, basisAmount: 0 }

  let basis = 0
  for (const line of lines) {
    if (line.discounted && !settings.earnOnDiscounted) continue
    basis = round(basis + line.lineTotalIncl, 2)
  }

  // A refund basket is negative; it earns nothing rather than deducting twice
  // (the reversal of the original sale is what claws points back).
  basis = round(Math.max(0, basis - Math.max(0, fundedAmount)), 2)
  if (basis <= 0) return { points: 0, basisAmount: 0 }

  const multiplier = tier?.multiplier ?? 1
  const points = Math.floor((basis / settings.earnRate) * multiplier)

  return { points: Math.max(0, points), basisAmount: basis }
}

/* ── Redeeming ───────────────────────────────────────────────────────────── */

/** What a points balance is worth in rand. Rounds DOWN to the cent. */
export function pointsToRand(points: number, settings: LoyaltySettings): number {
  if (settings.redeemRate <= 0 || points <= 0) return 0
  return Math.floor((points / settings.redeemRate) * 100) / 100
}

/**
 * Points needed to fund a rand amount. Rounds UP.
 *
 * Up, not down, because the customer is receiving the rand: charging the
 * rounded-down points would hand out a fraction of a cent on every redemption.
 * The value is snapped to six decimals first — `0.1 * 3` is 0.30000000000000004
 * in IEEE-754, and without the snap that ceilings to one point too many.
 */
export function randToPoints(rand: number, settings: LoyaltySettings): number {
  if (settings.redeemRate <= 0 || rand <= 0) return 0
  return Math.ceil(round(rand * settings.redeemRate, 6))
}

/**
 * The most of `amountDue` a balance may settle.
 *
 * Capped by the balance, by what is actually owed, and refused entirely below
 * the minimum — a floor that is not enforced here would be enforced by the
 * server after the cashier had already promised the customer a discount.
 */
export function maxRedeemableRand(
  points: number,
  amountDue: number,
  settings: LoyaltySettings,
): number {
  if (!settings.enabled) return 0
  if (points < settings.minRedeemPoints) return 0
  return round(Math.min(pointsToRand(points, settings), Math.max(0, amountDue)), 2)
}

/* ── Punch cards ─────────────────────────────────────────────────────────── */

export type CardRewardType = 'free_item' | 'value' | 'points'

export type LoyaltyCard = {
  id: number
  name: string
  isActive: boolean
  requiredStamps: number
  rewardType: CardRewardType
  rewardProductId: number | null
  rewardProductName: string | null
  rewardValue: number
  oneStampPerSale: boolean
  minLineAmount: number
  voucherValidDays: number
  startsOn: string | null
  endsOn: string | null
  /** Empty means the card earns on anything. */
  productIds: number[]
  departmentIds: number[]
}

/** Whether a card is running on a given day. */
export function cardActiveOn(card: LoyaltyCard, on: Date): boolean {
  if (!card.isActive) return false
  const day = on.toISOString().slice(0, 10)
  if (card.startsOn && day < card.startsOn) return false
  if (card.endsOn && day > card.endsOn) return false
  return true
}

/** A basket line, reduced to what stamping cares about. */
export type StampLine = {
  productId: number | null
  departmentId: number | null
  qty: number
  lineTotalIncl: number
}

/**
 * How many stamps a basket earns on one card.
 *
 * `oneStampPerSale` is the ordinary coffee-card rule and the default: a trolley
 * of ten tins earns ONE stamp, not a completed card. Turning it off stamps per
 * qualifying unit, for a card that genuinely means "every tenth item free".
 */
export function stampsForBasket(lines: readonly StampLine[], card: LoyaltyCard, on: Date): number {
  if (!cardActiveOn(card, on)) return 0

  const scoped = card.productIds.length > 0 || card.departmentIds.length > 0

  let units = 0
  for (const line of lines) {
    if (line.qty <= 0) continue
    if (line.lineTotalIncl < card.minLineAmount) continue

    if (scoped) {
      const matches =
        (line.productId !== null && card.productIds.includes(line.productId)) ||
        (line.departmentId !== null && card.departmentIds.includes(line.departmentId))
      if (!matches) continue
    }

    units += Math.floor(line.qty)
  }

  if (units <= 0) return 0
  return card.oneStampPerSale ? 1 : units
}

/**
 * How many cards a stamp count completes, and what is left over.
 *
 * The remainder CARRIES: eleven stamps on a ten-stamp card is one reward and
 * one stamp towards the next, not one reward and a discarded stamp.
 */
export function cardCompletions(
  totalStamps: number,
  requiredStamps: number,
): { completed: number; progress: number } {
  if (requiredStamps <= 0) return { completed: 0, progress: 0 }
  return {
    completed: Math.floor(totalStamps / requiredStamps),
    progress: totalStamps % requiredStamps,
  }
}

/* ── Voucher codes ───────────────────────────────────────────────────────── */

/**
 * No vowels, so a code can never spell a word — including an offensive one on a
 * customer's slip. No 0/O, 1/I, 5/S or Z either: those are the pairs people
 * misread and then phone about.
 */
export const VOUCHER_ALPHABET = 'BCDFGHJKLMNPQRTVWXY2346789'
export const VOUCHER_CODE_LENGTH = 8

/* ── Validation ──────────────────────────────────────────────────────────── */

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Normalises settings off a form.
 *
 * Returns the cleaned object or a single sentence naming what is wrong — the
 * same shape the rest of the app's validators use, so a screen can show it
 * without translating anything.
 */
export function cleanSettings(raw: Partial<LoyaltySettings>): LoyaltySettings | { error: string } {
  const earnRate = num(raw.earnRate, LOYALTY_DEFAULTS.earnRate)
  const redeemRate = num(raw.redeemRate, LOYALTY_DEFAULTS.redeemRate)
  const minRedeemPoints = Math.floor(num(raw.minRedeemPoints, 0))
  const expiryMonths = Math.floor(num(raw.expiryMonths, LOYALTY_DEFAULTS.expiryMonths))
  const tierWindowMonths = Math.floor(num(raw.tierWindowMonths, LOYALTY_DEFAULTS.tierWindowMonths))
  const tierGraceMonths = Math.floor(num(raw.tierGraceMonths, LOYALTY_DEFAULTS.tierGraceMonths))

  if (earnRate <= 0) return { error: 'Rand per point must be more than zero.' }
  if (redeemRate <= 0) return { error: 'Points per rand must be more than zero.' }
  if (minRedeemPoints < 0) return { error: 'The minimum to redeem cannot be negative.' }

  const expiryMode = (raw.expiryMode ?? LOYALTY_DEFAULTS.expiryMode) as ExpiryMode
  if (!['never', 'activity', 'earn'].includes(expiryMode)) {
    return { error: 'Choose how points expire.' }
  }
  if (expiryMode !== 'never' && expiryMonths < 1) {
    return { error: 'Points must be allowed to last at least a month.' }
  }

  const tierBasis = (raw.tierBasis ?? LOYALTY_DEFAULTS.tierBasis) as TierBasis
  if (!['rolling', 'lifetime'].includes(tierBasis)) {
    return { error: 'Choose how tier standing is measured.' }
  }
  if (tierBasis === 'rolling' && tierWindowMonths < 1) {
    return { error: 'The tier window must be at least a month.' }
  }
  if (tierGraceMonths < 0) return { error: 'The grace period cannot be negative.' }

  return {
    enabled: !!raw.enabled,
    earnRate,
    redeemRate,
    minRedeemPoints,
    earnOnDiscounted: raw.earnOnDiscounted !== false,
    expiryMode,
    expiryMonths,
    tierBasis,
    tierWindowMonths,
    tierGraceMonths,
  }
}

/**
 * Checks a whole tier ladder at once.
 *
 * Validated as a SET rather than row by row, because the errors that matter are
 * relational: two tiers with the same name, or a higher tier that is easier to
 * reach than a lower one. A ladder where Gold needs less spend than Silver
 * would quietly make Silver unreachable.
 */
export function cleanTierLadder(
  raw: readonly Partial<LoyaltyTier>[],
): Omit<LoyaltyTier, 'id'>[] | { error: string } {
  if (raw.length === 0) return { error: 'A programme needs at least one tier.' }

  const cleaned: Omit<LoyaltyTier, 'id'>[] = []
  const seen = new Set<string>()

  for (const [index, row] of raw.entries()) {
    const name = (row.name ?? '').trim()
    if (!name) return { error: `Tier ${index + 1} needs a name.` }
    if (name.length > 40) return { error: `"${name}" is too long — 40 characters at most.` }

    const key = name.toLowerCase()
    if (seen.has(key)) return { error: `There are two tiers called "${name}".` }
    seen.add(key)

    const qualifyingSpend = num(row.qualifyingSpend, 0)
    const multiplier = num(row.multiplier, 1)
    const discountPct = num(row.discountPct, 0)

    if (qualifyingSpend < 0) return { error: `"${name}" cannot need negative spend.` }
    if (multiplier <= 0) return { error: `"${name}" needs a multiplier above zero.` }
    if (discountPct < 0 || discountPct > 100) {
      return { error: `"${name}" needs a discount between 0 and 100 percent.` }
    }

    cleaned.push({
      name,
      step: index + 1,
      qualifyingSpend,
      multiplier,
      discountPct,
      color: (row.color ?? '').trim(),
      isActive: row.isActive !== false,
    })
  }

  const entry = cleaned.find((t) => t.qualifyingSpend === 0)
  if (!entry) {
    return { error: 'One tier must need no spend at all — that is where new members start.' }
  }

  for (let i = 1; i < cleaned.length; i++) {
    if (cleaned[i].qualifyingSpend <= cleaned[i - 1].qualifyingSpend) {
      return {
        error: `"${cleaned[i].name}" must need more spend than "${cleaned[i - 1].name}" — as listed, it can never be reached.`,
      }
    }
  }

  return cleaned
}
