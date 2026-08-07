import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { nextDocumentNumber } from './sequences'
import { guardPosting } from './periodLocks'
import { postTx } from './journals'
import { resolveAccount } from './chartOfAccounts'
import { today } from './ledger'
import {
  bookValue,
  disposalResult,
  refuseAsset,
  schedule,
  type AssetStatus,
  type DepreciableAsset,
} from '../assetModel'

/**
 * The fixed asset register.
 *
 * ── WHY AN ASSET IS NOT AN EXPENSE ───────────────────────────────────────
 *
 * A laptop bought for R24 000 is not a R24 000 cost in the month it was
 * bought — it is a thing the business owns, which becomes a cost over the
 * three years it is used. 042 already keeps capital spending out of the profit
 * and loss for that reason; this is the other half, the asset itself and the
 * depreciation that turns it into a cost slowly.
 *
 * ── THE REGISTER OWNS accumulated_depreciation ───────────────────────────
 *
 * Same rule as every other subledger here. The register is the source of
 * truth, the GL mirrors it, and reconcileAssets() proves they agree. Nothing
 * else writes that column — the depreciation run does, in the same transaction
 * as the item that explains it.
 */

export type FixedAsset = {
  id: number
  assetCode: string
  name: string
  description: string | null
  categoryId: number
  categoryName?: string | null
  serialNumber: string | null
  location: string | null
  status: AssetStatus
  acquiredOn: string
  cost: number
  residualValue: number
  lifeMonths: number
  depreciationStart: string
  accumulatedDepreciation: number
  lastDepreciatedTo: string | null
  /** Cost less accumulated — what it is carried at. */
  bookValue: number
  /** True once it has depreciated down to its residual. */
  fullyDepreciated: boolean
  expenseId: number | null
  supplierId: number | null
  supplierName?: string | null
  invoiceNumber: string | null
  disposedOn: string | null
  disposalProceeds: number | null
  disposalResult: number | null
  disposalReason: string | null
  notes: string | null
  userName: string
  createdAt: Date
}

type Row = RowDataPacket & Record<string, unknown>

