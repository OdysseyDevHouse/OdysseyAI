import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { today } from './ledger'
import {
  isConfidentMatch,
  rankMatches,
  reconcile,
  refuseLink,
  type MatchCandidate,
  type MatchScore,
  type BankTxnStatus,
} from './cashbookRules'

/**
 * The cashbook: money moving through bank, cash and card accounts.
 *
 * THE INVARIANT, as in every other ledger here: bank_accounts.balance equals
 * opening_balance plus SUM(amount_signed) over non-void rows. Both move in one
 * transaction; nothing else writes balance; reconcileBankBalances() proves it.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
 *
 * It is NOT a second copy of the sub-ledger. A customer payment already exists
 * in customer_transactions; the bank row here records that the MONEY ARRIVED,
 * which is a different fact on a different date. The two are joined by
 * cashbook_links, and the gap between them is the reconciliation.
 *
 * Posting a receipt therefore creates BOTH rows and the link between them, and
 * that is the normal path — see recordCustomerReceipt(). Capturing a bank row
 * on its own is for movements with no sub-ledger side at all: bank charges,
 * interest received, an owner's drawing.
 */

export type BankTransaction = {
  id: number
  bankAccountId: number
  txnDate: string
  amountSigned: number
  description: string | null
  reference: string | null
  status: BankTxnStatus
  reconciliationId: number | null
  source: string
  sourceDocId: number | null
  importKey: string | null
  userName: string
  createdAt: Date
  /** Running balance after this line, oldest first. Only set by listTransactions. */
  runningBalance?: number
  /** How much of this line is already tied to sub-ledger rows. */
  linkedAmount?: number
  /** Signed remainder still to explain. Zero when fully matched. */
  unlinkedAmount?: number
}

type Row = RowDataPacket & Record<string, unknown>

function mapTxn(r: Row): BankTransaction {
  return {
    id: Number(r.id),
    bankAccountId: Number(r.bank_account_id),
    txnDate: String(r.txn_date),
    amountSigned: toNum(r.amount_signed),
    description: (r.description as string | null) ?? null,
    reference: (r.reference as string | null) ?? null,
    status: String(r.status) as BankTxnStatus,
    reconciliationId: r.reconciliation_id === null ? null : Number(r.reconciliation_id),
    source: String(r.source),
    sourceDocId: r.source_doc_id === null ? null : Number(r.source_doc_id),
    importKey: (r.import_key as string | null) ?? null,
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
  }
}

const SELECT_TXN = `
  SELECT id, bank_account_id, txn_date, amount_signed, description, reference,
         status, reconciliation_id, source, source_doc_id, import_key, user_name, created_at
    FROM bank_transactions
`

/* ── Reads ───────────────────────────────────────────────────────────────── */

export type TransactionOptions = {
  from?: string
  to?: string
  status?: BankTxnStatus
  /** Only rows not fully tied to a sub-ledger row — the reconciliation worklist. */
  unmatchedOnly?: boolean
  limit?: number
}

/**
 * One account's movements, oldest first, with a running balance.
 *
 * The running balance starts from the account's opening balance, so the last
 * row's total equals the account's stored balance — which is the check a person
 * does by eye, and it must come out.
 *
 * `linkedAmount` comes from a correlated subquery rather than a join: a row can
 * have many links, and a join would multiply the transaction rows and quietly
 * break the running balance.
 */
