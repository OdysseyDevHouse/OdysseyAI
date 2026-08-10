import 'server-only'
import { siteQuery, siteExecute } from '@/lib/siteDb'
import { toNum } from '@/lib/decimals'

/**
 * The storefront funnel: view → add to cart → checkout → purchase.
 *
 * ── FIRST-PARTY, AND THAT IS THE POINT ───────────────────────────────────
 *
 * No third-party pixel, no advertising cookie, nothing leaving this database.
 * So there is no consent banner to bolt on, no data-processing agreement to
 * sign, and nothing disclosed about a shopper that the shop does not already
 * know from its own orders.
 *
 * ── IT STORES NO PERSON ──────────────────────────────────────────────────
 *
 * `sessionKey` is a random id the browser mints and keeps for one session. Not
 * a customer id, not an email, not an IP address, not a fingerprint. Its only
 * job is to join a view to a purchase. The same person tomorrow is a different
 * shopper as far as this table knows — a deliberate limitation, and the reason
 * this needs no consent.
 *
 * ── RECORDING NEVER FAILS A REQUEST ──────────────────────────────────────
 *
 * Every write here swallows its own errors. An analytics row is worth strictly
 * less than the page it is measuring, and a funnel that can break a checkout
 * is a funnel that will eventually break a checkout.
 */

type Row = Record<string, unknown>

export type EventKind = 'view' | 'add_to_cart' | 'begin_checkout' | 'purchase'

const KINDS: EventKind[] = ['view', 'add_to_cart', 'begin_checkout', 'purchase']

/** A session key is 32 hex characters. Anything else is not one. */
function validKey(raw: string): string | null {
  const key = (raw ?? '').trim().toLowerCase()
  return /^[a-f0-9]{32}$/.test(key) ? key : null
}

/**
 * Record one funnel event.
 *
 * Returns nothing and throws nothing — see the note above. A malformed session
 * key is dropped rather than stored, because a key that cannot have come from
 * our own script cannot join to anything either.
 */
export async function recordEvent(
  siteId: number,
  input: {
    kind: EventKind
    sessionKey: string
    productId?: number | null
    valueIncl?: number
  },
): Promise<void> {
  try {
    if (!KINDS.includes(input.kind)) return
    const key = validKey(input.sessionKey)
    if (!key) return

    const productId =
      Number.isInteger(input.productId) && Number(input.productId) > 0
        ? Number(input.productId)
        : null

    await siteExecute(
      siteId,
      `INSERT INTO storefront_events (kind, product_id, session_key, value_incl)
       VALUES (?,?,?,?)`,
      [input.kind, productId, key, Math.max(0, Number(input.valueIncl) || 0).toFixed(4)],
    )
  } catch {
    /* deliberately ignored — an event is worth less than the page it measures */
  }
}

export type FunnelStage = {
  kind: EventKind
  label: string
  /** Distinct SESSIONS that reached this stage, not raw events. */
  sessions: number
  /** Share of the sessions that reached the FIRST stage. */
  ofTop: number
  /** Share of the sessions that reached the stage immediately before. */
  ofPrevious: number
}

export type FunnelReport = {
  stages: FunnelStage[]
  /** What the purchases in this window were worth. */
  revenueIncl: number
  /** How many days back the window reaches. */
  days: number
}

const LABELS: Record<EventKind, string> = {
  view: 'Viewed a product',
  add_to_cart: 'Added to basket',
  begin_checkout: 'Started checkout',
  purchase: 'Ordered',
}

/**
 * The funnel over a window.
 *
 * ── SESSIONS, NOT EVENTS ─────────────────────────────────────────────────
 *
 * Counted DISTINCT by session at every stage. Raw events would make the top of
 * the funnel meaningless — one shopper browsing twenty products is twenty
 * views and one visit, and a conversion rate against the twenty is a number
 * that goes DOWN the more engaged a shopper is.
 *
 * ── EACH STAGE IS COUNTED INDEPENDENTLY ──────────────────────────────────
 *
 * A session that ordered is counted at "Ordered" whether or not it was ever
 * recorded viewing a product — someone arriving on a department page, adding
 * from the tile and checking out never fires a view. Requiring the earlier
 * stage would quietly under-count real orders, and a funnel that disagrees
 * with the orders list is a funnel nobody trusts.
 *
 * That does mean a later stage can exceed an earlier one. The report shows the
 * true figures rather than clamping, because a stage that is somehow larger is
 * telling the shop something real about how people reach it.
 */
