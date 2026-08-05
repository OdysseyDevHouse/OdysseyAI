import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum, formatMoney } from '../decimals'
import { send, isConfigured } from '../mail'
import { buildStatement, type StatementFormat } from '../statements/render'
import { renderStatementPdf } from '../statements/pdf'
import { logActivity, type Actor } from './activityLog'

/**
 * Statement runs — sending many statements without blocking a request.
 *
 * A run is a QUEUE. Items are created up front, then worked through afterwards,
 * each recording its own outcome. Two hundred statements cannot be sent inside
 * a request: the connection would time out somewhere in the middle with no way
 * to know which ones went.
 *
 * ── WHAT THE QUEUE BUYS ──────────────────────────────────────────────────
 *
 *   Progress is real. The screen polls the counts rather than guessing.
 *   Failures are per-item. One bad address marks one item failed.
 *   Retry is a filter, not a re-send — the 194 that worked stay untouched.
 */

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed'
export type ItemStatus = 'queued' | 'sent' | 'failed' | 'skipped'

export type StatementRun = {
  id: number
  periodFrom: string
  periodTo: string
  format: StatementFormat
  status: RunStatus
  totalCount: number
  sentCount: number
  failedCount: number
  skippedCount: number
  userName: string
  startedAt: Date | null
  finishedAt: Date | null
  error: string | null
  createdAt: Date
}

export type StatementItem = {
  id: number
  runId: number
  customerId: number
  customerCode: string
  customerName: string
  email: string | null
  status: ItemStatus
  closingBalance: number
  overdueAmount: number
  attempts: number
  error: string | null
  sentAt: Date | null
}

type Row = RowDataPacket & Record<string, unknown>

function mapRun(r: Row): StatementRun {
  return {
    id: Number(r.id),
    periodFrom: String(r.period_from),
    periodTo: String(r.period_to),
    format: String(r.format) as StatementFormat,
    status: String(r.status) as RunStatus,
    totalCount: Number(r.total_count),
    sentCount: Number(r.sent_count),
    failedCount: Number(r.failed_count),
    skippedCount: Number(r.skipped_count),
    userName: String(r.user_name ?? ''),
    startedAt: (r.started_at as Date | null) ?? null,
    finishedAt: (r.finished_at as Date | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

function mapItem(r: Row): StatementItem {
  return {
    id: Number(r.id),
    runId: Number(r.run_id),
    customerId: Number(r.customer_id),
    customerCode: String(r.customer_code),
    customerName: String(r.customer_name),
    email: (r.email as string | null) ?? null,
    status: String(r.status) as ItemStatus,
    closingBalance: toNum(r.closing_balance),
    overdueAmount: toNum(r.overdue_amount),
    attempts: Number(r.attempts),
    error: (r.error as string | null) ?? null,
    sentAt: (r.sent_at as Date | null) ?? null,
  }
}

export async function getRun(siteId: number, id: number): Promise<StatementRun | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT * FROM customer_statement_runs WHERE id = ? LIMIT 1',
    [id],
  )
  return row ? mapRun(row) : null
}

export async function listRuns(siteId: number, limit = 20): Promise<StatementRun[]> {
  const capped = Math.min(Math.max(limit, 1), 100)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM customer_statement_runs ORDER BY created_at DESC LIMIT ${capped}`,
  )
  return rows.map(mapRun)
}

export async function listItems(
  siteId: number,
  runId: number,
  status?: ItemStatus,
): Promise<StatementItem[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM customer_statement_items
      WHERE run_id = ? ${status ? 'AND status = ?' : ''}
      ORDER BY customer_name`,
    status ? [runId, status] : [runId],
  )
  return rows.map(mapItem)
}

