import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { customerOwnerSite } from '../storeGroups'
import { round, toNum } from '../decimals'
import { logActivityTx, type Actor } from './activityLog'
import {
  AGING_BUCKETS,
  bucketFor,
  DOC_LABELS,
  daysBetween,
  dueDateFor,
  emptyAging,
  isDebit,
  planAutoAllocation,
  refuseAllocation,
  signedAmount,
  splitVat,
  today,
  type Aging,
  type Allocatable,
  type DocType,
} from './ledger'
import { guardPosting } from './periodLocks'

/**
 * The debtors sub-ledger.
 *
 * THE INVARIANT: customers.balance always equals SUM(amount_signed) for that
 * customer. Every function that moves one moves the other, in the SAME
 * transaction. Nothing else may write customers.balance — updateCustomer()
 * deliberately omits it from its column list, and reconcileBalances() below
 * proves the promise held.
 *
 * A row, once posted, is never edited or deleted. A mistake is corrected by
 * posting its reverse, so the trail shows what happened AND what was done about
 * it. That is why there is no updateTransaction() here.
 *
 * ── WHICH DATABASE THIS READS AND WRITES ──────────────────────────────────
 *
 * Not necessarily the caller's. A store group may share one customer file, in
 * which case the ledger lives in the group's primary store and every branch
 * posts into it — see customerOwnerSite() in lib/storeGroups.ts.
 *
 * So every query here goes through the three helpers below rather than calling
 * siteQuery/siteTransaction directly. Three reasons that matters here more than
 * anywhere else:
 *
 *   1. THE INVARIANT ABOVE IS PER DATABASE. A balance and the rows that move it
 *      must live together, or the two halves of a posting land in different
 *      places and reconcileBalances() reports drift no one can repair.
 *   2. Every table this file touches — customers, customer_transactions,
 *      customer_allocations — moves to the owner TOGETHER, so one resolution
 *      per call is correct for the whole statement. This file never joins a
 *      branch-owned table, which is what makes that true.
 *   3. siteTransaction still gets ONE connection, so the transaction is a real
 *      transaction. Resolving the owner does not split it; it only chooses
 *      which database it runs against.
 *
 * With no sharing configured the owner is the caller, so all of this is an
 * identity function and the file behaves exactly as it always has.
 */

/** The site whose database holds this caller's customers. */
async function owner(siteId: number): Promise<number> {
  return (await customerOwnerSite(siteId)).siteId
}

async function ledgerQuery<T = RowDataPacket>(
  siteId: number,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return siteQuery<T>(await owner(siteId), sql, params)
}

async function ledgerQueryOne<T = RowDataPacket>(
  siteId: number,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  return siteQueryOne<T>(await owner(siteId), sql, params)
}

async function ledgerTransaction<T>(
  siteId: number,
  fn: (tx: PoolConnection) => Promise<T>,
): Promise<T> {
  return siteTransaction(await owner(siteId), fn)
}

export type LedgerLine = {
  id: number
  customerId: number
  docType: DocType
  docLabel: string
  docNumber: string | null
  docDate: string
  dueDate: string | null
  reference: string | null
  description: string | null
  amountGross: number
  amountVat: number
  amountNet: number
  /** Signed: positive = the customer owes more. */
  amountSigned: number
  /** Signed and still unsettled. Zero when fully matched. */
  amountOutstanding: number
  source: string
  sourceDocId: number | null
  reversesId: number | null
  userName: string
  createdAt: Date
  /** Running total after this line, oldest to newest. Only set by listLedger. */
  runningBalance?: number
  /** Days past due, for a debit that is still open. Zero when settled or a credit. */
  daysOverdue?: number
}

type Row = RowDataPacket & Record<string, unknown>

