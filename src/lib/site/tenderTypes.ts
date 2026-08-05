import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { round, toNum } from '../decimals'

/**
 * How a sale is paid for.
 *
 * A tender type is a small BEHAVIOUR PROGRAM, not a label. The till reads these
 * flags and changes what it does — which is why they are rows and not an ENUM.
 * A store adding Yoco must never need a schema change or a deploy.
 *
 * The trap avoided here is a `tender_kind ENUM('cash','card','account')`
 * discriminator: the moment that exists you are back to a fixed list, and Yoco
 * has to lie about being a card. `countsAsDrawerCash` is what makes something
 * cash-like, not a label saying so.
 */

export type TenderType = {
  id: number
  code: string
  name: string
  // ── Behaviour: the engine branches on every one of these
  postsToDebtor: boolean
  requiresCustomer: boolean
  countsAsDrawerCash: boolean
  opensCashDrawer: boolean
  allowsChange: boolean
  allowsSplit: boolean
  allowsRefund: boolean
  requiresReference: boolean
  referenceLabel: string | null
  roundsToCashDenomination: boolean
  minAmount: number
  maxAmount: number
  surchargePct: number
  integrationKey: string | null
  // ── Presentation
  icon: string | null
  color: string | null
  position: number
  isActive: boolean
  isSystem: boolean
}

type Row = RowDataPacket & Record<string, unknown>

function mapTender(r: Row): TenderType {
  return {
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    postsToDebtor: !!r.posts_to_debtor,
    requiresCustomer: !!r.requires_customer,
    countsAsDrawerCash: !!r.counts_as_drawer_cash,
    opensCashDrawer: !!r.opens_cash_drawer,
    allowsChange: !!r.allows_change,
    allowsSplit: !!r.allows_split,
    allowsRefund: !!r.allows_refund,
    requiresReference: !!r.requires_reference,
    referenceLabel: (r.reference_label as string | null) ?? null,
    roundsToCashDenomination: !!r.rounds_to_cash_denomination,
    minAmount: toNum(r.min_amount),
    maxAmount: toNum(r.max_amount),
    surchargePct: toNum(r.surcharge_pct),
    integrationKey: (r.integration_key as string | null) ?? null,
    icon: (r.icon as string | null) ?? null,
    color: (r.color as string | null) ?? null,
    position: Number(r.position),
    isActive: !!r.is_active,
    isSystem: !!r.is_system,
  }
}

/* Deliberately does NOT select from tender_integrations: secrets must never be
   read by the query that renders the setup grid or the till buttons. */
const SELECT_TENDER = `
  SELECT id, code, name, posts_to_debtor, requires_customer, counts_as_drawer_cash,
         opens_cash_drawer, allows_change, allows_split, allows_refund,
         requires_reference, reference_label, rounds_to_cash_denomination,
         min_amount, max_amount, surcharge_pct, integration_key,
         icon, color, position, is_active, is_system
    FROM tender_types
`

export async function listTenderTypes(
  siteId: number,
  includeInactive = false,
): Promise<TenderType[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_TENDER} ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY position ASC, id ASC`,
  )
  return rows.map(mapTender)
}

export async function getTenderType(siteId: number, id: number): Promise<TenderType | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_TENDER} WHERE id = ? LIMIT 1`, [id])
  return row ? mapTender(row) : null
}

