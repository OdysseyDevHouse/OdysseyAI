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
  /**
   * Which way a forced price ending moves — 'up', 'down' or 'nearest'.
   *
   * Not a detail: on a .99 ending, R14.32 becomes R14.99 rounding up and
   * R13.99 rounding down, and stores genuinely differ. Up protects margin,
   * down never charges above what the rule worked out, nearest stays closest.
   */
  price_ending_direction: 'up',
  /** Cash denomination the DRAWER rounds to. Never rounds the invoice. */
  sales_cash_rounding: '0.05',
  /** Nothing on or before this date may be voided, edited or backdated. */
  vat_period_locked_to: '',
  /** Whether a finalised invoice may be corrected. Off until reverse-and-repost exists. */
  sales_allow_finalised_edit: '0',

  /* ── Auto-numbered master data ─────────────────────────────────────────
     Whether a new customer, supplier or product gets its code suggested from
     the matching sequence instead of being typed. Off by default so a store
     with an existing coding scheme keeps it — see 062_master_data_codes.sql.
     The suggestion stays editable; these switch the default, not the field. */
  autocode_customer: '0',
  autocode_supplier: '0',
  autocode_product: '0',
  barcode_variable_prefix: '2',
  barcode_plu_length: '5',
  barcode_value_divisor: '100',
  /** How far a drawer may be out before an explanation is required at cash-up. */
  cashup_variance_tolerance: '5.00',

  /* ── Receiving guards ──────────────────────────────────────────────────
     Two checks at the moment a GRV is posted. Both are about the same thing:
     a receipt is the ONLY act that writes average_cost, and a keying error
     here is silent — it does not throw, it just prices next quarter's GP
     report wrong. */

  /**
   * How far the keyed lines may differ from the supplier's invoice total
   * before the receipt is refused.
   *
   * Small on purpose. This catches a transposed 91 for 19, a line entered
   * twice, a case cost keyed as a unit cost — the errors that otherwise reach
   * the ledger and are found when the supplier queries the payment. Cents of
   * tolerance because a supplier's own rounding can differ from ours by one.
   *
   * Only applies when a total is actually given: receiving without the invoice
   * in hand stays possible, and is the common case for a delivery note.
   */
  purchase_invoice_tolerance: '0.10',

  /**
   * Percentage a unit cost may move from the last one paid before the screen
   * warns.
   *
   * A WARNING, never a refusal: prices genuinely move, and a buyer who knows
   * the supplier put 30% on is better placed than this setting. It exists so
   * that R1,000 keyed for R100 is noticed while the invoice is still in hand
   * rather than in next month's margin report. Zero switches it off.
   */
  purchase_cost_change_warn_pct: '20',
  /**
   * What a cash-up reconciles.
   *
   * 'terminal' — the drawer in a register, counted by whoever is on it. Retail.
   * 'user'     — a person and their own float, across whatever tills they
   *              worked. Hospitality, where twenty waiters share ten registers
   *              and "which of the six people on till 4 is short" has no answer.
   *
   * Defaults to 'terminal' so an existing store keeps behaving as it did.
   */
  cashup_mode: 'terminal',
  /**
   * What kind of till this shop runs.
   *
   * 'retail'      — a queue at a counter. One basket at a time, paid before the
   *                 customer leaves. The default, so every existing store is
   *                 untouched.
   * 'hospitality' — tables. A basket per table, held open while people eat, paid
   *                 at the end. The same basket and the same posting path; what
   *                 differs is how a waiter FINDS the one they left open.
   *
   * Read in exactly three places on the client — see PosShell. A fourth is the
   * signal that the flag is being threaded rather than contained.
   */
  pos_mode: 'retail',
  /**
   * Whether a service charge applies only to a TABLE's bill.
   *
   * ON by default, and that default is the careful one: a percentage added to a R600
   * takeaway or a retail basket is a charge the customer did not expect and did not agree
   * to, and it would start appearing the moment a shop configured its first tier. A
   * restaurant gets service charges where they belong; a retail shop never sees the
   * feature at all.
   *
   * '1' or '0' rather than a boolean, matching every other flag in this table.
   */
  tips_tables_only: '1',
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
   * How long a quote's prices stand, in days.
   *
   * 30 is the ordinary commercial term. Zero means quotes never expire, for a
   * business that would rather not chase validity.
   */
  quote_validity_days: '30',
  /** Printed at the foot of a quote. Blank until a store writes its own terms. */
  quote_terms_text: '',

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

  /* ── Loyalty ───────────────────────────────────────────────────────────
     The programme's rates and policy. Tiers, punch cards and vouchers are
     rows in their own tables — only the scalars a store owner types into a
     form live here. Defaults documented in lib/loyaltyRules.ts, which is
     where the arithmetic that consumes them lives; these must agree with
     LOYALTY_DEFAULTS. Off until a store opens its programme. */
  loyalty_enabled: '0',
  /** Rand of spend that earns one point. R1 = 1 point. */
  loyalty_earn_rate: '1',
  /** Points needed to fund R1 off a sale. 10 makes a point worth 10c. */
  loyalty_redeem_rate: '10',
  /** A floor on redemption, so the till is not asked to spend three points. */
  loyalty_min_redeem_points: '0',
  /** Whether an already-discounted line still earns. */
  loyalty_earn_on_discounted: '1',
  /** never | activity (idle balance lapses) | earn (each batch ages out). */
  loyalty_expiry_mode: 'activity',
  loyalty_expiry_months: '12',
  /** rolling (a moving window) | lifetime (everything ever spent). */
  loyalty_tier_basis: 'rolling',
  loyalty_tier_window_months: '12',
  /** Months an earned tier survives a fall in spend, so a quiet month does
      not demote someone on a Tuesday. */
  loyalty_tier_grace_months: '12',

  /* ── Staff pay multipliers ─────────────────────────────────────────────
     What an hour outside ordinary time costs, as a multiple of the ordinary
     rate. The defaults are the BCEA figures and most stores will never touch
     them — but a bargaining council agreement can set higher rates, and a
     store bound by one needs to be able to say so. The arithmetic that
     consumes these lives in staffCost.ts; the bands themselves are worked out
     in timesheetModel.ts, which is rate-agnostic. */
  /** Section 10 — overtime, above the ordinary week. */
  staff_overtime_multiplier: '1.5',
  /** Section 16(1) — Sunday work, for somebody who does not ordinarily work Sundays. */
  staff_sunday_multiplier: '2',
  /** Section 16(2) — Sunday work, for somebody who does. See user_employment.works_sundays. */
  staff_sunday_ordinary_multiplier: '1.5',
  /** Section 18(2)(a) — a public holiday that is not an ordinary working day. */
  staff_holiday_multiplier: '2',

  /* ── Document numbering ────────────────────────────────────────────────
     See sql/site/064_pos_numbering.sql and lib/site/numbering.ts. */

  /**
   * 'terminal' or 'site'.
   *
   * 'terminal' gives every till its own invoice sequence, numbered
   * INV_01_02_000097, so a till can trade offline indefinitely — it allocates
   * locally with nothing reserved and nothing to run out of. Each till's own run
   * is gapless, at the cost of there being no single company-wide run.
   *
   * 'site' is one shared sequence, which is how every store numbered before this
   * existed. A till then cannot number a sale offline at all.
   *
   * Defaults to 'site' HERE, deliberately, even though the migration seeds
   * 'terminal' for stores it touches: a default is what an unmigrated or
   * hand-edited site falls back to, and falling back to the behaviour a store
   * already had is the only safe direction.
   */
  sales_number_scope: 'site',

  /**
   * This store's number inside the group, as it appears in an invoice number.
   *
   * Twenty branches each number their first till 01, so without this every branch
   * issues INV_01_000097 and a group report has twenty rows claiming one invoice
   * number. uq_doc_number cannot catch it — each site has its own database and its
   * own copy of that index.
   *
   * Frozen once the store has issued anything; see setStoreNumber().
   */
  store_number: '01',
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

    /* The two receiving guards. Both had no case here until they became
       editable — an unvalidated key falls through to `default` and saves
       whatever it is given, which was harmless while the only writer was a
       migration and is not once a text box points at it. */

    case 'purchase_invoice_tolerance': {
      const tolerance = Number(value)
      if (!Number.isFinite(tolerance) || tolerance < 0) {
        return 'The tolerance cannot be negative.'
      }
      /* Cents, not rands. This check exists to catch a transposed digit or a
         case cost keyed as a unit cost; a tolerance of R50 would wave through
         exactly those errors while still looking configured. */
      if (tolerance > 10) return 'A tolerance above R10 would let a keying error through.'
      return null
    }

    case 'purchase_cost_change_warn_pct': {
      const pct = Number(value)
      // Zero is meaningful: it switches the warning off for a shop whose costs
      // genuinely move on every delivery.
      if (!Number.isFinite(pct) || pct < 0) return 'The percentage cannot be negative.'
      if (pct > 1000) return 'A threshold that high would never warn about anything.'
      return null
    }

    case 'price_ending_direction':
      return value === 'up' || value === 'down' || value === 'nearest'
        ? null
        : "Price ending direction must be 'up', 'down' or 'nearest'."

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

    case 'sales_number_scope':
      return value === 'terminal' || value === 'site'
        ? null
        : "Numbering scope must be 'terminal' or 'site'."

    // Digits only, and never zero. This lands in a legal document number, so a
    // stray letter here would print on an invoice — and 'store 0' reads as
    // "no store" to anyone comparing group reports.
    case 'store_number':
      return /^\d{1,4}$/.test(value) && Number(value) >= 1
        ? null
        : 'The store number must be 1 to 4 digits, e.g. 01.'

    case 'sales_allow_finalised_edit':
    case 'autocode_customer':
    case 'autocode_supplier':
    case 'autocode_product':
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

    case 'pos_mode':
      return value === 'retail' || value === 'hospitality'
        ? null
        : "POS mode must be 'retail' or 'hospitality'."

    /* A flag, so only the two values this table uses everywhere else. Validated rather
       than coerced: a stray 'true' would read as ON by the !== '0' test and as OFF by any
       future reader that compared to '1', which is the kind of disagreement that surfaces
       months later as a service charge on a takeaway. */
    case 'tips_tables_only':
      return value === '1' || value === '0' ? null : 'That setting must be 1 or 0.'

    case 'cashup_mode':
      return value === 'terminal' || value === 'user'
        ? null
        : "Cash-up mode must be 'terminal' or 'user'."

    // The two rates are guarded here as well as in cleanSettings, because this
    // is the only check a direct setSetting() call passes through. A zero or
    // negative rate divides by zero in the earn arithmetic.
    case 'loyalty_earn_rate': {
      const rate = Number(value)
      return Number.isFinite(rate) && rate > 0 ? null : 'Rand per point must be more than zero.'
    }

    case 'loyalty_redeem_rate': {
      const rate = Number(value)
      return Number.isFinite(rate) && rate > 0 ? null : 'Points per rand must be more than zero.'
    }

    case 'loyalty_min_redeem_points': {
      const floor = Number(value)
      return Number.isFinite(floor) && floor >= 0
        ? null
        : 'The minimum to redeem cannot be negative.'
    }

    case 'loyalty_expiry_mode':
      return value === 'never' || value === 'activity' || value === 'earn'
        ? null
        : "Expiry mode must be 'never', 'activity' or 'earn'."

    case 'loyalty_tier_basis':
      return value === 'rolling' || value === 'lifetime'
        ? null
        : "Tier basis must be 'rolling' or 'lifetime'."

    case 'loyalty_expiry_months':
    case 'loyalty_tier_window_months':
    case 'loyalty_tier_grace_months': {
      const months = Number(value)
      if (!Number.isFinite(months) || months < 0) return 'That must be zero or more months.'
      // Beyond a decade the policy is indistinguishable from "never", and a
      // typo of an extra digit is far more likely than a genuine 100-year rule.
      if (months > 120) return 'Choose 120 months or fewer.'
      return null
    }

    case 'staff_overtime_multiplier':
    case 'staff_sunday_multiplier':
    case 'staff_sunday_ordinary_multiplier':
    case 'staff_holiday_multiplier': {
      const multiplier = Number(value)
      if (!Number.isFinite(multiplier)) return 'Enter a multiplier, such as 1.5.'
      // Below 1 would pay an overtime hour LESS than an ordinary one, which no
      // agreement may do — the BCEA rates are a floor, not a default to argue
      // down from. Above 5 is a decimal point in the wrong place.
      if (multiplier < 1) return 'A multiplier below 1 would pay overtime less than ordinary time.'
      if (multiplier > 5) return 'That multiplier looks like a typo. Five times is the ceiling here.'
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
