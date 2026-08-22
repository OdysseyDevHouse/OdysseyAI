import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { loyaltyQuery, loyaltyQueryOne, loyaltyExecute, loyaltyTransaction } from './loyaltyDb'
import { round, toNum } from '../decimals'
import {
  LOYALTY_DEFAULTS,
  computeEarn,
  maxRedeemableRand,
  pointsToRand,
  randToPoints,
  tierForSpend,
  nextTier,
  cleanTierLadder,
  type EarnLine,
  type LoyaltySettings,
  type LoyaltyTier,
} from '../loyaltyRules'
import { customerOwnerSite } from '../storeGroups'
import { getSettings, setSetting } from './settings'
import { logActivity, type Actor } from './activityLog'

/**
 * Loyalty — points, tiers and membership.
 *
 * ── THE ONE INVARIANT ────────────────────────────────────────────────────
 *
 * The balance is SUM(loyalty_ledger.points). Nothing else is authoritative.
 * `loyalty_members.points_balance` is a cache written inside the same
 * transaction as the row that changed it, so the till can show a figure without
 * summing a customer's whole history — but no decision is ever made from it.
 * Every spend re-reads the ledger under a lock, because the cache is exactly
 * the value a concurrent till may have just invalidated.
 *
 * ── WHAT JOINS A TRANSACTION AND WHAT DOES NOT ───────────────────────────
 *
 * `redeemPointsForSale` takes a `tx` and MUST run inside the sale's own
 * transaction: spending points is part of paying, and a sale that committed
 * without deducting them would give the goods away. It throws rather than
 * returning a result, so a failure rolls the sale back.
 *
 * `awardSaleLoyalty` opens its own connection and runs AFTER the sale commits.
 * Earning is a consequence of a sale, not a condition of it — a loyalty table
 * that is briefly unreachable must never stop a shop from trading. It is
 * fail-soft by contract and idempotent per document, so a retry cannot pay
 * twice.
 *
 * Cards, vouchers and the wallet live in their own modules; they share these
 * rules but not this file.
 */

type Row = RowDataPacket & Record<string, unknown>

/* ── Settings ────────────────────────────────────────────────────────────── */

const SETTING_KEYS = [
  'loyalty_enabled',
  'loyalty_earn_rate',
  'loyalty_redeem_rate',
  'loyalty_min_redeem_points',
  'loyalty_earn_on_discounted',
  'loyalty_expiry_mode',
  'loyalty_expiry_months',
  'loyalty_tier_basis',
  'loyalty_tier_window_months',
  'loyalty_tier_grace_months',
] as const

export async function getLoyaltySettings(siteId: number): Promise<LoyaltySettings> {
  const raw = await getSettings(siteId, SETTING_KEYS)

  return {
    enabled: raw.loyalty_enabled === '1',
    earnRate: toNum(raw.loyalty_earn_rate, LOYALTY_DEFAULTS.earnRate),
    redeemRate: toNum(raw.loyalty_redeem_rate, LOYALTY_DEFAULTS.redeemRate),
    minRedeemPoints: toNum(raw.loyalty_min_redeem_points, 0),
    earnOnDiscounted: raw.loyalty_earn_on_discounted === '1',
    expiryMode: (raw.loyalty_expiry_mode as LoyaltySettings['expiryMode']) ?? 'activity',
    expiryMonths: toNum(raw.loyalty_expiry_months, LOYALTY_DEFAULTS.expiryMonths),
    tierBasis: (raw.loyalty_tier_basis as LoyaltySettings['tierBasis']) ?? 'rolling',
    tierWindowMonths: toNum(raw.loyalty_tier_window_months, LOYALTY_DEFAULTS.tierWindowMonths),
    tierGraceMonths: toNum(raw.loyalty_tier_grace_months, LOYALTY_DEFAULTS.tierGraceMonths),
  }
}

export type SaveResult = { ok: true } | { ok: false; error: string }

export async function saveLoyaltySettings(
  siteId: number,
  actor: Actor,
  settings: LoyaltySettings,
): Promise<SaveResult> {
  const before = await getLoyaltySettings(siteId)

  const values: [(typeof SETTING_KEYS)[number], string][] = [
    ['loyalty_enabled', settings.enabled ? '1' : '0'],
    ['loyalty_earn_rate', String(settings.earnRate)],
    ['loyalty_redeem_rate', String(settings.redeemRate)],
    ['loyalty_min_redeem_points', String(settings.minRedeemPoints)],
    ['loyalty_earn_on_discounted', settings.earnOnDiscounted ? '1' : '0'],
    ['loyalty_expiry_mode', settings.expiryMode],
    ['loyalty_expiry_months', String(settings.expiryMonths)],
    ['loyalty_tier_basis', settings.tierBasis],
    ['loyalty_tier_window_months', String(settings.tierWindowMonths)],
    ['loyalty_tier_grace_months', String(settings.tierGraceMonths)],
  ]

  for (const [key, value] of values) {
    const saved = await setSetting(siteId, key, value)
    if (!saved.ok) return saved
  }

  // Turning the programme on and off is the switch worth being able to point
  // at afterwards — it changes what every till offers.
  if (before.enabled !== settings.enabled) {
    await logActivity(siteId, actor, {
      entity: 'loyalty',
      entityId: null,
      action: settings.enabled ? 'programme_opened' : 'programme_closed',
    })
  } else {
    await logActivity(siteId, actor, {
      entity: 'loyalty',
      entityId: null,
      action: 'settings_changed',
      detail: `Earn R${settings.earnRate} = 1 point · ${settings.redeemRate} points = R1`,
    })
  }

  return { ok: true }
}

/**
 * Whether the till should offer loyalty at all.
 *
 * Both the programme switch AND an active tender are required: a store that
 * enabled the programme but never switched on the LOYALTY_POINTS tender has no
 * way to take a redemption, and offering a button that cannot post is worse
 * than not offering one.
 */
