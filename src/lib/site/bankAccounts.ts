import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { ACCOUNT_TYPE_LABELS, BANK_ACCOUNT_TYPES, type BankAccountType } from './cashbookRules'

/**
 * Bank, cash and card-settlement accounts.
 *
 * THE INVARIANT, stated as customerLedger.ts states its own: an account's
 * `balance` always equals `opening_balance` plus SUM(amount_signed) over its
 * non-void transactions. Everything that moves one moves the other in the SAME
 * transaction, nothing else writes `balance`, and reconcileBankBalances()
 * proves the promise held.
 *
 * updateAccount() deliberately omits `balance` from its column list for exactly
 * the reason updateCustomer() does: a screen that can set a balance directly is
 * a screen that can make the ledger disagree with itself.
 */

export type BankAccount = {
  id: number
  code: string
  name: string
  accountType: BankAccountType
  accountTypeLabel: string
  bankName: string | null
  accountNumber: string | null
  branchCode: string | null
  openingBalance: number
  openingDate: string | null
  balance: number
  lastReconciledDate: string | null
  lastReconciledBalance: number | null
  isDefaultReceipts: boolean
  isDefaultPayments: boolean
  status: 'active' | 'closed'
  sortOrder: number
  notes: string | null
  /** Rows captured but not yet agreed to a statement. Only set by listAccounts. */
  unreconciledCount?: number
  createdAt: Date
}

type Row = RowDataPacket & Record<string, unknown>