function mapLine(r: Row): LedgerLine {
  const docType = String(r.doc_type) as DocType
  return {
    id: Number(r.id),
    customerId: Number(r.customer_id),
    docType,
    docLabel: DOC_LABELS[docType] ?? docType,
    docNumber: (r.doc_number as string | null) ?? null,
    // DATE columns arrive as strings (dateStrings in db.ts), which is what the
    // aging maths and <input type="date"> both want.
    docDate: String(r.doc_date),
    dueDate: r.due_date === null ? null : String(r.due_date),
    reference: (r.reference as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    amountGross: toNum(r.amount_gross),
    amountVat: toNum(r.amount_vat),
    amountNet: toNum(r.amount_net),
    amountSigned: toNum(r.amount_signed),
    amountOutstanding: toNum(r.amount_outstanding),
    source: String(r.source),
    sourceDocId: r.source_doc_id === null ? null : Number(r.source_doc_id),
    reversesId: r.reverses_id === null ? null : Number(r.reverses_id),
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
  }
}

const SELECT_LINE = `
  SELECT id, customer_id, doc_type, doc_number, doc_date, due_date, reference, description,
         amount_gross, amount_vat, amount_net, amount_signed, amount_outstanding,
         source, source_doc_id, reverses_id, user_name, created_at
    FROM customer_transactions
`

/* ── Reads ───────────────────────────────────────────────────────────────── */

export type LedgerOptions = {
  /** Hide fully settled lines — the "open items only" toggle. */
  openOnly?: boolean
  from?: string
  to?: string
  limit?: number
}

/**
 * One account's ledger, oldest first, with a running balance.
 *
 * The running balance is computed here rather than in SQL: a window function
 * would tie this to MySQL 8, and the page size is one account's history, so the
 * loop costs nothing. Oldest-first because a running balance only makes sense
 * read downwards — the UI reverses it for display if it wants newest first.
 */
export async function listLedger(
  siteId: number,
  customerId: number,
  opts: LedgerOptions = {},
): Promise<LedgerLine[]> {
  const where: string[] = ['customer_id = ?']
  const params: unknown[] = [customerId]

  if (opts.openOnly) where.push('amount_outstanding <> 0')
  if (opts.from) {
    where.push('doc_date >= ?')
    params.push(opts.from)
  }
  if (opts.to) {
    where.push('doc_date <= ?')
    params.push(opts.to)
  }

  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000)
  const rows = await ledgerQuery<Row>(
    siteId,
    `${SELECT_LINE} WHERE ${where.join(' AND ')}
      ORDER BY doc_date ASC, id ASC
      LIMIT ${limit}`,
    params,
  )

  const now = today()
  let running = 0

  return rows.map((r) => {
    const line = mapLine(r)
    running = round(running + line.amountSigned, 2)
    line.runningBalance = running
    line.daysOverdue =
      line.dueDate && line.amountOutstanding > 0 ? Math.max(daysBetween(line.dueDate, now), 0) : 0
    return line
  })
}

export async function getTransaction(siteId: number, id: number): Promise<LedgerLine | null> {
  const row = await ledgerQueryOne<Row>(siteId, `${SELECT_LINE} WHERE id = ? LIMIT 1`, [id])
  return row ? mapLine(row) : null
}

/** Open debits for an account, oldest first — what a credit can be applied to. */
export async function openDebits(siteId: number, customerId: number): Promise<LedgerLine[]> {
  const rows = await ledgerQuery<Row>(
    siteId,
    `${SELECT_LINE} WHERE customer_id = ? AND amount_outstanding > 0
      ORDER BY doc_date ASC, id ASC`,
    [customerId],
  )
  return rows.map(mapLine)
}

/** Credits with something left to apply — the other half of the allocation screen. */
export async function unappliedCredits(siteId: number, customerId: number): Promise<LedgerLine[]> {
  const rows = await ledgerQuery<Row>(
    siteId,
    `${SELECT_LINE} WHERE customer_id = ? AND amount_outstanding < 0
      ORDER BY doc_date ASC, id ASC`,
    [customerId],
  )
  return rows.map(mapLine)
}

