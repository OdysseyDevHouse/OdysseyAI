'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import { siteExecute } from '@/lib/siteDb'
import { setSoldOut } from '@/lib/site/branchTrading'
import { parseHm, type OpeningHours } from '@/lib/reservationTypes'

/**
 * Trading hours, the order switch, and what has run out today.
 *
 * The rules these write are enforced in placePublicOrder, not here — a screen
 * is where they are SET, and the server is where they are kept. See
 * tradingHours.ts for the three states and why closed is not one of the two
 * that stop an order.
 */

export type TradingResult = { ok: true } | { ok: false; error: string }

/**
 * Writes the week.
 *
 * Ranges are validated and normalised here rather than trusted: a backwards
 * pair would otherwise be stored, read back by a parser that silently drops it,
 * and leave a shop wondering why Tuesday disappeared. Dropping it HERE means
 * the screen re-renders without it and the manager can see that it went.
 *
 * An empty week is stored as NULL, not as '{}'. Those are different answers —
 * NULL is "no hours set, always open", which is what every shop had before this
 * screen existed, and '{}' would read as closed forever.
 */
export async function saveTradingHoursAction(hours: OpeningHours): Promise<TradingResult> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const clean: OpeningHours = {}
  for (const [day, ranges] of Object.entries(hours ?? {})) {
    const n = Number(day)
    if (!Number.isInteger(n) || n < 0 || n > 6) continue
    if (!Array.isArray(ranges)) continue

    const usable = ranges.filter((r) => {
      if (!Array.isArray(r) || r.length !== 2) return false
      const from = parseHm(String(r[0]))
      const to = parseHm(String(r[1]))
      return from !== null && to !== null && to > from
    })
    if (usable.length > 0) clean[String(n)] = usable as OpeningHours[string]
  }

  const isEmpty = Object.keys(clean).length === 0
  await siteExecute(siteId, 'UPDATE online_store_settings SET trading_hours = ? WHERE id = 1', [
    isEmpty ? null : JSON.stringify(clean),
  ])

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: null,
    action: 'update',
    detail: isEmpty ? 'Trading hours cleared — the shop is always open' : 'Trading hours updated',
  }).catch(() => {})

  revalidatePath('/online-store/trading')
  return { ok: true }
}

/**
 * Stops or restarts the queue.
 *
 * Deliberately separate from the hours: a kitchen that is drowning at 19:00 on
 * a Friday needs to stop taking orders for twenty minutes without editing its
 * trading hours and remembering to put them back.
 */
export async function setAcceptingOrdersAction(
  accepting: boolean,
  note: string,
): Promise<TradingResult> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  await siteExecute(
    siteId,
    'UPDATE online_store_settings SET accepting_orders = ?, accepting_note = ? WHERE id = 1',
    [accepting ? 1 : 0, note.trim().slice(0, 200)],
  )

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: null,
    action: accepting ? 'resumed' : 'paused',
    detail: accepting
      ? 'Online orders resumed'
      : `Online orders paused: ${note.trim() || 'no reason given'}`,
  }).catch(() => {})

  revalidatePath('/online-store/trading')
  return { ok: true }
}

export async function setHorizonAction(days: number): Promise<TradingResult> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx

  const clamped = Math.min(30, Math.max(0, Math.round(Number(days) || 0)))
  await siteExecute(
    ctx.siteId,
    'UPDATE online_store_settings SET order_horizon_days = ? WHERE id = 1',
    [clamped],
  )
  revalidatePath('/online-store/trading')
  return { ok: true }
}

/**
 * A date that does not follow the weekly pattern.
 *
 * Yesterday is refused rather than stored: a closure that has already passed
 * changes nothing, and letting them accumulate would grow a list nobody prunes
 * on a table the storefront reads.
 */
export async function saveTradingExceptionAction(input: {
  onDate: string
  isClosed: boolean
  openTime: string
  closeTime: string
  note: string
}): Promise<TradingResult> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.onDate)) {
    return { ok: false, error: 'Choose a date.' }
  }
  const today = new Date()
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  if (input.onDate < todayIso) {
    return { ok: false, error: 'That date has already passed.' }
  }

  // A short day needs both ends. Without them the date means nothing the
  // storefront can act on, and tradingHours reads it as closed — which is
  // probably not what somebody filling in "open late" intended.
  if (!input.isClosed) {
    const from = parseHm(input.openTime)
    const to = parseHm(input.closeTime)
    if (from === null || to === null) {
      return { ok: false, error: 'Enter both an opening and a closing time, or mark it closed.' }
    }
    if (to <= from) return { ok: false, error: 'The closing time must be later.' }
  }

  await siteExecute(
    siteId,
    `INSERT INTO online_trading_exceptions (on_date, is_closed, open_time, close_time, note)
          VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE is_closed = VALUES(is_closed), open_time = VALUES(open_time),
                             close_time = VALUES(close_time), note = VALUES(note)`,
    [
      input.onDate,
      input.isClosed ? 1 : 0,
      input.isClosed ? null : input.openTime,
      input.isClosed ? null : input.closeTime,
      input.note.trim().slice(0, 200),
    ],
  )

  revalidatePath('/online-store/trading')
  return { ok: true }
}

export async function deleteTradingExceptionAction(onDate: string): Promise<TradingResult> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx

  await siteExecute(ctx.siteId, 'DELETE FROM online_trading_exceptions WHERE on_date = ?', [onDate])
  revalidatePath('/online-store/trading')
  return { ok: true }
}

/**
 * Marks a product sold out until a date, or puts it back on the menu.
 *
 * `until` of '' clears the mark — which is how staff put something back the
 * moment the fryer is fixed, rather than waiting for a date to pass.
 */
export async function setSoldOutAction(
  productId: number,
  until: string,
  note: string,
): Promise<TradingResult> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  if (!Number.isInteger(productId) || productId <= 0) {
    return { ok: false, error: 'That product no longer exists.' }
  }
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    return { ok: false, error: 'Choose a date.' }
  }

  await setSoldOut(siteId, productId, until || null, note, actor.userName)

  await logActivity(siteId, actor, {
    entity: 'product',
    entityId: productId,
    action: 'update',
    detail: until ? `Sold out online until ${until}` : 'Back on the online menu',
  }).catch(() => {})

  revalidatePath('/online-store/trading')
  return { ok: true }
}
