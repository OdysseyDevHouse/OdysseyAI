import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQuery, siteQueryOne } from '../siteDb'
import { toNum } from '../decimals'
import { DEFAULT_MAX_CANCELLATION_FEE_PCT } from '../laybyRules'

/**
 * The site settings KV.
 *
 * The table has existed since 001_products.sql with exactly one reader
 * (getCostBasis) and NO writer at all — every value in it was put there by a
 * migration. Sales needs to change settings from a screen, so this is that
 * writer.
 *
 * Reads are DEFENSIVE by design, following getCostBasis: a missing row, an
 * empty string or a value nobody recognises all fall back to the documented
 * default rather than throwing. A setting is configuration, and configuration
 * that can crash a till is worse than configuration that is wrong.
 *
 * What belongs here: single scalar values a store owner changes and nothing
 * joins to. What does NOT: anything with behaviour attached (tender types),
 * anything queried in bulk (numbering), or anything needing its own columns.
 * Those earn tables.
 */

/** Every setting the app reads, with its default. One list, so nothing is invented at a call site. */
export const SETTING_DEFAULTS = {
  cost_basis: 'average',
  /** Cash denomination the DRAWER rounds to. Never rounds the invoice. */
  sales_cash_rounding: '0.05',
  /** Nothing on or before this date may be voided, edited or backdated. */
  vat_period_locked_to: '',
  /** Whether a finalised invoice may be corrected. Off until reverse-and-repost exists. */
  sales_allow_finalised_edit: '0',
  barcode_variable_prefix: '2',
  barcode_plu_length: '5',
  barcode_value_divisor: '100',
  /** How far a drawer may be out before an explanation is required at cash-up. */
  cashup_variance_tolerance: '5.00',
  /**
   * Lay-by cancellation fee, as a percentage of the FULL price.
   *
   * Defaults to zero deliberately. Section 62 of the Consumer Protection Act
   * caps it at 1% and only permits it where the fee was disclosed to the
   * customer before they signed — so a system that defaulted to charging one
   * would put a store in breach on its first lay-by. See laybyRules.ts.
   */
  layby_cancellation_fee_pct: '0',
  /** How long a customer has to pay off a lay-by, in days. */
  layby_default_days: '90',
  /** Printed on the customer's copy. The fee must appear here to be chargeable. */
  layby_terms_text: '',
  /**
   * The store's own ceiling on a cancellation fee, as a percentage.
   *
   * A house rule, not a statute. Section 62(6) lets the Minister prescribe a
   * maximum and none is set in the Act, so this defaults conservatively and
   * can be raised by a store with advice supporting it.
   */
  layby_max_fee_pct: '1',

  /**
   * Whether credit notes claw commission back at all.
   *
   * Off by default: a return that earns nobody a clawback means the business
   * carries every refund while the salesperson keeps the commission on a sale
   * that came undone. Some shops choose that deliberately — hence the switch.
   */
  commission_exclude_returns: '0',
  /**
   * Charge a clawback to the rep on the ORIGINAL sale, not to whoever
   * processed the refund. On by default: without it the person who happens to
   * work the returns desk accumulates everybody else's negatives.
   */
  commission_returns_original_rep: '1',
  /**
   * Pay lay-by commission only once it is paid up. On by default: a lay-by
   * that lapses was never a sale, and paying at take-on means clawing it back.
   */
  commission_layby_on_completion: '1',
} as const

export type SettingKey = keyof typeof SETTING_DEFAULTS

export async function getSetting(siteId: number, key: SettingKey): Promise<string> {
  const row = await siteQueryOne<RowDataPacket & { setting_value: string | null }>(
    siteId,
    'SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1',
    [key],
  )
  const value = row?.setting_value
  return value === null || value === undefined ? SETTING_DEFAULTS[key] : value
}

/** Several at once, so a screen needs one round trip rather than seven. */
export async function getSettings(
  siteId: number,
  keys: readonly SettingKey[],
): Promise<Record<string, string>> {
  if (keys.length === 0) return {}

  const rows = await siteQuery<RowDataPacket & { setting_key: string; setting_value: string | null }>(
    siteId,
    `SELECT setting_key, setting_value FROM settings
      WHERE setting_key IN (${keys.map(() => '?').join(',')})`,
    [...keys],
  )

  const found = new Map(rows.map((r) => [r.setting_key, r.setting_value]))
  const result: Record<string, string> = {}
  for (const key of keys) {
    const value = found.get(key)
    result[key] = value === null || value === undefined ? SETTING_DEFAULTS[key] : value
  }
  return result
}

export async function getNumericSetting(siteId: number, key: SettingKey): Promise<number> {
  return toNum(await getSetting(siteId, key), toNum(SETTING_DEFAULTS[key]))
}

export async function getBooleanSetting(siteId: number, key: SettingKey): Promise<boolean> {
  return (await getSetting(siteId, key)) === '1'
}

export type SaveResult = { ok: true } | { ok: false; error: string }

/**
 * Writes one setting.
 *
 * Upsert rather than update: a site migrated before a setting existed has no
 * row for it, and failing to save because of that would be baffling.
 */
