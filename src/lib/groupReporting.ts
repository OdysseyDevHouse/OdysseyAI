import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { groupForSite, membersOfGroup, linkedStores, type StoreGroup } from './storeGroups'
import { getSiteForUser } from './sites'
import { getUserByControlId } from './site/users'
import {
  capabilitiesForRole,
  can,
  type Capability,
  type CapabilitySet,
} from './site/permissions'
import { siteQuery, siteQueryOne } from './siteDb'
import {
  incomeStatement,
  balanceSheet,
  type IncomeStatement,
  type BalanceSheet,
  type StatementGroup,
  type DateRange,
} from './site/financialStatements'
import { subtypeRank } from './glModel'
import { reconcileStoreTransfers, type StoreTransferDrift } from './site/storeTransfers'
import { addDays, daysBetweenDates } from './site/interestRules'
import { round, toNum } from './decimals'

/**
 * Consolidated reporting across a store group.
 *
 * Lives beside storeGroups.ts rather than under site/ because everything here
 * spans databases: the group comes from the control DB, the figures from each
 * member store's own DB. Nothing in this file writes anything, anywhere.
 *
 * ── WHO MAY SEE WHAT ─────────────────────────────────────────────────────
 *
 * Group membership alone proves nothing about the person asking. A member
 * store is included only when this user (a) may open it per cp2_user_sites —
 * the ONLY place site access is decided (sites.ts) — and (b) holds the
 * screen's capability under that store's OWN role. Anything less would make a
 * consolidated screen a way to read stores the user cannot open, which is
 * exactly what setup/linked-stores warns against. Excluded stores are
 * reported with their reason, never silently summed.
 *
 * ── ONE BROKEN STORE MUST NOT KILL THE SCREEN ────────────────────────────
 *
 * Schema drifts between sites and a member database can be unreachable. Every
 * per-site read runs through perSite(), which turns a throw into a per-store
 * error the page renders as a chip — the productFanout doctrine.
 */

export type GroupSite = {
  siteId: number
  name: string
  code: string
  isPrimary: boolean
}

export type ExcludedSite = {
  siteId: number
  name: string
  reason: 'no-access' | 'no-permission'
}

export type GroupScope = {
  group: StoreGroup
  sites: GroupSite[]
  excluded: ExcludedSite[]
}

/**
 * The stores a consolidated screen may aggregate for this user.
 *
 * Null when the current site belongs to no group — the single-store case,
 * where these screens show their empty state. Membership is the group list
 * (NOT the sharesProducts fan-out list — that flag governs product syncing,
 * and a store that shares nothing still trades and still consolidates).
 */
export async function groupScopeFor(
  currentSiteId: number,
  controlUserId: number,
  capability: Capability,
): Promise<GroupScope | null> {
  const group = await groupForSite(currentSiteId)
  if (!group) return null

  const members = (await membersOfGroup(group.id)).filter((m) => m.hasDatabase)
  const sites: GroupSite[] = []
  const excluded: ExcludedSite[] = []

  for (const member of members) {
    const entry = {
      siteId: member.siteId,
      name: member.displayName,
      code: member.siteCode,
      isPrimary: member.siteId === group.primarySiteId,
    }

    // The current site was already vetted by the session; re-checking it here
    // would only disagree with the page guard that let the user in.
    if (member.siteId === currentSiteId) {
      sites.push(entry)
      continue
    }

    const access = await getSiteForUser(controlUserId, member.siteId)
    if (!access) {
      excluded.push({ siteId: member.siteId, name: member.displayName, reason: 'no-access' })
      continue
    }

    try {
      // A control user who has never opened a member store has no local users
      // row there yet (adoption happens on first visit) — that is a
      // no-permission outcome, not a crash.
      const local = await getUserByControlId(member.siteId, controlUserId)
      const caps = local ? await capabilitiesForRole(member.siteId, local.roleId) : null
      if (!local || !local.isActive || !caps || !can(caps, capability)) {
        excluded.push({ siteId: member.siteId, name: member.displayName, reason: 'no-permission' })
        continue
      }
    } catch {
      // An unreachable member database cannot prove permission either way —
      // treated as no-permission so the aggregate stays honest.
      excluded.push({ siteId: member.siteId, name: member.displayName, reason: 'no-permission' })
      continue
    }

    sites.push(entry)
  }

  // Primary store first, then the group's own display order (membersOfGroup
  // orders by position). First-seen wins in every merge below, so the primary
  // store's account names take precedence.
  sites.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))

  return { group, sites, excluded }
}

/**
 * The stores a PRODUCT-LEVEL report may aggregate for this user.
 *
 * The difference from groupScopeFor is the whole reason this exists: that one
 * uses group MEMBERSHIP, which is right for money — a store keeps its own books
 * whether or not it shares a product file, and its revenue consolidates either
 * way. Product identity across databases is the stock CODE, and a code only
 * means the same thing in two stores that actually share a product file.
 *
 * Aggregate by code over `membersOfGroup` and you sum unrelated products that
 * happen to collide on a code — "A-1042" is coffee beans in one shop and a
 * brake pad in another. That produces numbers, and they are silently
 * meaningless, which is worse than an error.
 *
 * So this narrows to `linkedStores()` (hasDatabase AND sharesProducts) and then
 * applies exactly the same per-store permission check as groupScopeFor: group
 * membership still proves nothing about the person asking.
 */
export async function productScopeFor(
  currentSiteId: number,
  controlUserId: number,
  capability: Capability,
): Promise<GroupScope | null> {
  const group = await groupForSite(currentSiteId)
  if (!group) return null

  const shared = await linkedStores(currentSiteId)
  const scope = await groupScopeFor(currentSiteId, controlUserId, capability)
  if (!scope) return null

  const sharesProducts = new Set(shared.map((m) => m.siteId))

  /* A store in the group that shares nothing is not "excluded" in the sense the
     page reports — it is simply not part of this question, and listing it as a
     permission problem would be a lie. It is dropped from both lists. */
  return {
    group: scope.group,
    sites: scope.sites.filter((s) => sharesProducts.has(s.siteId)),
    excluded: scope.excluded.filter((e) => sharesProducts.has(e.siteId)),
  }
}

/**
 * What this control user may do AT one member store, under that store's own role.
 *
 * The same lookup groupScopeFor makes inline, exported because running a report
 * across stores needs the predicate itself rather than a yes/no answer: the
 * engine strips columns per store, so a junior at one shop sees that shop's
 * figures without cost while an owner's own store keeps them.
 *
 * Null when the user has never opened that store (no local users row yet) or it
 * cannot be read — both mean "assume nothing", and the caller refuses.
 */
export async function capabilitiesForSiteUser(
  siteId: number,
  controlUserId: number,
): Promise<CapabilitySet | null> {
  try {
    const local = await getUserByControlId(siteId, controlUserId)
    if (!local || !local.isActive) return null
    return await capabilitiesForRole(siteId, local.roleId)
  } catch {
    return null
  }
}

/* ── Fail-soft per-site runner ────────────────────────────────────────────── */

export type SiteResult<T> = { siteId: number; name: string } & (
  | { ok: true; data: T }
  | { ok: false; error: string }
)