/** By code, for engine paths that need a specific one — 'ACCOUNT' on a credit sale. */
export async function getTenderByCode(siteId: number, code: string): Promise<TenderType | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_TENDER} WHERE code = ? LIMIT 1`, [code])
  return row ? mapTender(row) : null
}

export type TenderInput = {
  code: string
  name: string
  postsToDebtor?: boolean
  requiresCustomer?: boolean
  countsAsDrawerCash?: boolean
  opensCashDrawer?: boolean
  allowsChange?: boolean
  allowsSplit?: boolean
  allowsRefund?: boolean
  requiresReference?: boolean
  referenceLabel?: string | null
  roundsToCashDenomination?: boolean
  minAmount?: number
  maxAmount?: number
  surchargePct?: number
  integrationKey?: string | null
  icon?: string | null
  color?: string | null
  position?: number
  isActive?: boolean
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }
export type DeleteResult = { ok: true } | { ok: false; error: string }

export function validateTender(input: TenderInput): string | null {
  if (!input.code?.trim()) return 'A code is required.'
  // The code is the engine's stable handle, so it must be predictable. The name
  // is what gets renamed to "Kontant".
  if (!/^[A-Z0-9_]{2,24}$/.test(input.code.trim().toUpperCase())) {
    return 'Code must be 2–24 characters, letters, digits and underscores only.'
  }
  if (!input.name?.trim()) return 'A name is required.'
  if (input.name.trim().length > 60) return 'Name must be 60 characters or fewer.'

  if ((input.minAmount ?? 0) < 0) return 'Minimum amount cannot be negative.'
  if ((input.maxAmount ?? 0) < 0) return 'Maximum amount cannot be negative.'
  if ((input.maxAmount ?? 0) > 0 && (input.minAmount ?? 0) > (input.maxAmount ?? 0)) {
    return 'Minimum cannot be above the maximum.'
  }
  if ((input.surchargePct ?? 0) < 0 || (input.surchargePct ?? 0) > 100) {
    return 'Surcharge must be between 0 and 100 percent.'
  }
  if (input.requiresReference && !input.referenceLabel?.trim()) {
    return 'Give the reference a label, so the cashier knows what to type.'
  }

  // An account tender that does not demand a customer would let a walk-in buy
  // on credit with nowhere to post the debt.
  if (input.postsToDebtor && input.requiresCustomer === false) {
    return 'A tender that posts to an account must require a customer.'
  }
  // Change can only come out of the drawer.
  if (input.allowsChange && !input.countsAsDrawerCash) {
    return 'Only a tender counted in the drawer can give change.'
  }
  return null
}

function columns(input: TenderInput): unknown[] {
  return [
    input.code.trim().toUpperCase(),
    input.name.trim(),
    input.postsToDebtor ? 1 : 0,
    // Forced on for an account tender: validate() refuses the contradiction, so
    // this only normalises the "left unset" case.
    input.postsToDebtor || input.requiresCustomer ? 1 : 0,
    input.countsAsDrawerCash ? 1 : 0,
    input.opensCashDrawer ? 1 : 0,
    input.allowsChange ? 1 : 0,
    input.allowsSplit === false ? 0 : 1,
    input.allowsRefund === false ? 0 : 1,
    input.requiresReference ? 1 : 0,
    input.requiresReference ? (input.referenceLabel?.trim() || 'Reference') : null,
    input.roundsToCashDenomination ? 1 : 0,
    (input.minAmount ?? 0).toFixed(4),
    (input.maxAmount ?? 0).toFixed(4),
    (input.surchargePct ?? 0).toFixed(3),
    input.integrationKey?.trim() || null,
    input.icon?.trim() || null,
    input.color?.trim() || null,
    input.position ?? 0,
    input.isActive === false ? 0 : 1,
  ]
}

const COLUMN_LIST = `code, name, posts_to_debtor, requires_customer, counts_as_drawer_cash,
                     opens_cash_drawer, allows_change, allows_split, allows_refund,
                     requires_reference, reference_label, rounds_to_cash_denomination,
                     min_amount, max_amount, surcharge_pct, integration_key,
                     icon, color, position, is_active`

export async function createTenderType(siteId: number, input: TenderInput): Promise<SaveResult> {
  const invalid = validateTender(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.code.trim().toUpperCase()
  const clash = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM tender_types WHERE code = ? LIMIT 1',
    [code],
  )
  if (clash) return { ok: false, error: `A tender with code "${code}" already exists.` }

  const res = await siteExecute(
    siteId,
    `INSERT INTO tender_types (${COLUMN_LIST})
     VALUES (${Array.from({ length: COLUMN_LIST.split(',').length }, () => '?').join(',')})`,
    columns(input),
  )
  return { ok: true, id: res.insertId }
}

/**
 * Updates a tender type.
 *
 * A system tender may be renamed, reordered, restyled and deactivated, but its
 * CODE is fixed: the engine matches on it, and letting someone rename CASH to
 * KONTANT would break every rule that looks for it.
 */
export async function updateTenderType(
  siteId: number,
  id: number,
  input: TenderInput,
): Promise<SaveResult> {
  const existing = await getTenderType(siteId, id)
  if (!existing) return { ok: false, error: 'Tender type not found.' }

  const effective: TenderInput = existing.isSystem ? { ...input, code: existing.code } : input

  const invalid = validateTender(effective)
  if (invalid) return { ok: false, error: invalid }

  const code = effective.code.trim().toUpperCase()
  if (code !== existing.code) {
    const clash = await siteQueryOne<RowDataPacket & { id: number }>(
      siteId,
      'SELECT id FROM tender_types WHERE code = ? AND id <> ? LIMIT 1',
      [code, id],
    )
    if (clash) return { ok: false, error: `A tender with code "${code}" already exists.` }
  }

  await siteExecute(
    siteId,
    `UPDATE tender_types SET
       code = ?, name = ?, posts_to_debtor = ?, requires_customer = ?, counts_as_drawer_cash = ?,
       opens_cash_drawer = ?, allows_change = ?, allows_split = ?, allows_refund = ?,
       requires_reference = ?, reference_label = ?, rounds_to_cash_denomination = ?,
       min_amount = ?, max_amount = ?, surcharge_pct = ?, integration_key = ?,
       icon = ?, color = ?, position = ?, is_active = ?
     WHERE id = ?`,
    [...columns(effective), id],
  )
  return { ok: true, id }
}

/**
 * Deletes a tender type.
 *
 * Refused for a system tender (the engine assumes it exists) and for any tender
 * that has taken money — the FK on sales_tenders is RESTRICT, so the database
 * would refuse anyway, but a clear sentence beats a constraint error.
 */
export async function deleteTenderType(siteId: number, id: number): Promise<DeleteResult> {
  const tender = await getTenderType(siteId, id)
  if (!tender) return { ok: false, error: 'Tender type not found.' }

  if (tender.isSystem) {
    return {
      ok: false,
      error: `${tender.name} is a built-in tender and cannot be deleted. Deactivate it instead to take it off the till.`,
    }
  }

  const used = await siteQueryOne<RowDataPacket & { n: number }>(
    siteId,
    'SELECT COUNT(*) AS n FROM sales_tenders WHERE tender_type_id = ?',
    [id],
  )
  if (Number(used?.n ?? 0) > 0) {
    return {
      ok: false,
      error: `${tender.name} has been used on ${used!.n} sale${Number(used!.n) === 1 ? '' : 's'}. Deactivate it instead — deleting it would break those documents.`,
    }
  }

  await siteExecute(siteId, 'DELETE FROM tender_types WHERE id = ?', [id])
  return { ok: true }
}

/** Persists the drag order from the setup screen. */
export async function reorderTenderTypes(siteId: number, orderedIds: number[]): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await siteExecute(siteId, 'UPDATE tender_types SET position = ? WHERE id = ?', [index + 1, id])
  }
}

/* ── The tender engine ───────────────────────────────────────────────────── */

/**
 * The rules themselves live in lib/tenderMath.ts, not here.
 *
 * This module is server-only because it talks to the database, but the till's
 * tender pad is a Client Component that needs the SAME arithmetic to show a
 * running change figure while the cashier types. Duplicating the rules on the
 * client is how the screen and the posting engine end up disagreeing about what
 * is owed. Re-exported here so server callers still import one thing.
 */
export { checkTenders } from '../tenderMath'
export type { TenderBehaviour, TenderLine, TenderCheck } from '../tenderMath'