/**
 * Age analysis for one account, as at a date.
 *
 * Buckets are built from amount_outstanding, not amount_gross — that is the
 * whole point of open item. Unapplied credits are summed into `current` rather
 * than being dropped: money on account genuinely reduces what is owed, and an
 * age analysis whose buckets do not add up to the balance is one nobody trusts.
 */
export async function agingFor(
  siteId: number,
  customerId: number,
  /**
   * The width of one rung, from the account's statement cycle.
   *
   * Defaults to 30 so every existing caller is unchanged. A weekly account read on a
   * 30-day ladder would show a debt four cycles overdue sitting in the first bucket —
   * technically true, and useless to whoever is chasing it.
   */
  bucketWidth = 30,
): Promise<Aging> {
  const rows = await ledgerQuery<Row>(
    siteId,
    `${SELECT_LINE} WHERE customer_id = ? AND amount_outstanding <> 0`,
    [customerId],
  )

  const now = today()
  const aging = emptyAging()

  for (const raw of rows) {
    const line = mapLine(raw)
    if (line.amountOutstanding < 0) {
      aging.current = round(aging.current + line.amountOutstanding, 2)
    } else {
      const overdue = line.dueDate ? daysBetween(line.dueDate, now) : 0
      const bucket = bucketFor(overdue, bucketWidth)
      aging[bucket] = round(aging[bucket] + line.amountOutstanding, 2)
    }
    aging.total = round(aging.total + line.amountOutstanding, 2)
  }

  return aging
}

/**
 * Age analysis for one account AS IT STOOD on a past date.
 *
 * ── WHY THIS CANNOT READ `amount_outstanding` ─────────────────────────────
 *
 * That column is the CURRENT position, and it is maintained as allocations happen. A
 * January invoice settled by an April payment has `amount_outstanding = 0` today — so a
 * February statement built from it reports February as though that April money had
 * already arrived, and the aging silently disagrees with the statement a customer was
 * actually sent.
 *
 * So the outstanding figure is RECONSTRUCTED: the debit's gross, less only the
 * allocations made on or before `asAt`. `customer_allocations.allocated_at` is what
 * makes that possible, and it is why allocations are rows with a date rather than a
 * running total on the invoice.
 *
 * ── AND WHY LATENESS IS MEASURED TO `asAt`, NOT TO TODAY ──────────────────
 *
 * A statement dated 28 February says how late each invoice was ON THE 28TH. Measuring
 * to today would age a February statement by however long ago February was, which is
 * both wrong and unreproducible — reprinting the same statement next month would give a
 * different answer.
 *
 * ── WHY THIS DELEGATES RATHER THAN RECONSTRUCTING ─────────────────────────
 *
 * aging.ts already owns that reconstruction for the whole book, and scoping it to one
 * customer is a WHERE clause. A second implementation here would be a second thing to
 * keep correct — and a per-row query for each credit besides. See the header of aging.ts
 * on why the fast and as-at paths must not drift.
 *
 * An account with nothing outstanding produces no row, hence the empty fallback: a
 * settled account's statement shows zeros, which is right.
 */
export async function agingAsAt(
  siteId: number,
  customerId: number,
  asAt: string,
  bucketWidth = 30,
): Promise<Aging> {
  const { customerAging } = await import('./aging')
  const { rows } = await customerAging(siteId, {
    asAt,
    customerId,
    bucketDays: bucketWidth,
  })
  return rows[0]?.aging ?? emptyAging()
}

/** The whole book, bucketed, for the age-analysis screen. */
export async function agingSummary(siteId: number): Promise<Aging> {
  const rows = await ledgerQuery<Row>(
    siteId,
    `SELECT due_date, amount_outstanding FROM customer_transactions WHERE amount_outstanding <> 0`,
  )

  const now = today()
  const aging = emptyAging()

  for (const r of rows) {
    const outstanding = toNum(r.amount_outstanding)
    if (outstanding < 0) {
      aging.current = round(aging.current + outstanding, 2)
    } else {
      const due = r.due_date === null ? null : String(r.due_date)
      const bucket = bucketFor(due ? daysBetween(due, now) : 0)
      aging[bucket] = round(aging[bucket] + outstanding, 2)
    }
    aging.total = round(aging.total + outstanding, 2)
  }

  return aging
}