export async function listTransactions(
  siteId: number,
  bankAccountId: number,
  opts: TransactionOptions = {},
): Promise<BankTransaction[]> {
  const where: string[] = ['t.bank_account_id = ?']
  const params: unknown[] = [bankAccountId]

  if (opts.from) {
    where.push('t.txn_date >= ?')
    params.push(opts.from)
  }
  if (opts.to) {
    where.push('t.txn_date <= ?')
    params.push(opts.to)
  }
  if (opts.status) {
    where.push('t.status = ?')
    params.push(opts.status)
  }

  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000)

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT t.*, (
              SELECT COALESCE(SUM(l.amount), 0) FROM cashbook_links l WHERE l.bank_txn_id = t.id
            ) AS linked_amount
       FROM bank_transactions t
      WHERE ${where.join(' AND ')}
      ORDER BY t.txn_date ASC, t.id ASC
      LIMIT ${limit}`,
    params,
  )

  const account = await siteQueryOne<Row>(
    siteId,
    'SELECT opening_balance FROM bank_accounts WHERE id = ? LIMIT 1',
    [bankAccountId],
  )
  let running = toNum(account?.opening_balance)

  const mapped = rows.map((r) => {
    const line = mapTxn(r)
    if (line.status !== 'void') running = round(running + line.amountSigned, 2)
    line.runningBalance = running

    const linked = toNum(r.linked_amount)
    line.linkedAmount = linked
    // Signed remainder: a receipt of 500 with 200 linked still has 300 to
    // explain, and it is still money IN, so the sign is preserved.
    const remainder = round(Math.abs(line.amountSigned) - linked, 2)
    line.unlinkedAmount = line.amountSigned < 0 ? -remainder : remainder
    return line
  })

  return opts.unmatchedOnly ? mapped.filter((l) => Math.abs(l.unlinkedAmount ?? 0) > 0.004) : mapped
}

export async function getTransaction(siteId: number, id: number): Promise<BankTransaction | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_TXN} WHERE id = ? LIMIT 1`, [id])
  return row ? mapTxn(row) : null
}

/** How much of a bank row is already linked. Positive magnitude. */
export async function linkedAmount(siteId: number, bankTxnId: number): Promise<number> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT COALESCE(SUM(amount), 0) AS total FROM cashbook_links WHERE bank_txn_id = ?',
    [bankTxnId],
  )
  return toNum(row?.total)
}

/* ── Capturing ───────────────────────────────────────────────────────────── */

export type CaptureInput = {
  bankAccountId: number
  txnDate?: string
  /** Signed: positive into the account, negative out. */
  amount: number
  description?: string | null
  reference?: string | null
  source?: string
  sourceDocId?: number | null
  importKey?: string | null
  importBatchId?: number | null
}

export type CaptureResult = { ok: true; id: number } | { ok: false; error: string }

export function validateCapture(input: CaptureInput): string | null {
  if (!Number.isFinite(input.amount) || round(input.amount, 2) === 0) {
    return 'Enter an amount.'
  }
  if (Math.abs(input.amount) > 999_999_999) return 'That amount is too large.'
  if (input.txnDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.txnDate)) {
    return 'That date is not valid.'
  }
  return null
}

/**
 * Records one movement and moves the account balance, atomically.
 *
 * Both writes or neither, for the reason postTransaction() gives: a row without
 * its balance move leaves an account understating what it holds, and a balance
 * move without its row leaves a figure nobody can explain.
 */
export async function captureTransaction(
  siteId: number,
  actor: Actor,
  input: CaptureInput,
): Promise<CaptureResult> {
  const invalid = validateCapture(input)
  if (invalid) return { ok: false, error: invalid }

  const account = await siteQueryOne<Row>(
    siteId,
    "SELECT id, code, status FROM bank_accounts WHERE id = ? LIMIT 1",
    [input.bankAccountId],
  )
  if (!account) return { ok: false, error: 'That account no longer exists.' }
  if (String(account.status) === 'closed') {
    return { ok: false, error: 'That account is closed.' }
  }

  const amount = round(input.amount, 2)
  const txnDate = input.txnDate ?? today()

  return siteTransaction(siteId, async (tx) => {
    const id = await insertTxn(tx, { ...input, amount, txnDate }, actor)
    await bumpBankBalance(tx, input.bankAccountId, amount)
    return { ok: true as const, id }
  })
}

/**
 * The insert half, shared with the importer and the receipt path.
 *
 * Takes an open transaction rather than opening one, so a caller that is
 * already writing a customer payment can put the bank row in the SAME
 * transaction. Does NOT move the balance — the caller does, because a batch
 * import moves it once for many rows rather than once per row.
 */
