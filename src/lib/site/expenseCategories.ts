import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { toNum } from '../decimals'
import { logActivity, type Actor } from './activityLog'
import {
  CATEGORY_TYPE_LABELS,
  CATEGORY_TYPES,
  type ExpenseCategoryType,
} from '../expenseModel'

/**
 * Expense categories — where money that is not stock goes.
 *
 * THIS IS THE SEED OF THE CHART OF ACCOUNTS. Every category carries an
 * `account_code` from the day it is created, even though there is no general
 * ledger yet: when one lands, these rows become its expense section and every
 * expense already posted has somewhere to go. Adding the code afterwards means
 * back-filling history by hand, which is the migration nobody finishes.
 *
 * A seed of twenty-odd categories ships in 042 so a store can capture its first
 * expense without designing a chart of accounts first — the task that stops
 * most people using an accounting system at all.
 */

export type ExpenseCategory = {
  id: number
  accountCode: string
  name: string
  parentId: number | null
  parentName: string | null
  categoryType: ExpenseCategoryType
  categoryTypeLabel: string
  defaultVatRateId: number | null
  defaultVatRatePct: number | null
  /** False where the VAT Act denies the input deduction — entertainment, salaries. */
  vatClaimable: boolean
  isActive: boolean
  sortOrder: number
  notes: string | null
  /** Spend in the period the caller asked about. Only set by listWithTotals. */
  periodTotal?: number
  /** How many expenses reference it — shown before offering to deactivate. */
  usageCount?: number
}

type Row = RowDataPacket & Record<string, unknown>

function mapCategory(r: Row): ExpenseCategory {
  const categoryType = String(r.category_type) as ExpenseCategoryType
  return {
    id: Number(r.id),
    accountCode: String(r.account_code),
    name: String(r.name),
    parentId: r.parent_id === null ? null : Number(r.parent_id),
    parentName: (r.parent_name as string | null) ?? null,
    categoryType,
    categoryTypeLabel: CATEGORY_TYPE_LABELS[categoryType] ?? categoryType,
    defaultVatRateId: r.default_vat_rate_id === null ? null : Number(r.default_vat_rate_id),
    defaultVatRatePct: r.default_vat_rate_pct === null ? null : toNum(r.default_vat_rate_pct),
    vatClaimable: Boolean(r.vat_claimable),
    isActive: Boolean(r.is_active),
    sortOrder: Number(r.sort_order),
    notes: (r.notes as string | null) ?? null,
  }
}

const SELECT_CATEGORY = `
  SELECT c.id, c.account_code, c.name, c.parent_id, c.category_type,
         c.default_vat_rate_id, c.vat_claimable, c.is_active, c.sort_order, c.notes,
         p.name AS parent_name,
         v.rate AS default_vat_rate_pct
    FROM expense_categories c
    LEFT JOIN expense_categories p ON p.id = c.parent_id
    LEFT JOIN vat_rates v          ON v.id = c.default_vat_rate_id
`

export async function listCategories(
  siteId: number,
  opts: { includeInactive?: boolean } = {},
): Promise<ExpenseCategory[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_CATEGORY}
      ${opts.includeInactive ? '' : 'WHERE c.is_active = TRUE'}
      ORDER BY c.sort_order, c.account_code`,
  )
  return rows.map(mapCategory)
}

export async function getCategory(siteId: number, id: number): Promise<ExpenseCategory | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_CATEGORY} WHERE c.id = ? LIMIT 1`, [id])
  return row ? mapCategory(row) : null
}

/**
 * Categories with what was spent on each in a period.
 *
 * The setup screen's real question is not "what categories exist" but "which
 * ones are actually used, and for how much" — a list of thirty categories where
 * four carry all the spend is telling you to tidy up.
 */
export async function listWithTotals(
  siteId: number,
  range: { from: string; to: string },
): Promise<ExpenseCategory[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_CATEGORY.replace('FROM expense_categories c', `FROM expense_categories c`)}
    `,
  ).catch(() => [] as Row[])

  const totals = await siteQuery<Row>(
    siteId,
    `SELECT l.category_id, COALESCE(SUM(l.line_excl), 0) AS total, COUNT(DISTINCT l.expense_id) AS n
       FROM expense_lines l
       JOIN expenses e ON e.id = l.expense_id
      WHERE e.status = 'finalised' AND e.expense_date BETWEEN ? AND ?
      GROUP BY l.category_id`,
    [range.from, range.to],
  )

  const byId = new Map<number, { total: number; count: number }>()
  for (const t of totals) {
    byId.set(Number(t.category_id), { total: toNum(t.total), count: Number(t.n) })
  }

  return rows.map((r) => {
    const category = mapCategory(r)
    const found = byId.get(category.id)
    return { ...category, periodTotal: found?.total ?? 0, usageCount: found?.count ?? 0 }
  })
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export type CategoryInput = {
  accountCode: string
  name: string
  parentId?: number | null
  categoryType?: ExpenseCategoryType
  defaultVatRateId?: number | null
  vatClaimable?: boolean
  sortOrder?: number
  notes?: string | null
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

export function validateCategory(input: CategoryInput): string | null {
  if (!input.accountCode?.trim()) return 'An account code is required.'
  if (input.accountCode.trim().length > 16) return 'That account code is too long.'
  if (!input.name?.trim()) return 'A name is required.'
  if (input.name.trim().length > 120) return 'That name is too long.'
  if (input.categoryType && !CATEGORY_TYPES.includes(input.categoryType)) {
    return 'That is not a valid category type.'
  }
  return null
}

export async function createCategory(
  siteId: number,
  actor: Actor,
  input: CategoryInput,
): Promise<SaveResult> {
  const invalid = validateCategory(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.accountCode.trim()
  const clash = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM expense_categories WHERE account_code = ? LIMIT 1',
    [code],
  )
  if (clash) return { ok: false, error: `Account code ${code} is already in use.` }

  const result = await siteExecute(
    siteId,
    `INSERT INTO expense_categories
       (account_code, name, parent_id, category_type, default_vat_rate_id,
        vat_claimable, sort_order, notes)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      code,
      input.name.trim(),
      input.parentId ?? null,
      input.categoryType ?? 'operating',
      input.defaultVatRateId ?? null,
      input.vatClaimable ?? true,
      input.sortOrder ?? 500,
      input.notes?.trim() || null,
    ],
  )

  await logActivity(siteId, actor, {
    entity: 'expense',
    entityId: result.insertId,
    action: 'category_create',
    detail: `Created expense category ${code} — ${input.name.trim()}`,
  })

  return { ok: true, id: result.insertId }
}