function mapAsset(r: Row): FixedAsset {
  const cost = toNum(r.cost)
  const accumulated = toNum(r.accumulated_depreciation)
  const residual = toNum(r.residual_value)

  return {
    id: Number(r.id),
    assetCode: String(r.asset_code),
    name: String(r.name),
    description: (r.description as string | null) ?? null,
    categoryId: Number(r.category_id),
    categoryName: (r.category_name as string | null) ?? null,
    serialNumber: (r.serial_number as string | null) ?? null,
    location: (r.location as string | null) ?? null,
    status: String(r.status) as AssetStatus,
    acquiredOn: String(r.acquired_on),
    cost,
    residualValue: residual,
    lifeMonths: Number(r.life_months),
    depreciationStart: String(r.depreciation_start),
    accumulatedDepreciation: accumulated,
    lastDepreciatedTo: r.last_depreciated_to === null ? null : String(r.last_depreciated_to),
    bookValue: bookValue(cost, accumulated),
    fullyDepreciated: round(cost - accumulated, 2) <= round(residual, 2),
    expenseId: r.expense_id === null ? null : Number(r.expense_id),
    supplierId: r.supplier_id === null ? null : Number(r.supplier_id),
    supplierName: (r.supplier_name as string | null) ?? null,
    invoiceNumber: (r.invoice_number as string | null) ?? null,
    disposedOn: r.disposed_on === null ? null : String(r.disposed_on),
    disposalProceeds: r.disposal_proceeds === null ? null : toNum(r.disposal_proceeds),
    disposalResult: r.disposal_result === null ? null : toNum(r.disposal_result),
    disposalReason: (r.disposal_reason as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
  }
}

const SELECT_ASSET = `
  SELECT a.*, c.name AS category_name, s.name AS supplier_name
    FROM fixed_assets a
    LEFT JOIN asset_categories c ON c.id = a.category_id
    LEFT JOIN suppliers s        ON s.id = a.supplier_id
`

/* ── Categories ──────────────────────────────────────────────────────────── */

export type AssetCategory = {
  id: number
  name: string
  code: string | null
  defaultLifeMonths: number
  defaultResidualPct: number
  costAccountId: number | null
  accumAccountId: number | null
  expenseAccountId: number | null
  isActive: boolean
  /** How many assets are in it, and what they are carried at. */
  assetCount?: number
  bookValue?: number
}

export async function listCategories(siteId: number): Promise<AssetCategory[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT c.*,
            (SELECT COUNT(*) FROM fixed_assets a
              WHERE a.category_id = c.id AND a.status <> 'disposed') AS asset_count,
            (SELECT COALESCE(SUM(a.cost - a.accumulated_depreciation), 0) FROM fixed_assets a
              WHERE a.category_id = c.id AND a.status <> 'disposed') AS book_value
       FROM asset_categories c
      WHERE c.is_active = TRUE
      ORDER BY c.sort_order, c.name`,
  )

  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    code: (r.code as string | null) ?? null,
    defaultLifeMonths: Number(r.default_life_months),
    defaultResidualPct: toNum(r.default_residual_pct),
    costAccountId: r.cost_account_id === null ? null : Number(r.cost_account_id),
    accumAccountId: r.accum_account_id === null ? null : Number(r.accum_account_id),
    expenseAccountId: r.expense_account_id === null ? null : Number(r.expense_account_id),
    isActive: Boolean(r.is_active),
    assetCount: Number(r.asset_count ?? 0),
    bookValue: toNum(r.book_value),
  }))
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

export type AssetListOptions = {
  status?: AssetStatus
  categoryId?: number
  search?: string
  limit?: number
}

export async function listAssets(
  siteId: number,
  opts: AssetListOptions = {},
): Promise<FixedAsset[]> {
  const where: string[] = []
  const params: unknown[] = []

  if (opts.status) {
    where.push('a.status = ?')
    params.push(opts.status)
  } else {
    // A disposed asset is history. It stays findable by filter, but the
    // register is a list of what the business currently owns.
    where.push("a.status <> 'disposed'")
  }
  if (opts.categoryId) {
    where.push('a.category_id = ?')
    params.push(opts.categoryId)
  }
  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`
    where.push('(a.name LIKE ? OR a.asset_code LIKE ? OR a.serial_number LIKE ? OR a.location LIKE ?)')
    params.push(term, term, term, term)
  }

  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 2000)
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_ASSET}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.asset_code
      LIMIT ${limit}`,
    params,
  )
  return rows.map(mapAsset)
}

export async function getAsset(siteId: number, id: number): Promise<FixedAsset | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_ASSET} WHERE a.id = ? LIMIT 1`, [id])
  return row ? mapAsset(row) : null
}

/** The month-by-month life of one asset, for its detail screen. */
export async function assetSchedule(siteId: number, id: number) {
  const asset = await getAsset(siteId, id)
  if (!asset) return []
  return schedule(toDepreciable(asset))
}

export function toDepreciable(asset: FixedAsset): DepreciableAsset {
  return {
    id: asset.id,
    status: asset.status,
    cost: asset.cost,
    residualValue: asset.residualValue,
    lifeMonths: asset.lifeMonths,
    depreciationStart: asset.depreciationStart,
    accumulatedDepreciation: asset.accumulatedDepreciation,
    lastDepreciatedTo: asset.lastDepreciatedTo,
    disposedOn: asset.disposedOn,
  }
}

export type AssetSummary = {
  count: number
  totalCost: number
  totalAccumulated: number
  totalBookValue: number
  /** Assets that have reached their residual and stopped depreciating. */
  fullyDepreciatedCount: number
  /** Recorded but not yet in use, so contributing nothing to the P&L. */
  pendingCount: number
  disposedThisYear: number
}