export async function loyaltyTenderIds(
  siteId: number,
): Promise<{ points: number | null; wallet: number | null }> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, code FROM tender_types
      WHERE integration_key = 'loyalty' AND is_active = 1`,
  )
  const find = (code: string) => {
    const row = rows.find((r) => String(r.code) === code)
    return row ? Number(row.id) : null
  }
  return { points: find('LOYALTY_POINTS'), wallet: find('LOYALTY_WALLET') }
}

/* ── Tiers ───────────────────────────────────────────────────────────────── */

function mapTier(r: Row): LoyaltyTier {
  return {
    id: Number(r.id),
    name: String(r.name),
    step: Number(r.step),
    qualifyingSpend: toNum(r.qualifying_spend),
    multiplier: toNum(r.multiplier, 1),
    discountPct: toNum(r.discount_pct),
    color: String(r.color ?? ''),
    isActive: !!r.is_active,
  }
}

export async function listTiers(siteId: number, includeInactive = true): Promise<LoyaltyTier[]> {
  // The owner's ladder. A shared programme has ONE set of tiers — Gold must
  // mean the same thing at every branch, or a member is promoted by walking
  // into a different shop. Read from the branch this returned an empty ladder,
  // which silently untiers everybody rather than failing.
  const rows = await loyaltyQuery<Row>(
    siteId,
    `SELECT id, name, step, qualifying_spend, multiplier, discount_pct, color, is_active
       FROM loyalty_tiers ${includeInactive ? '' : 'WHERE is_active = 1'}
      ORDER BY step ASC, id ASC`,
  )
  return rows.map(mapTier)
}

/**
 * Replaces the whole ladder.
 *
 * Matched on NAME rather than id, so a store that reorders its tiers keeps its
 * members where they are. A tier that disappears from the list is deleted, and
 * the FK drops its members to no tier — the next review re-places them.
 *
 * `step` is renumbered from the submitted order rather than trusted, because
 * two rows sharing a step would violate the unique key and the screen has no
 * good way to explain that.
 */
export async function saveTiers(
  siteId: number,
  actor: Actor,
  raw: readonly Partial<LoyaltyTier>[],
): Promise<SaveResult> {
  const cleaned = cleanTierLadder(raw)
  if ('error' in cleaned) return { ok: false, error: cleaned.error }

  // Every statement in here touches loyalty_tiers alone, so the whole
  // transaction moves to the owner. Editing the ladder at a branch edits the
  // GROUP's ladder — which is the intent: one programme, one set of tiers.
  await loyaltyTransaction(siteId, async (tx) => {
    const [existing] = await tx.query<Row[]>('SELECT id, name FROM loyalty_tiers')
    const byName = new Map(existing.map((r) => [String(r.name).toLowerCase(), Number(r.id)]))

    const kept: number[] = []

    // Steps are bumped clear of the final range first. Without this, renumbering
    // in place trips uq_tier_step the moment two tiers swap positions — the
    // update for the first collides with the row that has not moved yet.
    await tx.execute('UPDATE loyalty_tiers SET step = step + 1000')

    for (const tier of cleaned) {
      const id = byName.get(tier.name.toLowerCase())
      if (id) {
        await tx.execute(
          `UPDATE loyalty_tiers
              SET name = ?, step = ?, qualifying_spend = ?, multiplier = ?,
                  discount_pct = ?, color = ?, is_active = ?
            WHERE id = ?`,
          [
            tier.name,
            tier.step,
            tier.qualifyingSpend.toFixed(4),
            tier.multiplier.toFixed(3),
            tier.discountPct.toFixed(3),
            tier.color,
            tier.isActive ? 1 : 0,
            id,
          ] as never,
        )
        kept.push(id)
      } else {
        const [res] = await tx.execute(
          `INSERT INTO loyalty_tiers
             (name, step, qualifying_spend, multiplier, discount_pct, color, is_active)
           VALUES (?,?,?,?,?,?,?)`,
          [
            tier.name,
            tier.step,
            tier.qualifyingSpend.toFixed(4),
            tier.multiplier.toFixed(3),
            tier.discountPct.toFixed(3),
            tier.color,
            tier.isActive ? 1 : 0,
          ] as never,
        )
        kept.push((res as { insertId: number }).insertId)
      }
    }

    if (kept.length > 0) {
      await tx.execute(
        `DELETE FROM loyalty_tiers WHERE id NOT IN (${kept.map(() => '?').join(',')})`,
        kept as never,
      )
    }
  })

  await logActivity(siteId, actor, {
    entity: 'loyalty',
    entityId: null,
    action: 'tiers_changed',
    detail: cleaned.map((t) => t.name).join(' · '),
  })

  return { ok: true }
}

/* ── Members ─────────────────────────────────────────────────────────────── */

export type LoyaltyMember = {
  memberId: number
  /** What the till matches on. Replaces customers.loyalty_number. */
  memberNumber: string
  /**
   * The linked debtors account, or null.
   *
   * Null is ordinary, not exceptional: a shopper who joined with a cell number
   * is a member and may never be a customer. Code reading this must not treat
   * absence as an error — it used to be impossible, which is why the old shape
   * carried customerCode and customerName as required strings.
   */
  customerId: number | null
  name: string
  phone: string | null
  isActive: boolean
  points: number
  pointsValue: number
  walletBalance: number
  tier: LoyaltyTier | null
  qualifyingSpend: number
  next: { tier: LoyaltyTier; shortfall: number } | null
  joinedAt: Date | null
  lastActivityAt: Date | null
}

/** The window qualifying spend is measured over. Null means "everything". */
function windowStart(settings: LoyaltySettings, now = new Date()): Date | null {
  if (settings.tierBasis === 'lifetime') return null
  const from = new Date(now)
  from.setMonth(from.getMonth() - settings.tierWindowMonths)
  return from
}

/**
 * A customer's standing.
 *
 * Returns a zeroed member rather than null for a customer with no row: the
 * programme is open to every account, so "has never earned" and "is not a
 * member" are the same state and a null would force every caller to handle a
 * case that is not really a case.
 *
 * Balances come from the LEDGER, not the cache — this is what the till reads
 * before offering a redemption.
 */
export async function getMember(
  siteId: number,
  memberId: number,
  settings?: LoyaltySettings,
): Promise<LoyaltyMember | null> {
  const config = settings ?? (await getLoyaltySettings(siteId))
  const tiers = await listTiers(siteId)

  const [member, totals, spend, wallet] = await Promise.all([
    // The member IS the record now — it used to be a facet of a customer, so
    // this function opened by reading `customers` and returned null when there
    // was none. A walk-in member has no customer at all, and that early return
    // would have hidden every one of them.
    //
    // `id`, not `member_id`: loyalty_members is keyed on its own id and
    // customer_id is the optional link.
    loyaltyQueryOne<Row>(
      siteId,
      `SELECT id, member_number, customer_id, name, phone, email,
              is_active, tier_id, joined_at, last_activity_at
         FROM loyalty_members WHERE id = ? LIMIT 1`,
      [memberId],
    ),
    loyaltyQueryOne<Row>(
      siteId,
      'SELECT COALESCE(SUM(points),0) AS points FROM loyalty_ledger WHERE member_id = ?',
      [memberId],
    ),
    qualifyingSpendFor(siteId, memberId, config),
    loyaltyQueryOne<Row>(
      siteId,
      'SELECT COALESCE(SUM(amount),0) AS amount FROM loyalty_wallet WHERE member_id = ?',
      [memberId],
    ),
  ])

  // No member row, no member. This used to fall back to "enrolled, zero
  // balance" for any customer, because every customer implicitly was one.
  // Membership is now a thing somebody joins, so its absence is an answer.
  if (!member) return null

  const points = round(toNum(totals?.points), 4)
  const tier = tierForSpend(tiers, spend)

  return {
    memberId,
    memberNumber: String(member.member_number),
    customerId: member.customer_id === null ? null : Number(member.customer_id),
    name: String(member.name),
    phone: (member.phone as string | null) ?? null,
    isActive: !!member.is_active,
    points,
    pointsValue: pointsToRand(points, config),
    walletBalance: round(toNum(wallet?.amount), 2),
    tier,
    qualifyingSpend: spend,
    next: nextTier(tiers, spend),
    joinedAt: (member?.joined_at as Date) ?? null,
    lastActivityAt: (member?.last_activity_at as Date) ?? null,
  }
}

/** Spend that counts towards a tier: earn rows only, inside the window. */
async function qualifyingSpendFor(
  siteId: number,
  memberId: number,
  settings: LoyaltySettings,
): Promise<number> {
  const from = windowStart(settings)
  const row = await loyaltyQueryOne<Row>(
    siteId,
    `SELECT COALESCE(SUM(basis_amount),0) AS spend
       FROM loyalty_ledger
      WHERE member_id = ? AND entry_type = 'earn'
        ${from ? 'AND created_at >= ?' : ''}`,
    from ? [memberId, from] : [memberId],
  )
  return round(toNum(row?.spend), 2)
}

/**
 * Rewrites a member's cache and re-places them on the ladder.
 *
 * Runs on the caller's transaction so the cache can never disagree with the
 * row that just changed.
 *
 * TIER MOVEMENT IS ASYMMETRIC, and deliberately so. An upgrade takes effect the
 * moment it is earned — that is the reward. A DEMOTION only happens once the
 * review date has passed, giving a customer a grace period rather than dropping
 * them out of Gold the first week they spend less than usual.
 */
async function refreshMember(
  tx: PoolConnection,
  memberId: number,
  settings: LoyaltySettings,
  tiers: readonly LoyaltyTier[],
): Promise<void> {
  const [[totals]] = await tx.query<Row[]>(
    'SELECT COALESCE(SUM(points),0) AS points FROM loyalty_ledger WHERE member_id = ?',
    [memberId] as never,
  )
  const [[walletRow]] = await tx.query<Row[]>(
    'SELECT COALESCE(SUM(amount),0) AS amount FROM loyalty_wallet WHERE member_id = ?',
    [memberId] as never,
  )

  const from = windowStart(settings)
  const [[spendRow]] = await tx.query<Row[]>(
    `SELECT COALESCE(SUM(basis_amount),0) AS spend
       FROM loyalty_ledger
      WHERE member_id = ? AND entry_type = 'earn'
        ${from ? 'AND created_at >= ?' : ''}`,
    (from ? [memberId, from] : [memberId]) as never,
  )

  const points = round(toNum(totals?.points), 4)
  const wallet = round(toNum(walletRow?.amount), 4)
  const spend = round(toNum(spendRow?.spend), 2)

  const [[existing]] = await tx.query<Row[]>(
    'SELECT tier_id, tier_review_date FROM loyalty_members WHERE id = ? FOR UPDATE',
    [memberId] as never,
  )

  const earned = tierForSpend(tiers, spend)
  const currentId = existing?.tier_id === null || existing?.tier_id === undefined
    ? null
    : Number(existing.tier_id)
  const current = tiers.find((t) => t.id === currentId) ?? null

  let tierId = earned?.id ?? null
  let touchTierSince = true

  if (current && earned && earned.step < current.step) {
    // A fall. Honour the grace period: keep the higher tier until the review
    // date arrives, then let the drop happen.
    const review = existing?.tier_review_date ? new Date(String(existing.tier_review_date)) : null
    const due = review !== null && review <= new Date()
    if (!due) {
      tierId = current.id
      touchTierSince = false
    }
  } else if (current && earned && earned.id === current.id) {
    touchTierSince = false
  }

  // The next review is always pushed out from now, so a customer who holds
  // their tier gets a fresh grace period rather than being reviewed repeatedly.
  const review = new Date()
  review.setMonth(review.getMonth() + Math.max(1, settings.tierGraceMonths))
  const reviewDate = review.toISOString().slice(0, 10)

  /*
   * An UPDATE, not the upsert this used to be.
   *
   * When the table was keyed on customer_id, the upsert was honest: the
   * customer already existed, and this created or refreshed their loyalty
   * cache. A member is not like that. A member has a number and a name, and
   * neither can be invented by a cache refresh — an INSERT here would either
   * fail on the NOT NULL columns or, worse, manufacture a nameless member.
   *
   * So a missing member updates nothing, which is correct: there is no cache to
   * refresh for someone who has not joined.
   */
  await tx.execute(
    `UPDATE loyalty_members
        SET points_balance = ?,
            wallet_balance = ?,
            tier_id = ?,
            ${touchTierSince ? 'tier_since = NOW(),' : ''}
            tier_review_date = ?,
            last_activity_at = NOW()
      WHERE id = ?`,
    [points.toFixed(4), wallet.toFixed(4), tierId, reviewDate, memberId] as never,
  )
}

/** Rebuilds a member's cache from the ledger. The repair tool for drift. */
export async function recalcMember(siteId: number, memberId: number): Promise<void> {
  const settings = await getLoyaltySettings(siteId)
  const tiers = await listTiers(siteId)
  await loyaltyTransaction(siteId, async (tx) => {
    await refreshMember(tx, memberId, settings, tiers)
  })
}

/* ── The ledger ──────────────────────────────────────────────────────────── */

export type LedgerEntryType = 'earn' | 'redeem' | 'expire' | 'adjust' | 'reverse'

export type LedgerEntry = {
  id: number
  memberId: number
  entryType: LedgerEntryType
  points: number
  basisAmount: number
  documentId: number | null
  documentNumber: string
  tierName: string
  multiplier: number
  note: string
  userName: string
  createdAt: Date
}

function mapLedger(r: Row): LedgerEntry {
  return {
    id: Number(r.id),
    memberId: Number(r.member_id),
    entryType: String(r.entry_type) as LedgerEntryType,
    points: toNum(r.points),
    basisAmount: toNum(r.basis_amount),
    documentId: r.document_id === null ? null : Number(r.document_id),
    documentNumber: String(r.document_number ?? ''),
    tierName: String(r.tier_name ?? ''),
    multiplier: toNum(r.multiplier, 1),
    note: String(r.note ?? ''),
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
  }
}

export async function listLedger(
  siteId: number,
  memberId: number,
  limit = 200,
): Promise<LedgerEntry[]> {
  const capped = Math.min(Math.max(1, Math.floor(limit)), 1000)
  const rows = await loyaltyQuery<Row>(
    siteId,
    `SELECT id, member_id, entry_type, points, basis_amount, document_id, document_number,
            tier_name, multiplier, note, user_name, created_at
       FROM loyalty_ledger
      WHERE member_id = ?
      ORDER BY id DESC
      LIMIT ${capped}`,
    [memberId],
  )
  return rows.map(mapLedger)
}

/** The balance, read under a lock. The only figure a spend may be based on. */
async function lockedBalance(tx: PoolConnection, memberId: number): Promise<number> {
  // Locks the member row so two tills serialise here rather than both reading
  // the same balance and each spending it. A member id that matches nothing
  // locks nothing and sums to zero, which refuses the spend either way.
  await tx.query('SELECT id FROM loyalty_members WHERE id = ? FOR UPDATE', [memberId] as never)

  const [[row]] = await tx.query<Row[]>(
    'SELECT COALESCE(SUM(points),0) AS points FROM loyalty_ledger WHERE member_id = ?',
    [memberId] as never,
  )
  return round(toNum(row?.points), 4)
}

type LedgerWrite = {
  memberId: number
  entryType: LedgerEntryType
  points: number
  basisAmount?: number
  documentId?: number | null
  documentNumber?: string
  tierName?: string
  multiplier?: number
  note?: string
}

/**
 * Appends one points row.
 *
 * `originSiteId` is the store the sale happened in, NOT the store the ledger
 * lives in. With a shared customer file those differ, and `document_id` alone
 * stops identifying a document — uq_ledger_document_earn is built on the pair,
 * so leaving it out would make one branch's award collide with another's and
 * the customer would silently lose the points.
 */
async function insertLedger(
  tx: PoolConnection,
  actor: Actor,
  originSiteId: number,
  entry: LedgerWrite,
): Promise<number> {
  const [res] = await tx.execute(
    `INSERT INTO loyalty_ledger
       (member_id, entry_type, points, basis_amount, document_id, document_number,
        origin_site_id, tier_name, multiplier, note, user_id, user_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      entry.memberId,
      entry.entryType,
      round(entry.points, 4).toFixed(4),
      round(entry.basisAmount ?? 0, 4).toFixed(4),
      entry.documentId ?? null,
      entry.documentNumber ?? '',
      originSiteId,
      entry.tierName ?? '',
      round(entry.multiplier ?? 1, 3).toFixed(3),
      (entry.note ?? '').slice(0, 255),
      actor.userId,
      actor.userName.slice(0, 120),
    ] as never,
  )
  return (res as { insertId: number }).insertId
}