export async function setSetting(
  siteId: number,
  key: SettingKey,
  value: string,
): Promise<SaveResult> {
  const invalid = validateSetting(key, value)
  if (invalid) return { ok: false, error: invalid }

  await siteExecute(
    siteId,
    `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [key, value],
  )
  return { ok: true }
}

/**
 * Per-key validation.
 *
 * Settings are typed only by convention — the column is a VARCHAR — so this is
 * the only thing standing between a typo on a setup screen and a till that
 * rounds to the nearest R5.
 */
export function validateSetting(key: SettingKey, value: string): string | null {
  switch (key) {
    case 'cost_basis':
      return value === 'average' || value === 'last'
        ? null
        : "Cost basis must be 'average' or 'last'."

    case 'sales_cash_rounding': {
      const amount = Number(value)
      if (!Number.isFinite(amount) || amount < 0) return 'Cash rounding must be zero or more.'
      // A denomination above 10c would round a sale by more than 5c, which
      // nobody intends and every customer notices.
      if (amount > 0.1) return 'Cash rounding cannot be more than 10c.'
      return null
    }

    case 'vat_period_locked_to':
      // Empty means no period is locked, which is the default state.
      return value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? null
        : 'Enter a date as yyyy-mm-dd, or leave it blank.'

    case 'sales_allow_finalised_edit':
      return value === '0' || value === '1' ? null : 'That setting must be on or off.'

    case 'layby_cancellation_fee_pct': {
      const pct = Number(value)
      if (!Number.isFinite(pct) || pct < 0) return 'The fee must be zero or more.'
      // Sanity only. The real ceiling is layby_max_fee_pct, checked by the
      // caller against the store's own policy — section 62(6) leaves the
      // maximum to regulation rather than fixing one, so this file must not
      // claim a statutory figure it cannot point at.
      if (pct > 100) return 'A fee cannot exceed the price of the goods.'
      return null
    }

    case 'layby_max_fee_pct': {
      const pct = Number(value)
      if (!Number.isFinite(pct) || pct < 0) return 'The ceiling must be zero or more.'
      if (pct > 100) return 'A ceiling above 100% is meaningless.'
      return null
    }

    case 'layby_default_days': {
      const days = Number(value)
      if (!Number.isInteger(days) || days < 1) return 'Enter a number of days, at least one.'
      if (days > 730) return 'Two years is the longest a lay-by can run here.'
      return null
    }

    case 'layby_terms_text':
      // Free text, and blank is meaningful: no terms means no disclosed fee,
      // which means no fee may be charged. cancelLayby enforces that.
      return value.length > 4000 ? 'The terms are too long to print.' : null

    case 'barcode_variable_prefix':
      return /^\d{1,2}$/.test(value) ? null : 'The prefix must be one or two digits.'

    case 'barcode_plu_length': {
      const length = Number(value)
      return Number.isInteger(length) && length >= 3 && length <= 7
        ? null
        : 'PLU length must be between 3 and 7 digits.'
    }

    case 'barcode_value_divisor': {
      const divisor = Number(value)
      // 100 means the embedded value is in cents; 1000 means grams.
      return divisor === 1 || divisor === 10 || divisor === 100 || divisor === 1000
        ? null
        : 'Divisor must be 1, 10, 100 or 1000.'
    }

    case 'cashup_variance_tolerance': {
      const tolerance = Number(value)
      if (!Number.isFinite(tolerance) || tolerance < 0) return 'Tolerance cannot be negative.'
      // A large tolerance quietly defeats the point of counting the drawer.
      if (tolerance > 500) return 'A tolerance above 500 would hide real shortages.'
      return null
    }

    default:
      return null
  }
}

/**
 * Whether a date falls inside a locked period.
 *
 * The single guard behind void, credit and any future edit. Without it someone
 * will void a March invoice in July, after the VAT return went in, and the
 * first anyone hears of it is from an auditor.
 *
 * TWO SOURCES, and every caller gets both:
 *
 *   `vat_period_locked_to` — the original site-wide floor. Locks everything on
 *   or before one date. Still honoured, so nothing that relied on it changed.
 *
 *   `period_locks` — the table added in 037, which can express "February is
 *   closed while March is open", carries a reason, and records who closed it.
 *   Only HARD locks refuse here; a soft lock is a warning and this function
 *   returns a boolean with nowhere to put one.
 *
 * The table is queried directly rather than through periodLocks.ts because that
 * module imports this one — going the other way would be a cycle. Callers
 * wanting the reason, or wanting to distinguish soft from hard, should use
 * periodLocks.isLocked() instead; this stays boolean for its existing callers.
 */
export async function isPeriodLocked(siteId: number, date: string): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false

  const lockedTo = await getSetting(siteId, 'vat_period_locked_to')
  if (lockedTo && date <= lockedTo) return true

  // A missing table means 037 has not run on this site yet; treat that as
  // unlocked rather than failing every posting path.
  const row = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    `SELECT id FROM period_locks
      WHERE unlocked_at IS NULL AND lock_type = 'hard'
        AND ? BETWEEN period_from AND period_to
      LIMIT 1`,
    [date],
  ).catch(() => null)

  return row !== null
}