export async function funnel(siteId: number, days: number): Promise<FunnelReport> {
  const window = windowDays(days)

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT kind, COUNT(DISTINCT session_key) AS sessions
       FROM storefront_events
      WHERE created_at >= (NOW() - INTERVAL ? DAY)
      GROUP BY kind`,
    [window],
  ).catch(() => [])

  const bySessionKind = new Map(
    rows.map((r) => [String(r.kind) as EventKind, Number(r.sessions ?? 0)]),
  )

  const revenue = await siteQuery<Row>(
    siteId,
    `SELECT COALESCE(SUM(value_incl), 0) AS total
       FROM storefront_events
      WHERE kind = 'purchase' AND created_at >= (NOW() - INTERVAL ? DAY)`,
    [window],
  ).catch(() => [])

  const top = bySessionKind.get('view') ?? 0
  let previous = 0

  const stages: FunnelStage[] = KINDS.map((kind, index) => {
    const sessions = bySessionKind.get(kind) ?? 0
    const stage: FunnelStage = {
      kind,
      label: LABELS[kind],
      sessions,
      // Guarded against a zero top: an empty window is 0%, not NaN%.
      ofTop: top > 0 ? (sessions / top) * 100 : 0,
      ofPrevious: index === 0 ? 100 : previous > 0 ? (sessions / previous) * 100 : 0,
    }
    previous = sessions
    return stage
  })

  return {
    stages,
    revenueIncl: toNum(revenue[0]?.total),
    days: window,
  }
}

/**
 * The window, clamped, and expressed in DAYS rather than as two timestamps.
 *
 * ── WHY NOT A PAIR OF JS DATES ───────────────────────────────────────────
 *
 * `created_at` is written by the database with CURRENT_TIMESTAMP, in the
 * database's own timezone. Passing a JS Date compares that against the app
 * process's clock, and the two are not the same wall time — on a server two
 * hours ahead of UTC, every event written today sits AFTER a `to` bound of
 * "now", and the report reads empty while the table is full.
 *
 * Measured, not theorised: with 204 events in the table the funnel returned
 * four zeros until this changed.
 *
 * Letting the database do its own arithmetic removes the mismatch entirely —
 * NOW() and created_at are then the same clock by construction.
 */
function windowDays(days: number): number {
  return Math.min(Math.max(Math.round(days) || 30, 1), 365)
}

/**
 * The products people look at most, and how often a look becomes a basket.
 *
 * The question behind it is "which products are being seen but not bought",
 * which is where a bad photograph or a wrong price shows up — and which no
 * report a shop already has can answer.
 */
export async function productFunnel(
  siteId: number,
  days: number,
  limit = 10,
): Promise<{ productId: number; description: string; views: number; adds: number }[]> {
  const rows = await siteQuery<Row>(
    siteId,
    // Same clock as the funnel above, for the same reason — see windowDays.
    `SELECT e.product_id,
            p.description,
            SUM(e.kind = 'view') AS views,
            SUM(e.kind = 'add_to_cart') AS adds
       FROM storefront_events e
       JOIN products p ON p.id = e.product_id
      WHERE e.created_at >= (NOW() - INTERVAL ? DAY)
        AND e.product_id IS NOT NULL
      GROUP BY e.product_id, p.description
      ORDER BY views DESC
      LIMIT ${Math.min(Math.max(limit, 1), 50)}`,
    [windowDays(days)],
  ).catch(() => [])

  return rows.map((r) => ({
    productId: Number(r.product_id),
    description: String(r.description ?? ''),
    views: Number(r.views ?? 0),
    adds: Number(r.adds ?? 0),
  }))
}
