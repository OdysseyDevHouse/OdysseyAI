import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { groupForSite, membersOfGroup, type StoreGroup } from './storeGroups'
import { getSiteForUser } from './sites'
import { getUserByControlId } from './site/users'
import { capabilitiesForRole, can, type Capability } from './site/permissions'
import { siteQueryOne } from './siteDb'
import { incomeStatement, type IncomeStatement, type DateRange } from './site/financialStatements'
import { subtypeRank } from './glModel'
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
        `SELECT COALESCE(SUM(l.line_total_incl), 0) AS incl,
                COALESCE(SUM(l.line_total_excl), 0) AS excl,
                COALESCE(SUM(l.unit_cost_excl * l.qty), 0) AS cost
           FROM sales_document_lines l
           JOIN sales_documents d ON d.id = l.document_id
          WHERE d.status = 'finalised'
            AND d.doc_type IN ('invoice','credit_sale')
            AND d.document_date BETWEEN ? AND ?`,
        [range.monthFrom, range.monthTo],
      ),
      siteQueryOne<Row>(
        siteId,
        `SELECT COUNT(*) AS n FROM sales_documents
          WHERE status = 'finalised' AND doc_type = 'invoice'
            AND document_date BETWEEN ? AND ?`,
        [range.monthFrom, range.monthTo],
      ),
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
    ])

    const excl = toNum(monthLines?.excl)
    return {
      today: { turnoverIncl: toNum(todayDocs?.total), saleCount: Number(todayDocs?.n ?? 0) },
      month: {
        turnoverIncl: toNum(monthLines?.incl),
        turnoverExcl: excl,
        grossProfit: round(excl - toNum(monthLines?.cost), 2),
        saleCount: Number(monthDocs?.n ?? 0),
      },
      stockValue: round(toNum(stock?.v), 2),
    }
  })
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
  type MergedLine = ConsolidatedLine & { subtype: string | null; label: string }
  const bySection = new Map<Section, Map<string, MergedLine>>(
    SECTIONS.map((s) => [s, new Map()]),
  )

  statements.forEach((statement, siteIndex) => {
    for (const section of SECTIONS) {
      const merged = bySection.get(section)!
      for (const block of statement[section]) {
        for (const line of block.lines) {
          const existing = merged.get(line.accountCode)
          if (existing) {
            existing.perSite[siteIndex] = line.amount
            existing.total = round(existing.total + line.amount, 2)
          } else {
            const perSite: (number | null)[] = sites.map(() => null)
            perSite[siteIndex] = line.amount
            merged.set(line.accountCode, {
              accountCode: line.accountCode,
              // First-seen wins; sites are ordered primary-first, so the
              // primary store names shared accounts.
              name: line.name,
              subtype: block.subtype,
              label: block.label,
              perSite,
              total: line.amount,
            })
          }
        }
      }
    }
  })

  const buildBlocks = (section: Section): ConsolidatedBlock[] => {
    const grouped = new Map<string, ConsolidatedBlock>()
    const lines = [...bySection.get(section)!.values()].sort((a, b) =>
      a.accountCode.localeCompare(b.accountCode),
    )
    for (const line of lines) {
      const key = line.subtype ?? '~none'
      const block = grouped.get(key) ?? {
        subtype: line.subtype,
        label: line.label,
        lines: [],
        perSiteTotals: sites.map(() => 0),
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
    return [...grouped.values()].sort((a, b) => subtypeRank(a.subtype) - subtypeRank(b.subtype))
  }

  const sumBlocks = (blocks: ConsolidatedBlock[]): { perSite: number[]; total: number } => {
    const perSite = sites.map(() => 0)
    let total = 0
    for (const block of blocks) {
      block.perSiteTotals.forEach((v, i) => {
        perSite[i] = round(perSite[i] + v, 2)
      })
      total = round(total + block.total, 2)
    }
    return { perSite, total }
  }

  const revenue = buildBlocks('revenue')
  const costOfSales = buildBlocks('costOfSales')
  const expenses = buildBlocks('expenses')
  const revenueSums = sumBlocks(revenue)
  const cosSums = sumBlocks(costOfSales)
  const expenseSums = sumBlocks(expenses)

  return {
    sites,
    revenue,
    revenueTotal: revenueSums.total,
    perSiteRevenue: revenueSums.perSite,
    costOfSales,
    costOfSalesTotal: cosSums.total,
    grossProfit: round(revenueSums.total - cosSums.total, 2),
    expenses,
    expenseTotal: expenseSums.total,
    netProfit: round(revenueSums.total - cosSums.total - expenseSums.total, 2),
    perSiteNet: sites.map((_, i) =>
      round(revenueSums.perSite[i] - cosSums.perSite[i] - expenseSums.perSite[i], 2),
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
