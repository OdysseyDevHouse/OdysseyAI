import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { supplierDbPrefix } from './customerDb'
import { round, toNum } from '../decimals'

/**
 * Commission — rules, calculation, runs.
 *
 * See 042 for why the schema looks the way it does. The short version: profit
 * is the default basis because on a turnover scheme a discount costs the
 * salesperson their rate and costs the business the whole margin; tiers are
 * marginal because retroactive tiers create a cliff worth gaming; and a run
 * locks because a figure someone has been paid must never move afterwards.
 */

export type CommissionBasis = 'gross_profit' | 'turnover'

export type CommissionTier = {
  fromAmount: number
  ratePct: number
}

export type CommissionRule = {
  id: number
  name: string
  priority: number
  basis: CommissionBasis
  departmentId: number | null
  departmentName: string | null
  productId: number | null
  productCode: string | null
  brandId: number | null
  brandName: string | null
  supplierId: number | null
  supplierName: string | null
  userId: number | null
  userName: string | null
  isExclusion: boolean
  ratePct: number
  threshold: number
  isActive: boolean
  tiers: CommissionTier[]
}

type RuleRow = RowDataPacket & {
  id: number
  name: string
  priority: number
  basis: CommissionBasis
  department_id: number | null
  department_name: string | null
  product_id: number | null
  product_code: string | null
  brand_id: number | null
  brand_name: string | null
  supplier_id: number | null
  supplier_name: string | null
  user_id: number | null
  user_name: string | null
  is_exclusion: number
  rate_pct: string | number
  threshold: string | number
  is_active: number
}

/** A commission rule is this shop's; a supplier it scopes to may be the group's. */
const selectRule = (sdb: string) => `
  SELECT r.id, r.name, r.priority, r.basis,
         r.department_id, d.name AS department_name,
         r.product_id, p.code AS product_code,
         r.brand_id, b.name AS brand_name,
         r.supplier_id, s.name AS supplier_name,
         r.user_id, u.name AS user_name,
         r.is_exclusion, r.rate_pct, r.threshold, r.is_active
    FROM commission_rules r
    LEFT JOIN departments d ON d.id = r.department_id
    LEFT JOIN products    p ON p.id = r.product_id
    LEFT JOIN brands      b ON b.id = r.brand_id
    LEFT JOIN ${sdb}suppliers s ON s.id = r.supplier_id
    LEFT JOIN users       u ON u.id = r.user_id
`

function mapRule(r: RuleRow, tiers: CommissionTier[]): CommissionRule {
  return {
    id: r.id,
    name: r.name,
    priority: r.priority,
    basis: r.basis,
    departmentId: r.department_id,
    departmentName: r.department_name,
    productId: r.product_id,
    productCode: r.product_code,
    brandId: r.brand_id,
    brandName: r.brand_name,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    userId: r.user_id,
    userName: r.user_name,
    isExclusion: !!r.is_exclusion,
    ratePct: toNum(r.rate_pct),
    threshold: toNum(r.threshold),
    isActive: !!r.is_active,
    tiers,
  }
}

export async function listRules(siteId: number, activeOnly = false): Promise<CommissionRule[]> {
  const sdb = await supplierDbPrefix(siteId)
  const rows = await siteQuery<RuleRow>(
    siteId,
    `${selectRule(sdb)} ${activeOnly ? 'WHERE r.is_active = 1' : ''}
      ORDER BY r.priority ASC, r.id ASC`,
  )
  if (!rows.length) return []

  const tiers = await siteQuery<RowDataPacket & { rule_id: number; from_amount: string; rate_pct: string }>(
    siteId,
    `SELECT rule_id, from_amount, rate_pct FROM commission_tiers
      WHERE rule_id IN (${rows.map(() => '?').join(',')})
      ORDER BY rule_id, from_amount ASC`,
    rows.map((r) => r.id),
  )

  const byRule = new Map<number, CommissionTier[]>()
  for (const t of tiers) {
    const list = byRule.get(t.rule_id) ?? []
    list.push({ fromAmount: toNum(t.from_amount), ratePct: toNum(t.rate_pct) })
    byRule.set(t.rule_id, list)
  }

  return rows.map((r) => mapRule(r, byRule.get(r.id) ?? []))
}

export async function getRule(siteId: number, ruleId: number): Promise<CommissionRule | null> {
  const sdb = await supplierDbPrefix(siteId)
  const row = await siteQueryOne<RuleRow>(siteId, `${selectRule(sdb)} WHERE r.id = ? LIMIT 1`, [ruleId])
  if (!row) return null

  const tiers = await siteQuery<RowDataPacket & { from_amount: string; rate_pct: string }>(
    siteId,
    'SELECT from_amount, rate_pct FROM commission_tiers WHERE rule_id = ? ORDER BY from_amount ASC',
    [ruleId],
  )
  return mapRule(
    row,
    tiers.map((t) => ({ fromAmount: toNum(t.from_amount), ratePct: toNum(t.rate_pct) })),
  )
}