/* ── Posting ─────────────────────────────────────────────────────────────── */

export type PostInput = {
  customerId: number
  docType: DocType
  /** Positive magnitude — the sign comes from docType. A journal keeps its sign. */
  amount: number
  docDate?: string
  docNumber?: string | null
  reference?: string | null
  description?: string | null
  /** VAT-inclusive percentage, for documents that carry VAT. */
  vatRatePct?: number
  source?: string
  sourceDocId?: number | null
  reversesId?: number | null
  /** Match a credit against the oldest open debits straight away. */
  autoAllocate?: boolean
}

export type PostResult = { ok: true; id: number } | { ok: false; error: string }

export function validatePost(input: PostInput): string | null {
  if (!Number.isFinite(input.amount) || input.amount === 0) {
    return 'Enter an amount.'
  }
  if (input.docType !== 'journal' && input.amount < 0) {
    return 'Enter a positive amount — the document type decides the direction.'
  }
  if (Math.abs(input.amount) > 99_999_999) return 'That amount is too large.'
  if (input.docDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.docDate)) {
    return 'That date is not valid.'
  }
  if ((input.vatRatePct ?? 0) < 0 || (input.vatRatePct ?? 0) > 100) {
    return 'VAT rate must be between 0 and 100 percent.'
  }
  return null
}

/**
 * Posts one transaction and moves the balance, atomically.
 *
 * The two writes are inseparable: a ledger row without its balance move leaves
 * the account understating what is owed, and a balance move without its row
 * leaves a figure nobody can explain. Both happen inside one siteTransaction or
 * neither does.
 */