export async function assetSummary(siteId: number): Promise<AssetSummary> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT
       COUNT(CASE WHEN status <> 'disposed' THEN 1 END) AS n,
       COALESCE(SUM(CASE WHEN status <> 'disposed' THEN cost END), 0) AS total_cost,
       COALESCE(SUM(CASE WHEN status <> 'disposed' THEN accumulated_depreciation END), 0) AS total_accum,
       COUNT(CASE WHEN status = 'active'
                   AND cost - accumulated_depreciation <= residual_value + 0.004 THEN 1 END) AS fully_n,
       COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending_n,
       COUNT(CASE WHEN status = 'disposed' AND disposed_on >= ? THEN 1 END) AS disposed_n
     FROM fixed_assets`,
    [`${today().slice(0, 4)}-01-01`],
  )

  const totalCost = toNum(row?.total_cost)
  const totalAccumulated = toNum(row?.total_accum)

  return {
    count: Number(row?.n ?? 0),
    totalCost,
    totalAccumulated,
    totalBookValue: round(totalCost - totalAccumulated, 2),
    fullyDepreciatedCount: Number(row?.fully_n ?? 0),
    pendingCount: Number(row?.pending_n ?? 0),
    disposedThisYear: Number(row?.disposed_n ?? 0),
  }
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export type AssetInput = {
  name: string
  description?: string | null
  categoryId: number
  serialNumber?: string | null
  location?: string | null
  status?: AssetStatus
  acquiredOn: string
  cost: number
  residualValue?: number
  lifeMonths: number
  depreciationStart?: string
  expenseId?: number | null
  supplierId?: number | null
  invoiceNumber?: string | null
  notes?: string | null
}

export type SaveResult = { ok: true; id: number; assetCode: string } | { ok: false; error: string }

/**
 * Adds an asset to the register.
 *
 * Does NOT post a journal. The asset almost always arrives from a capital
 * expense that has already debited the asset account — posting again here would
 * double the cost on the balance sheet. Where an asset is recorded with no
 * expense behind it (an opening register, an owner's contribution), the
 * balancing entry is a manual journal, which is a deliberate decision rather
 * than something to guess at.
 */
export async function createAsset(
  siteId: number,
  actor: Actor,
  input: AssetInput,
): Promise<SaveResult> {
  const refusal = refuseAsset(input)
  if (refusal) return { ok: false, error: refusal }

  const category = await siteQueryOne<Row>(
    siteId,
    'SELECT id, name FROM asset_categories WHERE id = ? LIMIT 1',
    [input.categoryId],
  )
  if (!category) return { ok: false, error: 'Choose a category for the asset.' }

  const depreciationStart = input.depreciationStart ?? input.acquiredOn

  return siteTransaction(siteId, async (tx) => {
    const assetCode = await nextDocumentNumber(tx, 'asset')

    const [res] = await tx.execute(
      `INSERT INTO fixed_assets
         (asset_code, name, description, category_id, serial_number, location, status,
          acquired_on, cost, residual_value, life_months, depreciation_start,
          expense_id, supplier_id, invoice_number, notes, user_id, user_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        assetCode,
        input.name.trim(),
        input.description?.trim() || null,
        input.categoryId,
        input.serialNumber?.trim() || null,
        input.location?.trim() || null,
        input.status ?? 'active',
        input.acquiredOn,
        round(input.cost, 2).toFixed(4),
        round(input.residualValue ?? 0, 2).toFixed(4),
        input.lifeMonths,
        depreciationStart,
        input.expenseId ?? null,
        input.supplierId ?? null,
        input.invoiceNumber?.trim() || null,
        input.notes?.trim() || null,
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )
    const id = (res as { insertId: number }).insertId

    await logActivityTx(tx, actor, {
      entity: 'gl',
      entityId: id,
      action: 'asset_create',
      detail: `${assetCode} · ${input.name.trim()} · ${round(input.cost, 2).toFixed(2)}`,
    })

    return { ok: true as const, id, assetCode }
  })
}