/**
 * How specific a rule is, used to seed its priority.
 *
 * A product rule should beat a department rule by default, because that is
 * what someone means when they write one. The number is only a starting point:
 * `priority` is editable precisely so "this promotion beats everything" can be
 * expressed without contorting the scope.
 */
export function defaultPriority(scope: {
  productId?: number | null
  brandId?: number | null
  supplierId?: number | null
  departmentId?: number | null
  userId?: number | null
}): number {
  if (scope.productId) return 10
  if (scope.brandId) return 20
  if (scope.supplierId) return 30
  if (scope.departmentId) return 40
  if (scope.userId) return 50
  return 100
}

export type RuleInput = {
  name: string
  priority: number | null
  basis: CommissionBasis
  departmentId: number | null
  productId: number | null
  brandId: number | null
  supplierId: number | null
  userId: number | null
  isExclusion: boolean
  ratePct: number
  threshold: number
  isActive: boolean
  tiers: CommissionTier[]
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

function validate(input: RuleInput): string | null {
  if (!input.name.trim()) return 'Give the rule a name.'
  if (input.name.length > 120) return 'That name is too long.'
  if (input.ratePct < 0 || input.ratePct > 100) return 'The rate must be between 0 and 100 percent.'
  if (input.threshold < 0) return 'A threshold cannot be negative.'

  if (input.tiers.length) {
    // A tier table that does not start at zero leaves the first slice of
    // earnings with no rate at all, which reads as "unpaid" rather than as the
    // configuration mistake it is.
    const sorted = [...input.tiers].sort((a, b) => a.fromAmount - b.fromAmount)
    if (sorted[0].fromAmount !== 0) return 'The first tier must start at 0.'

    for (const tier of sorted) {
      if (tier.ratePct < 0 || tier.ratePct > 100) {
        return 'Every tier rate must be between 0 and 100 percent.'
      }
      if (tier.fromAmount < 0) return 'A tier cannot start below 0.'
    }
    const amounts = sorted.map((t) => t.fromAmount)
    if (new Set(amounts).size !== amounts.length) {
      return 'Two tiers cannot start at the same amount.'
    }
  }
  return null
}

export async function createRule(siteId: number, input: RuleInput): Promise<SaveResult> {
  const problem = validate(input)
  if (problem) return { ok: false, error: problem }

  return siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO commission_rules
         (name, priority, basis, department_id, product_id, brand_id, supplier_id,
          user_id, is_exclusion, rate_pct, threshold, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.name.trim(),
        input.priority ?? defaultPriority(input),
        input.basis,
        input.departmentId,
        input.productId,
        input.brandId,
        input.supplierId,
        input.userId,
        input.isExclusion ? 1 : 0,
        input.ratePct.toFixed(3),
        input.threshold.toFixed(4),
        input.isActive ? 1 : 0,
      ],
    )
    const id = (res as { insertId: number }).insertId

    for (const tier of input.tiers) {
      await tx.execute(
        'INSERT INTO commission_tiers (rule_id, from_amount, rate_pct) VALUES (?,?,?)',
        [id, tier.fromAmount.toFixed(4), tier.ratePct.toFixed(3)],
      )
    }
    return { ok: true as const, id }
  })
}

export async function updateRule(
  siteId: number,
  ruleId: number,
  input: RuleInput,
): Promise<SaveResult> {
  const problem = validate(input)
  if (problem) return { ok: false, error: problem }

  return siteTransaction(siteId, async (tx) => {
    await tx.execute(
      `UPDATE commission_rules
          SET name = ?, priority = ?, basis = ?, department_id = ?, product_id = ?,
              brand_id = ?, supplier_id = ?, user_id = ?, is_exclusion = ?,
              rate_pct = ?, threshold = ?, is_active = ?
        WHERE id = ?`,
      [
        input.name.trim(),
        input.priority ?? defaultPriority(input),
        input.basis,
        input.departmentId,
        input.productId,
        input.brandId,
        input.supplierId,
        input.userId,
        input.isExclusion ? 1 : 0,
        input.ratePct.toFixed(3),
        input.threshold.toFixed(4),
        input.isActive ? 1 : 0,
        ruleId,
      ],
    )

    // Replaced wholesale rather than diffed: a tier table is small, and an
    // in-place merge is where off-by-one band boundaries come from.
    await tx.execute('DELETE FROM commission_tiers WHERE rule_id = ?', [ruleId])
    for (const tier of input.tiers) {
      await tx.execute(
        'INSERT INTO commission_tiers (rule_id, from_amount, rate_pct) VALUES (?,?,?)',
        [ruleId, tier.fromAmount.toFixed(4), tier.ratePct.toFixed(3)],
      )
    }
    return { ok: true as const, id: ruleId }
  })
}

