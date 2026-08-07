import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { guardPosting } from './periodLocks'
import { postTx } from './journals'
import { listAssets, toDepreciable, categoryAccount } from './fixedAssets'
import { today } from './ledger'
import { chargeFor, monthKey, monthStart } from '../assetModel'
import type { JournalLineInput } from '../glModel'

/**
 * Charging depreciation.
 *
 * Propose, review, post — the same shape as an interest run or a payment run,
 * and for the same reason. Depreciation is a real journal against the profit
 * and loss, and an asset entered with the wrong life quietly misstates profit
 * every month until somebody notices. So the figures are shown, with their
 * workings, before they are posted.
 *
 * ── ONE RUN PER MONTH ────────────────────────────────────────────────────
 *
 * Charging a month twice doubles the expense and takes every asset past its
 * residual. Two things prevent it: the unique index on (period_month, status)
 * in 046, and `last_depreciated_to` on each asset, which chargeFor() checks.
 * Belt and braces, because the failure is silent and compounds.
 */

export type DepreciationRunStatus = 'draft' | 'posted' | 'cancelled'

export type DepreciationRun = {
  id: number
  periodMonth: string
  status: DepreciationRunStatus
  totalAmount: number
  assetCount: number
  postedCount: number
  batchId: number | null
  notes: string | null
  userName: string
  postedAt: Date | null
  createdAt: Date
}

export type DepreciationItem = {
  id: number
  runId: number
  assetId: number
  assetCode: string
  assetName: string
  cost: number
  residualValue: number
  lifeMonths: number
  openingAccumulated: number
  amount: number
  status: 'pending' | 'posted' | 'skipped'
  skipReason: string | null
  /** Accumulated after this charge — the workings, for the screen. */
  closingAccumulated: number
  closingBookValue: number
}

type Row = RowDataPacket & Record<string, unknown>

function mapRun(r: Row): DepreciationRun {
  return {
    id: Number(r.id),
    periodMonth: String(r.period_month),
    status: String(r.status) as DepreciationRunStatus,
    totalAmount: toNum(r.total_amount),
    assetCount: Number(r.asset_count),
    postedCount: Number(r.posted_count),
    batchId: r.batch_id === null ? null : Number(r.batch_id),
    notes: (r.notes as string | null) ?? null,
    userName: String(r.user_name ?? ''),
    postedAt: (r.posted_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

function mapItem(r: Row): DepreciationItem {
  const cost = toNum(r.cost)
  const opening = toNum(r.opening_accumulated)
  const amount = toNum(r.amount)
  const closing = round(opening + amount, 2)

  return {
    id: Number(r.id),
    runId: Number(r.run_id),
    assetId: Number(r.asset_id),
    assetCode: String(r.asset_code),
    assetName: String(r.asset_name),
    cost,
    residualValue: toNum(r.residual_value),
    lifeMonths: Number(r.life_months),
    openingAccumulated: opening,
    amount,
    status: String(r.status) as DepreciationItem['status'],
    skipReason: (r.skip_reason as string | null) ?? null,
    closingAccumulated: closing,
    closingBookValue: round(cost - closing, 2),
  }
}

export async function listRuns(siteId: number, limit = 24): Promise<DepreciationRun[]> {
  const capped = Math.min(Math.max(limit, 1), 200)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM depreciation_runs ORDER BY period_month DESC LIMIT ${capped}`,
  )
  return rows.map(mapRun)
}

export async function getRun(siteId: number, id: number): Promise<DepreciationRun | null> {
  const row = await siteQueryOne<Row>(siteId, 'SELECT * FROM depreciation_runs WHERE id = ? LIMIT 1', [
    id,
  ])
  return row ? mapRun(row) : null
}

export async function listItems(
  siteId: number,
  runId: number,
): Promise<DepreciationItem[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM depreciation_run_items WHERE run_id = ?
      ORDER BY status, amount DESC, asset_name`,
    [runId],
  )
  return rows.map(mapItem)
}

/** The draft run, if one is open. Only one may be at a time. */
export async function openDraft(siteId: number): Promise<DepreciationRun | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    "SELECT * FROM depreciation_runs WHERE status = 'draft' ORDER BY period_month DESC LIMIT 1",
  )
  return row ? mapRun(row) : null
}