/* ── Earning ─────────────────────────────────────────────────────────────── */

export type SaleLine = {
  productId: number | null
  departmentId: number | null
  qty: number
  lineTotalIncl: number
  discountIncl: number
}

export type AwardInput = {
  memberId: number
  documentId: number
  documentNumber: string
  lines: readonly SaleLine[]
  /** Rand of this sale settled with points or a rand voucher — earns nothing. */
  fundedAmount?: number
}

/**
 * Grants the points a sale earned.
 *
 * CALLED AFTER THE SALE HAS COMMITTED, and fail-soft by contract: the caller
 * wraps it in a try/catch and a failure here must never un-sell goods that have
 * already left the shop. Missing points are visible on the account and can be
 * granted by hand; an un-postable sale at a queue of customers cannot.
 *
 * IDEMPOTENT PER DOCUMENT. `uq_ledger_document_earn` means a second attempt for
 * the same sale hits a duplicate-key error rather than paying twice, so a
 * retried finalise is safe. The check below turns that into a quiet no-op for
 * the ordinary case; the constraint is what makes the concurrent case safe.
 */
export async function awardSaleLoyalty(
  siteId: number,
  actor: Actor,
  input: AwardInput,
): Promise<{ points: number } | null> {
  const settings = await getLoyaltySettings(siteId)
  if (!settings.enabled) return null

  const already = await loyaltyQueryOne<Row>(
    siteId,
    `SELECT id FROM loyalty_ledger WHERE document_id = ? AND entry_type = 'earn' LIMIT 1`,
    [input.documentId],
  )
  if (already) return null

  const tiers = await listTiers(siteId)
  const spend = await qualifyingSpendFor(siteId, input.memberId, settings)
  const tier = tierForSpend(tiers, spend)

  const earnLines: EarnLine[] = input.lines.map((l) => ({
    lineTotalIncl: l.lineTotalIncl,
    discounted: l.discountIncl > 0,
  }))

  /*
   * A running bonus-points promotion, if there is one (213).
   *
   * Read from the SPECIALS of the selling site rather than the loyalty owner's:
   * a group shares one programme but each branch runs its own promotions, and
   * "double points this weekend" is a decision the branch made about its own
   * trading. Resolved against the clock here, at the moment of the sale, the
   * same way every other special decides whether it is running.
   *
   * No audience is passed. A member is by definition attached — this function
   * only runs when one is — and the channel is the till.
   */
  const { liveSpecials } = await import('./specials')
  const { pointsMultiplierFor } = await import('../specialsEngine')
  const promo = pointsMultiplierFor(await liveSpecials(siteId), new Date(), {
    isMember: true,
    channel: 'in_store',
  })

  const result = computeEarn(earnLines, settings, tier, input.fundedAmount ?? 0, promo)
  if (result.points <= 0) return null

  try {
    await loyaltyTransaction(siteId, async (tx) => {
      await insertLedger(tx, actor, siteId, {
        memberId: input.memberId,
        entryType: 'earn',
        points: result.points,
        basisAmount: result.basisAmount,
        documentId: input.documentId,
        documentNumber: input.documentNumber,
        tierName: tier?.name ?? '',
        /*
         * The multiplier ACTUALLY USED, tier and promotion combined.
         *
         * Recording only the tier's would make the ledger disagree with the
         * points beside it — a gold member on a double-points weekend would
         * show 1.5 against an entry worked out at 3, and "why did I get this
         * many points" would be unanswerable from the row that exists to
         * answer it.
         */
        multiplier: round((tier?.multiplier ?? 1) * promo, 3),
      })
      await refreshMember(tx, input.memberId, settings, tiers)
    })
  } catch (error) {
    // A duplicate key here means a concurrent finalise won the race and the
    // points are already granted. That is success, not failure.
    const code = (error as { code?: string }).code
    if (code === 'ER_DUP_ENTRY') return null
    throw error
  }

  return { points: result.points }
}

