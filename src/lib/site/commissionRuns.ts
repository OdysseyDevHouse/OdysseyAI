import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { getSetting } from './settings'
import { listRules, ruleForLine, rateForSlice, type CommissionRule } from './commission'
import type { Actor } from './activityLog'

/**
 * Commission runs — calculating a period, and freezing it.
 *
 * OPEN MEANS RECALCULABLE, LOCKED MEANS FROZEN. Everything here turns on that.
 * While a run is open its entries are thrown away and rebuilt from the sales
 * every time it is calculated, so late captures and corrections are picked up.
 * Once locked, nothing recomputes it — because a figure somebody has been paid
 * must not move when a rule is edited or a cost is corrected six months later.
 */

export type RunStatus = 'open' | 'locked'

export type CommissionRun = {
  id: number
  periodStart: string
  periodEnd: string
  status: RunStatus
  calculatedAt: string | null
  lockedAt: string | null
  lockedByName: string | null
  totalAmount: number
  note: string | null
}

type RunRow = RowDataPacket & {
  id: number
  period_start: string
  period_end: string
  status: RunStatus
  calculated_at: string | null
  locked_at: string | null
  locked_by_name: string | null
  total_amount: string | number
  note: string | null
}

function mapRun(r: RunRow): CommissionRun {
  return {
    id: r.id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    status: r.status,
    calculatedAt: r.calculated_at,
    lockedAt: r.locked_at,
    lockedByName: r.locked_by_name,
    totalAmount: toNum(r.total_amount),
    note: r.note,
  }
}

export async function listRuns(siteId: number): Promise<CommissionRun[]> {
  const rows = await siteQuery<RunRow>(
    siteId,
    `SELECT id, period_start, period_end, status, calculated_at, locked_at,
            locked_by_name, total_amount, note
       FROM commission_runs ORDER BY period_start DESC`,
  )
  return rows.map(mapRun)
}

export async function getRun(siteId: number, runId: number): Promise<CommissionRun | null> {
  const row = await siteQueryOne<RunRow>(
    siteId,
    `SELECT id, period_start, period_end, status, calculated_at, locked_at,
            locked_by_name, total_amount, note
       FROM commission_runs WHERE id = ? LIMIT 1`,
    [runId],
  )
  return row ? mapRun(row) : null
}

export type RunResult = { ok: true; id: number } | { ok: false; error: string }

/**
 * Opens a period.
 *
 * Overlap is refused rather than merged: two runs covering the same day would
 * pay the same sale twice, and the UNIQUE key on the exact pair of dates is not
 * enough to catch a range that merely overlaps.
 */
export async function createRun(
  siteId: number,
  periodStart: string,
  periodEnd: string,
  note: string | null,
): Promise<RunResult> {
  if (!periodStart || !periodEnd) return { ok: false, error: 'Choose a period.' }
  if (periodEnd < periodStart) return { ok: false, error: 'The period ends before it starts.' }

  const clash = await siteQueryOne<RowDataPacket & { id: number; period_start: string; period_end: string }>(
    siteId,
    `SELECT id, period_start, period_end FROM commission_runs
      WHERE period_start <= ? AND period_end >= ? LIMIT 1`,
    [periodEnd, periodStart],
  )
  if (clash) {
    return {
      ok: false,
      error: `That overlaps the run for ${clash.period_start} to ${clash.period_end}. Every sale must fall in exactly one period.`,
    }
  }

  const res = await siteExecute(
    siteId,
    'INSERT INTO commission_runs (period_start, period_end, note) VALUES (?,?,?)',
    [periodStart, periodEnd, note?.trim() || null],
  )
  return { ok: true, id: res.insertId }
}

type LineRow = RowDataPacket & {
  line_id: number
  document_id: number
  document_number: string
  document_date: string
  doc_type: string
  user_id: number
  user_name: string
  product_id: number | null
  product_code: string | null
  description: string
  department_id: number | null
  brand_id: number | null
  qty: string
  line_total_excl: string
  unit_cost_excl: string
  original_rep_id: number | null
}