async function insertTxn(
  tx: PoolConnection,
  input: CaptureInput & { amount: number; txnDate: string },
  actor: Actor,
): Promise<number> {
  const [res] = await tx.execute(
    `INSERT INTO bank_transactions
       (bank_account_id, txn_date, amount_signed, description, reference,
        source, source_doc_id, import_key, import_batch_id, user_id, user_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.bankAccountId,
      input.txnDate,
      input.amount.toFixed(4),
      input.description?.trim().slice(0, 255) || null,
      input.reference?.trim().slice(0, 120) || null,
      input.source ?? 'manual',
      input.sourceDocId ?? null,
      input.importKey ?? null,
      input.importBatchId ?? null,
      actor.userId,
      actor.userName.slice(0, 120),
    ] as never,
  )
  return (res as { insertId: number }).insertId
}

/** The only place bank_accounts.balance is ever written. */
async function bumpBankBalance(
  tx: PoolConnection,
  bankAccountId: number,
  delta: number,
): Promise<void> {
  await tx.execute('UPDATE bank_accounts SET balance = balance + ? WHERE id = ?', [
    delta.toFixed(4),
    bankAccountId,
  ] as never)
}

/**
 * Voids a captured row.
 *
 * Kept, never deleted, per 014's rule — but unlike the sub-ledger this does not
 * post a reversing row. A bank line is an observation rather than a document:
 * nobody holds a printed copy of it, and a statement showing a movement beside
 * its cancelling twin is harder to read than one showing the movement struck
 * through. The balance is backed out and the row stays visible as void.
 */
export async function voidTransaction(
  siteId: number,
  actor: Actor,
  id: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!reason?.trim()) return { ok: false, error: 'Give a reason.' }

  const txn = await getTransaction(siteId, id)
  if (!txn) return { ok: false, error: 'That transaction no longer exists.' }
  if (txn.status === 'void') return { ok: false, error: 'That transaction is already void.' }
  if (txn.status === 'reconciled') {
    return {
      ok: false,
      error: 'That line is part of a completed reconciliation. Reopen the reconciliation first.',
    }
  }

  const linked = await linkedAmount(siteId, id)
  if (linked > 0) {
    return { ok: false, error: 'That line is matched to a payment. Unmatch it first.' }
  }

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      "UPDATE bank_transactions SET status = 'void', description = CONCAT(COALESCE(description,''), ' · VOID: ', ?) WHERE id = ?",
      [reason.trim().slice(0, 120), id] as never,
    )
    await bumpBankBalance(tx, txn.bankAccountId, -txn.amountSigned)
    await logActivityTx(tx, actor, {
      entity: 'bank',
      entityId: txn.bankAccountId,
      action: 'void',
      detail: `Voided ${txn.amountSigned.toFixed(2)} of ${txn.txnDate} — ${reason.trim()}`,
    })
  })

  return { ok: true }
}

/* ── Receipts: the sub-ledger and the bank together ──────────────────────── */

export type ReceiptInput = {
  customerId: number
  bankAccountId: number
  amount: number
  receiptDate?: string
  reference?: string | null
  description?: string | null
  /** Match against the oldest open invoices straight away. */
  autoAllocate?: boolean
}

/**
 * Records money received from a customer: ledger row, bank row, and the link.
 *
 * This is the path that makes the cashbook worth having. Before it, a payment
 * reduced a debtor's balance and nothing said where the money went; now the
 * same action says both, and the two can be reconciled against a statement.
 *
 * Ordering matters and is deliberate. The customer payment posts FIRST via the
 * sub-ledger's own function, so its invariant and its auto-allocation behave
 * exactly as they do everywhere else. The bank row and link follow. A failure
 * after the payment leaves an unlinked receipt — visible, fixable, and far
 * better than a bank row referring to a payment that does not exist.
 */
export async function recordCustomerReceipt(
  siteId: number,
  actor: Actor,
  input: ReceiptInput,
): Promise<{ ok: true; customerTxnId: number; bankTxnId: number } | { ok: false; error: string }> {
  const { postTransaction } = await import('./customerLedger')

  if (!Number.isFinite(input.amount) || round(input.amount, 2) <= 0) {
    return { ok: false, error: 'Enter a positive amount.' }
  }

  const account = await siteQueryOne<Row>(
    siteId,
    "SELECT id, status FROM bank_accounts WHERE id = ? LIMIT 1",
    [input.bankAccountId],
  )
  if (!account) return { ok: false, error: 'Choose an account for the money to go into.' }
  if (String(account.status) === 'closed') return { ok: false, error: 'That account is closed.' }

  const receiptDate = input.receiptDate ?? today()

  const posted = await postTransaction(siteId, actor, {
    customerId: input.customerId,
    docType: 'payment',
    amount: round(input.amount, 2),
    docDate: receiptDate,
    reference: input.reference ?? null,
    description: input.description ?? 'Receipt',
    source: 'receipt',
    autoAllocate: input.autoAllocate ?? true,
  })
  if (!posted.ok) return posted

  const bank = await siteTransaction(siteId, async (tx) => {
    const bankTxnId = await insertTxn(
      tx,
      {
        bankAccountId: input.bankAccountId,
        // Positive: money INTO the account. The customer side posted negative
        // (they owe less) — opposite signs for the same event, as designed.
        amount: round(input.amount, 2),
        txnDate: receiptDate,
        description: input.description?.trim() || 'Customer receipt',
        reference: input.reference ?? null,
        source: 'receipt',
        sourceDocId: posted.id,
      },
      actor,
    )
    await bumpBankBalance(tx, input.bankAccountId, round(input.amount, 2))

    await tx.execute(
      `INSERT INTO cashbook_links
         (bank_txn_id, customer_txn_id, amount, match_type, confidence, user_id, user_name)
       VALUES (?,?,?,'manual',100,?,?)`,
      [
        bankTxnId,
        posted.id,
        round(input.amount, 2).toFixed(4),
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )

    return bankTxnId
  })

  return { ok: true, customerTxnId: posted.id, bankTxnId: bank }
}

/* ── Linking ─────────────────────────────────────────────────────────────── */

export type LinkResult = { ok: true; linked: number } | { ok: false; error: string }

/**
 * Ties a bank line to a sub-ledger payment.
 *
 * Unlike an allocation, this moves NO money and touches NO balance: both rows
 * already exist and both balances are already right. A link only records that
 * they describe the same event — which is what makes one of them stop being a
 * reconciling item.
 */
export async function linkTransaction(
  siteId: number,
  actor: Actor,
  bankTxnId: number,
  side: 'customer' | 'supplier',
  ledgerTxnId: number,
  amount: number,
  opts: { matchType?: 'auto' | 'manual'; confidence?: number } = {},
): Promise<LinkResult> {
  const bank = await getTransaction(siteId, bankTxnId)
  if (!bank) return { ok: false, error: 'That bank line no longer exists.' }
  if (bank.status === 'void') return { ok: false, error: 'That bank line is void.' }

  const table = side === 'customer' ? 'customer_transactions' : 'supplier_transactions'
  const ledger = await siteQueryOne<Row>(
    siteId,
    `SELECT id, amount_signed FROM ${table} WHERE id = ? LIMIT 1`,
    [ledgerTxnId],
  )
  if (!ledger) return { ok: false, error: 'That transaction no longer exists.' }

  const already = await linkedAmount(siteId, bankTxnId)
  const refusal = refuseLink(bank.amountSigned, toNum(ledger.amount_signed), already, amount)
  if (refusal) return { ok: false, error: refusal }

  const value = round(amount, 2)
  const column = side === 'customer' ? 'customer_txn_id' : 'supplier_txn_id'

  await siteExecute(
    siteId,
    `INSERT INTO cashbook_links
       (bank_txn_id, ${column}, amount, match_type, confidence, user_id, user_name)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount), linked_at = CURRENT_TIMESTAMP`,
    [
      bankTxnId,
      ledgerTxnId,
      value.toFixed(4),
      opts.matchType ?? 'manual',
      Math.min(Math.max(opts.confidence ?? 100, 0), 100),
      actor.userId,
      actor.userName.slice(0, 120),
    ],
  )

  return { ok: true, linked: value }
}

/** Undoes one link. Neither balance moves, for the reason linkTransaction gives. */
export async function unlinkTransaction(
  siteId: number,
  actor: Actor,
  linkId: number,
): Promise<LinkResult> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT id, bank_txn_id, amount FROM cashbook_links WHERE id = ? LIMIT 1',
    [linkId],
  )
  if (!row) return { ok: false, error: 'That match no longer exists.' }

  const bank = await getTransaction(siteId, Number(row.bank_txn_id))
  if (bank?.status === 'reconciled') {
    return {
      ok: false,
      error: 'That match is part of a completed reconciliation. Reopen the reconciliation first.',
    }
  }

  await siteExecute(siteId, 'DELETE FROM cashbook_links WHERE id = ?', [linkId])
  await logActivity(siteId, actor, {
    entity: 'bank',
    entityId: bank?.bankAccountId ?? null,
    action: 'unmatch',
    detail: `Unmatched ${toNum(row.amount).toFixed(2)}`,
  })
  return { ok: true, linked: toNum(row.amount) }
}

export type LinkDetail = {
  id: number
  side: 'customer' | 'supplier'
  ledgerTxnId: number
  partyName: string
  docNumber: string | null
  docDate: string
  amount: number
  matchType: 'auto' | 'manual'
  confidence: number
  userName: string
}

/** What a bank line is matched to, for the detail panel. */
export async function linksFor(siteId: number, bankTxnId: number): Promise<LinkDetail[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT l.id, l.amount, l.match_type, l.confidence, l.user_name,
            l.customer_txn_id, l.supplier_txn_id,
            ct.doc_number AS c_doc, ct.doc_date AS c_date, c.name AS c_name,
            st.doc_number AS s_doc, st.doc_date AS s_date, s.name AS s_name
       FROM cashbook_links l
       LEFT JOIN customer_transactions ct ON ct.id = l.customer_txn_id
       LEFT JOIN customers c             ON c.id = ct.customer_id
       LEFT JOIN supplier_transactions st ON st.id = l.supplier_txn_id
       LEFT JOIN suppliers s             ON s.id = st.supplier_id
      WHERE l.bank_txn_id = ?
      ORDER BY l.linked_at`,
    [bankTxnId],
  )

  return rows.map((r) => {
    const isCustomer = r.customer_txn_id !== null
    return {
      id: Number(r.id),
      side: isCustomer ? ('customer' as const) : ('supplier' as const),
      ledgerTxnId: Number(isCustomer ? r.customer_txn_id : r.supplier_txn_id),
      partyName: String((isCustomer ? r.c_name : r.s_name) ?? ''),
      docNumber: ((isCustomer ? r.c_doc : r.s_doc) as string | null) ?? null,
      docDate: String((isCustomer ? r.c_date : r.s_date) ?? ''),
      amount: toNum(r.amount),
      matchType: String(r.match_type) as 'auto' | 'manual',
      confidence: Number(r.confidence),
      userName: String(r.user_name ?? ''),
    }
  })
}

