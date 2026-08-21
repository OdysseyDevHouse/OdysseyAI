import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { customerQueryOne, supplierQueryOne } from './customerDb'
import { toNum } from '../decimals'
import { logActivity, type Actor } from './activityLog'
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABELS,
  CONTROL_TYPE_LABELS,
  displayBalance,
  statementFor,
  subtypeLabel,
  subtypeRank,
  type AccountType,
  type ControlType,
} from '../glModel'

/**
 * The chart of accounts.
 *
 * Every account the ledger can post to, and the mapping layer that tells the
 * subledgers which one to use. See 045 for why control accounts are not
 * postable and why the GL is a derived mirror rather than the source of truth.
 */

export type GlAccount = {
  id: number
  accountCode: string
  name: string
  accountType: AccountType
  accountTypeLabel: string
  subtype: string | null
  subtypeLabel: string
  parentId: number | null
  controlType: ControlType | null
  controlLabel: string | null
  controlRefId: number | null
  isPostable: boolean
  isActive: boolean
  /** Signed by the debit convention: positive is a net debit. */
  balance: number
  /** The same figure as a reader expects it — credit-normal types flipped. */
  displayBalance: number
  statement: 'income_statement' | 'balance_sheet'
  sortOrder: number
  notes: string | null
}

type Row = RowDataPacket & Record<string, unknown>

function mapAccount(r: Row): GlAccount {
  const accountType = String(r.account_type) as AccountType
  const subtype = (r.subtype as string | null) ?? null
  const controlType = (r.control_type as ControlType | null) ?? null
  const balance = toNum(r.balance)

  return {
    id: Number(r.id),
    accountCode: String(r.account_code),
    name: String(r.name),
    accountType,
    accountTypeLabel: ACCOUNT_TYPE_LABELS[accountType],
    subtype,
    subtypeLabel: subtypeLabel(subtype, accountType),
    parentId: r.parent_id === null ? null : Number(r.parent_id),
    controlType,
    controlLabel: controlType ? CONTROL_TYPE_LABELS[controlType] : null,
    controlRefId: r.control_ref_id === null ? null : Number(r.control_ref_id),
    isPostable: Boolean(r.is_postable),
    isActive: Boolean(r.is_active),
    balance,
    displayBalance: displayBalance(accountType, balance),
    statement: statementFor(accountType),
    sortOrder: Number(r.sort_order),
    notes: (r.notes as string | null) ?? null,
  }
}

const SELECT_ACCOUNT = `
  SELECT id, account_code, name, account_type, subtype, parent_id,
         control_type, control_ref_id, is_postable, is_active, balance, sort_order, notes
    FROM gl_accounts
`

export async function listAccounts(
  siteId: number,
  opts: { includeInactive?: boolean; postableOnly?: boolean; type?: AccountType } = {},
): Promise<GlAccount[]> {
  const where: string[] = []
  const params: unknown[] = []

  if (!opts.includeInactive) where.push('is_active = TRUE')
  if (opts.postableOnly) where.push('is_postable = TRUE')
  if (opts.type) {
    where.push('account_type = ?')
    params.push(opts.type)
  }

  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_ACCOUNT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY sort_order, account_code`,
    params,
  )
  return rows.map(mapAccount)
}

export async function getAccount(siteId: number, id: number): Promise<GlAccount | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_ACCOUNT} WHERE id = ? LIMIT 1`, [id])
  return row ? mapAccount(row) : null
}