export async function postTransaction(
  siteId: number,
  actor: Actor,
  input: PostInput,
): Promise<PostResult> {
  const invalid = validatePost(input)
  if (invalid) return { ok: false, error: invalid }

  // A closed period refuses the posting outright. Without this, a journal dated
  // into a month whose VAT return has been filed lands silently, and the first
  // anyone hears of it is from an auditor. See periodLocks.ts.
  const locked = await guardPosting(siteId, input.docDate ?? today(), 'ledger')
  if (locked) return { ok: false, error: locked }

  const customer = await ledgerQueryOne<Row>(
    siteId,
    'SELECT id, code, name, payment_terms_days FROM customers WHERE id = ? LIMIT 1',
    [input.customerId],
  )
  if (!customer) return { ok: false, error: 'Customer not found.' }

  // The same document number twice on one account is nearly always a mistake —
  // a re-post, or a number typed onto the wrong transaction type. It shipped
  // once as a payment keyed as an invoice, which pushed a balance UP by the
  // amount paid and looked entirely normal on the screen.
  //
  // Refused rather than warned, because there is no legitimate case for two
  // documents of the same type sharing a number: the reversal path writes its
  // own number, and a genuine second document has a genuine second number.
  if (input.docNumber?.trim()) {
    const clash = await ledgerQueryOne<Row>(
      siteId,
      `SELECT id, doc_type FROM customer_transactions
        WHERE customer_id = ? AND doc_number = ? AND doc_type = ? LIMIT 1`,
      [input.customerId, input.docNumber.trim(), input.docType],
    )
    if (clash) {
      return {
        ok: false,
        error: `${input.docNumber.trim()} is already on this account as ${DOC_LABELS[input.docType].toLowerCase()} #${clash.id}. Use a different number, or reverse the original.`,
      }
    }
  }

  const docDate = input.docDate ?? today()
  const termsDays = Number(customer.payment_terms_days ?? 30)
  const dueDate = dueDateFor(input.docType, docDate, termsDays)
  const signed = signedAmount(input.docType, input.amount)
  const { gross, net, vat } = splitVat(Math.abs(signed), input.vatRatePct ?? 0)

  const posted = await ledgerTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO customer_transactions
         (customer_id, doc_type, doc_number, doc_date, due_date, reference, description,
          amount_gross, amount_vat, amount_net, amount_signed, amount_outstanding,
          source, source_doc_id, origin_site_id, reverses_id, user_id, user_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.customerId,
        input.docType,
        input.docNumber?.trim() || null,
        docDate,
        dueDate,
        input.reference?.trim() || null,
        input.description?.trim() || null,
        gross.toFixed(4),
        vat.toFixed(4),
        net.toFixed(4),
        signed.toFixed(4),
        // A new row is entirely unsettled, so outstanding starts equal to the
        // signed amount and is worked down by allocations.
        signed.toFixed(4),
        input.source ?? 'manual',
        input.sourceDocId ?? null,
        // WHICH STORE this row came from. source_doc_id names a document in the
        // CALLER's database, and document ids are per-database — so once ten
        // branches post into one shared ledger, the id alone stops identifying
        // anything. The pair is what a lookup must match on.
        siteId,
        input.reversesId ?? null,
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )
    const id = (res as { insertId: number }).insertId

    await bumpBalance(tx, input.customerId, signed)

    await logActivityTx(tx, actor, {
      entity: 'customer',
      entityId: input.customerId,
      action: 'ledger',
      detail: `${DOC_LABELS[input.docType]} ${input.docNumber ?? ''} ${signed.toFixed(2)}`.replace(
        /\s+/g,
        ' ',
      ),
    })

    return { ok: true as const, id }
  }).then(async (result) => {
    // Auto-allocation runs in its own transaction, after the posting is safely
    // committed. A failure to match must never roll back the payment itself —
    // an unallocated payment is a tidy-up job; a lost one is a phone call.
    if (result.ok && input.autoAllocate && signed < 0) {
      await autoAllocate(siteId, actor, result.id)
    }
    return result
  })

  // ── Credit control: a settled account starts the ladder again ──────────
  //
  // Without this an account that reached a final demand two years ago and has
  // paid on time ever since would still be sitting at the top rung, so the
  // next time it slipped a day it would be sent a final demand rather than a
  // friendly reminder.
  //
  // AFTER the transaction, deliberately, and swallowing its own errors. This
  // is bookkeeping about chasing, not about money — a credit-control table
  // being missing or locked must never undo a customer's payment.
  if (posted.ok && signed < 0) {
    try {
      const { resetLevel } = await import('./creditControl')
      const owing = await ledgerQueryOne<Row>(
        siteId,
        `SELECT COALESCE(SUM(amount_outstanding), 0) AS overdue
           FROM customer_transactions
          WHERE customer_id = ? AND amount_outstanding > 0
            AND due_date IS NOT NULL AND due_date < ?`,
        [input.customerId, today()],
      )
      if (toNum(owing?.overdue) <= 0) await resetLevel(siteId, input.customerId)
    } catch (error) {
      console.error('credit level reset failed', error)
    }
  }

  return posted
}

/** Applies the balance delta. The only place customers.balance is ever written. */
async function bumpBalance(tx: PoolConnection, customerId: number, delta: number): Promise<void> {
  await tx.execute('UPDATE customers SET balance = balance + ? WHERE id = ?', [
    delta.toFixed(4),
    customerId,
  ] as never)
}

/**
 * Reverses a posted transaction by posting its opposite.
 *
 * Never an UPDATE or a DELETE. The original stays exactly as it was issued —
 * the customer may hold a printed copy of it — and the correction sits beside
 * it, linked, so the trail shows both what happened and what was done about it.
 */