/**
 * Every commissionable line in a period.
 *
 * Attribution is `sales_document_lines.sales_rep_id` where it is set, falling
 * back to the document's own user — the person who rang it up. 033 made the rep
 * per LINE precisely because two assistants can serve one customer off one
 * invoice, and only the per-line answer pays the right person.
 *
 * `original_rep_id` carries the rep from the line a credit note reverses, so a
 * clawback can be charged to whoever made the sale rather than to whoever was
 * standing at the till when the goods came back.
 */
async function commissionableLines(
  siteId: number,
  periodStart: string,
  periodEnd: string,
  excludeReturns: boolean,
): Promise<LineRow[]> {
  return siteQuery<LineRow>(
    siteId,
    `SELECT l.id AS line_id, d.id AS document_id, d.document_number,
            DATE(d.document_date) AS document_date, d.doc_type,
            COALESCE(l.sales_rep_user_id, d.user_id) AS user_id,
            d.user_name,
            l.product_id, l.product_code, l.description,
            l.department_id, p.brand_id,
            l.qty, l.line_total_excl, l.unit_cost_excl,
            src.sales_rep_user_id AS original_rep_id
       FROM sales_document_lines l
       INNER JOIN sales_documents d ON d.id = l.document_id
       LEFT JOIN products p ON p.id = l.product_id
        LEFT JOIN sales_document_lines src ON src.id = l.source_line_id
      WHERE d.status = 'finalised'
        AND d.document_date >= ? AND d.document_date < DATE_ADD(?, INTERVAL 1 DAY)
        AND d.doc_type IN ('invoice'${excludeReturns ? '' : ",'credit_sale'"})
      ORDER BY d.document_date ASC, d.id ASC, l.line_number ASC`,
    [periodStart, periodEnd],
  )
}

/** Ancestor chain for every department, so a rule on a parent covers children. */
async function departmentPaths(siteId: number): Promise<Map<number, number[]>> {
  const rows = await siteQuery<RowDataPacket & { id: number; parent_id: number | null }>(
    siteId,
    'SELECT id, parent_id FROM departments',
  )
  const parents = new Map<number, number | null>()
  for (const r of rows) parents.set(r.id, r.parent_id)

  const paths = new Map<number, number[]>()
  for (const r of rows) {
    const path: number[] = []
    let at: number | null = r.id
    // Guarded against a cycle: fk_dept_parent is RESTRICT, not a tree check,
    // so a loop is possible in principle and would hang this otherwise.
    const seen = new Set<number>()
    while (at !== null && !seen.has(at)) {
      seen.add(at)
      path.push(at)
      at = parents.get(at) ?? null
    }
    paths.set(r.id, path)
  }
  return paths
}

/** Which suppliers each product can come from — a rule may name any of them. */
async function productSuppliers(siteId: number): Promise<Map<number, number[]>> {
  const rows = await siteQuery<RowDataPacket & { product_id: number; supplier_id: number }>(
    siteId,
    'SELECT product_id, supplier_id FROM product_suppliers',
  )
  const map = new Map<number, number[]>()
  for (const r of rows) {
    const list = map.get(r.product_id) ?? []
    list.push(r.supplier_id)
    map.set(r.product_id, list)
  }
  return map
}

export type CalculateResult =
  | { ok: true; entries: number; total: number; people: number }
  | { ok: false; error: string }

/**
 * Works out what everyone earned, and replaces the run's entries with the
 * answer.
 *
 * Deliberately destructive on an OPEN run: entries are deleted and rebuilt, so
 * recalculating after a late capture or a corrected cost gives the current
 * truth rather than layering a second set of rows on top of the first. A LOCKED
 * run is refused outright.
 *
 * Lines are walked in document order per person so that tier bands and
 * thresholds accumulate the way they did in real life. Reordering them would
 * change who crossed a threshold when, and therefore what they earned.
 */