export async function getAccountByCode(siteId: number, code: string): Promise<GlAccount | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_ACCOUNT} WHERE account_code = ? LIMIT 1`, [
    code.trim(),
  ])
  return row ? mapAccount(row) : null
}

/** Accounts grouped for a statement, in conventional order. */
export function groupBySubtype(accounts: readonly GlAccount[]): {
  subtype: string | null
  label: string
  accounts: GlAccount[]
  total: number
}[] {
  const groups = new Map<string, { subtype: string | null; label: string; accounts: GlAccount[] }>()

  for (const account of accounts) {
    const key = account.subtype ?? account.accountType
    const group = groups.get(key) ?? {
      subtype: account.subtype,
      label: account.subtypeLabel,
      accounts: [],
    }
    group.accounts.push(account)
    groups.set(key, group)
  }

  return [...groups.values()]
    .map((g) => ({
      ...g,
      total: g.accounts.reduce((sum, a) => sum + a.displayBalance, 0),
    }))
    .sort((a, b) => subtypeRank(a.subtype) - subtypeRank(b.subtype))
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export type AccountInput = {
  accountCode: string
  name: string
  accountType: AccountType
  subtype?: string | null
  parentId?: number | null
  isPostable?: boolean
  sortOrder?: number
  notes?: string | null
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

export function validateAccount(input: AccountInput): string | null {
  if (!input.accountCode?.trim()) return 'An account code is required.'
  if (input.accountCode.trim().length > 16) return 'That account code is too long.'
  if (!input.name?.trim()) return 'A name is required.'
  if (!ACCOUNT_TYPES.includes(input.accountType)) return 'Choose an account type.'
  return null
}

export async function createAccount(
  siteId: number,
  actor: Actor,
  input: AccountInput,
): Promise<SaveResult> {
  const invalid = validateAccount(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.accountCode.trim()
  const clash = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM gl_accounts WHERE account_code = ? LIMIT 1',
    [code],
  )
  if (clash) return { ok: false, error: `Account ${code} already exists.` }

  const result = await siteExecute(
    siteId,
    `INSERT INTO gl_accounts
       (account_code, name, account_type, subtype, parent_id, is_postable, sort_order, notes)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      code,
      input.name.trim(),
      input.accountType,
      input.subtype?.trim() || null,
      input.parentId ?? null,
      input.isPostable ?? true,
      input.sortOrder ?? 5000,
      input.notes?.trim() || null,
    ],
  )

  await logActivity(siteId, actor, {
    entity: 'gl',
    entityId: result.insertId,
    action: 'account_create',
    detail: `Created GL account ${code} — ${input.name.trim()}`,
  })

  return { ok: true, id: result.insertId }
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

  const code = input.accountCode.trim()
  const clash = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM gl_accounts WHERE account_code = ? AND id <> ? LIMIT 1',
    [code, id],
  )
  if (clash) return { ok: false, error: `Account ${code} already exists.` }

  // Changing the TYPE of an account that has been posted to would move
  // historical entries between the P&L and the balance sheet, silently
  // restating every prior period.
  if (input.accountType !== existing.accountType) {
    const posted = await siteQueryOne<Row>(
      siteId,
      'SELECT id FROM journal_lines WHERE account_id = ? LIMIT 1',
      [id],
    )
    if (posted) {
      return {
        ok: false,
        error:
          'That account has entries posted to it, so its type cannot change — it would move historical figures between the profit and loss and the balance sheet. Create a new account instead.',
      }
    }
  }

  await siteExecute(
    siteId,
    `UPDATE gl_accounts
        SET account_code = ?, name = ?, account_type = ?, subtype = ?, parent_id = ?,
            is_postable = ?, sort_order = ?, notes = ?
      WHERE id = ?`,
    [
      code,
      input.name.trim(),
      input.accountType,
      input.subtype?.trim() || null,
      input.parentId ?? null,
      // A control account is never postable, whatever the form says.
      existing.controlType ? false : (input.isPostable ?? true),
      input.sortOrder ?? existing.sortOrder,
      input.notes?.trim() || null,
      id,
    ],
  )

  await logActivity(siteId, actor, {
    entity: 'gl',
    entityId: id,
    action: 'account_update',
    detail: `Updated GL account ${code}`,
  })

  return { ok: true, id }
}

export async function setAccountActive(
  siteId: number,
  actor: Actor,
  id: number,
  active: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const account = await getAccount(siteId, id)
  if (!account) return { ok: false, error: 'That account no longer exists.' }

  // Hiding an account that still holds a balance makes it vanish from the
  // chart while its figure stays in every total — the balance sheet would stop
  // adding up against its own detail.
  if (!active && Math.abs(account.balance) > 0.004) {
    return {
      ok: false,
      error: `That account still holds ${Math.abs(account.displayBalance).toFixed(2)}. Journal the balance out before hiding it.`,
    }
  }

  await siteExecute(siteId, 'UPDATE gl_accounts SET is_active = ? WHERE id = ?', [active, id])
  await logActivity(siteId, actor, {
    entity: 'gl',
    entityId: id,
    action: active ? 'account_activate' : 'account_deactivate',
    detail: `${active ? 'Reactivated' : 'Hid'} GL account ${account.accountCode}`,
  })
  return { ok: true }
}