/* ── Finding matches ─────────────────────────────────────────────────────── */

export type MatchSuggestion = MatchScore & {
  side: 'customer' | 'supplier'
  ledgerTxnId: number
  partyName: string
  docNumber: string | null
  docDate: string
  amount: number
}

/**
 * Candidate sub-ledger rows for one bank line.
 *
 * Only payments that are not already fully linked, within a generous date
 * window either side. The window is 60 days rather than unlimited because an
 * unmatched payment older than that is a data problem rather than a timing one,
 * and scanning years of history to score them all makes the screen slow for no
 * benefit.
 *
 * Which side is searched follows the sign: money in can only be a customer
 * receipt, money out only a supplier payment. That halves the work and removes
 * a whole class of nonsense suggestion.
 */
export async function suggestMatches(
  siteId: number,
  bankTxnId: number,
  limit = 5,
): Promise<MatchSuggestion[]> {
  const bank = await getTransaction(siteId, bankTxnId)
  if (!bank || bank.status === 'void') return []

  const already = await linkedAmount(siteId, bankTxnId)
  const remainder = round(Math.abs(bank.amountSigned) - already, 2)
  if (remainder <= 0) return []

  const side: 'customer' | 'supplier' = bank.amountSigned > 0 ? 'customer' : 'supplier'
  const [table, partyTable, partyKey, linkColumn] =
    side === 'customer'
      ? ['customer_transactions', 'customers', 'customer_id', 'customer_txn_id']
      : ['supplier_transactions', 'suppliers', 'supplier_id', 'supplier_txn_id']

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT t.id, t.doc_number, t.doc_date, t.amount_signed, t.reference, t.description,
            p.name AS party_name, p.code AS party_code,
            COALESCE(l.linked, 0) AS linked
       FROM ${table} t
       JOIN ${partyTable} p ON p.id = t.${partyKey}
       LEFT JOIN (
             SELECT ${linkColumn} AS txn_id, SUM(amount) AS linked
               FROM cashbook_links WHERE ${linkColumn} IS NOT NULL GROUP BY ${linkColumn}
            ) l ON l.txn_id = t.id
      WHERE t.doc_type = 'payment'
        AND t.doc_date BETWEEN DATE_SUB(?, INTERVAL 60 DAY) AND DATE_ADD(?, INTERVAL 60 DAY)
        AND ABS(t.amount_signed) - COALESCE(l.linked, 0) > 0.004
      ORDER BY t.doc_date DESC
      LIMIT 400`,
    [bank.txnDate, bank.txnDate],
  )

  const bankCandidate: MatchCandidate = {
    id: bank.id,
    date: bank.txnDate,
    amount: bank.amountSigned,
    reference: bank.reference,
    description: bank.description,
  }

  const byId = new Map<number, Row>()
  const candidates: MatchCandidate[] = rows.map((r) => {
    byId.set(Number(r.id), r)
    return {
      id: Number(r.id),
      date: String(r.doc_date),
      // Score against what is LEFT of the payment, not its face value: a
      // half-linked payment should match a bank line for the remainder.
      amount:
        toNum(r.amount_signed) < 0
          ? -round(Math.abs(toNum(r.amount_signed)) - toNum(r.linked), 2)
          : round(Math.abs(toNum(r.amount_signed)) - toNum(r.linked), 2),
      reference: (r.reference as string | null) ?? null,
      description: (r.description as string | null) ?? null,
      partyName: (r.party_name as string | null) ?? null,
      partyCode: (r.party_code as string | null) ?? null,
    }
  })

  return rankMatches(bankCandidate, candidates, limit).map((score) => {
    const row = byId.get(score.candidateId)
    return {
      ...score,
      side,
      ledgerTxnId: score.candidateId,
      partyName: String(row?.party_name ?? ''),
      docNumber: (row?.doc_number as string | null) ?? null,
      docDate: String(row?.doc_date ?? ''),
      amount: toNum(row?.amount_signed),
    }
  })
}

/**
 * Links every bank line whose best match is unambiguous.
 *
 * Uses isConfidentMatch, so a tie is never taken automatically however high it
 * scores — see that function for why. Everything it declines to touch is left
 * on the reconciliation screen for a person, which is the correct outcome
 * rather than a failure.
 */
export async function autoMatch(
  siteId: number,
  actor: Actor,
  bankAccountId: number,
  opts: { from?: string; to?: string } = {},
): Promise<{ matched: number; considered: number }> {
  const unmatched = await listTransactions(siteId, bankAccountId, {
    ...opts,
    status: 'unreconciled',
    unmatchedOnly: true,
  })

  let matched = 0

  for (const line of unmatched) {
    const suggestions = await suggestMatches(siteId, line.id, 2)
    if (!isConfidentMatch(suggestions)) continue

    const best = suggestions[0]
    const result = await linkTransaction(
      siteId,
      actor,
      line.id,
      best.side,
      best.ledgerTxnId,
      Math.min(Math.abs(line.unlinkedAmount ?? 0), Math.abs(best.amount)),
      { matchType: 'auto', confidence: best.confidence },
    )
    if (result.ok) matched++
  }

  if (matched > 0) {
    await logActivity(siteId, actor, {
      entity: 'bank',
      entityId: bankAccountId,
      action: 'auto_match',
      detail: `Matched ${matched} of ${unmatched.length} unreconciled line${unmatched.length === 1 ? '' : 's'}`,
    })
  }

  return { matched, considered: unmatched.length }
}

/* ── Reconciliation ──────────────────────────────────────────────────────── */

export type Reconciliation = {
  id: number
  bankAccountId: number
  statementDate: string
  statementBalance: number
  bookBalance: number
  unreconciledTotal: number
  difference: number
  status: 'draft' | 'completed'
  matchedCount: number
  notes: string | null
  userName: string
  completedAt: Date | null
  createdAt: Date
}

function mapRecon(r: Row): Reconciliation {
  return {
    id: Number(r.id),
    bankAccountId: Number(r.bank_account_id),
    statementDate: String(r.statement_date),
    statementBalance: toNum(r.statement_balance),
    bookBalance: toNum(r.book_balance),
    unreconciledTotal: toNum(r.unreconciled_total),
    difference: toNum(r.difference),
    status: String(r.status) as 'draft' | 'completed',
    matchedCount: Number(r.matched_count),
    notes: (r.notes as string | null) ?? null,
    userName: String(r.user_name ?? ''),
    completedAt: (r.completed_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

export async function listReconciliations(
  siteId: number,
  bankAccountId: number,
  limit = 20,
): Promise<Reconciliation[]> {
  const capped = Math.min(Math.max(limit, 1), 100)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM bank_reconciliations WHERE bank_account_id = ?
      ORDER BY statement_date DESC LIMIT ${capped}`,
    [bankAccountId],
  )
  return rows.map(mapRecon)
}