/* ── Redeeming ───────────────────────────────────────────────────────────── */

export type RedeemInput = {
  memberId: number
  documentId: number
  documentNumber: string
  /** Rand of the sale being settled with points. */
  randAmount: number
}

/**
 * Spends points against a sale. JOINS THE SALE'S TRANSACTION.
 *
 * THROWS on any problem, so an unaffordable redemption rolls the sale back
 * rather than handing over goods that were never paid for. That is the whole
 * reason this takes a `tx` while awarding does not.
 */
export async function redeemPointsForSale(
  tx: PoolConnection,
  actor: Actor,
  /** The store making the sale — see insertLedger on why this is not the owner. */
  originSiteId: number,
  input: RedeemInput,
  settings: LoyaltySettings,
  tiers: readonly LoyaltyTier[],
): Promise<{ points: number }> {
  if (!settings.enabled) throw new Error('The loyalty programme is not running.')
  if (input.randAmount <= 0) throw new Error('Enter an amount to settle with points.')

  const balance = await lockedBalance(tx, input.memberId)
  const needed = randToPoints(input.randAmount, settings)

  if (settings.minRedeemPoints > 0 && balance < settings.minRedeemPoints) {
    throw new Error(
      `At least ${settings.minRedeemPoints} points are needed to redeem — this account has ${Math.floor(balance)}.`,
    )
  }
  if (needed > balance) {
    const worth = pointsToRand(balance, settings)
    throw new Error(
      `Not enough points: ${Math.floor(balance)} is worth R${worth.toFixed(2)}, and R${input.randAmount.toFixed(2)} was asked for.`,
    )
  }

  await insertLedger(tx, actor, originSiteId, {
    memberId: input.memberId,
    entryType: 'redeem',
    points: -needed,
    documentId: input.documentId,
    documentNumber: input.documentNumber,
    note: `R${round(input.randAmount, 2).toFixed(2)} off ${input.documentNumber}`,
  })

  await refreshMember(tx, input.memberId, settings, tiers)
  return { points: needed }
}