/** Runs one read against every store, turning throws into per-store errors. */
export async function perSite<T>(
  sites: GroupSite[],
  fn: (siteId: number) => Promise<T>,
): Promise<SiteResult<T>[]> {
  const settled = await Promise.allSettled(sites.map((s) => fn(s.siteId)))
  return settled.map((outcome, i) => {
    const base = { siteId: sites[i].siteId, name: sites[i].name }
    if (outcome.status === 'fulfilled') return { ...base, ok: true as const, data: outcome.value }
    const reason = outcome.reason
    return {
      ...base,
      ok: false as const,
      error: reason instanceof Error ? reason.message : 'This store could not be read.',
    }
  })
}

/* ── Group dashboard ──────────────────────────────────────────────────────── */

/** One period's trading, the same shape whether it is this month or last. */
export type PeriodTrading = {
  turnoverIncl: number
  turnoverExcl: number
  grossProfit: number
  saleCount: number
}

export type GroupDashboardRow = {
  today: { turnoverIncl: number; saleCount: number }
  month: PeriodTrading
  /**
   * The SAME span one period earlier, so every figure can be shown as a change
   * rather than a bare number. A month-to-date total compares against the same
   * number of days of the previous month — not the whole of it, which would
   * report every store as down until the last day of the month.
   */
  previous: PeriodTrading
  stockValue: number
  /** Drawer variance over the month: counted minus expected, summed. */
  cashVariance: number
  /** What the month's voids, refunds and discounts came to — the leak figures. */
  exceptions: { voidValue: number; voidCount: number; discountValue: number }
}

type Row = RowDataPacket & Record<string, unknown>

/** Turnover, cost and count for one date span — the shape both periods share. */
async function tradingFor(siteId: number, from: string, to: string): Promise<PeriodTrading> {
  const [lines, docs] = await Promise.all([
    siteQueryOne<Row>(
      siteId,
      `SELECT COALESCE(SUM(l.line_total_incl), 0) AS incl,
              COALESCE(SUM(l.line_total_excl), 0) AS excl,
              COALESCE(SUM(l.unit_cost_excl * l.qty), 0) AS cost
         FROM sales_document_lines l
         JOIN sales_documents d ON d.id = l.document_id
        WHERE d.status = 'finalised'
          AND d.doc_type IN ('invoice','credit_sale')
          AND d.document_date BETWEEN ? AND ?`,
      [from, to],
    ),
    siteQueryOne<Row>(
      siteId,
      `SELECT COUNT(*) AS n FROM sales_documents
        WHERE status = 'finalised' AND doc_type = 'invoice'
          AND document_date BETWEEN ? AND ?`,
      [from, to],
    ),
  ])

  const excl = toNum(lines?.excl)
  return {
    turnoverIncl: toNum(lines?.incl),
    turnoverExcl: excl,
    grossProfit: round(excl - toNum(lines?.cost), 2),
    saleCount: Number(docs?.n ?? 0),
  }
}

/**
 * One read that must never fail the whole row.
 *
 * Schema drifts between sites: a store can be behind on migrations and lack the
 * shift tables entirely. Its SALES are still worth showing, so a missing table
 * yields null here rather than throwing out to perSite and turning the store
 * into an error chip. Reserved for figures that are genuinely supplementary —
 * a store whose sales cannot be read IS an error, and still reports as one.
 */
async function safeQueryOne(
  siteId: number,
  sql: string,
  params: unknown[] = [],
): Promise<Row | null> {
  try {
    return await siteQueryOne<Row>(siteId, sql, params)
  } catch {
    return null
  }
}

/**
 * The trading picture per store: today, the month so far, the same span a
 * period earlier, stock at cost, and the month's leak figures.
 *
 * The sale queries mirror salesDashboard's kpisFor exactly — finalised
 * invoices and credit sales by document_date — so this screen and each
 * store's own dashboard can never disagree about what counts as a sale.
 *
 * The comparison period is passed in rather than derived here: only the caller
 * knows which month it is looking at, and a helper guessing "30 days back"
 * would silently mis-compare a 28-day February against a 31-day January.
 *
 * Cash variance and the exception figures are read fail-soft INSIDE the fan-out
 * (see safeQueryOne): schema drifts between sites, and a store missing the
 * shift tables must still contribute its sales rather than failing the row.
 */
export async function groupDashboard(
  sites: GroupSite[],
  range: {
    todayIso: string
    monthFrom: string
    monthTo: string
    prevFrom: string
    prevTo: string
  },
): Promise<SiteResult<GroupDashboardRow>[]> {
  return perSite(sites, async (siteId) => {
    const [month, previous, todayDocs, stock, variance, exceptions] = await Promise.all([
      tradingFor(siteId, range.monthFrom, range.monthTo),
      tradingFor(siteId, range.prevFrom, range.prevTo),
      siteQueryOne<Row>(
        siteId,
        `SELECT COUNT(*) AS n, COALESCE(SUM(total_incl), 0) AS total
           FROM sales_documents
          WHERE status = 'finalised' AND doc_type = 'invoice'
            AND document_date = ?`,
        [range.todayIso],
      ),
      siteQueryOne<Row>(
        siteId,
        `SELECT COALESCE(SUM(stock_on_hand * average_cost), 0) AS v
           FROM products WHERE is_archived = 0`,
      ),
      /* The variance signed off at close, not one recomputed here — the shift
         row stores it precisely so the figure on a report is the one somebody
         put their name to. Shifts are dated by when they OPENED. */
      safeQueryOne(
        siteId,
        `SELECT COALESCE(SUM(variance), 0) AS v
           FROM shifts
          WHERE closed_at IS NOT NULL
            AND DATE(opened_at) BETWEEN ? AND ?`,
        [range.monthFrom, range.monthTo],
      ),
      /* Cancellations and discounts, the two leak figures a head office reads
         together. 'cancelled' is the only value there is — 022 merged 'void'
         into it — and the discount comes off finalised documents only, since a
         discount on a cancelled sale never happened. */
      safeQueryOne(
        siteId,
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'cancelled' THEN total_incl END), 0) AS void_value,
           COALESCE(SUM(status = 'cancelled'), 0)                               AS void_count,
           COALESCE(SUM(CASE WHEN status = 'finalised' THEN discount_total END), 0) AS discount_value
         FROM sales_documents
        WHERE document_date BETWEEN ? AND ?`,
        [range.monthFrom, range.monthTo],
      ),
    ])

    return {
      today: { turnoverIncl: toNum(todayDocs?.total), saleCount: Number(todayDocs?.n ?? 0) },
      month,
      previous,
      stockValue: round(toNum(stock?.v), 2),
      cashVariance: round(toNum(variance?.v), 2),
      exceptions: {
        voidValue: round(toNum(exceptions?.void_value), 2),
        voidCount: Number(exceptions?.void_count ?? 0),
        discountValue: round(toNum(exceptions?.discount_value), 2),
      },
    }
  })
}

/* ── Sales by store, over time ────────────────────────────────────────────── */

/** How the date axis is bucketed. */
export type SalesGrain = 'day' | 'month'

export type SalesByStorePeriod = {
  /** '2026-08-14' for a day, '2026-08' for a month — sorts correctly as text. */
  period: string
  /**
   * One entry per site, index-aligned with `sites`. Null means the store did
   * not trade in that period at all, which is a different statement from a day
   * it opened and took nothing — see StoreColumnTable.
   */
  perSite: (number | null)[]
  total: number
}

export type SalesByStore = {
  range: DateRange
  grain: SalesGrain
  sites: { siteId: number; name: string }[]
  failures: { siteId: number; name: string; error: string }[]
  periods: SalesByStorePeriod[]
  /** Each store's total for the whole range, index-aligned with `sites`. */
  perSiteTotals: number[]
  total: number
}

/**
 * Turnover per store per day or month — the backbone chain report.
 *
 * Grouped in SQL rather than by reading every document and bucketing in
 * TypeScript: a year of daily sales across five stores is a few hundred rows
 * out of the database this way, and hundreds of thousands the other.
 *
 * A store missing from a period keeps NULL rather than zero. Over a date range
 * this matters more than it looks: a store that opened in June should show
 * dashes for January to May, not five months of "R0.00" implying it traded and
 * sold nothing.
 */
export async function salesByStore(
  sites: GroupSite[],
  range: DateRange,
  grain: SalesGrain = 'day',
): Promise<SalesByStore> {
  // The format string is chosen HERE from a closed union, never interpolated
  // from anything a caller supplies.
  const bucket = grain === 'month' ? `DATE_FORMAT(d.document_date, '%Y-%m')` : `d.document_date`

  const results = await perSite(sites, async (siteId) => {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT ${bucket} AS period,
              COALESCE(SUM(l.line_total_incl), 0) AS incl
         FROM sales_document_lines l
         JOIN sales_documents d ON d.id = l.document_id
        WHERE d.status = 'finalised'
          AND d.doc_type IN ('invoice','credit_sale')
          AND d.document_date BETWEEN ? AND ?
        GROUP BY period
        ORDER BY period`,
      [range.from, range.to],
    )
    const out = new Map<string, number>()
    for (const r of rows) {
      // A DATE comes back as a Date object from the driver; the month bucket is
      // already a string. periodKey normalises both without a timezone shift.
      out.set(periodKey(r.period), toNum(r.incl))
    }
    return out
  })

  const ok = results.filter((r): r is SiteResult<Map<string, number>> & { ok: true } => r.ok)
  const failures = results
    .filter((r): r is SiteResult<Map<string, number>> & { ok: false } => !r.ok)
    .map((r) => ({ siteId: r.siteId, name: r.name, error: r.error }))

  // Every period any store traded in, ascending. Built from what came back
  // rather than generated from the range, so a 400-day range with two trading
  // days is two rows.
  const allPeriods = [...new Set(ok.flatMap((r) => [...r.data.keys()]))].sort()

  const periods: SalesByStorePeriod[] = allPeriods.map((period) => {
    const perSiteValues = ok.map((r) => r.data.get(period) ?? null)
    return {
      period,
      perSite: perSiteValues,
      total: round(
        perSiteValues.reduce<number>((t, v) => (v === null ? t : t + v), 0),
        2,
      ),
    }
  })

  return {
    range,
    grain,
    sites: ok.map((r) => ({ siteId: r.siteId, name: r.name })),
    failures,
    periods,
    perSiteTotals: ok.map((r) =>
      round(
        [...r.data.values()].reduce((t, v) => t + v, 0),
        2,
      ),
    ),
    total: round(
      periods.reduce((t, p) => t + p.total, 0),
      2,
    ),
  }
}