export async function getReconciliation(
  siteId: number,
  id: number,
): Promise<Reconciliation | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT * FROM bank_reconciliations WHERE id = ? LIMIT 1',
    [id],
  )
  return row ? mapRecon(row) : null
}

/**
 * Works out where an account stands against a statement, without saving.
 *
 * The live figure behind the reconciliation screen: it recomputes on every
 * keystroke of the statement balance, so it must not write anything. Signing
 * off is completeReconciliation() below.
 *
 * `unreconciledTotal` counts only rows dated ON OR BEFORE the statement date. A
 * payment captured for next week is not a reconciling item for this statement —
 * including it would show a difference that no amount of matching could clear.
 */
export async function previewReconciliation(
  siteId: number,
  bankAccountId: number,
  statementDate: string,
  statementBalance: number,
): Promise<
  ReturnType<typeof reconcile> & { unreconciledCount: number; matchedCount: number }
> {
  const [account, totals] = await Promise.all([
    siteQueryOne<Row>(
      siteId,
      'SELECT opening_balance FROM bank_accounts WHERE id = ? LIMIT 1',
      [bankAccountId],
    ),
    siteQueryOne<Row>(
      siteId,
      `SELECT
         COALESCE(SUM(CASE WHEN txn_date <= ? AND status <> 'void' THEN amount_signed END), 0) AS book_moved,
         COALESCE(SUM(CASE WHEN txn_date <= ? AND status = 'unreconciled' THEN amount_signed END), 0) AS unreconciled,
         COUNT(CASE WHEN txn_date <= ? AND status = 'unreconciled' THEN 1 END) AS unreconciled_count,
         COUNT(CASE WHEN txn_date <= ? AND status = 'reconciled' THEN 1 END) AS matched_count
       FROM bank_transactions WHERE bank_account_id = ?`,
      [statementDate, statementDate, statementDate, statementDate, bankAccountId],
    ),
  ])

  const bookBalance = round(toNum(account?.opening_balance) + toNum(totals?.book_moved), 2)

  return {
    ...reconcile({
      statementBalance,
      bookBalance,
      unreconciledTotal: toNum(totals?.unreconciled),
    }),
    unreconciledCount: Number(totals?.unreconciled_count ?? 0),
    matchedCount: Number(totals?.matched_count ?? 0),
  }
}