export async function reverseTransaction(
  siteId: number,
  actor: Actor,
  id: number,
  reason: string,
): Promise<PostResult> {
  if (!reason?.trim()) return { ok: false, error: 'Give a reason for the reversal.' }

  const original = await getTransaction(siteId, id)
  if (!original) return { ok: false, error: 'Transaction not found.' }

  const already = await ledgerQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM customer_transactions WHERE reverses_id = ? LIMIT 1',
    [id],
  )
  if (already) return { ok: false, error: 'That transaction has already been reversed.' }

  // BOTH dates are checked. The reversal itself is dated today and must land in
  // an open period, but reversing a document that sits inside a CLOSED one also
  // changes that period's figures — the original's outstanding drops to zero —
  // so a closed original is refused even when today is open.
  const originalLocked = await guardPosting(siteId, original.docDate, 'ledger')
  if (originalLocked) {
    return {
      ok: false,
      error: `That document is dated inside a closed period. ${originalLocked}`,
    }
  }
  const todayLocked = await guardPosting(siteId, today(), 'ledger')
  if (todayLocked) return { ok: false, error: todayLocked }

  // Allocations against the original would point at a document that no longer
  // says what it said. Unwind them first, deliberately, rather than silently.
  if (round(original.amountOutstanding, 2) !== round(original.amountSigned, 2)) {
    return {
      ok: false,
      error: 'That document has payments allocated against it. Unallocate them first.',
    }
  }

  return ledgerTransaction(siteId, async (tx) => {
    const reversed = round(-original.amountSigned, 2)

    const [res] = await tx.execute(
      `INSERT INTO customer_transactions
         (customer_id, doc_type, doc_number, doc_date, due_date, reference, description,
          amount_gross, amount_vat, amount_net, amount_signed, amount_outstanding,
          source, origin_site_id, reverses_id, user_id, user_name)
       VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        original.customerId,
        'journal',
        original.docNumber ? `REV-${original.docNumber}` : null,
        today(),
        original.reference,
        `Reversal of ${original.docLabel} ${original.docNumber ?? `#${original.id}`} — ${reason.trim()}`,
        round(-original.amountGross, 2).toFixed(4),
        round(-original.amountVat, 2).toFixed(4),
        round(-original.amountNet, 2).toFixed(4),
        reversed.toFixed(4),
        reversed.toFixed(4),
        'manual',
        // The reversal belongs to the store that raised it, which need not be
        // the store that posted the original.
        siteId,
        original.id,
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )
    const id = (res as { insertId: number }).insertId

    // The original is now settled by its reversal, and so is the reversal.
    await tx.execute(
      'UPDATE customer_transactions SET amount_outstanding = 0 WHERE id IN (?, ?)',
      [original.id, id] as never,
    )
    await tx.execute(
      `INSERT INTO customer_allocations (debit_txn_id, credit_txn_id, amount, user_id, user_name)
       VALUES (?,?,?,?,?)`,
      [
        original.amountSigned > 0 ? original.id : id,
        original.amountSigned > 0 ? id : original.id,
        Math.abs(original.amountSigned).toFixed(4),
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )

    await bumpBalance(tx, original.customerId, reversed)

    await logActivityTx(tx, actor, {
      entity: 'customer',
      entityId: original.customerId,
      action: 'reverse',
      detail: `Reversed ${original.docLabel} ${original.docNumber ?? `#${original.id}`} — ${reason.trim()}`,
    })

    return { ok: true as const, id }
  })
}

/* ── Allocation ──────────────────────────────────────────────────────────── */

export type AllocateResult = { ok: true; allocated: number } | { ok: false; error: string }

/**
 * Matches a credit against a debit for a given amount.
 *
 * Three writes, one transaction: the allocation row, and both sides'
 * amount_outstanding. The balance does NOT move — allocation is bookkeeping
 * about money that has already been posted, and touching the balance here would
 * double-count it. That distinction is the one most likely to be got wrong.
 */
export async function allocate(
  siteId: number,
  actor: Actor,
  debitId: number,
  creditId: number,
  amount: number,
): Promise<AllocateResult> {
  const [debit, credit] = await Promise.all([
    getTransaction(siteId, debitId),
    getTransaction(siteId, creditId),
  ])
  if (!debit || !credit) return { ok: false, error: 'Transaction not found.' }
  if (debit.customerId !== credit.customerId) {
    return { ok: false, error: 'Both documents must belong to the same customer.' }
  }

  const refusal = refuseAllocation(toAllocatable(debit), toAllocatable(credit), amount)
  if (refusal) return { ok: false, error: refusal }

  const value = round(amount, 2)

  await ledgerTransaction(siteId, async (tx) => {
    await tx.execute(
      `INSERT INTO customer_allocations (debit_txn_id, credit_txn_id, amount, user_id, user_name)
            VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount), allocated_at = CURRENT_TIMESTAMP`,
      [debitId, creditId, value.toFixed(4), actor.userId, actor.userName.slice(0, 120)] as never,
    )
    // Debit falls toward zero, credit rises toward zero — opposite signs, same
    // magnitude, so the pair stays consistent.
    await tx.execute(
      'UPDATE customer_transactions SET amount_outstanding = amount_outstanding - ? WHERE id = ?',
      [value.toFixed(4), debitId] as never,
    )
    await tx.execute(
      'UPDATE customer_transactions SET amount_outstanding = amount_outstanding + ? WHERE id = ?',
      [value.toFixed(4), creditId] as never,
    )
  })

  return { ok: true, allocated: value }
}

/** Undoes one match, returning both sides to unsettled. */
export async function unallocate(
  siteId: number,
  actor: Actor,
  debitId: number,
  creditId: number,
): Promise<AllocateResult> {
  const row = await ledgerQueryOne<Row>(
    siteId,
    'SELECT amount FROM customer_allocations WHERE debit_txn_id = ? AND credit_txn_id = ? LIMIT 1',
    [debitId, creditId],
  )
  if (!row) return { ok: false, error: 'That allocation no longer exists.' }

  const value = toNum(row.amount)

  await ledgerTransaction(siteId, async (tx) => {
    await tx.execute(
      'DELETE FROM customer_allocations WHERE debit_txn_id = ? AND credit_txn_id = ?',
      [debitId, creditId] as never,
    )
    await tx.execute(
      'UPDATE customer_transactions SET amount_outstanding = amount_outstanding + ? WHERE id = ?',
      [value.toFixed(4), debitId] as never,
    )
    await tx.execute(
      'UPDATE customer_transactions SET amount_outstanding = amount_outstanding - ? WHERE id = ?',
      [value.toFixed(4), creditId] as never,
    )
    await logActivityTx(tx, actor, {
      entity: 'customer',
      entityId: 0,
      action: 'unallocate',
      detail: `Unallocated ${value.toFixed(2)} between #${debitId} and #${creditId}`,
    })
  })

  return { ok: true, allocated: value }
}

