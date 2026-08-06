import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { nextDocumentNumber } from './sequences'
import { guardPosting } from './periodLocks'
import { today } from './ledger'
import { journalTotals, refuseJournal, type JournalLineInput } from '../glModel'

/**
 * Posting to the general ledger.
 *
 * ── THE INVARIANT ────────────────────────────────────────────────────────
 *
 * Every posted batch sums to zero, and gl_accounts.balance always equals the
 * sum of that account's posted journal lines. Both are moved in the SAME
 * transaction, nothing else writes a balance, and reconcileAccountBalances()
 * proves it held.
 *
 * The zero-sum check is not a formality. Every statement this system produces
 * rests on it: a trial balance that does not balance means an unbalanced batch
 * got in, and the difference will be chased through years of history by
 * somebody who does not know where to start.
 *
 * ── postTx IS THE ONE OTHER MODULES USE ──────────────────────────────────
 *
 * glPosting.ts mirrors subledger events into the ledger, and it must do so
 * inside the SAME database transaction as the subledger write — otherwise a
 * crash between them leaves the two permanently out of step. So the real work
 * takes an open connection, and the standalone post() wraps it for callers who
 * have no transaction of their own.
 */

export type JournalLine = {
  id: number
  lineNumber: number
  accountId: number
  accountCode: string | null
  accountName: string | null
  /** Signed: positive debit, negative credit. */
  amount: number
  debit: number
  credit: number
  description: string | null
  departmentId: number | null
  customerId: number | null
  supplierId: number | null
}

export type JournalBatch = {
  id: number
  journalNumber: string | null
  journalDate: string
  status: 'draft' | 'posted' | 'void'
  source: string
  sourceDocId: number | null
  description: string
  reference: string | null
  totalDebit: number
  totalCredit: number
  reversesId: number | null
  userName: string
  postedAt: Date | null
  createdAt: Date
  lines: JournalLine[]
}

type Row = RowDataPacket & Record<string, unknown>