/* ── Mappings ────────────────────────────────────────────────────────────── */

export type GlMapping = {
  id: number
  mappingKey: string
  refId: number | null
  accountId: number
  accountCode: string
  accountName: string
}

export async function listMappings(siteId: number, mappingKey?: string): Promise<GlMapping[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT m.*, a.account_code, a.name AS account_name
       FROM gl_mappings m
       JOIN gl_accounts a ON a.id = m.account_id
      ${mappingKey ? 'WHERE m.mapping_key = ?' : ''}
      ORDER BY m.mapping_key, m.ref_id`,
    mappingKey ? [mappingKey] : [],
  )

  return rows.map((r) => ({
    id: Number(r.id),
    mappingKey: String(r.mapping_key),
    refId: r.ref_id === null ? null : Number(r.ref_id),
    accountId: Number(r.account_id),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
  }))
}

/**
 * The account for a mapping, falling back to the key's default.
 *
 * The fallback is what lets a store add a department or a tender type without
 * configuring the GL first: the specific mapping is missing, the default
 * answers, and the journal still posts. Returning null instead would mean a
 * till sale failing because setup was incomplete.
 */
export async function resolveAccount(
  siteId: number,
  mappingKey: string,
  refId?: number | null,
): Promise<number | null> {
  if (refId) {
    const specific = await siteQueryOne<Row>(
      siteId,
      'SELECT account_id FROM gl_mappings WHERE mapping_key = ? AND ref_id = ? LIMIT 1',
      [mappingKey, refId],
    )
    if (specific) return Number(specific.account_id)
  }

  const fallback = await siteQueryOne<Row>(
    siteId,
    'SELECT account_id FROM gl_mappings WHERE mapping_key = ? AND ref_id IS NULL LIMIT 1',
    [mappingKey],
  )
  return fallback ? Number(fallback.account_id) : null
}

export async function setMapping(
  siteId: number,
  actor: Actor,
  mappingKey: string,
  refId: number | null,
  accountId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const account = await getAccount(siteId, accountId)
  if (!account) return { ok: false, error: 'That account no longer exists.' }
  if (!account.isPostable) {
    return {
      ok: false,
      error: `${account.name} is a control account and cannot be posted to directly.`,
    }
  }

  // MySQL treats NULLs as distinct in a UNIQUE index, so the default row must
  // be de-duplicated by hand or repeated saves would stack up rows.
  if (refId === null) {
    await siteExecute(
      siteId,
      'DELETE FROM gl_mappings WHERE mapping_key = ? AND ref_id IS NULL',
      [mappingKey],
    )
    await siteExecute(
      siteId,
      'INSERT INTO gl_mappings (mapping_key, ref_id, account_id) VALUES (?, NULL, ?)',
      [mappingKey, accountId],
    )
  } else {
    await siteExecute(
      siteId,
      `INSERT INTO gl_mappings (mapping_key, ref_id, account_id) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE account_id = VALUES(account_id)`,
      [mappingKey, refId, accountId],
    )
  }

  await logActivity(siteId, actor, {
    entity: 'gl',
    entityId: accountId,
    action: 'mapping_set',
    detail: `${mappingKey}${refId ? ` #${refId}` : ' (default)'} now posts to ${account.accountCode} — ${account.name}`,
  })

  return { ok: true }
}

/* ── Reconciliation of the invariant ─────────────────────────────────────── */

export type AccountDrift = {
  id: number
  accountCode: string
  name: string
  stored: number
  computed: number
  drift: number
}

/**
 * Accounts whose stored balance disagrees with their journal lines.
 *
 * The GL's own version of reconcileBalances(). Reports rather than repairs, for
 * the same reason: silently correcting a drift hides the posting bug that
 * caused it.
 */
export async function reconcileAccountBalances(siteId: number): Promise<AccountDrift[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT a.id, a.account_code, a.name,
            a.balance AS stored,
            COALESCE(l.total, 0) AS computed,
            a.balance - COALESCE(l.total, 0) AS drift
       FROM gl_accounts a
       LEFT JOIN (
             SELECT jl.account_id, SUM(jl.amount) AS total
               FROM journal_lines jl
               JOIN journal_batches b ON b.id = jl.batch_id
              WHERE b.status = 'posted'
              GROUP BY jl.account_id
            ) l ON l.account_id = a.id
      WHERE ABS(a.balance - COALESCE(l.total, 0)) > 0.0001
      ORDER BY ABS(a.balance - COALESCE(l.total, 0)) DESC`,
  )

  return rows.map((r) => ({
    id: Number(r.id),
    accountCode: String(r.account_code),
    name: String(r.name),
    stored: toNum(r.stored),
    computed: toNum(r.computed),
    drift: toNum(r.drift),
  }))
}