export async function updateAsset(
  siteId: number,
  actor: Actor,
  id: number,
  input: AssetInput,
): Promise<SaveResult> {
  const refusal = refuseAsset(input)
  if (refusal) return { ok: false, error: refusal }

  const existing = await getAsset(siteId, id)
  if (!existing) return { ok: false, error: 'That asset no longer exists.' }
  if (existing.status === 'disposed') {
    return { ok: false, error: 'A disposed asset is a record of what happened and cannot be edited.' }
  }

  // Changing the cost of an asset that has already depreciated would leave the
  // register and the ledger disagreeing about what was capitalised, and every
  // charge already posted would have been computed on a figure that no longer
  // exists.
  if (
    existing.accumulatedDepreciation > 0 &&
    round(input.cost, 2) !== round(existing.cost, 2)
  ) {
    return {
      ok: false,
      error: `${existing.assetCode} has already depreciated ${existing.accumulatedDepreciation.toFixed(2)}. Its cost cannot change — dispose of it and record the correct asset, so both are on the trail.`,
    }
  }

  // The residual may not drop below what is already written off, or the asset
  // is instantly over-depreciated.
  const alreadyBelow = round(existing.cost - existing.accumulatedDepreciation, 2)
  if (round(input.residualValue ?? 0, 2) > alreadyBelow) {
    return {
      ok: false,
      error: `That residual is above the current book value of ${alreadyBelow.toFixed(2)} — the asset would have been over-depreciated.`,
    }
  }

  await siteExecute(
    siteId,
    `UPDATE fixed_assets
        SET name = ?, description = ?, category_id = ?, serial_number = ?, location = ?,
            status = ?, acquired_on = ?, cost = ?, residual_value = ?, life_months = ?,
            depreciation_start = ?, supplier_id = ?, invoice_number = ?, notes = ?
      WHERE id = ?`,
    [
      input.name.trim(),
      input.description?.trim() || null,
      input.categoryId,
      input.serialNumber?.trim() || null,
      input.location?.trim() || null,
      input.status ?? existing.status,
      input.acquiredOn,
      round(input.cost, 2).toFixed(4),
      round(input.residualValue ?? 0, 2).toFixed(4),
      input.lifeMonths,
      input.depreciationStart ?? existing.depreciationStart,
      input.supplierId ?? null,
      input.invoiceNumber?.trim() || null,
      input.notes?.trim() || null,
      id,
    ],
  )

  await logActivity(siteId, actor, {
    entity: 'gl',
    entityId: id,
    action: 'asset_update',
    detail: `Updated ${existing.assetCode} — ${input.name.trim()}`,
  })

  return { ok: true, id, assetCode: existing.assetCode }
}

/* ── Acquiring from an expense ───────────────────────────────────────────── */

export type FromExpenseResult =
  | { ok: true; created: { id: number; assetCode: string; name: string }[] }
  | { ok: false; error: string }

/**
 * Turns a capital expense into assets.
 *
 * A capital expense has already debited an asset account — 042 types those
 * categories 'capital' and 045 maps them to 1500/1600 — so the money is on the
 * balance sheet correctly. What is missing is the REGISTER entry: the thing
 * itself, with a life, so it can start depreciating.
 *
 * One asset per line, because a slip covering a laptop and a printer is two
 * assets with two lives even though it is one invoice.
 */
export async function createFromExpense(
  siteId: number,
  actor: Actor,
  expenseId: number,
  overrides: {
    lineId: number
    name: string
    categoryId: number
    lifeMonths?: number
    residualValue?: number
    serialNumber?: string | null
  }[],
): Promise<FromExpenseResult> {
  const { getExpense } = await import('./expenses')
  const expense = await getExpense(siteId, expenseId)
  if (!expense) return { ok: false, error: 'That expense no longer exists.' }
  if (expense.status !== 'finalised') {
    return { ok: false, error: 'Only a posted expense can become an asset.' }
  }

  const existing = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM fixed_assets WHERE expense_id = ? LIMIT 1',
    [expenseId],
  )
  if (existing) {
    return { ok: false, error: 'That expense has already been recorded as an asset.' }
  }

  const categories = await listCategories(siteId)
  const created: { id: number; assetCode: string; name: string }[] = []

  for (const override of overrides) {
    const line = expense.lines.find((l) => l.id === override.lineId)
    if (!line) continue

    const category = categories.find((c) => c.id === override.categoryId)

    const result = await createAsset(siteId, actor, {
      name: override.name.trim() || line.description || expense.description || 'Asset',
      categoryId: override.categoryId,
      serialNumber: override.serialNumber,
      // The expense line's EXCLUSIVE figure: reclaimed VAT was never a cost, so
      // capitalising it would overstate the asset and every charge off it.
      cost: line.lineExcl,
      residualValue:
        override.residualValue ??
        round((line.lineExcl * (category?.defaultResidualPct ?? 0)) / 100, 2),
      lifeMonths: override.lifeMonths ?? category?.defaultLifeMonths ?? 36,
      acquiredOn: expense.expenseDate,
      depreciationStart: expense.expenseDate,
      expenseId,
      supplierId: expense.supplierId,
      invoiceNumber: expense.supplierInvoiceNo,
    })

    if (result.ok) {
      created.push({ id: result.id, assetCode: result.assetCode, name: override.name })
    }
  }

  if (created.length === 0) {
    return { ok: false, error: 'No assets could be created from that expense.' }
  }

  return { ok: true, created }
}

