import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { parseOpeningHours } from '../reservationTypes'
import type { TradingException, TradingRules } from '../tradingHours'

/**
 * A branch's own trading rules, and what it has run out of today.
 *
 * Both live in the branch's database, so a chain gets per-branch hours and
 * per-branch sold-out marks for free — the Claremont kitchen running out of
 * wings says nothing about Sea Point.
 */

type SettingsRow = RowDataPacket & {
  trading_hours: string | null
  accepting_orders: number
  accepting_note: string
  order_horizon_days: number
  lead_time_minutes: number
}

type ExceptionRow = RowDataPacket & {
  on_date: Date | string
  is_closed: number
  open_time: string | null
  close_time: string | null
  note: string
}

/** `YYYY-MM-DD` from whatever the driver handed back. */
function isoOf(value: Date | string): string {
  if (value instanceof Date) {
    const y = value.getUTCFullYear()
    const m = String(value.getUTCMonth() + 1).padStart(2, '0')
    const d = String(value.getUTCDate()).padStart(2, '0')
    /*
     * getUTC*, not getHours: the pool runs with timezone 'Z', so a DATE comes
     * back as midnight UTC and the local getters would roll it to the previous
     * day for anyone east of Greenwich — which is all of South Africa.
     */
    return `${y}-${m}-${d}`
  }
  return String(value).slice(0, 10)
}

/** `HH:MM` from a TIME column, which the driver returns as `HH:MM:SS`. */
const hm = (value: string | null): string | null => (value ? String(value).slice(0, 5) : null)

/**
 * How this shop trades.
 *
 * Falls back to "always open, taking orders" when the columns are missing — a
 * site that has not run 178 yet must keep working exactly as it did, not start
 * refusing every order because a SELECT failed.
 */
export async function tradingRules(siteId: number): Promise<TradingRules> {
  const fallback: TradingRules = {
    hours: null,
    exceptions: [],
    acceptingOrders: true,
    acceptingNote: '',
    leadTimeMinutes: 30,
    horizonDays: 2,
  }

  try {
    const row = await siteQueryOne<SettingsRow>(
      siteId,
      `SELECT trading_hours, accepting_orders, accepting_note, order_horizon_days,
              lead_time_minutes
         FROM online_store_settings WHERE id = 1`,
    )
    if (!row) return fallback

    const exceptions = await tradingExceptions(siteId)
    return {
      // NULL means always open. A populated but unparseable value becomes {},
      // which tradingHours reads as closed — see the note there on why those
      // two nulls get different answers.
      hours: row.trading_hours === null ? null : parseOpeningHours(row.trading_hours),
      exceptions,
      acceptingOrders: Boolean(row.accepting_orders),
      acceptingNote: String(row.accepting_note ?? ''),
      leadTimeMinutes: Number(row.lead_time_minutes ?? 30),
      horizonDays: Number(row.order_horizon_days ?? 2),
    }
  } catch {
    return fallback
  }
}

/**
 * Dates that do not follow the weekly pattern.
 *
 * Only from today onward: last Christmas cannot change whether the shop is open
 * now, and a shop that has been running for years would otherwise carry every
 * holiday it has ever recorded into a public page load.
 */
export async function tradingExceptions(siteId: number): Promise<TradingException[]> {
  try {
    const rows = await siteQuery<ExceptionRow>(
      siteId,
      `SELECT on_date, is_closed, open_time, close_time, note
         FROM online_trading_exceptions
        WHERE on_date >= CURDATE()
        ORDER BY on_date ASC
        LIMIT 400`,
    )
    return rows.map((r) => ({
      onDate: isoOf(r.on_date),
      isClosed: Boolean(r.is_closed),
      openTime: hm(r.open_time),
      closeTime: hm(r.close_time),
      note: String(r.note ?? ''),
    }))
  } catch {
    // No table yet. No exceptions is the right reading — the weekly pattern
    // stands, which is what the shop had before this migration existed.
    return []
  }
}

export type SoldOut = { productId: number; until: string; note: string }

type SoldOutRow = RowDataPacket & {
  product_id: number
  unavailable_until: Date | string
  note: string
}

/**
 * What this branch has run out of TODAY.
 *
 * A date rather than a flag, so it expires by itself: no cron, nothing for
 * staff to remember at close, and no way to leave a product hidden for a month
 * because somebody went on leave. `unavailable_until = today` is the common
 * case and means "back tomorrow".
 */
export async function soldOutToday(siteId: number): Promise<Map<number, SoldOut>> {
  const out = new Map<number, SoldOut>()
  try {
    const rows = await siteQuery<SoldOutRow>(
      siteId,
      `SELECT product_id, unavailable_until, note
         FROM online_product_availability
        WHERE unavailable_until >= CURDATE()`,
    )
    for (const r of rows) {
      out.set(Number(r.product_id), {
        productId: Number(r.product_id),
        until: isoOf(r.unavailable_until),
        note: String(r.note ?? ''),
      })
    }
  } catch {
    // No table yet: nothing is marked sold out, which is the pre-178 behaviour.
  }
  return out
}

/**
 * Marks a product as unavailable until a date, or clears the mark.
 *
 * Passing null clears it — which is how staff put something back on the menu the
 * moment the fryer is fixed, rather than waiting for the date to pass.
 */
export async function setSoldOut(
  siteId: number,
  productId: number,
  until: string | null,
  note = '',
  by = '',
): Promise<void> {
  if (until === null) {
    await siteExecute(siteId, 'DELETE FROM online_product_availability WHERE product_id = ?', [
      productId,
    ])
    return
  }
  await siteExecute(
    siteId,
    `INSERT INTO online_product_availability (product_id, unavailable_until, note, set_by)
          VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE unavailable_until = VALUES(unavailable_until),
                             note = VALUES(note),
                             set_by = VALUES(set_by),
                             set_at = CURRENT_TIMESTAMP`,
    [productId, until, note.slice(0, 120), by.slice(0, 120)],
  )
}