export async function updateCategory(
  siteId: number,
  actor: Actor,
  id: number,
  input: CategoryInput,
): Promise<SaveResult> {
  const invalid = validateCategory(input)
  if (invalid) return { ok: false, error: invalid }

  const existing = await getCategory(siteId, id)
  if (!existing) return { ok: false, error: 'That category no longer exists.' }

  const code = input.accountCode.trim()
  const clash = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM expense_categories WHERE account_code = ? AND id <> ? LIMIT 1',
    [code, id],
  )
  if (clash) return { ok: false, error: `Account code ${code} is already in use.` }

  // A category that is its own ancestor makes the tree infinite and every
  // recursive report hang. Only the direct case can happen through the form,
  // but the check is cheap.
  if (input.parentId === id) return { ok: false, error: 'A category cannot be its own parent.' }

  await siteExecute(
    siteId,
    `UPDATE expense_categories
        SET account_code = ?, name = ?, parent_id = ?, category_type = ?,
            default_vat_rate_id = ?, vat_claimable = ?, sort_order = ?, notes = ?
      WHERE id = ?`,
    [
      code,
      input.name.trim(),
      input.parentId ?? null,
      input.categoryType ?? existing.categoryType,
      input.defaultVatRateId ?? null,
      input.vatClaimable ?? true,
      input.sortOrder ?? existing.sortOrder,
      input.notes?.trim() || null,
      id,
    ],
  )

  await logActivity(siteId, actor, {
    entity: 'expense',
    entityId: id,
    action: 'category_update',
    detail: `Updated expense category ${code}`,
  })

  return { ok: true, id }
}

/**
 * Deactivates a category. Never deletes one that has been used.
 *
 * The FK from expense_lines is RESTRICT, so history cannot be orphaned; this
 * hides it from pickers while leaving every figure that depended on it intact.
 * Same rule as closing a bank account.
 */
export async function setCategoryActive(
  siteId: number,
  actor: Actor,
  id: number,
  active: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const category = await getCategory(siteId, id)
  if (!category) return { ok: false, error: 'That category no longer exists.' }

  await siteExecute(siteId, 'UPDATE expense_categories SET is_active = ? WHERE id = ?', [
    active,
    id,
  ])
  await logActivity(siteId, actor, {
    entity: 'expense',
    entityId: id,
    action: active ? 'category_activate' : 'category_deactivate',
    detail: `${active ? 'Reactivated' : 'Deactivated'} expense category ${category.accountCode} — ${category.name}`,
  })
  return { ok: true }
}

/**
 * Deletes a category that has never been used.
 *
 * Allowed only when nothing points at it: the seed ships twenty-odd categories
 * and a store that will never have a vehicle should be able to remove that row
 * rather than look at it for ever. Once used, deactivation is the only option.
 */
export async function deleteCategory(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const category = await getCategory(siteId, id)
  if (!category) return { ok: false, error: 'That category no longer exists.' }

  const [used, hasChildren, inTemplate] = await Promise.all([
    siteQueryOne<Row>(siteId, 'SELECT id FROM expense_lines WHERE category_id = ? LIMIT 1', [id]),
    siteQueryOne<Row>(siteId, 'SELECT id FROM expense_categories WHERE parent_id = ? LIMIT 1', [id]),
    siteQueryOne<Row>(
      siteId,
      'SELECT id FROM recurring_expense_lines WHERE category_id = ? LIMIT 1',
      [id],
    ),
  ])

  if (used) {
    return {
      ok: false,
      error: 'Expenses have been booked to that category. Deactivate it instead — the history must stay.',
    }
  }
  if (hasChildren) return { ok: false, error: 'That category has sub-categories under it.' }
  if (inTemplate) return { ok: false, error: 'A recurring expense uses that category.' }

  await siteExecute(siteId, 'DELETE FROM expense_categories WHERE id = ?', [id])
  await logActivity(siteId, actor, {
    entity: 'expense',
    entityId: null,
    action: 'category_delete',
    detail: `Deleted unused expense category ${category.accountCode} — ${category.name}`,
  })
  return { ok: true }
}

export { CATEGORY_TYPES, CATEGORY_TYPE_LABELS }
export type { ExpenseCategoryType }