/** Capital expenses that have not yet been recorded as assets. */
export async function unregisteredCapitalExpenses(
  siteId: number,
  limit = 50,
): Promise<
  { expenseId: number; documentNumber: string | null; expenseDate: string; supplierName: string | null; total: number }[]
> {
  const capped = Math.min(Math.max(limit, 1), 200)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT e.id, e.document_number, e.expense_date, e.supplier_name,
            COALESCE(SUM(l.line_excl), 0) AS total
       FROM expenses e
       JOIN expense_lines l      ON l.expense_id = e.id
       JOIN expense_categories c ON c.id = l.category_id
      WHERE e.status = 'finalised'
        AND c.category_type = 'capital'
        AND NOT EXISTS (SELECT 1 FROM fixed_assets a WHERE a.expense_id = e.id)
      GROUP BY e.id, e.document_number, e.expense_date, e.supplier_name
      ORDER BY e.expense_date DESC
      LIMIT ${capped}`,
  ).catch(() => [] as Row[])

  return rows.map((r) => ({
    expenseId: Number(r.id),
    documentNumber: (r.document_number as string | null) ?? null,
    expenseDate: String(r.expense_date),
    supplierName: (r.supplier_name as string | null) ?? null,
    total: toNum(r.total),
  }))
}

/* ── Disposal ────────────────────────────────────────────────────────────── */

export type DisposeResult =
  | { ok: true; bookValue: number; result: number; batchId: number | null }
  | { ok: false; error: string }

/**
 * Disposing of an asset — sold, scrapped or written off.
 *
 * ── THE JOURNAL, AND WHY IT HAS FOUR LEGS ────────────────────────────────
 *
 *   CREDIT cost                  remove the asset at what it cost
 *   DEBIT  accumulated           remove the depreciation charged against it
 *   DEBIT  bank                  whatever it sold for
 *   DEBIT/CREDIT profit or loss  the balancing figure
 *
 * The first two together strip the asset off the balance sheet at its book
 * value. The difference between that and the proceeds is a profit or a loss,
 * and it is ordinary either way — a vehicle depreciated over five years
 * usually sells for more than book value, because straight line is a
 * convention rather than a valuation.
 */
export async function disposeAsset(
  siteId: number,
  actor: Actor,
  id: number,
  input: {
    disposedOn: string
    proceeds: number
    reason: string
    /** Where the money landed. Omit for something scrapped. */
    bankAccountId?: number | null
  },
): Promise<DisposeResult> {
  if (!input.reason?.trim()) return { ok: false, error: 'Give a reason for the disposal.' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.disposedOn)) {
    return { ok: false, error: 'Choose a disposal date.' }
  }
  if ((input.proceeds ?? 0) < 0) return { ok: false, error: 'Proceeds cannot be negative.' }

  const asset = await getAsset(siteId, id)
  if (!asset) return { ok: false, error: 'That asset no longer exists.' }
  if (asset.status === 'disposed') return { ok: false, error: 'That asset is already disposed.' }
  if (input.disposedOn < asset.acquiredOn) {
    return { ok: false, error: 'It cannot be disposed of before it was acquired.' }
  }

  const locked = await guardPosting(siteId, input.disposedOn, 'ledger')
  if (locked) return { ok: false, error: locked }

  const proceeds = round(input.proceeds ?? 0, 2)
  const outcome = disposalResult(asset.cost, asset.accumulatedDepreciation, proceeds)

  // The register moves first and is the source of truth; the ledger mirrors it.
  await siteExecute(
    siteId,
    `UPDATE fixed_assets
        SET status = 'disposed', disposed_on = ?, disposal_proceeds = ?,
            disposal_result = ?, disposal_reason = ?
      WHERE id = ?`,
    [
      input.disposedOn,
      proceeds.toFixed(4),
      outcome.result.toFixed(4),
      input.reason.trim().slice(0, 400),
      id,
    ],
  )

  let batchId: number | null = null

  try {
    const [costAccount, accumAccount, disposalAccount, bankAccount] = await Promise.all([
      categoryAccount(siteId, asset.categoryId, 'cost_account_id'),
      categoryAccount(siteId, asset.categoryId, 'accum_account_id'),
      resolveAccount(siteId, 'asset_disposal'),
      resolveAccount(siteId, 'bank_account', input.bankAccountId),
    ])

    if (costAccount && accumAccount && disposalAccount) {
      const lines = [
        { accountId: costAccount, amount: round(-asset.cost, 2), description: 'Asset removed at cost' },
      ]

      if (asset.accumulatedDepreciation !== 0) {
        lines.push({
          accountId: accumAccount,
          amount: round(asset.accumulatedDepreciation, 2),
          description: 'Accumulated depreciation removed',
        })
      }

      if (proceeds !== 0 && bankAccount) {
        lines.push({ accountId: bankAccount, amount: proceeds, description: 'Proceeds on disposal' })
      }

      // The balancing figure. Negative amount = credit = a profit on sale.
      if (outcome.result !== 0) {
        lines.push({
          accountId: disposalAccount,
          amount: round(-outcome.result, 2),
          description: outcome.isProfit ? 'Profit on disposal' : 'Loss on disposal',
        })
      }

      const posted = await siteTransaction(siteId, async (tx) =>
        postTx(tx, actor, {
          journalDate: input.disposedOn,
          description: `Disposal of ${asset.assetCode} — ${asset.name}`,
          source: 'asset_disposal',
          sourceDocId: id,
          lines,
        }),
      )
      batchId = posted.id
    }
  } catch {
    // The GL is a derived mirror: a missing journal is a reporting gap that
    // ledgerHealth() reports, not a reason to un-dispose an asset that has
    // already been sold. See 045.
  }

  await logActivity(siteId, actor, {
    entity: 'gl',
    entityId: id,
    action: 'asset_dispose',
    detail: `${asset.assetCode} disposed for ${proceeds.toFixed(2)} · book ${outcome.bookValue.toFixed(2)} · ${outcome.isProfit ? 'profit' : 'loss'} ${Math.abs(outcome.result).toFixed(2)} — ${input.reason.trim()}`,
  })

  return { ok: true, bookValue: outcome.bookValue, result: outcome.result, batchId }
}

async function categoryAccount(
  siteId: number,
  categoryId: number,
  column: 'cost_account_id' | 'accum_account_id' | 'expense_account_id',
): Promise<number | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT ${column} AS account_id FROM asset_categories WHERE id = ? LIMIT 1`,
    [categoryId],
  )
  return row?.account_id === null || row?.account_id === undefined ? null : Number(row.account_id)
}

