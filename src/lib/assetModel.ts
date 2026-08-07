/*
 * Deliberately NOT `server-only`.
 *
 * Depreciation arithmetic and vocabulary, shared by the asset screens and the
 * server modules that write them. The asset form shows the monthly charge and
 * the schedule as the figures are typed, and it must use the same calculation
 * the run will apply. Same split as expenseModel.ts and glModel.ts.
 */
import { round } from './decimals'

/**
 * Straight-line depreciation.
 *
 *   (cost − residual) ÷ life in months
 *
 * Spread evenly, month by month. That is what the SARS wear-and-tear
 * allowances assume, what almost every small business uses, and what an
 * accountant expects unless told otherwise.
 *
 * ── THE THREE THINGS THAT GO WRONG ───────────────────────────────────────
 *
 * 1. OVER-DEPRECIATING. Rounding a monthly figure and multiplying it by the
 *    life almost never lands exactly on (cost − residual), so the last month
 *    must be a balancing figure. Without that, an asset depreciates below its
 *    residual — or stops a few rand short and never closes.
 *
 * 2. DEPRECIATING A DISPOSED OR NOT-YET-USED ASSET. Both are simply skipped,
 *    with a reason, rather than silently producing zero.
 *
 * 3. CHARGING A MONTH TWICE. The register records the last period charged and
 *    the run refuses to go back over it.
 *
 * All three are handled here rather than in the run, so they are testable
 * without a database.
 */

export const ASSET_STATUSES = ['pending', 'active', 'disposed'] as const
export type AssetStatus = (typeof ASSET_STATUSES)[number]

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  pending: 'Not yet in use',
  active: 'In use',
  disposed: 'Disposed',
}

export const ASSET_STATUS_HINTS: Record<AssetStatus, string> = {
  pending: 'Recorded but not yet used, so it is not depreciating.',
  active: 'In use and depreciating each month.',
  disposed: 'Sold, scrapped or written off. No longer depreciating.',
}

/** What a depreciation calculation needs to know about an asset. */
export type DepreciableAsset = {
  id: number
  status: AssetStatus
  cost: number
  residualValue: number
  lifeMonths: number
  /** yyyy-mm-dd. Depreciation starts in this month. */
  depreciationStart: string
  accumulatedDepreciation: number
  /** yyyy-mm-dd of the last month charged, or null if never. */
  lastDepreciatedTo: string | null
  disposedOn?: string | null
}

export type MonthlyCharge = {
  /** What to charge this month. Zero when nothing is due. */
  amount: number
  /** Set when nothing is charged, and why. */
  skipReason: string | null
  /** True when this charge takes the asset to its residual value. */
  isFinal: boolean
  /** Accumulated after this charge. */
  closingAccumulated: number
  /** Cost less accumulated, after this charge. */
  closingBookValue: number
}

/**
 * The depreciable amount: what will be written off over the asset's life.
 *
 * Never negative. A residual above cost is a data error rather than a negative
 * depreciation, and returning zero means the asset simply never depreciates
 * instead of appreciating month by month.
 */
export function depreciableAmount(cost: number, residualValue: number): number {
  return Math.max(round(cost - residualValue, 2), 0)
}

/** The even monthly figure, before the final-month adjustment. */
export function monthlyAmount(
  cost: number,
  residualValue: number,
  lifeMonths: number,
): number {
  if (lifeMonths <= 0) return 0
  return round(depreciableAmount(cost, residualValue) / lifeMonths, 2)
}

/**
 * What to charge one asset for one month.
 *
 * `periodMonth` is any date inside the month being charged; only its year and
 * month are used.
 *
 * The last charge is a BALANCING figure, not the even monthly amount. Rounding
 * R24 000 over 7 months gives R3 428.57, and seven of those come to R23 999.99
 * — a cent short, for ever. So the final month charges whatever remains, which
 * lands the asset exactly on its residual value.
 */
export function chargeFor(
  asset: DepreciableAsset,
  periodMonth: string,
): MonthlyCharge {
  const nothing = (reason: string): MonthlyCharge => ({
    amount: 0,
    skipReason: reason,
    isFinal: false,
    closingAccumulated: asset.accumulatedDepreciation,
    closingBookValue: round(asset.cost - asset.accumulatedDepreciation, 2),
  })

  if (asset.status === 'disposed') return nothing('Disposed.')
  if (asset.status === 'pending') return nothing('Not yet in use.')
  if (asset.lifeMonths <= 0) return nothing('No useful life is set.')

  const period = monthKey(periodMonth)
  const start = monthKey(asset.depreciationStart)

  if (period < start) return nothing(`Depreciation starts ${asset.depreciationStart}.`)

  // Already charged this month or later. The register records where it got to,
  // so a run cannot go back over ground it has covered.
  if (asset.lastDepreciatedTo && monthKey(asset.lastDepreciatedTo) >= period) {
    return nothing('Already depreciated to this month.')
  }

  // Disposed part-way through: no charge in the month of disposal or after.
  // A part-month charge would need a convention nobody agrees on, and the
  // disposal journal already accounts for the remaining book value.
  if (asset.disposedOn && monthKey(asset.disposedOn) <= period) {
    return nothing('Disposed before this month.')
  }

  const total = depreciableAmount(asset.cost, asset.residualValue)
  const remaining = round(total - asset.accumulatedDepreciation, 2)

  if (remaining <= 0) return nothing('Fully depreciated.')

  const even = monthlyAmount(asset.cost, asset.residualValue, asset.lifeMonths)

  // THE FINAL-MONTH RULE. Whatever is left, when it is less than a full
  // month's charge — which lands exactly on the residual rather than a cent
  // either side of it.
  const amount = remaining <= even || even <= 0 ? remaining : even
  const isFinal = amount >= remaining

  const closingAccumulated = round(asset.accumulatedDepreciation + amount, 2)

  return {
    amount,
    skipReason: null,
    isFinal,
    closingAccumulated,
    closingBookValue: round(asset.cost - closingAccumulated, 2),
  }
}