/** The month that has not been charged yet — what the screen offers by default. */
export async function nextPeriod(siteId: number): Promise<string> {
  const row = await siteQueryOne<Row>(
    siteId,
    "SELECT MAX(period_month) AS last FROM depreciation_runs WHERE status = 'posted'",
  )
  if (!row?.last) {
    // Nothing has ever been charged: start from the earliest asset, or this
    // month if the register is empty.
    const earliest = await siteQueryOne<Row>(
      siteId,
      "SELECT MIN(depreciation_start) AS start FROM fixed_assets WHERE status <> 'disposed'",
    )
    return monthStart(earliest?.start ? String(earliest.start) : today())
  }

  const d = new Date(`${monthStart(String(row.last))}T00:00:00`)
  d.setMonth(d.getMonth() + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

/* ── Proposing ───────────────────────────────────────────────────────────── */

export type ProposeResult =
  | { ok: true; runId: number; charged: number; skipped: number; total: number }
  | { ok: false; error: string }

/**
 * Works out what every asset depreciates this month and saves it as a draft.
 *
 * Posts NOTHING. Every asset gets a row — including the ones charging nothing,
 * with the reason — because "why is the workshop press not depreciating" is a
 * question the run should answer, exactly as a statement run queues its skips
 * rather than dropping them.
 */
export async function proposeRun(
  siteId: number,
  actor: Actor,
  periodMonth: string,
  notes?: string | null,
): Promise<ProposeResult> {
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(periodMonth)) {
    return { ok: false, error: 'Choose a month to charge.' }
  }
  const period = monthStart(periodMonth.length === 7 ? `${periodMonth}-01` : periodMonth)

  const alreadyPosted = await siteQueryOne<Row>(
    siteId,
    "SELECT id FROM depreciation_runs WHERE period_month = ? AND status = 'posted' LIMIT 1",
    [period],
  )
  if (alreadyPosted) {
    return { ok: false, error: `${monthKey(period)} has already been charged.` }
  }

  const existingDraft = await siteQueryOne<Row>(
    siteId,
    "SELECT id FROM depreciation_runs WHERE status = 'draft' LIMIT 1",
    [],
  )
  if (existingDraft) {
    return {
      ok: false,
      error: 'There is already a draft run open. Post or discard it before starting another.',
    }
  }

  const assets = await listAssets(siteId, { limit: 2000 })
  if (assets.length === 0) {
    return { ok: false, error: 'There are no assets in the register.' }
  }

  const planned = assets.map((asset) => ({
    asset,
    charge: chargeFor(toDepreciable(asset), period),
  }))

  const total = planned.reduce((sum, p) => round(sum + p.charge.amount, 2), 0)
  const charged = planned.filter((p) => p.charge.amount > 0).length

  const runId = await siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO depreciation_runs
         (period_month, total_amount, asset_count, notes, user_id, user_name)
       VALUES (?,?,?,?,?,?)`,
      [
        period,
        total.toFixed(4),
        charged,
        notes?.trim() || null,
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )
    const id = (res as { insertId: number }).insertId

    for (const { asset, charge } of planned) {
      await tx.execute(
        `INSERT INTO depreciation_run_items
           (run_id, asset_id, asset_code, asset_name, cost, residual_value, life_months,
            opening_accumulated, amount, status, skip_reason)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          asset.id,
          asset.assetCode,
          asset.name,
          asset.cost.toFixed(4),
          asset.residualValue.toFixed(4),
          asset.lifeMonths,
          asset.accumulatedDepreciation.toFixed(4),
          charge.amount.toFixed(4),
          charge.amount > 0 ? 'pending' : 'skipped',
          charge.skipReason,
        ] as never,
      )
    }

    return id
  })

  return { ok: true, runId, charged, skipped: planned.length - charged, total }
}

/* ── Posting ─────────────────────────────────────────────────────────────── */