export type ControlDrift = {
  accountCode: string
  name: string
  controlType: ControlType
  /** What the GL says. */
  glBalance: number
  /** What the subledger says. */
  subledgerBalance: number
  drift: number
  /**
   * Set when the figures came from the whole GROUP rather than this store.
   *
   * A shared customer file has one balance for every branch, so it can only be
   * proved against the sum of their debtors control accounts — see
   * reconcileControlAccounts(). Present so a screen can say which question was
   * answered rather than showing a group figure under a store's name.
   */
  scope?: { level: 'group'; stores: number; unreadable: number[] }
}

/**
 * Control accounts against the subledgers that own them.
 *
 * THE CHECK THAT MATTERS. The GL is a derived mirror (see 045), so the two can
 * drift — a posting path that moved a subledger without its journal, or the
 * reverse. This finds it.
 *
 * Anything reported here means a figure on the balance sheet disagrees with the
 * detail behind it, which is the one thing an accountant will not accept.
 */
export async function reconcileControlAccounts(siteId: number): Promise<ControlDrift[]> {
  const controls = await siteQuery<Row>(
    siteId,
    `${SELECT_ACCOUNT} WHERE control_type IS NOT NULL AND is_active = TRUE`,
  )

  const drifts: ControlDrift[] = []

  for (const raw of controls) {
    const account = mapAccount(raw)
    if (!account.controlType) continue

    let subledgerBalance = 0
    // Both replaced only by the shared-debtors case below, which compares a
    // group total against a group total rather than this store's figures.
    let glBalance = account.balance
    let groupScope: ControlDrift['scope']

    switch (account.controlType) {
      case 'debtors': {
        /*
         * ── ONE DEBTORS BOOK, SEVERAL SETS OF BOOKS ───────────────────────
         *
         * With a shared customer file the balance is the GROUP's: a payment
         * taken at store 3 settles an invoice raised at store 7, and there is
         * no honest way to split that per branch. So the comparison moves up a
         * level — the shared balance against the SUM of every member's debtors
         * control account.
         *
         * That is legitimate precisely because sharing is only offered to a
         * group that has declared itself ONE legal entity (016). One entity,
         * one debtors book, one reconciliation. Narrowing the shared balance to
         * a per-store share instead would make this check pass while proving
         * nothing, which is worse than reporting a difference.
         *
         * A single store, or a group that does not share, takes the ordinary
         * path below and nothing changes.
         */
        const row = await customerQueryOne<Row>(
          siteId,
          'SELECT COALESCE(SUM(balance), 0) AS total FROM customers',
        )
        subledgerBalance = toNum(row?.total)

        const group = await debtorsGroupScope(siteId)
        /*
         * ── `group !== null`, NOT `if (group)` — AND THAT IS LOAD-BEARING ──
         *
         * `if (group)` here compiled to something that entered its own body
         * with `group === null`, and threw on the next line reading .scope.
         * Not a theory: a console.log INSIDE the guard printed `null`, one
         * line after the guard was supposed to have excluded it, and the
         * trial balance 500ed for every store because of it.
         *
         * It reproduces only under the dev server (Next 16 / Turbopack), on
         * a clean .next — calling this function directly from a script, even
         * concurrently exactly as the page does, passes every time. So it is
         * a codegen fault rather than anything about this logic.
         *
         * The explicit comparison is immune, and it is the whole fix. Do not
         * shorten it back to a truthiness check because a linter suggests it.
         */
        if (group !== null && group !== undefined) {
          groupScope = group.scope
          // Replaces this account's own balance, not adds to it: the sum
          // already includes this store's control account.
          glBalance = group.controlTotal
        }
        break
      }
      case 'creditors': {
        // Reads the whole shared book when the file is shared, exactly as the
        // debtors case does — supplierQueryOne resolves the owner.
        const row = await supplierQueryOne<Row>(
          siteId,
          'SELECT COALESCE(SUM(balance), 0) AS total FROM suppliers',
        )
        // Creditors are a liability: positive in the subledger means we owe,
        // which is a CREDIT in the GL, so the sign flips.
        subledgerBalance = -toNum(row?.total)

        // And so must the GL side. Without this the group's creditors were
        // compared against ONE store's control account and every branch
        // reported drift equal to the others' creditors, for ever.
        const group = await creditorsGroupScope(siteId)
        // Explicit, for the reason spelled out on the debtors branch above.
        if (group !== null && group !== undefined) {
          groupScope = group.scope
          // Replaces this account's own balance, not adds to it: the sum
          // already includes this store's control account.
          glBalance = group.controlTotal
        }
        break
      }
      case 'bank': {
        const row = await siteQueryOne<Row>(
          siteId,
          account.controlRefId
            ? 'SELECT COALESCE(SUM(balance), 0) AS total FROM bank_accounts WHERE id = ?'
            : 'SELECT COALESCE(SUM(balance), 0) AS total FROM bank_accounts',
          account.controlRefId ? [account.controlRefId] : [],
        )
        subledgerBalance = toNum(row?.total)
        break
      }
      default:
        // stock, vat_input and vat_output have no single stored figure to
        // compare against — they are proved by their own reports instead.
        continue
    }

    const drift = round2(glBalance - subledgerBalance)
    if (Math.abs(drift) > 0.004) {
      drifts.push({
        accountCode: account.accountCode,
        name: account.name,
        controlType: account.controlType,
        glBalance,
        subledgerBalance,
        drift,
        ...(groupScope !== undefined ? { scope: groupScope } : {}),
      })
    }
  }

  return drifts
}