/**
 * A period cell as a sortable string.
 *
 * The driver hands back a Date for a DATE column, and the pool runs in UTC
 * (timezone 'Z'), so the wall-clock date must be read with getUTC* — using
 * getDate() here would shift a day backwards for anyone east of Greenwich and
 * silently file Monday's takings under Sunday.
 */
function periodKey(value: unknown): string {
  if (value instanceof Date) {
    const y = value.getUTCFullYear()
    const m = String(value.getUTCMonth() + 1).padStart(2, '0')
    const d = String(value.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(value ?? '')
}

/* ── Stock across stores, and rebalancing ─────────────────────────────────── */

export type StoreStockCell = {
  /** Null when the store does not carry this code at all — a dash, not a zero. */
  onHand: number | null
  /** The store's own reorder level, summed over its locations. */
  minStock: number
  /** onHand - minStock, negative when short. Null when not carried. */
  shortfall: number | null
}

export type StockLine = {
  code: string
  description: string
  /** Index-aligned with `sites`. */
  perSite: StoreStockCell[]
  totalOnHand: number
  /** Stores short of their reorder level, and stores with surplus above it. */
  shortCount: number
  surplusCount: number
}

export type GroupStock = {
  sites: { siteId: number; name: string }[]
  failures: { siteId: number; name: string; error: string }[]
  lines: StockLine[]
  /** True when the per-store cap trimmed the list — see the note on the page. */
  truncated: boolean
}

/** One store's holding of one code. */
type StockRow = { code: string; description: string; onHand: number; minStock: number }

const STOCK_CODE_CAP = 400

/**
 * What every linked store holds, by stock code.
 *
 * Matched by CODE, the only thing that identifies a product across databases —
 * ids increment independently per site and say nothing about each other. Callers
 * MUST scope with productScopeFor, not groupScopeFor: see the note there.
 *
 * In-transit locations are excluded. Goods dispatched from one store and not yet
 * received sit in the sender's transit location; counting them would show stock
 * that is on a van as available to sell, and a rebalancing suggestion would then
 * propose moving it again.
 *
 * `onlyProblems` restricts the fan-out to codes some store is short of, which is
 * what the rebalancing screen wants — a 40,000-product file is not a report.
 */
export async function groupStockByCode(
  sites: GroupSite[],
  options: { onlyProblems?: boolean; search?: string } = {},
): Promise<GroupStock> {
  const search = options.search?.trim()

  const results = await perSite(sites, async (siteId) => {
    const params: unknown[] = []
    let having = 'HAVING SUM(pls.stock_on_hand) <> 0 OR SUM(pls.min_stock) > 0'
    if (options.onlyProblems) {
      // Short of the reorder level at THIS store, or in the negative.
      having = 'HAVING SUM(pls.min_stock) > 0 AND SUM(pls.stock_on_hand) < SUM(pls.min_stock)'
    }
    let where = 'WHERE p.is_archived = 0 AND (l.is_transit = 0 OR l.is_transit IS NULL)'
    if (search) {
      where += ' AND (p.code LIKE ? OR p.description LIKE ?)'
      params.push(`%${search}%`, `%${search}%`)
    }

    const rows = await siteQuery<Row>(
      siteId,
      `SELECT p.code AS code,
              MIN(p.description) AS description,
              COALESCE(SUM(pls.stock_on_hand), 0) AS on_hand,
              COALESCE(SUM(pls.min_stock), 0) AS min_stock
         FROM products p
         JOIN product_location_stock pls ON pls.product_id = p.id
         LEFT JOIN stock_locations l ON l.id = pls.location_id
         ${where}
         GROUP BY p.code
         ${having}
         ORDER BY p.code
         LIMIT ${STOCK_CODE_CAP + 1}`,
      params,
    )
    return rows.map<StockRow>((r) => ({
      code: String(r.code ?? ''),
      description: String(r.description ?? ''),
      onHand: toNum(r.on_hand),
      minStock: toNum(r.min_stock),
    }))
  })

  const ok = results.filter((r): r is SiteResult<StockRow[]> & { ok: true } => r.ok)
  const failures = results
    .filter((r): r is SiteResult<StockRow[]> & { ok: false } => !r.ok)
    .map((r) => ({ siteId: r.siteId, name: r.name, error: r.error }))

  const truncated = ok.some((r) => r.data.length > STOCK_CODE_CAP)
  const byCode = new Map<string, Map<number, StockRow>>()
  const descriptions = new Map<string, string>()

  ok.forEach((store, i) => {
    for (const row of store.data.slice(0, STOCK_CODE_CAP)) {
      if (!row.code) continue
      const perStore = byCode.get(row.code) ?? new Map<number, StockRow>()
      perStore.set(i, row)
      byCode.set(row.code, perStore)
      // First store to name it wins, matching the account-name rule in the
      // consolidated statement — sites are sorted primary-first.
      if (!descriptions.has(row.code)) descriptions.set(row.code, row.description)
    }
  })

  /* Every store's holding of a code the FAN-OUT surfaced, including stores whose
     own query excluded it. Without this second pass a rebalancing report shows
     only the stores that are short and never the one holding the surplus —
     which is the entire answer it exists to give. */
  const wantedCodes = [...byCode.keys()]
  if (options.onlyProblems && wantedCodes.length > 0) {
    const fill = await perSite(sites, async (siteId) => {
      const placeholders = wantedCodes.map(() => '?').join(',')
      const rows = await siteQuery<Row>(
        siteId,
        `SELECT p.code AS code,
                MIN(p.description) AS description,
                COALESCE(SUM(pls.stock_on_hand), 0) AS on_hand,
                COALESCE(SUM(pls.min_stock), 0) AS min_stock
           FROM products p
           JOIN product_location_stock pls ON pls.product_id = p.id
           LEFT JOIN stock_locations l ON l.id = pls.location_id
          WHERE p.is_archived = 0
            AND (l.is_transit = 0 OR l.is_transit IS NULL)
            AND p.code IN (${placeholders})
          GROUP BY p.code`,
        wantedCodes,
      )
      return rows.map<StockRow>((r) => ({
        code: String(r.code ?? ''),
        description: String(r.description ?? ''),
        onHand: toNum(r.on_hand),
        minStock: toNum(r.min_stock),
      }))
    })

    fill.forEach((store, i) => {
      if (!store.ok) return
      for (const row of store.data) {
        const perStore = byCode.get(row.code)
        if (perStore && !perStore.has(i)) perStore.set(i, row)
      }
    })
  }

  const lines: StockLine[] = [...byCode.entries()]
    .map(([code, perStore]) => {
      const perSite = ok.map((_, i): StoreStockCell => {
        const row = perStore.get(i)
        if (!row) return { onHand: null, minStock: 0, shortfall: null }
        return {
          onHand: row.onHand,
          minStock: row.minStock,
          shortfall: round(row.onHand - row.minStock, 3),
        }
      })
      return {
        code,
        description: descriptions.get(code) ?? '',
        perSite,
        totalOnHand: round(
          perSite.reduce<number>((t, c) => (c.onHand === null ? t : t + c.onHand), 0),
          3,
        ),
        shortCount: perSite.filter((c) => c.minStock > 0 && c.shortfall !== null && c.shortfall < 0)
          .length,
        surplusCount: perSite.filter((c) => c.shortfall !== null && c.shortfall > 0).length,
      }
    })
    .sort((a, b) => a.code.localeCompare(b.code))

  return { sites: ok.map((r) => ({ siteId: r.siteId, name: r.name })), failures, lines, truncated }
}

export type RebalanceSuggestion = {
  code: string
  description: string
  fromSiteId: number
  fromName: string
  toSiteId: number
  toName: string
  /** Whole units to move. Never more than the sender can spare. */
  qty: number
  /** What the receiver is short by, for context. */
  shortBy: number
  /** What the sender holds above its own reorder level. */
  senderSpare: number
}

/**
 * Where stock should move: one store short, another holding surplus.
 *
 * The most profitable multi-store report there is, because it turns dead stock
 * at one shop into sales at another without buying anything.
 *
 * The rule is deliberately conservative. A sender only offers what it holds
 * ABOVE its own reorder level, so a transfer can never create a second shortage
 * to fix the first — the most common way an automated suggestion makes things
 * worse. Quantities are whole units: half a case is not a transfer.
 *
 * Suggestions are advice, not actions. Nothing here writes anything; moving the
 * stock is a store transfer somebody chooses to raise (site/storeTransfers.ts).
 */
export function rebalanceSuggestions(stock: GroupStock): RebalanceSuggestion[] {
  const out: RebalanceSuggestion[] = []

  for (const line of stock.lines) {
    if (line.shortCount === 0 || line.surplusCount === 0) continue

    // Who needs it most, and who can most afford to give — greatest need first
    // so the scarcest stock goes where it is most useful.
    const needs = line.perSite
      .map((c, i) => ({ i, need: c.minStock > 0 && c.shortfall !== null ? -c.shortfall : 0 }))
      .filter((n) => n.need > 0)
      .sort((a, b) => b.need - a.need)

    const spare = line.perSite
      .map((c, i) => ({ i, spare: c.shortfall !== null && c.shortfall > 0 ? c.shortfall : 0 }))
      .filter((s) => s.spare > 0)
      .sort((a, b) => b.spare - a.spare)

    for (const need of needs) {
      let outstanding = need.need
      for (const donor of spare) {
        if (outstanding <= 0) break
        if (donor.spare <= 0 || donor.i === need.i) continue

        const qty = Math.floor(Math.min(outstanding, donor.spare))
        if (qty < 1) continue

        out.push({
          code: line.code,
          description: line.description,
          fromSiteId: stock.sites[donor.i].siteId,
          fromName: stock.sites[donor.i].name,
          toSiteId: stock.sites[need.i].siteId,
          toName: stock.sites[need.i].name,
          qty,
          shortBy: round(need.need, 3),
          senderSpare: round(donor.spare, 3),
        })

        donor.spare -= qty
        outstanding -= qty
      }
    }
  }

  // Biggest moves first: a suggestion to shift 200 units matters more than one
  // to shift 2, and a list nobody reads to the end should lead with the former.
  return out.sort((a, b) => b.qty - a.qty)
}

/* ── Consolidated balance sheet ───────────────────────────────────────────── */

export type ConsolidatedBalanceSheet = {
  asAt: string
  sites: { siteId: number; name: string }[]
  failures: { siteId: number; name: string; error: string }[]
  assets: ConsolidatedBlock[]
  assetsTotal: number
  perSiteAssets: number[]
  liabilities: ConsolidatedBlock[]
  liabilitiesTotal: number
  equity: ConsolidatedBlock[]
  equityTotal: number
  /** This year's unclosed result, summed — it belongs in equity but has no account. */
  currentYearResult: number
  totalEquityAndReserves: number
  /** assets − (liabilities + equity + result). Zero when every ledger is sound. */
  outOfBalance: number
  balanced: boolean
}

/**
 * Merges statement groups from several stores into blocks keyed by ACCOUNT CODE.
 *
 * Pulled out of mergeIncomeStatements so the balance sheet gets the identical
 * treatment: same code matching, same first-seen naming, same null-where-absent
 * rule. Two implementations of this would be two chances to disagree about what
 * a missing account means.
 */
function mergeGroups(
  siteCount: number,
  perStoreGroups: StatementGroup[][],
): { blocks: ConsolidatedBlock[]; perSiteTotals: number[]; total: number } {
  type Merged = ConsolidatedLine & { subtype: string | null; label: string }
  const merged = new Map<string, Merged>()

  perStoreGroups.forEach((groups, siteIndex) => {
    for (const group of groups) {
      for (const line of group.lines) {
        const existing = merged.get(line.accountCode)
        if (existing) {
          existing.perSite[siteIndex] = line.amount
          existing.total = round(existing.total + line.amount, 2)
        } else {
          const perSite: (number | null)[] = Array.from({ length: siteCount }, () => null)
          perSite[siteIndex] = line.amount
          merged.set(line.accountCode, {
            accountCode: line.accountCode,
            name: line.name,
            subtype: group.subtype,
            label: group.label,
            perSite,
            total: line.amount,
          })
        }
      }
    }
  })

  const grouped = new Map<string, ConsolidatedBlock>()
  const lines = [...merged.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode))
  for (const line of lines) {
    const key = line.subtype ?? '~none'
    const block = grouped.get(key) ?? {
      subtype: line.subtype,
      label: line.label,
      lines: [],
      perSiteTotals: Array.from({ length: siteCount }, () => 0),
      total: 0,
    }
    block.lines.push({
      accountCode: line.accountCode,
      name: line.name,
      perSite: line.perSite,
      total: line.total,
    })
    line.perSite.forEach((v, i) => {
      block.perSiteTotals[i] = round(block.perSiteTotals[i] + (v ?? 0), 2)
    })
    block.total = round(block.total + line.total, 2)
    grouped.set(key, block)
  }

  const blocks = [...grouped.values()].sort(
    (a, b) => subtypeRank(a.subtype) - subtypeRank(b.subtype),
  )
  const perSiteTotals = Array.from({ length: siteCount }, (_, i) =>
    round(blocks.reduce((t, b) => t + b.perSiteTotals[i], 0), 2),
  )

  return {
    blocks,
    perSiteTotals,
    total: round(blocks.reduce((t, b) => t + b.total, 0), 2),
  }
}

/**
 * One balance sheet across every linked store, merged by account code.
 *
 * The same simple consolidation the P&L makes, and the same caveat: balances
 * between linked stores are NOT eliminated. If one store owes another, both the
 * receivable and the payable appear. For a group of shops with no inter-company
 * lending that is the whole picture; for one with a treasury function it is a
 * starting point, and the page says so.
 *
 * `outOfBalance` is summed rather than recomputed. A group whose stores each
 * balance individually balances in total, so a non-zero figure here always
 * points at a specific store's ledger rather than at the merge.
 */
export async function consolidatedBalanceSheet(
  sites: GroupSite[],
  asAt: string,
): Promise<ConsolidatedBalanceSheet> {
  const results = await perSite(sites, (siteId) => balanceSheet(siteId, asAt))
  const ok = results.filter((r): r is SiteResult<BalanceSheet> & { ok: true } => r.ok)
  const failures = results
    .filter((r): r is SiteResult<BalanceSheet> & { ok: false } => !r.ok)
    .map((r) => ({ siteId: r.siteId, name: r.name, error: r.error }))

  const n = ok.length
  const assets = mergeGroups(n, ok.map((r) => r.data.assets))
  const liabilities = mergeGroups(n, ok.map((r) => r.data.liabilities))
  const equity = mergeGroups(n, ok.map((r) => r.data.equity))

  const currentYearResult = round(ok.reduce((t, r) => t + r.data.currentYearResult, 0), 2)
  const totalEquityAndReserves = round(equity.total + currentYearResult, 2)
  const outOfBalance = round(assets.total - (liabilities.total + totalEquityAndReserves), 2)

  return {
    asAt,
    sites: ok.map((r) => ({ siteId: r.siteId, name: r.name })),
    failures,
    assets: assets.blocks,
    assetsTotal: assets.total,
    perSiteAssets: assets.perSiteTotals,
    liabilities: liabilities.blocks,
    liabilitiesTotal: liabilities.total,
    equity: equity.blocks,
    equityTotal: equity.total,
    currentYearResult,
    totalEquityAndReserves,
    outOfBalance,
    balanced: Math.abs(outOfBalance) < 0.01,
  }
}

/* ── Keyed merges: departments, tenders, hours ────────────────────────────── */

/**
 * One merged row: a key every store agrees on, a figure per store, a total.
 *
 * The shape three reports share, so the merge is written once. `perSite` keeps
 * null where a store has no such key at all — a department it does not run, a
 * tender it does not accept — which the table renders as a dash rather than a
 * zero, exactly as the consolidated statement does for a missing account.
 */
export type KeyedLine = {
  key: string
  label: string
  perSite: (number | null)[]
  total: number
}

export type KeyedReport = {
  sites: { siteId: number; name: string }[]
  failures: { siteId: number; name: string; error: string }[]
  lines: KeyedLine[]
  total: number
}

/** What one store returned: a key, a display label, and a figure. */
type KeyedRow = { key: string; label: string; value: number }

/**
 * Fans a per-store keyed query out and merges it, first-seen naming the row.
 *
 * Sites arrive primary-first, so the primary store's label for a key wins —
 * the same rule mergeIncomeStatements uses for account names, and for the same
 * reason: two stores can spell a department differently and only one name can
 * head the row.
 */
async function keyedMerge(
  sites: GroupSite[],
  read: (siteId: number) => Promise<KeyedRow[]>,
  sortBy: 'total' | 'key' = 'total',
): Promise<KeyedReport> {
  const results = await perSite(sites, read)
  const ok = results.filter((r): r is SiteResult<KeyedRow[]> & { ok: true } => r.ok)
  const failures = results
    .filter((r): r is SiteResult<KeyedRow[]> & { ok: false } => !r.ok)
    .map((r) => ({ siteId: r.siteId, name: r.name, error: r.error }))

  const labels = new Map<string, string>()
  const values = new Map<string, Map<number, number>>()

  ok.forEach((store, i) => {
    for (const row of store.data) {
      if (!labels.has(row.key)) labels.set(row.key, row.label)
      const byStore = values.get(row.key) ?? new Map<number, number>()
      byStore.set(i, row.value)
      values.set(row.key, byStore)
    }
  })

  const lines: KeyedLine[] = [...values.entries()].map(([key, byStore]) => {
    const perSite = ok.map((_, i) => byStore.get(i) ?? null)
    return {
      key,
      label: labels.get(key) ?? key,
      perSite,
      total: round(perSite.reduce<number>((t, v) => (v === null ? t : t + v), 0), 2),
    }
  })

  lines.sort((a, b) => (sortBy === 'key' ? a.key.localeCompare(b.key) : b.total - a.total))

  return {
    sites: ok.map((r) => ({ siteId: r.siteId, name: r.name })),
    failures,
    lines,
    total: round(lines.reduce((t, l) => t + l.total, 0), 2),
  }
}

/**
 * Turnover per department, per store.
 *
 * Matched by department NAME, not code: `departments.code` is nullable and
 * frequently unset, so a code match would silently drop most rows. Name is what
 * the shops actually keep in step, and `shares_departments` is what keeps it
 * so. A store that does not run a department keeps null, not zero.
 */
export async function departmentsByStore(
  sites: GroupSite[],
  range: DateRange,
): Promise<KeyedReport> {
  return keyedMerge(sites, async (siteId) => {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT COALESCE(dep.name, '(no department)') AS label,
              COALESCE(SUM(l.line_total_incl), 0) AS value
         FROM sales_document_lines l
         JOIN sales_documents d ON d.id = l.document_id
         LEFT JOIN products p ON p.id = l.product_id
         LEFT JOIN departments dep ON dep.id = p.department_id
        WHERE d.status = 'finalised'
          AND d.doc_type IN ('invoice','credit_sale')
          AND d.document_date BETWEEN ? AND ?
        GROUP BY label`,
      [range.from, range.to],
    )
    return rows.map((r) => ({
      key: String(r.label ?? ''),
      label: String(r.label ?? ''),
      value: toNum(r.value),
    }))
  })
}

/**
 * What was paid with, per store.
 *
 * Matched by tender CODE — the schema is explicit that code is the stable
 * handle and name is what a cashier may rename to "Kontant" without breaking a
 * rule. The code is snapshotted onto every tender row, so this needs no join
 * and a tender deleted since the sale still reports.
 *
 * Amounts are NET of change: a R100 note against an R87.50 sale is R87.50 of
 * cash taken, not R100. The gross figure is what the drawer saw, which is the
 * cash-up's question rather than this one.
 */
export async function tendersByStore(sites: GroupSite[], range: DateRange): Promise<KeyedReport> {
  return keyedMerge(sites, async (siteId) => {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT t.tender_code AS code,
              MIN(t.tender_name) AS label,
              COALESCE(SUM(t.amount - t.change_given), 0) AS value
         FROM sales_tenders t
         JOIN sales_documents d ON d.id = t.document_id
        WHERE d.status = 'finalised'
          AND d.document_date BETWEEN ? AND ?
        GROUP BY t.tender_code`,
      [range.from, range.to],
    )
    return rows.map((r) => ({
      key: String(r.code ?? ''),
      label: String(r.label ?? r.code ?? ''),
      value: toNum(r.value),
    }))
  })
}