export type PostRunResult =
  | { ok: true; posted: number; total: number; batchId: number | null }
  | { ok: false; error: string }

/**
 * Charges the depreciation.
 *
 * ── ONE JOURNAL FOR THE WHOLE RUN ────────────────────────────────────────
 *
 * Not one per asset. Depreciation for a month is a single accounting event —
 * "March depreciation, R5 958" — and forty journals of R150 each would bury the
 * ledger for no gain. The run items carry the per-asset detail, which is where
 * anybody looking for it would go.
 *
 *   DEBIT  depreciation expense    per category
 *   CREDIT accumulated depreciation  per category
 *
 * Grouped by category because that is the granularity the accounts have:
 * vehicles and equipment depreciate to different balance sheet lines.
 *
 * The REGISTER moves first and is the source of truth; the ledger mirrors it.
 */
export async function postRun(
  siteId: number,
  actor: Actor,
  runId: number,
): Promise<PostRunResult> {
  const run = await getRun(siteId, runId)
  if (!run) return { ok: false, error: 'That run no longer exists.' }
  if (run.status === 'posted') return { ok: false, error: 'That run has already been charged.' }
  if (run.status === 'cancelled') return { ok: false, error: 'That run was cancelled.' }

  // Depreciation is dated the last day of the month it charges, which is where
  // a period lock would bite.
  const chargeDate = lastDayOfMonth(run.periodMonth)
  const locked = await guardPosting(siteId, chargeDate, 'ledger')
  if (locked) return { ok: false, error: locked }

  const items = (await listItems(siteId, runId)).filter((i) => i.status === 'pending')
  if (items.length === 0) return { ok: false, error: 'There is nothing to charge on this run.' }

  // Group by category for the journal, and collect the accounts as we go.
  const byCategory = new Map<number, { expenseAccountId: number | null; accumAccountId: number | null; amount: number }>()

  for (const item of items) {
    const asset = await siteQueryOne<Row>(
      siteId,
      'SELECT category_id FROM fixed_assets WHERE id = ? LIMIT 1',
      [item.assetId],
    )
    const categoryId = Number(asset?.category_id ?? 0)
    if (!categoryId) continue

    const existing = byCategory.get(categoryId)
    if (existing) {
      existing.amount = round(existing.amount + item.amount, 2)
    } else {
      const [expenseAccountId, accumAccountId] = await Promise.all([
        categoryAccount(siteId, categoryId, 'expense_account_id'),
        categoryAccount(siteId, categoryId, 'accum_account_id'),
      ])
      byCategory.set(categoryId, { expenseAccountId, accumAccountId, amount: item.amount })
    }
  }

  let posted = 0
  let total = 0

  // The register, first and authoritative.
  await siteTransaction(siteId, async (tx) => {
    for (const item of items) {
      await tx.execute(
        `UPDATE fixed_assets
            SET accumulated_depreciation = accumulated_depreciation + ?,
                last_depreciated_to = ?
          WHERE id = ?`,
        [item.amount.toFixed(4), run.periodMonth, item.assetId] as never,
      )
      await tx.execute(
        "UPDATE depreciation_run_items SET status = 'posted' WHERE id = ?",
        [item.id] as never,
      )
      posted++
      total = round(total + item.amount, 2)
    }

    await tx.execute(
      `UPDATE depreciation_runs
          SET status = 'posted', posted_at = NOW(), posted_count = ?, total_amount = ?
        WHERE id = ?`,
      [posted, total.toFixed(4), runId] as never,
    )

    await logActivityTx(tx, actor, {
      entity: 'gl',
      entityId: runId,
      action: 'depreciation_post',
      detail: `${monthKey(run.periodMonth)} depreciation — ${posted} asset${posted === 1 ? '' : 's'}, ${total.toFixed(2)}`,
    })
  })

  // The ledger, mirroring it. Cannot fail the run — see 045.
  let batchId: number | null = null
  try {
    const lines: JournalLineInput[] = []

    for (const [, group] of byCategory) {
      if (group.amount === 0) continue
      if (!group.expenseAccountId || !group.accumAccountId) {
        throw new Error('A category has no depreciation accounts mapped.')
      }
      lines.push({
        accountId: group.expenseAccountId,
        amount: group.amount,
        description: 'Depreciation',
      })
      lines.push({
        accountId: group.accumAccountId,
        amount: round(-group.amount, 2),
        description: 'Accumulated depreciation',
      })
    }

    if (lines.length > 0) {
      const journal = await siteTransaction(siteId, async (tx) =>
        postTx(tx, actor, {
          journalDate: chargeDate,
          description: `Depreciation for ${monthKey(run.periodMonth)}`,
          source: 'depreciation',
          sourceDocId: runId,
          lines,
        }),
      )
      batchId = journal.id
      await siteExecute(siteId, 'UPDATE depreciation_runs SET batch_id = ? WHERE id = ?', [
        journal.id,
        runId,
      ])
    }
  } catch (error) {
    await logActivity(siteId, actor, {
      entity: 'gl',
      entityId: runId,
      action: 'mirror_failed',
      detail: `Depreciation for ${monthKey(run.periodMonth)} did not reach the ledger — ${error instanceof Error ? error.message : 'unknown'}`,
    }).catch(() => undefined)
  }

  return { ok: true, posted, total, batchId }
}