/**
 * Every member store's debtors control account, added up.
 *
 * Returns null when this store's debtors book is its own, which is every single
 * shop and every group that has not switched sharing on — the caller then takes
 * the ordinary per-store path and nothing about the check changes.
 *
 * ── "OWNS ITS OWN CUSTOMERS" IS NOT THE SAME QUESTION ─────────────────────
 *
 * This used to return null whenever customerOwnerSite(siteId) resolved to the
 * caller, as a shorthand for "not sharing". It is true at every branch and
 * FALSE at the primary: a primary hosting the group's file resolves to itself
 * while its customers table holds the whole group's debtors.
 *
 * So head office — the one place that reconciles the whole book — took the
 * per-store path and compared its own debtors control account against the
 * GROUP's sub-ledger total. It reported drift equal to every other branch's
 * debtors, with no scope marker to explain it, growing daily and repairable by
 * nothing. Measured at 55.1m against a demo group of two in
 * scripts/probe-shared-customer-accounting.ts.
 *
 * The question this has to ask is whether the FILE is shared, not whether this
 * store happens to hold it. customerFileIsShared() answers exactly that and is
 * true at both ends of a sharing group.
 *
 * ── WHY MEMBERSHIP IS RE-RESOLVED RATHER THAN FILTERED ON THE FLAG ────────
 *
 * shares_customers is what a member ASKED for; it is not what the resolver
 * DOES. ownerSiteFor() applies four further conditions — the group being one
 * legal entity, the primary sharing too, and both ends holding multi_branch —
 * and a store failing any of them keeps its own separate debtors book while
 * its flag still reads 1.
 *
 * Adding such a store's control account to this total would invent drift on
 * every other branch's trial balance equal to that store's own debtors: its GL
 * is counted here while its sub-ledger is not in the shared file. So each
 * member is asked where it actually routes, and only the ones that genuinely
 * land on this owner are counted. A lapsed Multi-Branch entitlement then
 * quietly narrows the check instead of breaking it.
 *
 * ── WHY A STORE THAT CANNOT BE READ IS NAMED RATHER THAN SKIPPED ──────────
 *
 * A missing branch makes the total too small, which reads as drift — money
 * apparently unaccounted for. Reporting "3 stores, 1 unreadable" lets a screen
 * say the figure is incomplete; silently dropping it would invent a discrepancy
 * and send somebody hunting for a posting error that does not exist.
 *
 * Never throws. A control-database problem must not take the accounting screen
 * down, and falling back to the per-store comparison is the same answer the
 * site gave before any of this existed.
 */