/**
 * Turnover by hour of day, per store.
 *
 * Keyed on the hour as a zero-padded string so it sorts as text and reads as a
 * label without a second lookup. Sorted by KEY rather than by total — a trading
 * pattern is only legible in clock order.
 *
 * Read from `created_at`, not `document_date`: a DATE column has no time in it,
 * and the whole question here is what time of day the shop was busy.
 */
export async function hoursByStore(sites: GroupSite[], range: DateRange): Promise<KeyedReport> {
  return keyedMerge(
    sites,
    async (siteId) => {
      const rows = await siteQuery<Row>(
        siteId,
        `SELECT LPAD(HOUR(d.created_at), 2, '0') AS hh,
                COALESCE(SUM(d.total_incl), 0) AS value
           FROM sales_documents d
          WHERE d.status = 'finalised'
            AND d.doc_type IN ('invoice','credit_sale')
            AND d.document_date BETWEEN ? AND ?
          GROUP BY hh`,
        [range.from, range.to],
      )
      return rows.map((r) => {
        const hh = String(r.hh ?? '00')
        return { key: hh, label: `${hh}:00`, value: toNum(r.value) }
      })
    },
    'key',
  )
}

/* ── Store transfers, across the group ────────────────────────────────────── */

export type GroupTransferDrift = StoreTransferDrift & {
  /** The store holding the problem — the one whose books are wrong. */
  siteId: number
  siteName: string
}

