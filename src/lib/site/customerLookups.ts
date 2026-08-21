import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQuery, siteQueryOne } from '../siteDb'
import { customerExecute, customerQuery, customerQueryOne, supplierQuery } from './customerDb'
import { toNum } from '../decimals'
import { toStatementCycle, type StatementCycle } from '../statementCycles'

/**
 * The customer master file's supporting lists — groups, reps and categories.
 *
 * Groups and reps are tables because they carry behaviour: a group holds the
 * terms a new account inherits, a rep holds an email statements copy in.
 * Category is a plain indexed string on the customer with a DISTINCT picker,
 * because it carries none — a lookup table for a field nothing branches on is
 * ceremony.
 */

type Row = RowDataPacket & Record<string, unknown>

/* ── Groups ──────────────────────────────────────────────────────────────── */

export type CustomerGroup = {
  id: number
  name: string
  code: string | null
  defaultTermsDays: number
  defaultCreditLimit: number
  /** Spend caps seeded onto a new account. Zero means no cap — see 175. */
  defaultDailyLimit: number
  defaultMonthlyLimit: number
  /**
   * The group's standing discount, resolved LIVE rather than seeded.
   *
   * Null means the group grants none, and an account whose own discount is
   * also null then has none. Unlike the credit defaults above, changing this
   * moves every account in the group that has not set its own — it is the
   * other half of `priceStructureId`, and both answer "what does this group
   * pay". See the header of 176.
   */
  defaultDiscountPct: number | null
  /** Interest defaults inherited by accounts in this group that set none of their own. */
  defaultInterestRatePct: number
  defaultInterestEnabled: boolean
  defaultInterestGraceDays: number
  /** Statement cycle a new account in this group starts on. */
  defaultStatementCycle: StatementCycle
  defaultStatementAnchorDay: number
  priceStructureId: number | null
  sortOrder: number
  isActive: boolean
  /** Accounts currently in this group — shown before offering to delete it. */
  customerCount: number
}

function mapGroup(r: Row): CustomerGroup {
  return {
    id: Number(r.id),
    name: String(r.name),
    code: (r.code as string | null) ?? null,
    defaultTermsDays: Number(r.default_terms_days),
    defaultCreditLimit: toNum(r.default_credit_limit),
    defaultDailyLimit: toNum(r.default_daily_limit),
    defaultMonthlyLimit: toNum(r.default_monthly_limit),
    // Null survives rather than collapsing to 0 — they are different claims.
    defaultDiscountPct:
      r.default_discount_pct === null || r.default_discount_pct === undefined
        ? null
        : toNum(r.default_discount_pct),
    defaultInterestRatePct: toNum(r.default_interest_rate_pct),
    defaultInterestEnabled: Boolean(r.default_interest_enabled),
    defaultInterestGraceDays: Number(r.default_interest_grace_days ?? 0),
    defaultStatementCycle: toStatementCycle(r.default_statement_cycle),
    defaultStatementAnchorDay: Number(r.default_statement_anchor_day ?? 0),
    priceStructureId: r.price_structure_id === null ? null : Number(r.price_structure_id),
    sortOrder: Number(r.sort_order),
    isActive: !!r.is_active,
    customerCount: Number(r.customer_count ?? 0),
  }
}

const SELECT_GROUP = `
  SELECT g.id, g.name, g.code, g.default_terms_days, g.default_credit_limit,
         g.default_daily_limit, g.default_monthly_limit, g.default_discount_pct,
         g.default_interest_rate_pct, g.default_interest_enabled, g.default_interest_grace_days,
         g.default_statement_cycle, g.default_statement_anchor_day,
         g.price_structure_id, g.sort_order, g.is_active,
         (SELECT COUNT(*) FROM customers c WHERE c.group_id = g.id) AS customer_count
    FROM customer_groups g
`

export async function listCustomerGroups(
  siteId: number,
  includeInactive = false,
): Promise<CustomerGroup[]> {
  const rows = await customerQuery<Row>(
    siteId,
    `${SELECT_GROUP}
      ${includeInactive ? '' : 'WHERE g.is_active = 1'}
      ORDER BY g.sort_order ASC, g.name ASC`,
  )
  return rows.map(mapGroup)
}