/** The last statement sent to an account, for its Statements tab. */
export async function lastStatementFor(
  siteId: number,
  customerId: number,
): Promise<StatementItem | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT * FROM customer_statement_items
      WHERE customer_id = ? AND status = 'sent'
      ORDER BY sent_at DESC LIMIT 1`,
    [customerId],
  )
  return row ? mapItem(row) : null
}

/* ── Creating a run ──────────────────────────────────────────────────────── */

export type CreateRunInput = {
  customerIds: number[]
  periodFrom: string
  periodTo: string
  format?: StatementFormat
}

export type CreateResult = { ok: true; runId: number; queued: number } | { ok: false; error: string }

/**
 * Queues a run. Sends nothing — that is `processRun`.
 *
 * Accounts with no email or nothing owed are queued as SKIPPED rather than
 * dropped: "why did Harbour Cafe not get one" is a question the run should
 * answer, and an account that silently never appears cannot answer it.
 */
export async function createRun(
  siteId: number,
  actor: Actor,
  input: CreateRunInput,
): Promise<CreateResult> {
  const ids = [...new Set(input.customerIds)].filter((id) => Number.isFinite(id) && id > 0)
  if (ids.length === 0) return { ok: false, error: 'Choose at least one account.' }
  if (ids.length > 1000) return { ok: false, error: 'That is more than 1000 accounts in one run.' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.periodFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(input.periodTo)) {
    return { ok: false, error: 'Choose a valid period.' }
  }
  if (input.periodFrom > input.periodTo) {
    return { ok: false, error: 'The period starts after it ends.' }
  }

  const customers = await siteQuery<Row>(
    siteId,
    `SELECT id, code, name, email, balance FROM customers WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )
  if (customers.length === 0) return { ok: false, error: 'None of those accounts exist.' }

  return siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO customer_statement_runs
         (period_from, period_to, format, total_count, user_id, user_name)
       VALUES (?,?,?,?,?,?)`,
      [
        input.periodFrom,
        input.periodTo,
        input.format ?? 'open-item',
        customers.length,
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )
    const runId = (res as { insertId: number }).insertId

    let skipped = 0
    for (const customer of customers) {
      const email = (customer.email as string | null)?.trim() ?? null
      const balance = toNum(customer.balance)

      // Decided at queue time so the reason is visible before the run starts.
      const skipReason = !email
        ? 'No email address on file.'
        : balance === 0
          ? 'Nothing outstanding.'
          : null
      if (skipReason) skipped++

      await tx.execute(
        `INSERT INTO customer_statement_items
           (run_id, customer_id, customer_code, customer_name, email, status, closing_balance, error)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          runId,
          Number(customer.id),
          String(customer.code),
          String(customer.name),
          email,
          skipReason ? 'skipped' : 'queued',
          balance.toFixed(4),
          skipReason,
        ] as never,
      )
    }

    if (skipped > 0) {
      await tx.execute('UPDATE customer_statement_runs SET skipped_count = ? WHERE id = ?', [
        skipped,
        runId,
      ] as never)
    }

    return { ok: true as const, runId, queued: customers.length - skipped }
  })
}

/* ── Working the queue ───────────────────────────────────────────────────── */

export type ProcessResult = { sent: number; failed: number; skipped: number }

/**
 * Works through a run's queued items.
 *
 * Deliberately sequential. Statements are a batch job nobody is watching in
 * real time, and most SMTP providers rate-limit hard enough that firing two
 * hundred sends in parallel is how a run gets throttled halfway through.
 *
 * Each item is committed as it completes, so a crash halfway leaves the first
 * half marked sent rather than losing the lot.
 */
export async function processRun(
  siteId: number,
  siteName: string,
  siteVatNumber: string | null,
  runId: number,
): Promise<ProcessResult> {
  const run = await getRun(siteId, runId)
  if (!run) return { sent: 0, failed: 0, skipped: 0 }

  await siteExecute(
    siteId,
    "UPDATE customer_statement_runs SET status = 'running', started_at = COALESCE(started_at, NOW()) WHERE id = ?",
    [runId],
  )

  if (!isConfigured()) {
    await siteExecute(
      siteId,
      `UPDATE customer_statement_runs
          SET status = 'failed', finished_at = NOW(),
              error = 'Email is not set up — SMTP_HOST and MAIL_FROM are missing.'
        WHERE id = ?`,
      [runId],
    )
    return { sent: 0, failed: 0, skipped: 0 }
  }

  const queued = await listItems(siteId, runId, 'queued')
  let sent = 0
  let failed = 0

  for (const item of queued) {
    const outcome = await sendOne(siteId, siteName, siteVatNumber, run, item)
    if (outcome.ok) sent++
    else failed++
  }

  await refreshCounts(siteId, runId)
  await siteExecute(
    siteId,
    "UPDATE customer_statement_runs SET status = 'completed', finished_at = NOW() WHERE id = ?",
    [runId],
  )

  return { sent, failed, skipped: run.skippedCount }
}