export type TransferFlowLeg = {
  fromSiteId: number
  fromName: string
  toSiteId: number
  toName: string
  transfers: number
  units: number
}

export type GroupTransfers = {
  /** Every drift across the group, unsettled first — those are counted twice. */
  drift: GroupTransferDrift[]
  /** Who sends what to whom over the period. */
  flow: TransferFlowLeg[]
  /** Dispatched and not yet received, right now, by sender. */
  inTransit: { siteId: number; name: string; transfers: number; units: number }[]
  failures: { siteId: number; name: string; error: string }[]
}

/**
 * Store transfers seen from above — drift, flow, and what is on the road.
 *
 * `reconcileStoreTransfers` already answers this per store, and answers it well:
 * it opens the PEER's database to ask whether the far end has already taken
 * goods this store still holds. What it cannot do is show the group. Finding a
 * transfer counted twice today means opening each store in turn and knowing to
 * look, which is a check nobody runs.
 *
 * `unsettled` drift is the one that matters: the receiver has the goods and the
 * sender still holds them, so the group's stock figure is overstated until
 * settleDispatch runs. `stale` is a late lorry — worth seeing, not an error, and
 * the two are never merged into one alarm.
 */
export async function groupTransfers(
  sites: GroupSite[],
  range: DateRange,
  staleAfterDays = 7,
): Promise<GroupTransfers> {
  const results = await perSite(sites, async (siteId) => {
    const [drift, flow, transit] = await Promise.all([
      reconcileStoreTransfers(siteId, staleAfterDays),
      /* Outbound only. Every inter-store transfer exists as two documents, one
         per database, so counting both directions would report every movement
         twice — once as the sender's 'out' and again as the receiver's 'in'. */
      siteQuery<Row>(
        siteId,
        `SELECT t.peer_site_id AS peer_id,
                MIN(t.peer_site_name) AS peer_name,
                COUNT(*) AS transfers,
                COALESCE(SUM((SELECT SUM(l.qty) FROM stock_transfer_lines l
                               WHERE l.transfer_id = t.id)), 0) AS units
           FROM stock_transfers t
          WHERE t.direction = 'out'
            AND t.status IN ('in_transit','received')
            AND t.document_date BETWEEN ? AND ?
            AND t.peer_site_id IS NOT NULL
          GROUP BY t.peer_site_id`,
        [range.from, range.to],
      ),
      siteQueryOne<Row>(
        siteId,
        `SELECT COUNT(*) AS transfers,
                COALESCE(SUM((SELECT SUM(l.qty) FROM stock_transfer_lines l
                               WHERE l.transfer_id = t.id)), 0) AS units
           FROM stock_transfers t
          WHERE t.direction = 'out' AND t.status = 'in_transit'`,
      ),
    ])
    return { drift, flow, transit }
  })

  const failures = results
    .filter((r): r is typeof r & { ok: false } => !r.ok)
    .map((r) => ({ siteId: r.siteId, name: r.name, error: r.error }))

  const drift: GroupTransferDrift[] = []
  const flow: TransferFlowLeg[] = []
  const inTransit: GroupTransfers['inTransit'] = []
  const nameOf = new Map(sites.map((s) => [s.siteId, s.name]))

  for (const r of results) {
    if (!r.ok) continue
    for (const d of r.data.drift) drift.push({ ...d, siteId: r.siteId, siteName: r.name })

    for (const row of r.data.flow) {
      const peerId = Number(row.peer_id)
      flow.push({
        fromSiteId: r.siteId,
        fromName: r.name,
        toSiteId: peerId,
        // The peer's CURRENT name where the group knows it, falling back to the
        // snapshot on the row — a store renamed since the transfer should read
        // by its name today, not the one frozen into a document last year.
        toName: nameOf.get(peerId) ?? String(row.peer_name ?? `Site ${peerId}`),
        transfers: Number(row.transfers ?? 0),
        units: toNum(row.units),
      })
    }

    const units = toNum(r.data.transit?.units)
    const count = Number(r.data.transit?.transfers ?? 0)
    if (count > 0) inTransit.push({ siteId: r.siteId, name: r.name, transfers: count, units })
  }

  // Unsettled first: those are goods on two sets of books at once, and a late
  // lorry must never outrank them.
  drift.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'unsettled' ? -1 : 1
    return (b.totalQty ?? 0) - (a.totalQty ?? 0)
  })

  flow.sort((a, b) => b.units - a.units)
  inTransit.sort((a, b) => b.units - a.units)

  return { drift, flow, inTransit, failures }
}