/** Applies a credit to the oldest open debits. See planAutoAllocation for why oldest. */
export async function autoAllocate(
  siteId: number,
  actor: Actor,
  creditId: number,
): Promise<AllocateResult> {
  const credit = await getTransaction(siteId, creditId)
  if (!credit) return { ok: false, error: 'Transaction not found.' }
  if (credit.amountOutstanding >= 0) return { ok: false, error: 'Nothing left to apply.' }

  const debits = await openDebits(siteId, credit.customerId)
  const plan = planAutoAllocation(toAllocatable(credit), debits.map(toAllocatable))

  let total = 0
  for (const step of plan) {
    const result = await allocate(siteId, actor, step.debitId, step.creditId, step.amount)
    if (result.ok) total = round(total + result.allocated, 2)
  }

  return { ok: true, allocated: total }
}

function toAllocatable(line: LedgerLine): Allocatable {
  return { id: line.id, docDate: line.docDate, outstanding: line.amountOutstanding }
}

/** What settled a given document, for the allocation detail panel. */
export async function allocationsFor(
  siteId: number,
  transactionId: number,
): Promise<{ otherId: number; amount: number; allocatedAt: Date; userName: string }[]> {
  const rows = await ledgerQuery<Row>(
    siteId,
    `SELECT CASE WHEN debit_txn_id = ? THEN credit_txn_id ELSE debit_txn_id END AS other_id,
            amount, allocated_at, user_name
       FROM customer_allocations
      WHERE debit_txn_id = ? OR credit_txn_id = ?
      ORDER BY allocated_at ASC`,
    [transactionId, transactionId, transactionId],
  )
  return rows.map((r) => ({
    otherId: Number(r.other_id),
    amount: toNum(r.amount),
    allocatedAt: r.allocated_at as Date,
    userName: String(r.user_name ?? ''),
  }))
}