function mapAccount(r: Row): BankAccount {
  const accountType = String(r.account_type) as BankAccountType
  return {
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    accountType,
    accountTypeLabel: ACCOUNT_TYPE_LABELS[accountType] ?? accountType,
    bankName: (r.bank_name as string | null) ?? null,
    accountNumber: (r.account_number as string | null) ?? null,
    branchCode: (r.branch_code as string | null) ?? null,
    openingBalance: toNum(r.opening_balance),
    openingDate: r.opening_date === null ? null : String(r.opening_date),
    balance: toNum(r.balance),
    lastReconciledDate: r.last_reconciled_date === null ? null : String(r.last_reconciled_date),
    lastReconciledBalance:
      r.last_reconciled_balance === null ? null : toNum(r.last_reconciled_balance),
    isDefaultReceipts: Boolean(r.is_default_receipts),
    isDefaultPayments: Boolean(r.is_default_payments),
    status: String(r.status) as 'active' | 'closed',
    sortOrder: Number(r.sort_order),
    notes: (r.notes as string | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

const SELECT_ACCOUNT = `
  SELECT id, code, name, account_type, bank_name, account_number, branch_code,
         opening_balance, opening_date, balance, last_reconciled_date, last_reconciled_balance,
         is_default_receipts, is_default_payments, status, sort_order, notes, created_at
    FROM bank_accounts
`

/* ── Reads ───────────────────────────────────────────────────────────────── */

/**
 * Every account, with how much is sitting unreconciled on each.
 *
 * The unreconciled count is the number that tells someone an account needs
 * attention, so it is fetched with the list rather than per-row on the screen —
 * a dashboard that needs N+1 queries to say "3 accounts need reconciling" is a
 * dashboard nobody leaves open.
 */
export async function listAccounts(
  siteId: number,
  opts: { includeClosed?: boolean } = {},
): Promise<BankAccount[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT a.*, (
              SELECT COUNT(*) FROM bank_transactions t
               WHERE t.bank_account_id = a.id AND t.status = 'unreconciled'
            ) AS unreconciled_count
       FROM bank_accounts a
      ${opts.includeClosed ? '' : "WHERE a.status = 'active'"}
      ORDER BY a.sort_order, a.name`,
  )
  return rows.map((r) => ({ ...mapAccount(r), unreconciledCount: Number(r.unreconciled_count ?? 0) }))
}

export async function getAccount(siteId: number, id: number): Promise<BankAccount | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_ACCOUNT} WHERE id = ? LIMIT 1`, [id])
  return row ? mapAccount(row) : null
}

export async function getAccountByCode(siteId: number, code: string): Promise<BankAccount | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_ACCOUNT} WHERE code = ? LIMIT 1`, [
    code.trim().toUpperCase(),
  ])
  return row ? mapAccount(row) : null
}

/**
 * Where receipts land, or where payments are drawn from, by default.
 *
 * Falls back to the first active account rather than returning null: a till
 * cash-up must always have somewhere to bank to, and failing a day's takings
 * because nobody ticked a checkbox in setup is not a defensible outcome.
 */
export async function defaultAccount(
  siteId: number,
  kind: 'receipts' | 'payments',
): Promise<BankAccount | null> {
  const column = kind === 'receipts' ? 'is_default_receipts' : 'is_default_payments'
  const row = await siteQueryOne<Row>(
    siteId,
    `${SELECT_ACCOUNT} WHERE ${column} = TRUE AND status = 'active' LIMIT 1`,
  )
  if (row) return mapAccount(row)

  const fallback = await siteQueryOne<Row>(
    siteId,
    `${SELECT_ACCOUNT} WHERE status = 'active' ORDER BY sort_order, id LIMIT 1`,
  )
  return fallback ? mapAccount(fallback) : null
}

/** Total cash across every active account — the figure a dashboard tile wants. */
export async function totalCash(siteId: number): Promise<number> {
  const row = await siteQueryOne<Row>(
    siteId,
    "SELECT COALESCE(SUM(balance), 0) AS total FROM bank_accounts WHERE status = 'active'",
  )
  return toNum(row?.total)
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export type AccountInput = {
  code: string
  name: string
  accountType?: BankAccountType
  bankName?: string | null
  accountNumber?: string | null
  branchCode?: string | null
  openingBalance?: number
  openingDate?: string | null
  isDefaultReceipts?: boolean
  isDefaultPayments?: boolean
  sortOrder?: number
  notes?: string | null
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

export function validateAccount(input: AccountInput): string | null {
  if (!input.code?.trim()) return 'Give the account a short code.'
  if (input.code.trim().length > 24) return 'That code is too long.'
  if (!input.name?.trim()) return 'Give the account a name.'
  if (input.accountType && !BANK_ACCOUNT_TYPES.includes(input.accountType)) {
    return 'That is not a valid account type.'
  }
  if (input.openingDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.openingDate)) {
    return 'That opening date is not valid.'
  }
  if (!Number.isFinite(input.openingBalance ?? 0)) return 'That opening balance is not a number.'
  return null
}

/**
 * Creates an account.
 *
 * The opening balance seeds `balance` directly rather than posting a
 * transaction for it. That differs from the sub-ledger, where an opening
 * balance IS a document — deliberately: a debtor's opening balance ages and
 * gets allocated against, so it needs to be a row, whereas a bank account's is
 * simply where the running total starts and has nothing to reconcile against.
 */
export async function createAccount(
  siteId: number,
  actor: Actor,
  input: AccountInput,
): Promise<SaveResult> {
  const invalid = validateAccount(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.code.trim().toUpperCase()
  const clash = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM bank_accounts WHERE code = ? LIMIT 1',
    [code],
  )
  if (clash) return { ok: false, error: `${code} is already in use by another account.` }

  const opening = round(input.openingBalance ?? 0, 2)

  return siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO bank_accounts
         (code, name, account_type, bank_name, account_number, branch_code,
          opening_balance, opening_date, balance, is_default_receipts, is_default_payments,
          sort_order, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        code,
        input.name.trim(),
        input.accountType ?? 'bank',
        input.bankName?.trim() || null,
        input.accountNumber?.trim() || null,
        input.branchCode?.trim() || null,
        opening.toFixed(4),
        input.openingDate || null,
        opening.toFixed(4),
        Boolean(input.isDefaultReceipts),
        Boolean(input.isDefaultPayments),
        input.sortOrder ?? 100,
        input.notes?.trim() || null,
      ] as never,
    )
    const id = (res as { insertId: number }).insertId

    await clearOtherDefaults(tx, id, input)

    await logActivityTx(tx, actor, {
      entity: 'bank',
      entityId: id,
      action: 'create',
      detail: `Created ${input.accountType ?? 'bank'} account ${code} — ${input.name.trim()}`,
    })

    return { ok: true as const, id }
  })
}

export async function updateAccount(
  siteId: number,
  actor: Actor,
  id: number,
  input: AccountInput,
): Promise<SaveResult> {
  const invalid = validateAccount(input)
  if (invalid) return { ok: false, error: invalid }

  const existing = await getAccount(siteId, id)
  if (!existing) return { ok: false, error: 'That account no longer exists.' }

  const code = input.code.trim().toUpperCase()
  const clash = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM bank_accounts WHERE code = ? AND id <> ? LIMIT 1',
    [code, id],
  )
  if (clash) return { ok: false, error: `${code} is already in use by another account.` }

  // Changing the opening balance must move the running balance by the same
  // amount, or the invariant breaks. Everything else is descriptive.
  const openingDelta = round((input.openingBalance ?? 0) - existing.openingBalance, 2)

  return siteTransaction(siteId, async (tx) => {
    await tx.execute(
      `UPDATE bank_accounts
          SET code = ?, name = ?, account_type = ?, bank_name = ?, account_number = ?,
              branch_code = ?, opening_balance = ?, opening_date = ?,
              balance = balance + ?, is_default_receipts = ?, is_default_payments = ?,
              sort_order = ?, notes = ?
        WHERE id = ?`,
      [
        code,
        input.name.trim(),
        input.accountType ?? existing.accountType,
        input.bankName?.trim() || null,
        input.accountNumber?.trim() || null,
        input.branchCode?.trim() || null,
        round(input.openingBalance ?? 0, 2).toFixed(4),
        input.openingDate || null,
        openingDelta.toFixed(4),
        Boolean(input.isDefaultReceipts),
        Boolean(input.isDefaultPayments),
        input.sortOrder ?? existing.sortOrder,
        input.notes?.trim() || null,
        id,
      ] as never,
    )

    await clearOtherDefaults(tx, id, input)

    await logActivityTx(tx, actor, {
      entity: 'bank',
      entityId: id,
      action: 'update',
      detail: `Updated account ${code}`,
    })

    return { ok: true as const, id }
  })
}

/**
 * Keeps "the default" singular.
 *
 * The schema cannot express "at most one row has this flag" — a UNIQUE index on
 * a boolean would permit exactly one FALSE too. So it is enforced here, in the
 * same transaction as the row that claimed the flag, which is the only place
 * that can see both the old holder and the new one.
 */
async function clearOtherDefaults(
  tx: PoolConnection,
  id: number,
  input: AccountInput,
): Promise<void> {
  if (input.isDefaultReceipts) {
    await tx.execute('UPDATE bank_accounts SET is_default_receipts = FALSE WHERE id <> ?', [
      id,
    ] as never)
  }
  if (input.isDefaultPayments) {
    await tx.execute('UPDATE bank_accounts SET is_default_payments = FALSE WHERE id <> ?', [
      id,
    ] as never)
  }
}

/**
 * Closes an account. Never deletes one.
 *
 * A bank account with history is a permanent record — its transactions are
 * evidence of money that moved, and the FK from bank_transactions is RESTRICT
 * for that reason. Closing hides it from pickers while leaving every figure
 * that ever depended on it intact.
 */
export async function closeAccount(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const account = await getAccount(siteId, id)
  if (!account) return { ok: false, error: 'That account no longer exists.' }
  if (round(account.balance, 2) !== 0) {
    return {
      ok: false,
      error: `That account still holds ${account.balance.toFixed(2)}. Move the balance out before closing it.`,
    }
  }

  await siteExecute(siteId, "UPDATE bank_accounts SET status = 'closed' WHERE id = ?", [id])
  await logActivity(siteId, actor, {
    entity: 'bank',
    entityId: id,
    action: 'close',
    detail: `Closed account ${account.code}`,
  })
  return { ok: true }
}

export async function reopenAccount(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const account = await getAccount(siteId, id)
  if (!account) return { ok: false, error: 'That account no longer exists.' }

  await siteExecute(siteId, "UPDATE bank_accounts SET status = 'active' WHERE id = ?", [id])
  await logActivity(siteId, actor, {
    entity: 'bank',
    entityId: id,
    action: 'reopen',
    detail: `Reopened account ${account.code}`,
  })
  return { ok: true }
}

/* ── Reconciliation of the invariant ─────────────────────────────────────── */

export type BankBalanceDrift = {
  id: number
  code: string
  name: string
  stored: number
  computed: number
  drift: number
}

/**
 * Accounts whose stored balance disagrees with their transactions.
 *
 * The exact analogue of reconcileBalances() in customerLedger.ts, and reports
 * rather than repairs for the same reason: silently correcting a drift hides
 * the posting bug that caused it. Void rows are excluded from the computed side
 * because they never moved money.
 */
export async function reconcileBankBalances(siteId: number): Promise<BankBalanceDrift[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT a.id, a.code, a.name,
            a.balance AS stored,
            a.opening_balance + COALESCE(t.moved, 0) AS computed,
            a.balance - (a.opening_balance + COALESCE(t.moved, 0)) AS drift
       FROM bank_accounts a
       LEFT JOIN (
             SELECT bank_account_id, SUM(amount_signed) AS moved
               FROM bank_transactions
              WHERE status <> 'void'
              GROUP BY bank_account_id
            ) t ON t.bank_account_id = a.id
      WHERE ABS(a.balance - (a.opening_balance + COALESCE(t.moved, 0))) > 0.0001
      ORDER BY ABS(a.balance - (a.opening_balance + COALESCE(t.moved, 0))) DESC`,
  )

  return rows.map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    stored: toNum(r.stored),
    computed: toNum(r.computed),
    drift: toNum(r.drift),
  }))
}

/** Resets one account's balance to what its transactions say. Audited, never automatic. */
export async function repairBankBalance(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<{ ok: true; from: number; to: number } | { ok: false; error: string }> {
  const drifts = await reconcileBankBalances(siteId)
  const drift = drifts.find((d) => d.id === id)
  if (!drift) return { ok: false, error: 'That balance already agrees with its transactions.' }

  await siteTransaction(siteId, async (tx) => {
    await tx.execute('UPDATE bank_accounts SET balance = ? WHERE id = ?', [
      drift.computed.toFixed(4),
      id,
    ] as never)
    await logActivityTx(tx, actor, {
      entity: 'bank',
      entityId: id,
      action: 'repair',
      detail: `Balance corrected from ${drift.stored.toFixed(2)} to ${drift.computed.toFixed(2)}`,
    })
  })

  return { ok: true, from: drift.stored, to: drift.computed }
}

export { ACCOUNT_TYPE_LABELS, BANK_ACCOUNT_TYPES }
export type { BankAccountType }