async function sendOne(
  siteId: number,
  siteName: string,
  siteVatNumber: string | null,
  run: StatementRun,
  item: StatementItem,
): Promise<{ ok: boolean }> {
  const fail = async (error: string) => {
    await siteExecute(
      siteId,
      "UPDATE customer_statement_items SET status = 'failed', attempts = attempts + 1, error = ? WHERE id = ?",
      [error.slice(0, 400), item.id],
    )
    return { ok: false }
  }

  if (!item.email) return fail('No email address on file.')

  try {
    const data = await buildStatement(siteId, siteName, siteVatNumber, item.customerId, {
      format: run.format,
      from: run.periodFrom,
      to: run.periodTo,
    })
    if (!data) return fail('That account no longer exists.')

    const pdf = await renderStatementPdf(data)

    const result = await send({
      to: item.email,
      subject: `Statement — ${data.account.code} — ${run.periodTo}`,
      text: plainBody(data.account.name, data.closingBalance, data.dueNow, siteName, data.account.code),
      attachments: [
        {
          filename: `statement-${data.account.code}-${run.periodTo}.pdf`,
          content: pdf,
          contentType: 'application/pdf',
        },
      ],
    })

    if (!result.ok) return fail(result.error)

    // The balance is frozen here, not at queue time: it is what the statement
    // they received actually said.
    await siteExecute(
      siteId,
      `UPDATE customer_statement_items
          SET status = 'sent', attempts = attempts + 1, error = NULL, sent_at = NOW(),
              closing_balance = ?, overdue_amount = ?
        WHERE id = ?`,
      [data.closingBalance.toFixed(4), data.dueNow.toFixed(4), item.id],
    )
    return { ok: true }
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'The statement could not be built.')
  }
}

/**
 * Requeues the failures so the worker picks them up again.
 *
 * Only the failures: re-sending the ones that worked would put a second
 * statement in front of a customer who already has one.
 */
export async function retryFailed(siteId: number, runId: number): Promise<{ requeued: number }> {
  const result = await siteExecute(
    siteId,
    "UPDATE customer_statement_items SET status = 'queued', error = NULL WHERE run_id = ? AND status = 'failed'",
    [runId],
  )
  const requeued = result.affectedRows

  if (requeued > 0) {
    await siteExecute(
      siteId,
      "UPDATE customer_statement_runs SET status = 'pending', finished_at = NULL, error = NULL WHERE id = ?",
      [runId],
    )
  }
  return { requeued }
}

/** Recomputes the header counts from the items, so they cannot drift. */
export async function refreshCounts(siteId: number, runId: number): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE customer_statement_runs r
        SET sent_count    = (SELECT COUNT(*) FROM customer_statement_items WHERE run_id = r.id AND status = 'sent'),
            failed_count  = (SELECT COUNT(*) FROM customer_statement_items WHERE run_id = r.id AND status = 'failed'),
            skipped_count = (SELECT COUNT(*) FROM customer_statement_items WHERE run_id = r.id AND status = 'skipped'),
            total_count   = (SELECT COUNT(*) FROM customer_statement_items WHERE run_id = r.id)
      WHERE r.id = ?`,
    [runId],
  )
}

/** A short covering note. The statement itself is the attachment. */
function plainBody(
  name: string,
  balance: number,
  overdue: number,
  siteName: string,
  code: string,
): string {
  const lines = [
    `Dear ${name},`,
    '',
    `Please find your statement attached, showing a balance of ${formatMoney(balance)}.`,
  ]

  // Leading with the overdue figure is the whole reason a chasing statement is
  // sent; burying it under the total is how it gets ignored.
  if (overdue > 0) {
    lines.push('', `${formatMoney(overdue)} of this is past its due date and we would appreciate settlement.`)
  }

  lines.push(
    '',
    `Please quote account ${code} with any payment.`,
    '',
    'If anything on the statement looks wrong, reply to this email and we will look into it.',
    '',
    'Kind regards,',
    siteName,
  )
  return lines.join('\n')
}

/**
 * Deletes a run and its items.
 *
 * Allowed only once it has finished: removing a running one would leave the
 * worker writing to rows that no longer exist.
 */
export async function deleteRun(
  siteId: number,
  actor: Actor,
  runId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const run = await getRun(siteId, runId)
  if (!run) return { ok: false, error: 'That run no longer exists.' }
  if (run.status === 'running') {
    return { ok: false, error: 'That run is still sending. Wait for it to finish.' }
  }

  await siteExecute(siteId, 'DELETE FROM customer_statement_runs WHERE id = ?', [runId])
  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: null,
    action: 'statement_run_deleted',
    detail: `Run of ${run.totalCount} statement${run.totalCount === 1 ? '' : 's'} removed`,
  })
  return { ok: true }
}