/* ── Like-for-like ────────────────────────────────────────────────────────── */

/** Why a store is not counted in the like-for-like figure. */
export type LfeExclusion = 'not-trading-then' | 'not-trading-now' | 'unreadable'

export type LikeForLikeStore = {
  siteId: number
  name: string
  current: number
  prior: number
  /** Null when the store took nothing in the prior window — see percentChange. */
  changePct: number | null
  /** Included in the headline figure. False stores are listed with a reason. */
  comparable: boolean
  excluded?: LfeExclusion
}

export type LikeForLike = {
  current: DateRange
  prior: DateRange
  stores: LikeForLikeStore[]
  /** Totals over COMPARABLE stores only — the whole point of the measure. */
  comparableCurrent: number
  comparablePrior: number
  comparableChangePct: number | null
  /** Every store that traded now, comparable or not — the honest group total. */
  totalCurrent: number
  failures: { siteId: number; name: string; error: string }[]
}

/**
 * The same span, one year earlier.
 *
 * Aligned by CALENDAR DATE, matching how the report engine's own 'lastYear'
 * period resolves (reportBuilder/spec.ts). Retail practice often aligns by
 * weekday instead, so that a Saturday is compared against a Saturday — worth
 * knowing, but two conventions inside one product is worse than one imperfect
 * one, and a figure that disagrees with every other report in the app is not
 * an improvement.
 *
 * 29 February has no counterpart in a common year and lands on the 28th, which
 * is the conventional treatment and keeps the window from silently spilling
 * into March.
 */