function mapBatch(r: Row, lines: JournalLine[] = []): JournalBatch {
  return {
    id: Number(r.id),
    journalNumber: (r.journal_number as string | null) ?? null,
    journalDate: String(r.journal_date),
    status: String(r.status) as JournalBatch['status'],
    source: String(r.source),
    sourceDocId: r.source_doc_id === null ? null : Number(r.source_doc_id),
    description: String(r.description),
    reference: (r.reference as string | null) ?? null,
    totalDebit: toNum(r.total_debit),
    totalCredit: toNum(r.total_credit),
    reversesId: r.reverses_id === null ? null : Number(r.reverses_id),
    userName: String(r.user_name ?? ''),
    postedAt: (r.posted_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
    lines,
  }
}

function mapLine(r: Row): JournalLine {
  const amount = toNum(r.amount)
  return {
    id: Number(r.id),
    lineNumber: Number(r.line_number),
    accountId: Number(r.account_id),
    accountCode: (r.account_code as string | null) ?? null,
    accountName: (r.account_name as string | null) ?? null,
    amount,
    debit: amount > 0 ? amount : 0,
    credit: amount < 0 ? -amount : 0,
    description: (r.description as string | null) ?? null,
    departmentId: r.department_id === null ? null : Number(r.department_id),
    customerId: r.customer_id === null ? null : Number(r.customer_id),
    supplierId: r.supplier_id === null ? null : Number(r.supplier_id),
  }
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

export async function listBatches(
  siteId: number,
  opts: { from?: string; to?: string; source?: string; status?: string; limit?: number } = {},
): Promise<JournalBatch[]> {
  const where: string[] = []
  const params: unknown[] = []

  if (opts.from) {
    where.push('journal_date >= ?')
    params.push(opts.from)
  }
  if (opts.to) {
    where.push('journal_date <= ?')
    params.push(opts.to)
  }
  if (opts.source) {
    where.push('source = ?')
    params.push(opts.source)
  }
  if (opts.status) {
    where.push('status = ?')
    params.push(opts.status)
  }

  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM journal_batches
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY journal_date DESC, id DESC
      LIMIT ${limit}`,
    params,
  )
  return rows.map((r) => mapBatch(r))
}

export async function getBatch(siteId: number, id: number): Promise<JournalBatch | null> {
  const row = await siteQueryOne<Row>(siteId, 'SELECT * FROM journal_batches WHERE id = ? LIMIT 1', [
    id,
  ])
  if (!row) return null

  const lines = await siteQuery<Row>(
    siteId,
    'SELECT * FROM journal_lines WHERE batch_id = ? ORDER BY line_number',
    [id],
  )
  return mapBatch(row, lines.map(mapLine))
}

/** The journal a document produced, from the document's side. */
export async function batchForSource(
  siteId: number,
  source: string,
  sourceDocId: number,
): Promise<JournalBatch | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT * FROM journal_batches
      WHERE source = ? AND source_doc_id = ? AND status = 'posted'
      ORDER BY id DESC LIMIT 1`,
    [source, sourceDocId],
  )
  return row ? mapBatch(row) : null
}

/* ── Posting ─────────────────────────────────────────────────────────────── */

export type PostInput = {
  journalDate?: string
  description: string
  reference?: string | null
  source?: string
  sourceDocId?: number | null
  lines: JournalLineInput[]
  /** Skip the period-lock check. Only for a year-end close, which posts INTO the year it closes. */
  bypassPeriodLock?: boolean
}

export type PostResult = { ok: true; id: number; journalNumber: string } | { ok: false; error: string }

/**
 * Posts a balanced journal inside an EXISTING transaction.
 *
 * This is what glPosting.ts calls. Taking the connection rather than opening
 * one is the whole point: the journal and the subledger write it mirrors must
 * commit together or not at all.
 *
 * Throws rather than returning a result, because it is called from inside a
 * transaction that must roll back on failure — a returned error would have to
 * be checked by every caller and one that forgot would commit a half-posted
 * event.
 */
export async function postTx(
  tx: PoolConnection,
  actor: Actor,
  input: PostInput,
): Promise<{ id: number; journalNumber: string }> {
  const journalDate = input.journalDate ?? today()
  const totals = journalTotals(input.lines)

  if (!totals.balanced) {
    throw new Error(
      `Journal does not balance: debits ${totals.totalDebit.toFixed(2)}, credits ${totals.totalCredit.toFixed(2)}, out by ${totals.difference.toFixed(2)}.`,
    )
  }
  if (input.lines.length === 0) throw new Error('A journal needs lines.')

  // Control accounts are maintained by their subledgers. A journal that posts
  // to one by hand puts the GL and the subledger permanently out of step with
  // nothing to explain the difference — see 045.
  const accountIds = [...new Set(input.lines.map((l) => l.accountId))]
  const [accounts] = await tx.query(
    `SELECT id, account_code, name, is_postable, is_active, control_type
       FROM gl_accounts WHERE id IN (${accountIds.map(() => '?').join(',')})`,
    accountIds as never,
  )
  const byId = new Map((accounts as Row[]).map((a) => [Number(a.id), a]))

  for (const id of accountIds) {
    const account = byId.get(id)
    if (!account) throw new Error('A journal line points at an account that no longer exists.')
    if (!account.is_active) throw new Error(`${account.name} is not an active account.`)
    // A subledger-sourced journal MAY post to its own control account — that is
    // exactly what it is for. Only 'manual' is refused.
    if (!account.is_postable && (input.source ?? 'manual') === 'manual') {
      throw new Error(
        `${account.name} is a control account maintained by its subledger. Post the underlying transaction instead.`,
      )
    }
  }

  const journalNumber = await nextDocumentNumber(tx, 'journal')

  const [res] = await tx.execute(
    `INSERT INTO journal_batches
       (journal_number, journal_date, status, source, source_doc_id, description, reference,
        total_debit, total_credit, user_id, user_name, posted_at)
     VALUES (?,?,'posted',?,?,?,?,?,?,?,?,NOW())`,
    [
      journalNumber,
      journalDate,
      input.source ?? 'manual',
      input.sourceDocId ?? null,
      input.description.slice(0, 255),
      input.reference?.trim() || null,
      totals.totalDebit.toFixed(4),
      totals.totalCredit.toFixed(4),
      actor.userId,
      actor.userName.slice(0, 120),
    ] as never,
  )
  const batchId = (res as { insertId: number }).insertId

  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i]
    const account = byId.get(line.accountId)
    const amount = round(line.amount, 2)

    await tx.execute(
      `INSERT INTO journal_lines
         (batch_id, line_number, account_id, account_code, account_name, amount,
          description, department_id, customer_id, supplier_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        batchId,
        i + 1,
        line.accountId,
        account ? String(account.account_code) : null,
        account ? String(account.name) : null,
        amount.toFixed(4),
        line.description?.trim().slice(0, 190) || null,
        line.departmentId ?? null,
        line.customerId ?? null,
        line.supplierId ?? null,
      ] as never,
    )

    // The balance moves with the line, in the same transaction. Nothing else
    // writes gl_accounts.balance.
    await tx.execute('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [
      amount.toFixed(4),
      line.accountId,
    ] as never)
  }

  return { id: batchId, journalNumber }
}

/**
 * Posts a journal in its own transaction.
 *
 * For the manual journal screen and anything else without a transaction of its
 * own. Validates first and returns a result rather than throwing, because a
 * person is waiting for an answer.
 */
export async function post(
  siteId: number,
  actor: Actor,
  input: PostInput,
): Promise<PostResult> {
  const refusal = refuseJournal({
    journalDate: input.journalDate,
    description: input.description,
    lines: input.lines,
  })
  if (refusal) return { ok: false, error: refusal }

  if (!input.bypassPeriodLock) {
    const locked = await guardPosting(siteId, input.journalDate ?? today(), 'ledger')
    if (locked) return { ok: false, error: locked }
  }

  try {
    const result = await siteTransaction(siteId, async (tx) => postTx(tx, actor, input))

    await logActivity(siteId, actor, {
      entity: 'gl',
      entityId: result.id,
      action: 'journal_post',
      detail: `${result.journalNumber} · ${input.description}`,
    })

    return { ok: true, id: result.id, journalNumber: result.journalNumber }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'That journal could not be posted.',
    }
  }
}

/**
 * Reverses a posted batch by posting its mirror.
 *
 * Never an UPDATE or a DELETE. The original stays exactly as posted and the
 * correction sits beside it, linked — the same rule the sub-ledgers follow, and
 * for the same reason: the trail must show what happened AND what was done
 * about it.
 */
export async function reverse(
  siteId: number,
  actor: Actor,
  id: number,
  reason: string,
  reversalDate?: string,
): Promise<PostResult> {
  if (!reason?.trim()) return { ok: false, error: 'Give a reason for the reversal.' }

  const batch = await getBatch(siteId, id)
  if (!batch) return { ok: false, error: 'That journal no longer exists.' }
  if (batch.status !== 'posted') return { ok: false, error: 'Only a posted journal can be reversed.' }

  const already = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM journal_batches WHERE reverses_id = ? LIMIT 1',
    [id],
  )
  if (already) return { ok: false, error: 'That journal has already been reversed.' }

  // A subledger-sourced journal is a mirror of a document. Reversing the mirror
  // on its own would leave the GL and the subledger disagreeing — the document
  // must be voided instead, which reverses both.
  if (batch.source !== 'manual') {
    return {
      ok: false,
      error: `That journal was raised by a ${batch.source.replace('_', ' ')}. Void the document itself — reversing only the ledger entry would put the ledger out of step with it.`,
    }
  }

  const date = reversalDate ?? today()
  const locked = await guardPosting(siteId, date, 'ledger')
  if (locked) return { ok: false, error: locked }

  try {
    const result = await siteTransaction(siteId, async (tx) => {
      const posted = await postTx(tx, actor, {
        journalDate: date,
        description: `Reversal of ${batch.journalNumber} — ${reason.trim()}`,
        reference: batch.reference,
        source: 'manual',
        lines: batch.lines.map((l) => ({
          accountId: l.accountId,
          amount: -l.amount,
          description: l.description,
          departmentId: l.departmentId,
          customerId: l.customerId,
          supplierId: l.supplierId,
        })),
      })

      await tx.execute('UPDATE journal_batches SET reverses_id = ? WHERE id = ?', [
        id,
        posted.id,
      ] as never)

      await logActivityTx(tx, actor, {
        entity: 'gl',
        entityId: id,
        action: 'journal_reverse',
        detail: `Reversed ${batch.journalNumber} — ${reason.trim()}`,
      })

      return posted
    })

    return { ok: true, id: result.id, journalNumber: result.journalNumber }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'That reversal could not be posted.',
    }
  }
}

/* ── Account enquiry ─────────────────────────────────────────────────────── */

export type LedgerEntry = {
  batchId: number
  journalNumber: string | null
  journalDate: string
  description: string
  lineDescription: string | null
  reference: string | null
  source: string
  debit: number
  credit: number
  /** Running balance after this entry, oldest first. */
  balance: number
}

/**
 * One account's entries, with a running balance.
 *
 * The drill-down behind every figure on a statement. Opening balance is
 * computed from everything before the range so the running total is true rather
 * than starting from zero mid-history.
 */
export async function accountLedger(
  siteId: number,
  accountId: number,
  range: { from: string; to: string },
): Promise<{ opening: number; entries: LedgerEntry[]; closing: number }> {
  const [openingRow, rows] = await Promise.all([
    siteQueryOne<Row>(
      siteId,
      `SELECT COALESCE(SUM(l.amount), 0) AS total
         FROM journal_lines l
         JOIN journal_batches b ON b.id = l.batch_id
        WHERE l.account_id = ? AND b.status = 'posted' AND b.journal_date < ?`,
      [accountId, range.from],
    ),
    siteQuery<Row>(
      siteId,
      `SELECT b.id AS batch_id, b.journal_number, b.journal_date, b.description,
              b.reference, b.source, l.amount, l.description AS line_description
         FROM journal_lines l
         JOIN journal_batches b ON b.id = l.batch_id
        WHERE l.account_id = ? AND b.status = 'posted'
          AND b.journal_date BETWEEN ? AND ?
        ORDER BY b.journal_date, b.id, l.line_number
        LIMIT 2000`,
      [accountId, range.from, range.to],
    ),
  ])

  const opening = toNum(openingRow?.total)
  let running = opening

  const entries = rows.map((r) => {
    const amount = toNum(r.amount)
    running = round(running + amount, 2)
    return {
      batchId: Number(r.batch_id),
      journalNumber: (r.journal_number as string | null) ?? null,
      journalDate: String(r.journal_date),
      description: String(r.description),
      lineDescription: (r.line_description as string | null) ?? null,
      reference: (r.reference as string | null) ?? null,
      source: String(r.source),
      debit: amount > 0 ? amount : 0,
      credit: amount < 0 ? -amount : 0,
      balance: running,
    }
  })

  return { opening, entries, closing: running }
}

export type { JournalLineInput }