/** What this customer may put on this sale. The figure the till shows. */
export async function redeemableFor(
  siteId: number,
  memberId: number,
  amountDue: number,
): Promise<{ points: number; maxRand: number; settings: LoyaltySettings }> {
  const settings = await getLoyaltySettings(siteId)
  if (!settings.enabled) return { points: 0, maxRand: 0, settings }

  const row = await loyaltyQueryOne<Row>(
    siteId,
    'SELECT COALESCE(SUM(points),0) AS points FROM loyalty_ledger WHERE member_id = ?',
    [memberId],
  )
  const points = round(toNum(row?.points), 4)
  return { points, maxRand: maxRedeemableRand(points, amountDue, settings), settings }
}

/* ── Before the sale opens ───────────────────────────────────────────────── */

/**
 * The member linked to a customer, if there is one.
 *
 * Resolved through the loyalty owner, so a branch on a shared programme finds
 * the group's member rather than looking in its own empty table. The customer
 * id is the BRANCH's — `loyalty_members.customer_id` holds the id from the
 * customer file's owner, which is the same database whenever both files are
 * shared and the branch's own when neither is. The one arrangement this cannot
 * serve is a shared programme over unshared customer files, where two branches
 * would each claim customer 41; `loyalty_members.customer_origin_site_id`
 * carries the store so the pair stays unambiguous.
 */
export async function memberIdForCustomer(
  siteId: number,
  customerId: number,
): Promise<number | null> {
  const owner = await customerOwnerSite(siteId)
  const row = await loyaltyQueryOne<Row>(
    siteId,
    `SELECT id FROM loyalty_members
      WHERE customer_id = ? AND customer_origin_site_id = ? AND is_active = 1`,
    [customerId, owner.siteId],
  )
  return row ? Number(row.id) : null
}

/* ── Joining ─────────────────────────────────────────────────────────────── */

export type EnrolInput = {
  name: string
  phone?: string | null
  email?: string | null
  /** The debtors account to link, if this member has one. */
  customerId?: number | null
  /**
   * A specific number — a pre-printed card being handed out.
   *
   * Left off, one is allocated. Supplied, it is taken as given and refused if
   * already in use: a shop with a box of printed cards must be able to use them
   * in whatever order they come out of the box.
   */
  memberNumber?: string | null
}

export type EnrolResult =
  | { ok: true; memberId: number; memberNumber: string }
  | { ok: false; error: string }

/**
 * Allocates the next member number, inside the caller's transaction.
 *
 * ── WHY NOT document_sequences ───────────────────────────────────────────
 *
 * Two reasons, either sufficient. It lives in the BRANCH's database while
 * members live in the loyalty owner's, so twenty branches sharing a programme
 * would each hand out M000001 and collide on uq_member_number. And
 * `verifySequence` audits a sequence by counting rows in a table with a
 * `status` column, which loyalty_members does not have — registering members
 * there would make an unrelated test suite report holes forever.
 *
 * ── WHY MAX()+1 IS SAFE HERE, WHERE IT USUALLY IS NOT ────────────────────
 *
 * Because it runs under the same transaction as the INSERT, and
 * uq_member_number is the real arbiter: two tills enrolling at once serialise
 * on the unique key, and the loser retries. Numbering a MEMBER is also not
 * numbering a document — nothing audits it for gaps, so a burnt number is
 * invisible rather than a defect.
 */