export function yearAgoWindow(range: DateRange): DateRange {
  return { from: shiftYear(range.from), to: shiftYear(range.to) }
}

function shiftYear(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  const priorYear = y - 1
  // 29 Feb in a leap year has no counterpart in a common one.
  const day = m === 2 && d === 29 && !isLeap(priorYear) ? 28 : d
  return `${priorYear}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/**
 * Like-for-like: growth with new stores taken out of it.
 *
 * The measure a chain is actually judged on. Opening a shop lifts group
 * turnover by construction, so a headline "up 22%" says nothing about whether
 * the business improved — it may be four stores trading worse and a fifth one
 * new. Same-store sales answer the question underneath: did the shops we had
 * last year sell more this year.
 *
 * A store counts as COMPARABLE only when it traded in BOTH windows. One that
 * opened during the year, or closed, is excluded from the headline and listed
 * with its reason rather than dropped silently — an exclusion nobody can see is
 * indistinguishable from a bug.
 */
export async function likeForLike(
  sites: GroupSite[],
  current: DateRange,
): Promise<LikeForLike> {
  const prior = yearAgoWindow(current)

  const results = await perSite(sites, async (siteId) => {
    const [now, then] = await Promise.all([
      tradingFor(siteId, current.from, current.to),
      tradingFor(siteId, prior.from, prior.to),
    ])
    return { now, then }
  })

  const failures = results
    .filter((r): r is SiteResult<{ now: PeriodTrading; then: PeriodTrading }> & { ok: false } => !r.ok)
    .map((r) => ({ siteId: r.siteId, name: r.name, error: r.error }))

  const stores: LikeForLikeStore[] = results.map((r) => {
    if (!r.ok) {
      return {
        siteId: r.siteId, name: r.name, current: 0, prior: 0, changePct: null,
        comparable: false, excluded: 'unreadable' as const,
      }
    }
    const currentTotal = r.data.now.turnoverIncl
    const priorTotal = r.data.then.turnoverIncl

    /* Trading is decided on SALE COUNT, not turnover. A store that took R0.00
       across a whole year but rang up sales and refunds to the same value did
       trade; one with no documents at all did not. */
    const tradedNow = r.data.now.saleCount > 0
    const tradedThen = r.data.then.saleCount > 0

    const excluded: LfeExclusion | undefined = !tradedThen
      ? 'not-trading-then'
      : !tradedNow
        ? 'not-trading-now'
        : undefined

    return {
      siteId: r.siteId,
      name: r.name,
      current: currentTotal,
      prior: priorTotal,
      changePct: percentChange(currentTotal, priorTotal),
      comparable: excluded === undefined,
      excluded,
    }
  })

  const comparable = stores.filter((s) => s.comparable)
  const comparableCurrent = round(comparable.reduce((t, s) => t + s.current, 0), 2)
  const comparablePrior = round(comparable.reduce((t, s) => t + s.prior, 0), 2)

  return {
    current,
    prior,
    stores,
    comparableCurrent,
    comparablePrior,
    comparableChangePct: percentChange(comparableCurrent, comparablePrior),
    totalCurrent: round(stores.reduce((t, s) => t + s.current, 0), 2),
    failures,
  }
}

/* ── Dashboard arithmetic ─────────────────────────────────────────────────── */

/**
 * The month to date, and the SAME NUMBER OF DAYS of the month before.
 *
 * The equal-length window is the whole point. Comparing 1–14 August against the
 * whole of July reports every store in the group as catastrophically down until
 * the last day of the month, which is worse than showing no comparison at all.
 *
 * Pure, and exported so a test can prove the boundaries — month lengths differ,
 * so 14 days into March compares against 1–14 February, and the 31st of a month
 * compares against a 30-day month's last day rather than rolling into the next.
 */
export function monthToDateWindows(todayIso: string): {
  monthFrom: string
  monthTo: string
  prevFrom: string
  prevTo: string
} {
  const monthFrom = `${todayIso.slice(0, 7)}-01`
  const elapsed = daysBetweenDates(monthFrom, todayIso)

  // The day before this month started IS the last day of the previous month,
  // whatever its length — no month-length table needed.
  const prevTo = addDays(monthFrom, -1)
  const prevFrom = `${prevTo.slice(0, 7)}-01`

  return {
    monthFrom,
    monthTo: todayIso,
    prevFrom,
    // Same elapsed days into the previous month, clamped so a 31st never spills
    // past the end of a 30-day month.
    prevTo: minDate(addDays(prevFrom, elapsed), prevTo),
  }
}

function minDate(a: string, b: string): string {
  return a < b ? a : b
}

/**
 * Percentage change, or null when there is nothing to compare against.
 *
 * Null rather than zero or Infinity: a store that took R0 last month and R50k
 * this month has not grown by 100%, or by any other number — the honest answer
 * is that the comparison does not exist, and the screen says "no prior period"
 * instead of inventing a figure.
 */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null
  return round(((current - previous) / Math.abs(previous)) * 100, 1)
}

/** Gross profit as a percentage of turnover, null when nothing was sold. */
export function marginPct(grossProfit: number, turnoverExcl: number): number | null {
  if (turnoverExcl === 0) return null
  return round((grossProfit / turnoverExcl) * 100, 1)
}

/**
 * Months of stock cover at the current run rate — stock at cost divided by a
 * month's cost of sales.
 *
 * Null when nothing sold: infinite cover is not a number, and a store with
 * stock and no sales is a different problem from one with twelve months' worth.
 */
export function stockCoverMonths(stockValue: number, monthCostOfSales: number): number | null {
  if (monthCostOfSales <= 0) return null
  return round(stockValue / monthCostOfSales, 1)
}

/** What a store is being flagged for, in the order a manager would want it. */
export type StoreExceptionKind = 'unreadable' | 'margin-drop' | 'cash-short' | 'sales-drop' | 'stock-cover'

export type StoreException = {
  siteId: number
  name: string
  kind: StoreExceptionKind
  /** One line, already phrased for a person: "GP down 4.2 pts vs last month". */
  detail: string
}

/** Thresholds for the exception strip. Named, so the screen is not full of magic numbers. */
export const EXCEPTION_LIMITS = {
  /** Percentage POINTS of margin lost against the prior period. */
  marginDropPts: 2,
  /** Rands short on the drawer over the month, ignoring direction. */
  cashVariance: 500,
  /** Percent decline in turnover against the prior period. */
  salesDropPct: 10,
  /** Months of stock on hand at the current run rate. */
  stockCoverMonths: 6,
} as const

/**
 * The stores that need looking at, worst first.
 *
 * This is what turns the screen from a table into a dashboard: a chain owner
 * opens it to find out WHICH STORE needs them today, and a grid of figures
 * makes them work that out for themselves every morning.
 *
 * A store can raise more than one flag — a store both short on cash and losing
 * margin is exactly the one to look at first, and collapsing that to a single
 * reason would hide half of why.
 */
export function storeExceptions(rows: SiteResult<GroupDashboardRow>[]): StoreException[] {
  const out: StoreException[] = []

  for (const row of rows) {
    if (!row.ok) {
      out.push({
        siteId: row.siteId,
        name: row.name,
        kind: 'unreadable',
        detail: 'This store could not be read',
      })
      continue
    }

    const d = row.data
    const nowMargin = marginPct(d.month.grossProfit, d.month.turnoverExcl)
    const wasMargin = marginPct(d.previous.grossProfit, d.previous.turnoverExcl)
    if (nowMargin !== null && wasMargin !== null) {
      const drop = round(wasMargin - nowMargin, 1)
      if (drop >= EXCEPTION_LIMITS.marginDropPts) {
        out.push({
          siteId: row.siteId,
          name: row.name,
          kind: 'margin-drop',
          detail: `Gross profit down ${drop} points on last month`,
        })
      }
    }

    if (Math.abs(d.cashVariance) >= EXCEPTION_LIMITS.cashVariance) {
      const short = d.cashVariance < 0
      out.push({
        siteId: row.siteId,
        name: row.name,
        kind: 'cash-short',
        detail: `Drawer ${short ? 'short' : 'over'} ${formatRands(Math.abs(d.cashVariance))} this month`,
      })
    }

    const salesChange = percentChange(d.month.turnoverIncl, d.previous.turnoverIncl)
    if (salesChange !== null && salesChange <= -EXCEPTION_LIMITS.salesDropPct) {
      out.push({
        siteId: row.siteId,
        name: row.name,
        kind: 'sales-drop',
        detail: `Turnover down ${Math.abs(salesChange)}% on last month`,
      })
    }

    // Cost of sales for the month, from the figures already read.
    const cover = stockCoverMonths(d.stockValue, d.month.turnoverExcl - d.month.grossProfit)
    if (cover !== null && cover >= EXCEPTION_LIMITS.stockCoverMonths) {
      /* Past a couple of years the exact figure stops being information: "479.7
         months" and "over 2 years" say the same thing to a manager, and only
         one of them reads like a number somebody should act on. */
      const phrase =
        cover >= 24 ? 'Over 2 years of stock on hand' : `${cover} months of stock on hand`
      out.push({
        siteId: row.siteId,
        name: row.name,
        kind: 'stock-cover',
        detail: `${phrase} at the current rate`,
      })
    }
  }

  // Worst first: a store nobody can read outranks a soft margin, because it
  // means every other figure on the screen is missing that store's trade.
  const rank: Record<StoreExceptionKind, number> = {
    unreadable: 0,
    'cash-short': 1,
    'margin-drop': 2,
    'sales-drop': 3,
    'stock-cover': 4,
  }
  return out.sort((a, b) => rank[a.kind] - rank[b.kind])
}

/** Thousands-separated rands with no decimals — for a one-line exception note. */
function formatRands(n: number): string {
  return `R${Math.round(n).toLocaleString('en-ZA')}`
}

/* ── Consolidated income statement ────────────────────────────────────────── */

export type ConsolidatedLine = {
  accountCode: string
  name: string
  /** Index-aligned with `sites`; null means the account does not exist there. */
  perSite: (number | null)[]
  total: number
}

export type ConsolidatedBlock = {
  subtype: string | null
  label: string
  lines: ConsolidatedLine[]
  perSiteTotals: number[]
  total: number
}

export type ConsolidatedIncomeStatement = {
  range: DateRange
  sites: { siteId: number; name: string }[]
  failures: { siteId: number; name: string; error: string }[]
  revenue: ConsolidatedBlock[]
  revenueTotal: number
  perSiteRevenue: number[]
  costOfSales: ConsolidatedBlock[]
  costOfSalesTotal: number
  grossProfit: number
  expenses: ConsolidatedBlock[]
  expenseTotal: number
  netProfit: number
  perSiteNet: number[]
}

type Section = 'revenue' | 'costOfSales' | 'expenses'
const SECTIONS: Section[] = ['revenue', 'costOfSales', 'expenses']

/**
 * Merges per-store statements into one, by ACCOUNT CODE.
 *
 * Codes, not ids: every store seeds the same chart with the same numbering
 * convention, but ids differ per database. A code one store has and another
 * lacks (a custom account) keeps null in the missing columns — rendered as a
 * dash, which is a different statement from a true zero.
 *
 * Pure and exported so the test can prove the arithmetic on synthetic
 * statements without touching a database.
 */
export function mergeIncomeStatements(
  sites: { siteId: number; name: string }[],
  statements: IncomeStatement[],
): Omit<ConsolidatedIncomeStatement, 'failures' | 'range'> {
  /* One merge for all three sections, shared with the balance sheet — see
     mergeGroups. Two implementations of "match by code, keep null where
     absent" would be two chances to disagree about what a dash means. */
  const merged = Object.fromEntries(
    SECTIONS.map((section) => [
      section,
      mergeGroups(sites.length, statements.map((s) => s[section])),
    ]),
  ) as Record<Section, ReturnType<typeof mergeGroups>>

  const { revenue, costOfSales, expenses } = merged

  return {
    sites,
    revenue: revenue.blocks,
    revenueTotal: revenue.total,
    perSiteRevenue: revenue.perSiteTotals,
    costOfSales: costOfSales.blocks,
    costOfSalesTotal: costOfSales.total,
    grossProfit: round(revenue.total - costOfSales.total, 2),
    expenses: expenses.blocks,
    expenseTotal: expenses.total,
    netProfit: round(revenue.total - costOfSales.total - expenses.total, 2),
    perSiteNet: sites.map((_, i) =>
      round(
        revenue.perSiteTotals[i] - costOfSales.perSiteTotals[i] - expenses.perSiteTotals[i],
        2,
      ),
    ),
  }
}

/**
 * One P&L across every included store.
 *
 * Each store's own incomeStatement runs unchanged — same maths as its own
 * accounting screen — and the merge is a pure sum by account code. This is a
 * SIMPLE consolidation: sales between linked stores are not eliminated.
 */
export async function consolidatedIncomeStatement(
  sites: GroupSite[],
  range: DateRange,
): Promise<ConsolidatedIncomeStatement> {
  const results = await perSite(sites, (siteId) => incomeStatement(siteId, range))
  const included = results.filter((r): r is SiteResult<IncomeStatement> & { ok: true } => r.ok)
  const failures = results
    .filter((r): r is SiteResult<IncomeStatement> & { ok: false } => !r.ok)
    .map((r) => ({ siteId: r.siteId, name: r.name, error: r.error }))

  const merged = mergeIncomeStatements(
    included.map((r) => ({ siteId: r.siteId, name: r.name })),
    included.map((r) => r.data),
  )

  return { range, failures, ...merged }
}