/* ── Reconciliation ──────────────────────────────────────────────────────── */

export type AssetDrift = {
  id: number
  assetCode: string
  name: string
  stored: number
  computed: number
  drift: number
}

/**
 * Assets whose accumulated depreciation disagrees with the runs that produced
 * it.
 *
 * The register's own version of reconcileBalances(). Reports rather than
 * repairs, for the same reason: silently correcting a drift hides the bug.
 */
export async function reconcileAssets(siteId: number): Promise<AssetDrift[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT a.id, a.asset_code, a.name,
            a.accumulated_depreciation AS stored,
            COALESCE(i.total, 0) AS computed,
            a.accumulated_depreciation - COALESCE(i.total, 0) AS drift
       FROM fixed_assets a
       LEFT JOIN (
             SELECT it.asset_id, SUM(it.amount) AS total
               FROM depreciation_run_items it
               JOIN depreciation_runs r ON r.id = it.run_id
              WHERE it.status = 'posted' AND r.status = 'posted'
              GROUP BY it.asset_id
            ) i ON i.asset_id = a.id
      WHERE ABS(a.accumulated_depreciation - COALESCE(i.total, 0)) > 0.0001
      ORDER BY ABS(a.accumulated_depreciation - COALESCE(i.total, 0)) DESC`,
  )

  return rows.map((r) => ({
    id: Number(r.id),
    assetCode: String(r.asset_code),
    name: String(r.name),
    stored: toNum(r.stored),
    computed: toNum(r.computed),
    drift: toNum(r.drift),
  }))
}

export { categoryAccount }
export type { AssetStatus }