export type ScheduleRow = {
  /** yyyy-mm of the charge. */
  month: string
  amount: number
  accumulated: number
  bookValue: number
}

/**
 * The whole life of an asset, month by month.
 *
 * Shown on the asset screen so somebody can see what they are committing to
 * before it starts posting — and so "when does this come off the books" has an
 * answer that is not a mental calculation.
 *
 * Capped at 600 rows: a 50-year life is beyond anything this system is for, and
 * an unbounded loop on bad data would hang the page rather than misreport.
 */
export function schedule(asset: DepreciableAsset): ScheduleRow[] {
  const rows: ScheduleRow[] = []
  const total = depreciableAmount(asset.cost, asset.residualValue)
  if (total <= 0 || asset.lifeMonths <= 0) return rows

  let accumulated = 0
  const cursor = new Date(`${monthKey(asset.depreciationStart)}-01T00:00:00`)
  const even = monthlyAmount(asset.cost, asset.residualValue, asset.lifeMonths)

  for (let i = 0; i < 600; i++) {
    const remaining = round(total - accumulated, 2)
    if (remaining <= 0) break

    const amount = remaining <= even || even <= 0 ? remaining : even
    accumulated = round(accumulated + amount, 2)

    rows.push({
      month: `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`,
      amount,
      accumulated,
      bookValue: round(asset.cost - accumulated, 2),
    })

    cursor.setMonth(cursor.getMonth() + 1)
  }

  return rows
}

/** Cost less accumulated depreciation — what the asset is carried at. */
export function bookValue(cost: number, accumulatedDepreciation: number): number {
  return round(cost - accumulatedDepreciation, 2)
}

/**
 * The profit or loss on disposing of an asset.
 *
 * Positive means it sold for more than it was carried at, which is income;
 * negative is a loss. Both are ordinary and neither is an error — a vehicle
 * depreciated over five years usually sells for more than its book value,
 * because straight line is a convention rather than a valuation.
 */
export function disposalResult(
  cost: number,
  accumulatedDepreciation: number,
  proceeds: number,
): { bookValue: number; result: number; isProfit: boolean } {
  const carried = bookValue(cost, accumulatedDepreciation)
  const result = round(proceeds - carried, 2)
  return { bookValue: carried, result, isProfit: result >= 0 }
}

/**
 * Why this asset cannot be saved. Null means it can.
 *
 * Pure, so the form refuses before the server is asked rather than after.
 */
export function refuseAsset(input: {
  name?: string | null
  cost?: number
  residualValue?: number
  lifeMonths?: number
  acquiredOn?: string
  depreciationStart?: string
}): string | null {
  if (!input.name?.trim()) return 'Give the asset a name.'
  if (!Number.isFinite(input.cost) || (input.cost ?? 0) <= 0) {
    return 'Enter what the asset cost.'
  }
  if ((input.cost ?? 0) > 999_999_999) return 'That cost is too large.'
  if ((input.residualValue ?? 0) < 0) return 'A residual value cannot be negative.'
  if ((input.residualValue ?? 0) > (input.cost ?? 0)) {
    return 'The residual value cannot be more than the cost — the asset would appreciate.'
  }
  if (!Number.isInteger(input.lifeMonths) || (input.lifeMonths ?? 0) <= 0) {
    return 'Enter a useful life in months.'
  }
  if ((input.lifeMonths ?? 0) > 600) return 'That useful life is longer than 50 years.'
  if (input.acquiredOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.acquiredOn)) {
    return 'That acquisition date is not valid.'
  }
  if (input.depreciationStart && !/^\d{4}-\d{2}-\d{2}$/.test(input.depreciationStart)) {
    return 'That depreciation start date is not valid.'
  }
  // Depreciating before you own it is always a mistake, and it produces months
  // of charges that have to be journalled back out.
  if (
    input.acquiredOn &&
    input.depreciationStart &&
    monthKey(input.depreciationStart) < monthKey(input.acquiredOn)
  ) {
    return 'Depreciation cannot start before the asset was acquired.'
  }
  return null
}

/* ── Months ──────────────────────────────────────────────────────────────── */

/** yyyy-mm from any yyyy-mm-dd. Comparison on this is month comparison. */
export function monthKey(date: string): string {
  return date.slice(0, 7)
}

/** The first day of a month, which is how a period is stored. */
export function monthStart(date: string): string {
  return `${monthKey(date)}-01`
}

/** The month after this one, for stepping a schedule forward. */
export function nextMonth(date: string): string {
  const d = new Date(`${monthStart(date)}T00:00:00`)
  d.setMonth(d.getMonth() + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

/** How many whole months from one to the other. Negative when earlier. */
export function monthsBetween(from: string, to: string): number {
  const a = new Date(`${monthStart(from)}T00:00:00`)
  const b = new Date(`${monthStart(to)}T00:00:00`)
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())
}