/* ── Reconciliation ──────────────────────────────────────────────────────── */

export type BalanceDrift = {
  id: number
  code: string
  name: string
  stored: number
  computed: number
  drift: number
}

/**
 * Accounts whose stored balance disagrees with their ledger.
 *
 * `> 0.0001` is not a tolerance — it is "not exactly equal", expressed in the
 * column's own precision. Both sides are DECIMAL and no float is involved, so
 * any row returned is a bug in a posting path, never rounding.
 *
 * Deliberately reports rather than repairs: silently correcting a drift would
 * hide the bug that caused it. repairBalance() below is the explicit, audited
 * fix, run once the cause is understood.
 */
export async function reconcileBalances(siteId: number): Promise<BalanceDrift[]> {
  const rows = await ledgerQuery<Row>(
    siteId,
    `SELECT c.id, c.code, c.name,
            c.balance                     AS stored,
            COALESCE(t.ledger_total, 0)   AS computed,
            c.balance - COALESCE(t.ledger_total, 0) AS drift
       FROM customers c
       LEFT JOIN (
             SELECT customer_id, SUM(amount_signed) AS ledger_total
               FROM customer_transactions
              GROUP BY customer_id
            ) t ON t.customer_id = c.id
      WHERE ABS(c.balance - COALESCE(t.ledger_total, 0)) > 0.0001
      ORDER BY ABS(c.balance - COALESCE(t.ledger_total, 0)) DESC`,
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

/** Resets one account's balance to what its ledger says. Audited, never automatic. */
export async function repairBalance(
  siteId: number,
  actor: Actor,
  customerId: number,
): Promise<{ ok: true; from: number; to: number } | { ok: false; error: string }> {
  const row = await ledgerQueryOne<Row>(
    siteId,
    `SELECT c.balance AS stored, COALESCE(SUM(t.amount_signed), 0) AS computed
       FROM customers c
       LEFT JOIN customer_transactions t ON t.customer_id = c.id
      WHERE c.id = ?
      GROUP BY c.id, c.balance`,
    [customerId],
  )
  if (!row) return { ok: false, error: 'Customer not found.' }

  const stored = toNum(row.stored)
  const computed = toNum(row.computed)
  if (round(stored, 4) === round(computed, 4)) {
    return { ok: false, error: 'That balance already agrees with the ledger.' }
  }

  await ledgerTransaction(siteId, async (tx) => {
    await tx.execute('UPDATE customers SET balance = ? WHERE id = ?', [
      computed.toFixed(4),
      customerId,
    ] as never)
    await logActivityTx(tx, actor, {
      entity: 'customer',
      entityId: customerId,
      action: 'repair',
      detail: `Balance corrected from ${stored.toFixed(2)} to ${computed.toFixed(2)} to match the ledger`,
    })
  })

  return { ok: true, from: stored, to: computed }
}

/** Narrows an untrusted string to a doc type, for form fields and URL params. */
export function toDocType(value: unknown): DocType | null {
  const raw = String(value ?? '')
  return (
    ['invoice', 'credit_note', 'payment', 'journal', 'opening', 'interest'] as readonly string[]
  ).includes(raw)
    ? (raw as DocType)
    : null
}

export { AGING_BUCKETS, isDebit }
export type { Aging, DocType }