async function nextMemberNumber(tx: PoolConnection): Promise<string> {
  const [[row]] = await tx.query<Row[]>(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(member_number, 2) AS UNSIGNED)), 0) AS n
       FROM loyalty_members
      WHERE member_number REGEXP '^M[0-9]+$'`,
  )
  return `M${String(Number(row?.n ?? 0) + 1).padStart(6, '0')}`
}

/**
 * Signs somebody up.
 *
 * ── WHAT IS REQUIRED, AND WHAT IS NOT ────────────────────────────────────
 *
 * A name. That is all. The plan asks for enrolment at the till in seconds from
 * a cell number, and every field this refuses to make optional is a queue
 * getting longer — so an address, an email and even a phone are things a member
 * may add later or never.
 *
 * `customerId` is optional for the same reason in reverse: joining must not
 * open a debtors account. A member with no account is the ordinary case.
 */
export async function enrolMember(
  siteId: number,
  actor: Actor,
  input: EnrolInput,
): Promise<EnrolResult> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Give the member a name.' }

  const settings = await getLoyaltySettings(siteId)
  if (!settings.enabled) return { ok: false, error: 'The loyalty programme is not running.' }

  // The customer id is only meaningful alongside the file it came from, and
  // both columns must be set or neither — see uq_member_customer.
  const owner = await customerOwnerSite(siteId)
  const customerId = input.customerId ?? null

  if (customerId) {
    const existing = await memberIdForCustomer(siteId, customerId)
    if (existing) return { ok: false, error: 'That customer is already a member.' }
  }

  const requested = input.memberNumber?.trim() ?? ''

  try {
    const result = await loyaltyTransaction(siteId, async (tx) => {
      const memberNumber = requested || (await nextMemberNumber(tx))

      const [res] = await tx.execute(
        `INSERT INTO loyalty_members
           (member_number, customer_id, customer_origin_site_id, name, phone, email, joined_at)
         VALUES (?,?,?,?,?,?,NOW())`,
        [
          memberNumber.slice(0, 60),
          customerId,
          customerId ? owner.siteId : null,
          name.slice(0, 160),
          input.phone?.trim().slice(0, 40) || null,
          input.email?.trim().slice(0, 190) || null,
        ] as never,
      )
      return { memberId: Number((res as { insertId: number }).insertId), memberNumber }
    })

    await logActivity(siteId, actor, {
      entity: 'loyalty',
      entityId: result.memberId,
      action: 'member_joined',
      detail: `${result.memberNumber} · ${name}`,
    })

    return { ok: true, ...result }
  } catch (error) {
    // The unique key is what makes concurrent enrolment safe, so its refusal is
    // an expected outcome to explain rather than a crash to report.
    const code = (error as { code?: string }).code
    if (code === 'ER_DUP_ENTRY') {
      return requested
        ? { ok: false, error: `Member number ${requested} is already in use.` }
        : { ok: false, error: 'Another till just took that number — please try again.' }
    }
    throw error
  }
}

/**
 * Links an existing member to a debtors account, or unlinks them.
 *
 * Separate from enrolment because it happens later and for a different reason:
 * a member who has been collecting points for a year opens an account, and the
 * two records should meet without either being recreated.
 */
export async function linkMemberToCustomer(
  siteId: number,
  actor: Actor,
  memberId: number,
  customerId: number | null,
): Promise<SaveResult> {
  const owner = await customerOwnerSite(siteId)

  if (customerId) {
    const taken = await memberIdForCustomer(siteId, customerId)
    if (taken && taken !== memberId) {
      return { ok: false, error: 'That customer is already linked to another member.' }
    }
  }

  await loyaltyExecute(
    siteId,
    `UPDATE loyalty_members
        SET customer_id = ?, customer_origin_site_id = ?
      WHERE id = ?`,
    // Both columns move together. Leaving the site set with a null id would
    // make a walk-in member look like they belong to a customer file.
    [customerId, customerId ? owner.siteId : null, memberId],
  )

  await logActivity(siteId, actor, {
    entity: 'loyalty',
    entityId: memberId,
    action: customerId ? 'member_linked' : 'member_unlinked',
    detail: customerId ? `Customer ${customerId}` : 'Account removed',
  })
  return { ok: true }
}

/**
 * A member as the till holds them: who they are, not what they are worth.
 *
 * The balance is deliberately absent. It moves — another till can spend it
 * while this basket sits on screen — so it is re-read by tillStandingAction at
 * the moment it is quoted, and never cached on the sale.
 */
export type TillMember = {
  id: number
  /** The member's own number, which is what the card carries. */
  number: string
  name: string
  /** The linked debtors account, or null for a member who has no account. */
  customerId: number | null
}

/** The member behind a scanned card or typed number. Null if there is none. */
export async function findTillMember(
  siteId: number,
  memberNumber: string,
): Promise<TillMember | null> {
  const code = memberNumber.trim()
  if (!code) return null

  const row = await loyaltyQueryOne<Row>(
    siteId,
    `SELECT id, member_number, name, customer_id
       FROM loyalty_members
      WHERE member_number = ? AND is_active = 1`,
    [code],
  )
  if (!row) return null

  return {
    id: Number(row.id),
    number: String(row.member_number),
    name: String(row.name),
    customerId: row.customer_id == null ? null : Number(row.customer_id),
  }
}

/** The member linked to a customer, shaped for the till. */
export async function tillMemberForCustomer(
  siteId: number,
  customerId: number,
): Promise<TillMember | null> {
  const owner = await customerOwnerSite(siteId)
  const row = await loyaltyQueryOne<Row>(
    siteId,
    `SELECT id, member_number, name, customer_id
       FROM loyalty_members
      WHERE customer_id = ? AND customer_origin_site_id = ? AND is_active = 1`,
    [customerId, owner.siteId],
  )
  if (!row) return null

  return {
    id: Number(row.id),
    number: String(row.member_number),
    name: String(row.name),
    customerId: row.customer_id == null ? null : Number(row.customer_id),
  }
}

/**
 * The debtors account a member is linked to, if any.
 *
 * The inverse of memberIdForCustomer, and it answers with the id ONLY when that
 * id means something to the asking site — a member linked to another store's
 * customer file resolves to null here rather than to an id that would open the
 * wrong customer. See customer_origin_site_id in sql/site/052_loyalty.sql.
 */
export async function customerIdForMember(
  siteId: number,
  memberId: number,
): Promise<number | null> {
  const owner = await customerOwnerSite(siteId)
  const row = await loyaltyQueryOne<Row>(
    siteId,
    `SELECT customer_id FROM loyalty_members
      WHERE id = ? AND customer_origin_site_id = ?`,
    [memberId, owner.siteId],
  )
  return row?.customer_id == null ? null : Number(row.customer_id)
}

/* ── Manual movement ─────────────────────────────────────────────────────── */

export type AdjustResult = { ok: true; balance: number } | { ok: false; error: string }

/**
 * A manual correction or goodwill gesture.
 *
 * Gated on `loyalty.adjust` at the action, not here — but a reason is required
 * at this level, because an unexplained points movement is exactly the entry
 * someone will have to account for later.
 */
export async function adjustPoints(
  siteId: number,
  actor: Actor,
  memberId: number,
  points: number,
  reason: string,
): Promise<AdjustResult> {
  if (!Number.isFinite(points) || points === 0) {
    return { ok: false, error: 'Enter the points to add or take away.' }
  }
  if (!reason.trim()) return { ok: false, error: 'Give a reason for the adjustment.' }

  const settings = await getLoyaltySettings(siteId)
  const tiers = await listTiers(siteId)

  try {
    const balance = await loyaltyTransaction(siteId, async (tx) => {
      const current = await lockedBalance(tx, memberId)
      if (points < 0 && current + points < 0) {
        throw new Error(
          `That would take the balance below zero — this account has ${Math.floor(current)} points.`,
        )
      }

      await insertLedger(tx, actor, siteId, {
        memberId,
        entryType: 'adjust',
        points,
        note: reason.trim(),
      })
      await refreshMember(tx, memberId, settings, tiers)
      return round(current + points, 4)
    })

    await logActivity(siteId, actor, {
      entity: 'loyalty',
      entityId: memberId,
      action: points > 0 ? 'points_granted' : 'points_deducted',
      detail: `${points > 0 ? '+' : ''}${points} · ${reason.trim()}`,
    })

    return { ok: true, balance }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not adjust.' }
  }
}

/* ── Reversal ────────────────────────────────────────────────────────────── */

export type ReversalResult = {
  ok: true
  pointsClawedBack: number
  pointsReturned: number
} | { ok: false; error: string }

/**
 * Undoes what a sale did to a loyalty account, for a refund or a void.
 *
 * Both directions: points EARNED on the sale are taken back, and points SPENT
 * on it are given back. Doing only the first is the common half-implementation,
 * and it quietly robs every customer who paid with points and then returned the
 * goods.
 *
 * A BALANCE MAY GO NEGATIVE HERE, deliberately. If a customer earned points and
 * spent them before refunding the sale, the points are gone; refusing the
 * reversal would leave the shop unable to process the refund, and silently
 * clawing back only what is left would hide the shortfall. A negative balance is
 * visible, and the next earn absorbs it.
 *
 * Idempotent: a second attempt finds its own reverse row and stops.
 */
export async function reverseSaleLoyalty(
  siteId: number,
  actor: Actor,
  documentId: number,
  reason: string,
): Promise<ReversalResult> {
  const settings = await getLoyaltySettings(siteId)
  const tiers = await listTiers(siteId)

  try {
    const result = await loyaltyTransaction(siteId, async (tx) => {
      const [rows] = await tx.query<Row[]>(
        `SELECT id, member_id, entry_type, points, document_number
           FROM loyalty_ledger WHERE document_id = ? FOR UPDATE`,
        [documentId] as never,
      )
      if (rows.length === 0) return { clawedBack: 0, returned: 0, memberId: null }

      if (rows.some((r) => String(r.entry_type) === 'reverse')) {
        return { clawedBack: 0, returned: 0, memberId: null }
      }

      const memberId = Number(rows[0].member_id)
      const documentNumber = String(rows[0].document_number ?? '')

      let clawedBack = 0
      let returned = 0
      for (const row of rows) {
        const type = String(row.entry_type)
        const points = toNum(row.points)
        if (type === 'earn') clawedBack = round(clawedBack + points, 4)
        if (type === 'redeem') returned = round(returned - points, 4)
      }

      const net = round(returned - clawedBack, 4)
      if (net !== 0 || clawedBack !== 0 || returned !== 0) {
        await insertLedger(tx, actor, siteId, {
          memberId,
          entryType: 'reverse',
          points: net,
          documentId,
          documentNumber,
          note: reason.trim().slice(0, 255),
        })
        await refreshMember(tx, memberId, settings, tiers)
      }

      return { clawedBack, returned, memberId }
    })

    if (result.memberId !== null) {
      await logActivity(siteId, actor, {
        entity: 'loyalty',
        entityId: result.memberId,
        action: 'sale_reversed',
        detail: `-${result.clawedBack} earned, +${result.returned} returned · ${reason.trim()}`,
      })
    }

    return {
      ok: true,
      pointsClawedBack: result.clawedBack,
      pointsReturned: result.returned,
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not reverse the loyalty on that sale.',
    }
  }
}

/* ── Expiry ──────────────────────────────────────────────────────────────── */

/**
 * Lapses points under the programme's policy. Safe to run repeatedly.
 *
 * 'activity' expires a whole balance once an account has been quiet for the
 * configured months. 'earn' ages each batch out on its own clock, oldest first,
 * which is fairer but only tells the customer the truth if the slip shows it.
 *
 * Written as negative `expire` rows like everything else, so an expiry is
 * visible in the history rather than a balance that mysteriously dropped.
 */
export async function expirePoints(
  siteId: number,
  actor: Actor,
): Promise<{ customers: number; points: number }> {
  const settings = await getLoyaltySettings(siteId)
  if (!settings.enabled || settings.expiryMode === 'never' || settings.expiryMonths < 1) {
    return { customers: 0, points: 0 }
  }

  const tiers = await listTiers(siteId)
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - settings.expiryMonths)

  const candidates =
    settings.expiryMode === 'activity'
      ? await loyaltyQuery<Row>(
          siteId,
          `SELECT m.id AS member_id
             FROM loyalty_members m
            WHERE m.points_balance > 0
              AND COALESCE(m.last_activity_at, m.joined_at) < ?`,
          [cutoff],
        )
      : await loyaltyQuery<Row>(
          siteId,
          `SELECT member_id
             FROM loyalty_ledger
            WHERE entry_type = 'earn' AND created_at < ?
            GROUP BY member_id
           HAVING COALESCE(SUM(points),0) > 0`,
          [cutoff],
        )

  let customers = 0
  let expired = 0

  for (const row of candidates) {
    const memberId = Number(row.member_id)

    const points = await loyaltyTransaction(siteId, async (tx) => {
      // Re-read under the lock: the balance may have moved between the sweep
      // above and this write, and expiring a stale figure would take points a
      // customer earned this morning.
      const balance = await lockedBalance(tx, memberId)
      if (balance <= 0) return 0

      const toExpire =
        settings.expiryMode === 'activity' ? balance : await agedBatch(tx, memberId, cutoff, balance)

      if (toExpire <= 0) return 0

      await insertLedger(tx, actor, siteId, {
        memberId,
        entryType: 'expire',
        points: -toExpire,
        note:
          settings.expiryMode === 'activity'
            ? `Inactive for ${settings.expiryMonths} months`
            : `Earned more than ${settings.expiryMonths} months ago`,
      })
      await refreshMember(tx, memberId, settings, tiers)
      return toExpire
    })

    if (points > 0) {
      customers += 1
      expired = round(expired + points, 4)
    }
  }

  if (customers > 0) {
    await logActivity(siteId, actor, {
      entity: 'loyalty',
      entityId: null,
      action: 'points_expired',
      detail: `${expired} points across ${customers} account${customers === 1 ? '' : 's'}`,
    })
  }

  return { customers, points: expired }
}

/**
 * How much of a balance was earned before the cutoff and not yet spent.
 *
 * FIFO: spending draws down the oldest points first, so what remains expirable
 * is the aged earnings less everything already taken off. Capped at the current
 * balance — a customer cannot lose more than they hold.
 */
async function agedBatch(
  tx: PoolConnection,
  memberId: number,
  cutoff: Date,
  balance: number,
): Promise<number> {
  const [[aged]] = await tx.query<Row[]>(
    `SELECT COALESCE(SUM(points),0) AS earned
       FROM loyalty_ledger
      WHERE member_id = ? AND entry_type = 'earn' AND created_at < ?`,
    [memberId, cutoff] as never,
  )
  const [[spent]] = await tx.query<Row[]>(
    `SELECT COALESCE(SUM(points),0) AS spent
       FROM loyalty_ledger
      WHERE member_id = ? AND entry_type <> 'earn'`,
    [memberId] as never,
  )

  // `spent` is negative for redemptions and expiries, positive for an upward
  // adjustment — adding it gives what is left of the aged batch either way.
  const remaining = round(toNum(aged?.earned) + toNum(spent?.spent), 4)
  return Math.max(0, Math.min(remaining, balance))
}

/* ── Lists and totals ────────────────────────────────────────────────────── */

export type MemberRow = {
  memberId: number
  /** The linked debtors account, or null for a walk-in member. */
  customerId: number | null
  code: string
  name: string
  phone: string
  points: number
  pointsValue: number
  walletBalance: number
  tierName: string
  tierColor: string
  qualifyingSpend: number
  vouchersReady: number
  lastActivityAt: Date | null
}

export type MemberListResult = { rows: MemberRow[]; total: number; truncated: boolean }

const MEMBER_LIST_CAP = 500

/**
 * The members list.
 *
 * One definition serving both the Members screen and its report, so the two can
 * never disagree about who is a member or what they are worth.
 *
 * Balances are summed from the ledger rather than read off the member cache:
 * this is the screen someone opens to check a disputed balance, and it should
 * show the authoritative figure even if a cache somewhere has drifted.
 */
export async function listMembers(
  siteId: number,
  options: { search?: string; tierId?: number | null; limit?: number } = {},
): Promise<MemberListResult> {
  const settings = await getLoyaltySettings(siteId)
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? MEMBER_LIST_CAP)), MEMBER_LIST_CAP)
  const from = windowStart(settings)

  const where: string[] = []
  const params: unknown[] = []

  if (from) params.push(from)

  if (options.search?.trim()) {
    const term = `%${options.search.trim()}%`
    // Against the MEMBER file. The old search read customers.loyalty_number,
    // which no member of this list is guaranteed to have — a walk-in has no
    // customer row at all, so searching customers would hide exactly the people
    // this screen now exists to show.
    where.push('(m.name LIKE ? OR m.member_number LIKE ? OR m.phone LIKE ?)')
    // Three, not four: the clause lost its loyalty_number placeholder.
    params.push(term, term, term)
  }
  if (options.tierId) {
    where.push('m.tier_id = ?')
    params.push(options.tierId)
  }

  // Aggregates are computed in SQL rather than merged in memory: unlike the old
  // system, customers and loyalty live in the SAME database here, so a join is
  // available and a 500-row page costs one round trip.
  const sql = `
    SELECT m.id, m.member_number, m.customer_id, m.name, m.phone,
           COALESCE(l.points, 0) AS points,
           COALESCE(w.wallet, 0) AS wallet,
           COALESCE(s.spend, 0) AS spend,
           COALESCE(v.ready, 0) AS vouchers_ready,
           m.last_activity_at,
           t.name AS tier_name, t.color AS tier_color
      FROM loyalty_members m
      LEFT JOIN loyalty_tiers t ON t.id = m.tier_id
      LEFT JOIN (
        SELECT member_id, SUM(points) AS points FROM loyalty_ledger GROUP BY member_id
      ) l ON l.member_id = m.id
      LEFT JOIN (
        SELECT member_id, SUM(amount) AS wallet FROM loyalty_wallet GROUP BY member_id
      ) w ON w.member_id = m.id
      LEFT JOIN (
        SELECT member_id, SUM(basis_amount) AS spend
          FROM loyalty_ledger
         WHERE entry_type = 'earn' ${from ? 'AND created_at >= ?' : ''}
         GROUP BY member_id
      ) s ON s.member_id = m.id
      LEFT JOIN (
        SELECT member_id, COUNT(*) AS ready
          FROM loyalty_vouchers
         WHERE status = 'issued' AND (expires_on IS NULL OR expires_on >= CURDATE())
         GROUP BY member_id
      ) v ON v.member_id = m.id
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY points DESC, m.name ASC
     LIMIT ${limit + 1}
  `

  const rows = await loyaltyQuery<Row>(siteId, sql, params)
  const truncated = rows.length > limit

  const countRow = await loyaltyQueryOne<Row>(
    siteId,
    'SELECT COUNT(*) AS n FROM loyalty_members',
  )

  return {
    rows: rows.slice(0, limit).map((r) => {
      const points = round(toNum(r.points), 4)
      return {
        memberId: Number(r.id),
        // The member's OWN number now, not a customer code. A walk-in member
        // has no customer code to show.
        code: String(r.member_number),
        customerId: r.customer_id === null ? null : Number(r.customer_id),
        name: String(r.name),
        phone: String(r.phone ?? ''),
        points,
        pointsValue: pointsToRand(points, settings),
        walletBalance: round(toNum(r.wallet), 2),
        tierName: String(r.tier_name ?? ''),
        tierColor: String(r.tier_color ?? ''),
        qualifyingSpend: round(toNum(r.spend), 2),
        vouchersReady: Number(r.vouchers_ready ?? 0),
        lastActivityAt: (r.last_activity_at as Date) ?? null,
      }
    }),
    total: Number(countRow?.n ?? 0),
    truncated,
  }
}

/**
 * What the programme owes.
 *
 * Outstanding points priced at the redemption rate, plus the wallet float —
 * which is money customers have already handed over and can demand goods for.
 * Under IFRS 15 that is deferred revenue, not profit, and a shop running a
 * programme of any size needs the figure at year end.
 */
export async function getLiability(siteId: number): Promise<{
  members: number
  points: number
  pointsValue: number
  walletFloat: number
}> {
  const settings = await getLoyaltySettings(siteId)

  const row = await loyaltyQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS members, COALESCE(SUM(points),0) AS points FROM (
       SELECT member_id, SUM(points) AS points
         FROM loyalty_ledger GROUP BY member_id HAVING SUM(points) > 0
     ) t`,
  )
  const wallet = await loyaltyQueryOne<Row>(
    siteId,
    `SELECT COALESCE(SUM(amount),0) AS float_amount FROM loyalty_wallet`,
  )

  const points = round(toNum(row?.points), 4)
  return {
    members: Number(row?.members ?? 0),
    points,
    pointsValue: pointsToRand(points, settings),
    walletFloat: round(toNum(wallet?.float_amount), 2),
  }
}

/** Bulk standing for the till's customer list. */
export async function memberSummaries(
  siteId: number,
): Promise<Map<number, { points: number; tierName: string }>> {
  // loyaltyQuery, not siteQuery: both tables belong to the loyalty owner, and on
  // a shared programme the branch's own copies are empty — this returned an
  // empty map rather than failing, which is the quieter of the two bugs here.
  const rows = await loyaltyQuery<Row>(
    siteId,
    `SELECT m.id AS member_id, m.points_balance, COALESCE(t.name,'') AS tier_name
       FROM loyalty_members m
       LEFT JOIN loyalty_tiers t ON t.id = m.tier_id`,
  )
  return new Map(
    rows.map((r) => [
      Number(r.member_id),
      { points: toNum(r.points_balance), tierName: String(r.tier_name) },
    ]),
  )
}

export { refreshMember, insertLedger, lockedBalance }