/**
 * Deletes a rule.
 *
 * `commission_entries.rule_id` is ON DELETE SET NULL and every entry carries a
 * snapshot of the rule's name, basis and rate — so a locked run still explains
 * itself after the rule behind it is gone.
 */
export async function deleteRule(siteId: number, ruleId: number): Promise<{ ok: boolean; error?: string }> {
  await siteExecute(siteId, 'DELETE FROM commission_rules WHERE id = ?', [ruleId])
  return { ok: true }
}

/* ── Calculation ───────────────────────────────────────────────────────── */

/**
 * What one line earns, given the rate that applies to it.
 *
 * Split out from the run so it can be tested directly, and so the rules screen
 * can show a worked example without writing anything.
 *
 * MARGINAL TIERS. `runningBase` is how much of this rule's basis the person has
 * already accumulated this period; the line's own base is then sliced across
 * whatever bands it spans. A line straddling a boundary is charged partly at
 * each rate, which is the whole point — crossing a threshold must not re-rate
 * what came before it.
 */
export function rateForSlice(
  rule: Pick<CommissionRule, 'ratePct' | 'tiers' | 'threshold'>,
  runningBase: number,
  lineBase: number,
): { amount: number; effectiveRate: number } {
  // Below the threshold nothing is earned. Applied to the running total rather
  // than the line so a threshold means "until this person has sold X", not
  // "until one sale is worth X".
  const start = Math.max(runningBase, rule.threshold)
  const end = runningBase + lineBase

  // A credit note (negative base) claws back at the rate that applies where the
  // person currently sits, rather than walking bands backwards. Walking
  // backwards would be defensible arithmetic and impossible to explain on a
  // statement.
  if (lineBase < 0) {
    const rate = rateAt(rule, Math.max(runningBase + lineBase, 0))
    return { amount: round(lineBase * (rate / 100), 2), effectiveRate: rate }
  }

  if (end <= start) return { amount: 0, effectiveRate: 0 }

  if (!rule.tiers.length) {
    const base = end - start
    return {
      amount: round(base * (rule.ratePct / 100), 2),
      effectiveRate: rule.ratePct,
    }
  }

  const bands = [...rule.tiers].sort((a, b) => a.fromAmount - b.fromAmount)
  let amount = 0

  for (let i = 0; i < bands.length; i++) {
    const bandStart = bands[i].fromAmount
    const bandEnd = i + 1 < bands.length ? bands[i + 1].fromAmount : Infinity

    // The slice of THIS line that falls inside THIS band.
    const from = Math.max(start, bandStart)
    const to = Math.min(end, bandEnd)
    if (to > from) amount += (to - from) * (bands[i].ratePct / 100)
  }

  const base = end - start
  return {
    amount: round(amount, 2),
    // Reported back so a statement can show one number rather than the bands.
    effectiveRate: base > 0 ? round((amount / base) * 100, 3) : 0,
  }
}

/** The rate in force at a given running total. */
function rateAt(rule: Pick<CommissionRule, 'ratePct' | 'tiers'>, at: number): number {
  if (!rule.tiers.length) return rule.ratePct
  const bands = [...rule.tiers].sort((a, b) => a.fromAmount - b.fromAmount)
  let rate = bands[0].ratePct
  for (const band of bands) if (at >= band.fromAmount) rate = band.ratePct
  return rate
}

/**
 * The rule that applies to one line, or null if none does.
 *
 * Lowest priority number wins, ties broken by id — so the answer is the same
 * every time it is asked, which is what makes a recalculation safe.
 *
 * An exclusion rule that matches stops the search and earns nothing: it is a
 * deliberate "not this", distinct from a 0% rule that might just be unfinished.
 */
export function ruleForLine(
  rules: CommissionRule[],
  line: {
    productId: number | null
    departmentId: number | null
    departmentPath: number[]
    brandId: number | null
    supplierIds: number[]
    userId: number
  },
): CommissionRule | null {
  for (const rule of rules) {
    if (!rule.isActive) continue
    if (rule.userId !== null && rule.userId !== line.userId) continue
    if (rule.productId !== null && rule.productId !== line.productId) continue
    if (rule.brandId !== null && rule.brandId !== line.brandId) continue
    // A product can have several suppliers, so this is "any of them".
    if (rule.supplierId !== null && !line.supplierIds.includes(rule.supplierId)) continue
    // Department matches the line's own department or any ancestor, so a rule
    // on "Furniture" covers "Furniture > Lounge" without listing children.
    if (rule.departmentId !== null && !line.departmentPath.includes(rule.departmentId)) continue

    return rule.isExclusion ? null : rule
  }
  return null
}