/**
 * Signs off a reconciliation and freezes its rows.
 *
 * Everything matched and dated on or before the statement date becomes
 * `reconciled` and is stamped with this reconciliation's id, which is what
 * stops a later edit silently changing a figure that has been agreed.
 *
 * REFUSES to complete out of balance unless explicitly forced. An unbalanced
 * reconciliation that can be signed off without comment is one that will be,
 * every month, and the difference will compound until nobody can find it. When
 * forced, the difference is stored and the reason is required.
 */
export async function completeReconciliation(
  siteId: number,
  actor: Actor,
  input: {
    bankAccountId: number
    statementDate: string
    statementBalance: number
    notes?: string | null
    /** Sign off despite a difference. Requires notes explaining it. */
    force?: boolean
  },
): Promise<{ ok: true; id: number; difference: number } | { ok: false; error: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.statementDate)) {
    return { ok: false, error: 'Choose a statement date.' }
  }

  const preview = await previewReconciliation(
    siteId,
    input.bankAccountId,
    input.statementDate,
    input.statementBalance,
  )

  if (!preview.balanced && !input.force) {
    return {
      ok: false,
      error: `That leaves ${Math.abs(preview.difference).toFixed(2)} unexplained. Match the outstanding items, or sign off with a reason.`,
    }
  }
  if (!preview.balanced && !input.notes?.trim()) {
    return { ok: false, error: 'Explain the difference before signing off.' }
  }

  const id = await siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO bank_reconciliations
         (bank_account_id, statement_date, statement_balance, book_balance,
          unreconciled_total, difference, status, matched_count, notes,
          user_id, user_name, completed_at)
       VALUES (?,?,?,?,?,?,'completed',?,?,?,?,NOW())`,
      [
        input.bankAccountId,
        input.statementDate,
        round(input.statementBalance, 2).toFixed(4),
        preview.bookBalance.toFixed(4),
        preview.unreconciledTotal.toFixed(4),
        preview.difference.toFixed(4),
        preview.matchedCount,
        input.notes?.trim() || null,
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )
    const reconId = (res as { insertId: number }).insertId

    // Freeze everything matched up to the statement date. A line with no link
    // is left unreconciled deliberately: it is still outstanding next month.
    await tx.execute(
      `UPDATE bank_transactions t
          SET t.status = 'reconciled', t.reconciliation_id = ?
        WHERE t.bank_account_id = ?
          AND t.txn_date <= ?
          AND t.status = 'unreconciled'
          AND EXISTS (SELECT 1 FROM cashbook_links l WHERE l.bank_txn_id = t.id)`,
      [reconId, input.bankAccountId, input.statementDate] as never,
    )

    await tx.execute(
      `UPDATE bank_accounts
          SET last_reconciled_date = ?, last_reconciled_balance = ?
        WHERE id = ?`,
      [
        input.statementDate,
        round(input.statementBalance, 2).toFixed(4),
        input.bankAccountId,
      ] as never,
    )

    await logActivityTx(tx, actor, {
      entity: 'bank',
      entityId: input.bankAccountId,
      action: 'reconcile',
      detail: preview.balanced
        ? `Reconciled to ${input.statementDate}, balanced at ${input.statementBalance.toFixed(2)}`
        : `Reconciled to ${input.statementDate} with ${preview.difference.toFixed(2)} unexplained — ${input.notes?.trim() ?? ''}`,
    })

    return reconId
  })

  return { ok: true, id, difference: preview.difference }
}

/**
 * Reopens a completed reconciliation.
 *
 * Returns its rows to unreconciled so they can be rematched. The reconciliation
 * row itself is kept and marked draft rather than deleted — "this was signed
 * off and then reopened" is exactly the sort of thing that must stay visible.
 */
export async function reopenReconciliation(
  siteId: number,
  actor: Actor,
  id: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!reason?.trim()) return { ok: false, error: 'Give a reason for reopening it.' }

  const recon = await getReconciliation(siteId, id)
  if (!recon) return { ok: false, error: 'That reconciliation no longer exists.' }
  if (recon.status === 'draft') return { ok: false, error: 'That reconciliation is already open.' }

  const newer = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM bank_reconciliations
      WHERE bank_account_id = ? AND statement_date > ? AND status = 'completed' LIMIT 1`,
    [recon.bankAccountId, recon.statementDate],
  )
  if (newer) {
    return {
      ok: false,
      error: 'A later reconciliation has been signed off. Reopen that one first.',
    }
  }

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      "UPDATE bank_transactions SET status = 'unreconciled', reconciliation_id = NULL WHERE reconciliation_id = ?",
      [id] as never,
    )
    await tx.execute(
      "UPDATE bank_reconciliations SET status = 'draft', completed_at = NULL, notes = CONCAT(COALESCE(notes,''), ' · REOPENED: ', ?) WHERE id = ?",
      [reason.trim().slice(0, 120), id] as never,
    )
    await tx.execute(
      `UPDATE bank_accounts a
          SET a.last_reconciled_date = (
                SELECT MAX(statement_date) FROM bank_reconciliations
                 WHERE bank_account_id = a.id AND status = 'completed'
              )
        WHERE a.id = ?`,
      [recon.bankAccountId] as never,
    )
    await logActivityTx(tx, actor, {
      entity: 'bank',
      entityId: recon.bankAccountId,
      action: 'reopen_reconciliation',
      detail: `Reopened the reconciliation to ${recon.statementDate} — ${reason.trim()}`,
    })
  })

  return { ok: true }
}

export type { BankTxnStatus }