export async function cancelRun(
  siteId: number,
  actor: Actor,
  runId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const run = await getRun(siteId, runId)
  if (!run) return { ok: false, error: 'That run no longer exists.' }
  if (run.status === 'posted') {
    return {
      ok: false,
      error: 'That run has been charged. Reverse its journal and adjust the register instead.',
    }
  }

  // Deleted rather than marked cancelled: the unique index on
  // (period_month, status) would otherwise block a fresh draft for the same
  // month, and a discarded proposal has nothing worth keeping.
  await siteExecute(siteId, 'DELETE FROM depreciation_runs WHERE id = ?', [runId])
  await logActivity(siteId, actor, {
    entity: 'gl',
    entityId: null,
    action: 'depreciation_cancel',
    detail: `Discarded the draft depreciation run for ${monthKey(run.periodMonth)}`,
  })
  return { ok: true }
}

/**
 * Removes one asset from a draft run.
 *
 * The commonest review action: an asset that should not have started
 * depreciating yet, or one about to be disposed of. Marking it skipped keeps it
 * visible with its reason rather than making it vanish.
 */
export async function excludeItem(
  siteId: number,
  actor: Actor,
  itemId: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const item = await siteQueryOne<Row>(
    siteId,
    `SELECT i.*, r.status AS run_status FROM depreciation_run_items i
       JOIN depreciation_runs r ON r.id = i.run_id WHERE i.id = ? LIMIT 1`,
    [itemId],
  )
  if (!item) return { ok: false, error: 'That line no longer exists.' }
  if (String(item.run_status) !== 'draft') {
    return { ok: false, error: 'That run is no longer a draft.' }
  }

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      "UPDATE depreciation_run_items SET status = 'skipped', skip_reason = ?, amount = 0 WHERE id = ?",
      [reason.trim().slice(0, 190) || 'Excluded during review', itemId] as never,
    )
    await tx.execute(
      `UPDATE depreciation_runs r
          SET r.total_amount = (SELECT COALESCE(SUM(amount), 0) FROM depreciation_run_items
                                 WHERE run_id = r.id AND status = 'pending'),
              r.asset_count = (SELECT COUNT(*) FROM depreciation_run_items
                                WHERE run_id = r.id AND status = 'pending')
        WHERE r.id = ?`,
      [Number(item.run_id)] as never,
    )
    await logActivityTx(tx, actor, {
      entity: 'gl',
      entityId: Number(item.asset_id),
      action: 'depreciation_excluded',
      detail: `${item.asset_code} excluded from a depreciation run — ${reason.trim() || 'no reason given'}`,
    })
  })

  return { ok: true }
}

/** The last day of the month a run charges — where the journal is dated. */
function lastDayOfMonth(periodMonth: string): string {
  const d = new Date(`${monthStart(periodMonth)}T00:00:00`)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`
}

export { lastDayOfMonth }