export async function calculateRun(siteId: number, runId: number): Promise<CalculateResult> {
  const run = await getRun(siteId, runId)
  if (!run) return { ok: false, error: 'That run no longer exists.' }
  if (run.status === 'locked') {
    return { ok: false, error: 'This run is locked. Unlock it first if the figures really must change.' }
  }

  const [excludeReturns, originalRep, rules, paths, suppliers] = await Promise.all([
    getSetting(siteId, 'commission_exclude_returns'),
    getSetting(siteId, 'commission_returns_original_rep'),
    listRules(siteId, true),
    departmentPaths(siteId),
    productSuppliers(siteId),
  ])

  const lines = await commissionableLines(
    siteId,
    run.periodStart,
    run.periodEnd,
    excludeReturns === '1',
  )

  // Running total per (person, rule), because a threshold and a tier band are
  // both properties of a rule — two rules with different bands must not share
  // one accumulator.
  const running = new Map<string, number>()
  const entries: {
    userId: number
    userName: string
    line: LineRow
    rule: CommissionRule
    base: number
    rate: number
    amount: number
  }[] = []

  for (const line of lines) {
    const isCredit = line.doc_type === 'credit_sale'

    // Who this belongs to. On a credit note, the rep from the line being
    // reversed — otherwise the person who happens to process refunds
    // accumulates everybody else's clawbacks.
    const userId =
      isCredit && originalRep === '1' && line.original_rep_id
        ? line.original_rep_id
        : toNum(line.user_id)
    if (!userId) continue

    const qty = toNum(line.qty)
    const revenue = toNum(line.line_total_excl)
    const cost = toNum(line.unit_cost_excl) * qty

    const matched = ruleForLine(rules, {
      productId: line.product_id,
      departmentId: line.department_id,
      departmentPath: line.department_id ? (paths.get(line.department_id) ?? [line.department_id]) : [],
      brandId: line.brand_id,
      supplierIds: line.product_id ? (suppliers.get(line.product_id) ?? []) : [],
      userId,
    })
    if (!matched) continue

    // Both bases are excl. VAT and net of discount — line_total_excl already is
    // both. Profit uses the cost snapshotted at sale time, so a supplier price
    // change cannot rewrite it.
    const base = matched.basis === 'gross_profit' ? round(revenue - cost, 2) : revenue
    if (base === 0) continue

    const key = `${userId}:${matched.id}`
    const already = running.get(key) ?? 0
    const { amount, effectiveRate } = rateForSlice(matched, already, base)
    running.set(key, already + base)

    if (amount === 0) continue

    entries.push({
      userId,
      userName: line.user_name,
      line,
      rule: matched,
      base,
      rate: effectiveRate,
      amount,
    })
  }

  const names = await siteQuery<RowDataPacket & { id: number; name: string }>(
    siteId,
    'SELECT id, name FROM users',
  )
  const nameById = new Map(names.map((n) => [n.id, n.name]))

  await siteTransaction(siteId, async (tx) => {
    await tx.execute('DELETE FROM commission_entries WHERE run_id = ?', [runId])

    for (const e of entries) {
      await tx.execute(
        `INSERT INTO commission_entries
           (run_id, user_id, user_name, line_id, document_id, document_number,
            document_date, doc_type, product_code, description,
            rule_id, rule_name, basis, base_amount, rate_pct, amount)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          runId,
          e.userId,
          nameById.get(e.userId) ?? e.userName ?? '',
          e.line.line_id,
          e.line.document_id,
          e.line.document_number,
          e.line.document_date,
          e.line.doc_type,
          e.line.product_code,
          e.line.description?.slice(0, 200) ?? null,
          e.rule.id,
          e.rule.name,
          e.rule.basis,
          e.base.toFixed(4),
          e.rate.toFixed(3),
          e.amount.toFixed(4),
        ],
      )
    }

    const total = entries.reduce((sum, e) => sum + e.amount, 0)
    await tx.execute(
      'UPDATE commission_runs SET calculated_at = NOW(), total_amount = ? WHERE id = ?',
      [round(total, 2).toFixed(4), runId],
    )
  })

  const total = round(
    entries.reduce((sum, e) => sum + e.amount, 0),
    2,
  )
  return {
    ok: true,
    entries: entries.length,
    total,
    people: new Set(entries.map((e) => e.userId)).size,
  }
}

/**
 * Freezes a run.
 *
 * After this nothing recalculates it. A credit note raised later against a sale
 * inside this period does NOT reopen it — the clawback lands in the next open
 * run, which is both the industry norm and the only version where "paid" stays
 * a fact rather than an opinion.
 */
export async function lockRun(
  siteId: number,
  runId: number,
  actor: Actor,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const run = await getRun(siteId, runId)
  if (!run) return { ok: false, error: 'That run no longer exists.' }
  if (run.status === 'locked') return { ok: false, error: 'This run is already locked.' }
  if (!run.calculatedAt) {
    return { ok: false, error: 'Calculate the run before locking it — there is nothing to freeze yet.' }
  }

  await siteExecute(
    siteId,
    `UPDATE commission_runs
        SET status = 'locked', locked_at = NOW(), locked_by_user_id = ?, locked_by_name = ?
      WHERE id = ? AND status = 'open'`,
    [actor.userId, actor.userName, runId],
  )
  return { ok: true }
}

/**
 * Reopens a locked run.
 *
 * Deliberately possible, deliberately deliberate. Correcting a genuine mistake
 * has to be available, but it must be a decision somebody makes and the audit
 * trail records — never a side effect of pressing Calculate.
 */
export async function unlockRun(
  siteId: number,
  runId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const run = await getRun(siteId, runId)
  if (!run) return { ok: false, error: 'That run no longer exists.' }
  if (run.status === 'open') return { ok: false, error: 'This run is already open.' }

  await siteExecute(
    siteId,
    `UPDATE commission_runs
        SET status = 'open', locked_at = NULL, locked_by_user_id = NULL, locked_by_name = NULL
      WHERE id = ?`,
    [runId],
  )
  return { ok: true }
}

export type RunSummaryRow = {
  userId: number
  userName: string
  entries: number
  earned: number
  clawback: number
  amount: number
}

/** What each person earned in a run, for the run screen. */
export async function runSummary(siteId: number, runId: number): Promise<RunSummaryRow[]> {
  const rows = await siteQuery<
    RowDataPacket & {
      user_id: number
      user_name: string
      entries: number
      earned: string
      clawback: string
      amount: string
    }
  >(
    siteId,
    `SELECT user_id, MAX(user_name) AS user_name, COUNT(*) AS entries,
            SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS earned,
            SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS clawback,
            SUM(amount) AS amount
       FROM commission_entries
      WHERE run_id = ?
      GROUP BY user_id
      ORDER BY SUM(amount) DESC`,
    [runId],
  )
  return rows.map((r) => ({
    userId: r.user_id,
    userName: r.user_name,
    entries: Number(r.entries),
    earned: toNum(r.earned),
    clawback: toNum(r.clawback),
    amount: toNum(r.amount),
  }))
}

export type StatementLine = {
  id: number
  documentNumber: string | null
  documentDate: string | null
  docType: string
  productCode: string | null
  description: string | null
  ruleName: string
  basis: string
  baseAmount: number
  ratePct: number
  amount: number
}

/** One person's lines in a run — the "on what?" behind their total. */
export async function statement(
  siteId: number,
  runId: number,
  userId: number,
): Promise<StatementLine[]> {
  const rows = await siteQuery<
    RowDataPacket & {
      id: number
      document_number: string | null
      document_date: string | null
      doc_type: string
      product_code: string | null
      description: string | null
      rule_name: string
      basis: string
      base_amount: string
      rate_pct: string
      amount: string
    }
  >(
    siteId,
    `SELECT id, document_number, document_date, doc_type, product_code, description,
            rule_name, basis, base_amount, rate_pct, amount
       FROM commission_entries
      WHERE run_id = ? AND user_id = ?
      ORDER BY document_date ASC, document_number ASC, id ASC`,
    [runId, userId],
  )
  return rows.map((r) => ({
    id: r.id,
    documentNumber: r.document_number,
    documentDate: r.document_date,
    docType: r.doc_type,
    productCode: r.product_code,
    description: r.description,
    ruleName: r.rule_name,
    basis: r.basis,
    baseAmount: toNum(r.base_amount),
    ratePct: toNum(r.rate_pct),
    amount: toNum(r.amount),
  }))
}