async function debtorsGroupScope(
  siteId: number,
): Promise<{ controlTotal: number; scope: NonNullable<ControlDrift['scope']> } | null> {
  const { customerOwnerSite, customerFileIsShared } = await import('../storeGroups')
  return controlGroupScope(siteId, 'debtors', customerFileIsShared, customerOwnerSite)
}

/**
 * The same, for the creditors control account.
 *
 * ── WHY THIS DID NOT EXIST, AND WHY THAT WAS A LIVE BUG ──────────────────
 *
 * The creditors branch of reconcileControlAccounts already reads its
 * sub-ledger through supplierQueryOne — so with a shared supplier file it was
 * ALREADY summing the whole group's creditors — and compared that against this
 * one store's creditors control account. Every branch would report drift equal
 * to the other branches' creditors, permanently, with no scope marker to
 * explain it.
 *
 * Exactly the fault the debtors side had at the primary, and it was missed for
 * the opposite reason: nothing exercises supplier sharing yet, so nobody had
 * seen the number come out wrong. Fixed now rather than when the supplier
 * modules land, because the flag column already exists and a group that set it
 * would meet this today.
 */
async function creditorsGroupScope(
  siteId: number,
): Promise<{ controlTotal: number; scope: NonNullable<ControlDrift['scope']> } | null> {
  const { supplierOwnerSite, supplierFileIsShared } = await import('../storeGroups')
  return controlGroupScope(siteId, 'creditors', supplierFileIsShared, supplierOwnerSite)
}

/**
 * One control account summed across every member that shares this file.
 *
 * Written once and given the file's resolver, rather than twice: the debtors
 * version has already been wrong twice — once taking the per-store path at the
 * primary, once counting members whose flag was set but who did not actually
 * route here — and a copy would be a third place to get it right.
 */
async function controlGroupScope(
  siteId: number,
  controlType: 'debtors' | 'creditors',
  fileIsShared: (siteId: number) => Promise<boolean>,
  ownerOf: (siteId: number) => Promise<{ siteId: number }>,
): Promise<{ controlTotal: number; scope: NonNullable<ControlDrift['scope']> } | null> {
  try {
    const { groupForSite, membersOfGroup } = await import('../storeGroups')
    if (!(await fileIsShared(siteId))) return null

    // Where THIS store's sub-ledger actually lives. Every member counted below
    // must agree with it, or their control accounts are being added to a total
    // the sub-ledger side does not cover.
    const owner = await ownerOf(siteId)

    const group = await groupForSite(siteId)
    if (!group) return null

    const candidates = (await membersOfGroup(group.id)).filter((m) => m.hasDatabase)
    const members: typeof candidates = []
    for (const m of candidates) {
      const theirOwner = await ownerOf(m.siteId)
      if (theirOwner.siteId === owner.siteId) members.push(m)
    }
    if (members.length === 0) return null

    let controlTotal = 0
    const unreadable: number[] = []
    for (const member of members) {
      try {
        // Summed across every control account of this type in that store,
        // because a chart may legitimately carry more than one.
        const row = await siteQueryOne<Row>(
          member.siteId,
          `SELECT COALESCE(SUM(balance), 0) AS total FROM gl_accounts
            WHERE control_type = ? AND is_active = TRUE`,
          [controlType],
        )
        controlTotal += toNum(row?.total)
      } catch {
        unreadable.push(member.siteId)
      }
    }

    return {
      controlTotal: round2(controlTotal),
      scope: { level: 'group', stores: members.length, unreadable },
    }
  } catch {
    return null
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS }
export type { AccountType, ControlType }