export async function getCustomerGroup(siteId: number, id: number): Promise<CustomerGroup | null> {
  const row = await customerQueryOne<Row>(siteId, `${SELECT_GROUP} WHERE g.id = ? LIMIT 1`, [id])
  return row ? mapGroup(row) : null
}

export type GroupInput = {
  name: string
  code?: string | null
  defaultTermsDays?: number
  defaultCreditLimit?: number
  /** Spend caps seeded onto a new account. Zero means no cap. */
  defaultDailyLimit?: number
  defaultMonthlyLimit?: number
  /** Live-resolved standing discount. Null = the group grants none. */
  defaultDiscountPct?: number | null
  /**
   * The interest and statement-cycle defaults.
   *
   * These columns have existed since 037 and 065 and are READ everywhere — the
   * customer form falls back to them, and its hints quote them at the user —
   * but until the setup screen landed there was no write path, so nothing could
   * ever set them off their column defaults. Adding them here rather than in a
   * second update function: a partial save that silently drops half an
   * aggregate is the failure mode this codebase has been bitten by before.
   */
  defaultInterestRatePct?: number
  defaultInterestEnabled?: boolean
  defaultInterestGraceDays?: number
  defaultStatementCycle?: StatementCycle
  defaultStatementAnchorDay?: number
  priceStructureId?: number | null
  sortOrder?: number
  isActive?: boolean
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

export function validateGroup(input: GroupInput): string | null {
  if (!input.name?.trim()) return 'A group name is required.'
  if (input.name.trim().length > 120) return 'Name must be 120 characters or fewer.'
  if ((input.defaultTermsDays ?? 0) < 0 || (input.defaultTermsDays ?? 0) > 365) {
    return 'Payment terms must be between 0 and 365 days.'
  }
  if ((input.defaultCreditLimit ?? 0) < 0) return 'Credit limit cannot be negative.'
  if ((input.defaultDailyLimit ?? 0) < 0) return 'A daily limit cannot be negative.'
  if ((input.defaultMonthlyLimit ?? 0) < 0) return 'A monthly limit cannot be negative.'
  // A daily cap above the monthly one can never bind — the same check the
  // account itself applies, so a group cannot seed a combination the account
  // would refuse the moment somebody opened it.
  if (
    (input.defaultDailyLimit ?? 0) > 0 &&
    (input.defaultMonthlyLimit ?? 0) > 0 &&
    (input.defaultDailyLimit ?? 0) > (input.defaultMonthlyLimit ?? 0)
  ) {
    return 'The daily limit cannot be more than the monthly limit.'
  }
  // Null is "grants none" and is fine; a number has to be a percentage.
  if (input.defaultDiscountPct !== null && input.defaultDiscountPct !== undefined) {
    if (input.defaultDiscountPct < 0 || input.defaultDiscountPct > 100) {
      return 'A standing discount must be between 0 and 100 percent.'
    }
  }
  // The same bounds validateCustomer() applies, so a group cannot seed an
  // account with figures the account itself would reject.
  if ((input.defaultInterestRatePct ?? 0) < 0) return 'An interest rate cannot be negative.'
  if ((input.defaultInterestRatePct ?? 0) > 100) {
    return 'That interest rate looks wrong — enter it as a yearly percentage.'
  }
  if ((input.defaultInterestGraceDays ?? 0) < 0 || (input.defaultInterestGraceDays ?? 0) > 365) {
    return 'The grace period must be between 0 and 365 days.'
  }
  // 0 means "calendar month" for a monthly cycle; 1–31 pins the cut day.
  if ((input.defaultStatementAnchorDay ?? 0) < 0 || (input.defaultStatementAnchorDay ?? 0) > 31) {
    return 'The cut day must be between 0 and 31.'
  }
  return null
}

export async function createCustomerGroup(siteId: number, input: GroupInput): Promise<SaveResult> {
  const invalid = validateGroup(input)
  if (invalid) return { ok: false, error: invalid }

  const name = input.name.trim()
  const clash = await customerQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM customer_groups WHERE name = ? LIMIT 1',
    [name],
  )
  if (clash) return { ok: false, error: `A group called "${name}" already exists.` }

  const res = await customerExecute(
    siteId,
    `INSERT INTO customer_groups
       (name, code, default_terms_days, default_credit_limit,
        default_daily_limit, default_monthly_limit, default_discount_pct,
        default_interest_rate_pct, default_interest_enabled, default_interest_grace_days,
        default_statement_cycle, default_statement_anchor_day,
        price_structure_id, sort_order, is_active)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      name,
      input.code?.trim() || null,
      input.defaultTermsDays ?? 30,
      (input.defaultCreditLimit ?? 0).toFixed(4),
      (input.defaultDailyLimit ?? 0).toFixed(4),
      (input.defaultMonthlyLimit ?? 0).toFixed(4),
      input.defaultDiscountPct === null || input.defaultDiscountPct === undefined
        ? null
        : input.defaultDiscountPct.toFixed(3),
      (input.defaultInterestRatePct ?? 0).toFixed(4),
      input.defaultInterestEnabled ? 1 : 0,
      input.defaultInterestGraceDays ?? 0,
      input.defaultStatementCycle ?? 'monthly',
      input.defaultStatementAnchorDay ?? 0,
      input.priceStructureId ?? null,
      input.sortOrder ?? 0,
      input.isActive === false ? 0 : 1,
    ],
  )
  return { ok: true, id: res.insertId }
}

export async function updateCustomerGroup(
  siteId: number,
  id: number,
  input: GroupInput,
): Promise<SaveResult> {
  const invalid = validateGroup(input)
  if (invalid) return { ok: false, error: invalid }

  const name = input.name.trim()
  const clash = await customerQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM customer_groups WHERE name = ? AND id <> ? LIMIT 1',
    [name, id],
  )
  if (clash) return { ok: false, error: `A group called "${name}" already exists.` }

  const res = await customerExecute(
    siteId,
    `UPDATE customer_groups
        SET name = ?, code = ?, default_terms_days = ?, default_credit_limit = ?,
            default_daily_limit = ?, default_monthly_limit = ?, default_discount_pct = ?,
            default_interest_rate_pct = ?, default_interest_enabled = ?,
            default_interest_grace_days = ?,
            default_statement_cycle = ?, default_statement_anchor_day = ?,
            price_structure_id = ?, sort_order = ?, is_active = ?
      WHERE id = ?`,
    [
      name,
      input.code?.trim() || null,
      input.defaultTermsDays ?? 30,
      (input.defaultCreditLimit ?? 0).toFixed(4),
      (input.defaultDailyLimit ?? 0).toFixed(4),
      (input.defaultMonthlyLimit ?? 0).toFixed(4),
      input.defaultDiscountPct === null || input.defaultDiscountPct === undefined
        ? null
        : input.defaultDiscountPct.toFixed(3),
      (input.defaultInterestRatePct ?? 0).toFixed(4),
      input.defaultInterestEnabled ? 1 : 0,
      input.defaultInterestGraceDays ?? 0,
      input.defaultStatementCycle ?? 'monthly',
      input.defaultStatementAnchorDay ?? 0,
      input.priceStructureId ?? null,
      input.sortOrder ?? 0,
      input.isActive === false ? 0 : 1,
      id,
    ],
  )
  if (res.affectedRows === 0) return { ok: false, error: 'Group not found.' }
  return { ok: true, id }
}

export type DeleteResult = { ok: true } | { ok: false; error: string }

/**
 * Deletes a group only when nothing points at it.
 *
 * The FK is ON DELETE SET NULL, so deleting one in use would quietly unassign
 * every account on it. Refusing beats a change nobody asked for and nobody
 * sees — the same reasoning as deleteDepartment().
 */
export async function deleteCustomerGroup(siteId: number, id: number): Promise<DeleteResult> {
  const group = await getCustomerGroup(siteId, id)
  if (!group) return { ok: false, error: 'Group not found.' }

  if (group.customerCount > 0) {
    return {
      ok: false,
      error: `${group.customerCount} customer${
        group.customerCount === 1 ? ' is' : 's are'
      } still in "${group.name}". Reassign ${
        group.customerCount === 1 ? 'it' : 'them'
      } first, or deactivate this group instead.`,
    }
  }

  await customerExecute(siteId, 'DELETE FROM customer_groups WHERE id = ?', [id])
  return { ok: true }
}

/* ── Reps ────────────────────────────────────────────────────────────────── */

export type SalesRep = {
  id: number
  name: string
  code: string | null
  email: string | null
  phone: string | null
  commissionPct: number
  isActive: boolean
  customerCount: number
}

function mapRep(r: Row): SalesRep {
  return {
    id: Number(r.id),
    name: String(r.name),
    code: (r.code as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    commissionPct: toNum(r.commission_pct),
    isActive: !!r.is_active,
    customerCount: Number(r.customer_count ?? 0),
  }
}

/**
 * sales_reps lives in THIS store; the customers assigned to a rep may not.
 *
 * The count is what deleteSalesRep refuses on, so getting it from the wrong
 * database is not cosmetic: a branch counted its own empty customers table and
 * never refused, letting somebody delete a rep who still holds two hundred
 * accounts in the shared file.
 *
 * Counted by NAME rather than rep_id, for the reason 205 gives — the id means
 * nothing on the other side of the boundary.
 *
 * A function rather than a constant because the customer database has to be
 * named in the SQL, and the name is only known at call time. The prefix is
 * empty for every unshared site, so the statement is byte-for-byte what it was.
 */
const selectRep = (cdb: string) => `
  SELECT r.id, r.name, r.code, r.email, r.phone, r.commission_pct, r.is_active,
         (SELECT COUNT(*) FROM ${cdb}customers c WHERE c.rep_name = r.name) AS customer_count
    FROM sales_reps r
`

export async function listSalesReps(
  siteId: number,
  includeInactive = false,
): Promise<SalesRep[]> {
  const { customerDbPrefix } = await import('./customerDb')
  const rows = await siteQuery<Row>(
    siteId,
    `${selectRep(await customerDbPrefix(siteId))}
      ${includeInactive ? '' : 'WHERE r.is_active = 1'}
      ORDER BY r.name ASC`,
  )
  return rows.map(mapRep)
}

export async function getSalesRep(siteId: number, id: number): Promise<SalesRep | null> {
  const { customerDbPrefix } = await import('./customerDb')
  const row = await siteQueryOne<Row>(
    siteId,
    `${selectRep(await customerDbPrefix(siteId))} WHERE r.id = ? LIMIT 1`,
    [id],
  )
  return row ? mapRep(row) : null
}

export type RepInput = {
  name: string
  code?: string | null
  email?: string | null
  phone?: string | null
  commissionPct?: number
  isActive?: boolean
}

export function validateRep(input: RepInput): string | null {
  if (!input.name?.trim()) return 'A rep name is required.'
  if (input.name.trim().length > 120) return 'Name must be 120 characters or fewer.'
  if (input.email?.trim() && !isEmail(input.email.trim())) {
    return 'That email address does not look valid.'
  }
  if ((input.commissionPct ?? 0) < 0 || (input.commissionPct ?? 0) > 100) {
    return 'Commission must be between 0 and 100 percent.'
  }
  return null
}

export async function createSalesRep(siteId: number, input: RepInput): Promise<SaveResult> {
  const invalid = validateRep(input)
  if (invalid) return { ok: false, error: invalid }

  const name = input.name.trim()
  const clash = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM sales_reps WHERE name = ? LIMIT 1',
    [name],
  )
  if (clash) return { ok: false, error: `A rep called "${name}" already exists.` }

  const res = await siteExecute(
    siteId,
    `INSERT INTO sales_reps (name, code, email, phone, commission_pct, is_active)
     VALUES (?,?,?,?,?,?)`,
    [
      name,
      input.code?.trim() || null,
      input.email?.trim().toLowerCase() || null,
      input.phone?.trim() || null,
      (input.commissionPct ?? 0).toFixed(3),
      input.isActive === false ? 0 : 1,
    ],
  )
  return { ok: true, id: res.insertId }
}

export async function updateSalesRep(
  siteId: number,
  id: number,
  input: RepInput,
): Promise<SaveResult> {
  const invalid = validateRep(input)
  if (invalid) return { ok: false, error: invalid }

  const name = input.name.trim()
  const clash = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM sales_reps WHERE name = ? AND id <> ? LIMIT 1',
    [name, id],
  )
  if (clash) return { ok: false, error: `A rep called "${name}" already exists.` }

  /*
   * A rename has to carry to the customers, because the NAME is the link (205).
   *
   * Read before the update, while the old name is still knowable. Without this,
   * renaming "Thabo M" to "Thabo Mokoena" would silently detach every account
   * assigned to them: the rep row changes, the customers keep the old string,
   * and the age analysis shows no rep for two hundred accounts.
   *
   * Done through the customer wrapper, so it reaches the shared file rather
   * than the branch's own empty table. Deliberately not one transaction with
   * the rep update — no transaction spans two databases — so the order matters:
   * the rep row is renamed first, and a failure here leaves customers pointing
   * at the old name, which is visible and repairable by renaming again. The
   * reverse order would leave customers naming a rep that does not exist.
   */
  const before = await siteQueryOne<RowDataPacket & { name: string }>(
    siteId,
    'SELECT name FROM sales_reps WHERE id = ? LIMIT 1',
    [id],
  )

  const res = await siteExecute(
    siteId,
    `UPDATE sales_reps
        SET name = ?, code = ?, email = ?, phone = ?, commission_pct = ?, is_active = ?
      WHERE id = ?`,
    [
      name,
      input.code?.trim() || null,
      input.email?.trim().toLowerCase() || null,
      input.phone?.trim() || null,
      (input.commissionPct ?? 0).toFixed(3),
      input.isActive === false ? 0 : 1,
      id,
    ],
  )
  if (res.affectedRows === 0) return { ok: false, error: 'Rep not found.' }

  const oldName = before ? String(before.name) : null
  if (oldName && oldName !== name) {
    await customerExecute(siteId, 'UPDATE customers SET rep_name = ? WHERE rep_name = ?', [
      name,
      oldName,
    ])
  }

  return { ok: true, id }
}

export async function deleteSalesRep(siteId: number, id: number): Promise<DeleteResult> {
  const rep = await getSalesRep(siteId, id)
  if (!rep) return { ok: false, error: 'Rep not found.' }

  if (rep.customerCount > 0) {
    return {
      ok: false,
      error: `${rep.customerCount} customer${
        rep.customerCount === 1 ? ' is' : 's are'
      } assigned to ${rep.name}. Reassign ${
        rep.customerCount === 1 ? 'it' : 'them'
      } first, or deactivate this rep instead.`,
    }
  }

  await siteExecute(siteId, 'DELETE FROM sales_reps WHERE id = ?', [id])
  return { ok: true }
}

/* ── Categories ──────────────────────────────────────────────────────────── */

/**
 * The categories actually in use, for the filter picker and a datalist on the
 * form. No table: the values ARE the data, so a DISTINCT is both the list and
 * the guarantee that it never drifts from what accounts really hold.
 */
export async function listCustomerCategories(siteId: number): Promise<string[]> {
  const rows = await customerQuery<RowDataPacket & { category: string }>(
    siteId,
    `SELECT DISTINCT category FROM customers
      WHERE category IS NOT NULL AND category <> ''
      ORDER BY category ASC
      LIMIT 200`,
  )
  return rows.map((r) => r.category)
}

export async function listSupplierCategories(siteId: number): Promise<string[]> {
  const rows = await supplierQuery<RowDataPacket & { category: string }>(
    siteId,
    `SELECT DISTINCT category FROM suppliers
      WHERE category IS NOT NULL AND category <> ''
      ORDER BY category ASC
      LIMIT 200`,
  )
  return rows.map((r) => r.category)
}

/** Shared by both master files, so one definition of "looks like an email". */
export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}
