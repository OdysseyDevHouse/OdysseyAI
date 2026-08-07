import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum, formatMoney } from '../decimals'
import { today } from './ledger'
import { logActivity, type Actor } from './activityLog'
import {
  decideLevel,
  promiseState,
  reliability,
  riskBand,
  renderTemplate,
  daysBetween,
  SKIP_LABELS,
  type DunningLevel,
  type CreditPosition,
  type SkipReason,
  type PromiseStatus,
  type PromiseState,
  type RiskBand,
} from '../creditModel'

/**
 * Credit control — the database side.
 *
 * The judgement lives in creditModel.ts as pure functions. This file feeds them
 * from the ledger and records what was decided.
 *
 * ── THE LEDGER IS STILL THE TRUTH ────────────────────────────────────────
 *
 * Nothing in here holds a balance. Overdue amounts are computed from
 * customer_transactions.amount_outstanding every time a run is built, and the
 * numbers copied onto a run item are a record of what the letter CLAIMED, not
 * a second version of the account. Delete every row in these tables and the
 * debtors book is unchanged — only the story of chasing it is lost.
 */

type Row = RowDataPacket & Record<string, unknown>

/* ── Levels ──────────────────────────────────────────────────────────────── */

function mapLevel(r: Row): DunningLevel {
  return {
    id: Number(r.id),
    step: Number(r.step),
    name: String(r.name),
    minDaysOverdue: Number(r.min_days_overdue),
    minAmount: toNum(r.min_amount),
    subject: String(r.subject),
    body: String(r.body),
    blocksAccount: Number(r.blocks_account) === 1,
    requiresCall: Number(r.requires_call) === 1,
    isActive: Number(r.is_active) === 1,
  }
}

export async function listLevels(siteId: number, activeOnly = false): Promise<DunningLevel[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM dunning_levels ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY step`,
  )
  return rows.map(mapLevel)
}

export async function getLevel(siteId: number, id: number): Promise<DunningLevel | null> {
  const row = await siteQueryOne<Row>(siteId, 'SELECT * FROM dunning_levels WHERE id = ? LIMIT 1', [
    id,
  ])
  return row ? mapLevel(row) : null
}

export type SaveLevelInput = {
  step: number
  name: string
  minDaysOverdue: number
  minAmount: number
  subject: string
  body: string
  blocksAccount: boolean
  requiresCall: boolean
  isActive: boolean
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

function validateLevel(input: SaveLevelInput): string | null {
  if (!input.name.trim()) return 'Give the level a name.'
  if (!input.subject.trim()) return 'The email needs a subject.'
  if (!input.body.trim()) return 'The email needs a body.'
  if (!Number.isInteger(input.step) || input.step < 1) return 'The step must be 1 or more.'
  if (input.minDaysOverdue < 0) return 'Days overdue cannot be negative.'
  if (input.minAmount < 0) return 'The minimum amount cannot be negative.'
  return null
}

export async function saveLevel(
  siteId: number,
  actor: Actor,
  id: number | null,
  input: SaveLevelInput,
): Promise<SaveResult> {
  const invalid = validateLevel(input)
  if (invalid) return { ok: false, error: invalid }

  const clash = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM dunning_levels WHERE step = ? AND id <> ? LIMIT 1',
    [input.step, id ?? 0],
  )
  if (clash) return { ok: false, error: `Step ${input.step} already exists.` }

  const values = [
    input.step,
    input.name.trim().slice(0, 80),
    input.minDaysOverdue,
    input.minAmount.toFixed(4),
    input.subject.trim().slice(0, 200),
    input.body.trim(),
    input.blocksAccount ? 1 : 0,
    input.requiresCall ? 1 : 0,
    input.isActive ? 1 : 0,
  ]

  if (id) {
    await siteExecute(
      siteId,
      `UPDATE dunning_levels SET step=?, name=?, min_days_overdue=?, min_amount=?,
         subject=?, body=?, blocks_account=?, requires_call=?, is_active=? WHERE id=?`,
      [...values, id],
    )
    await logActivity(siteId, actor, {
      entity: 'credit',
      entityId: id,
      action: 'level.update',
      detail: `Dunning level ${input.step} — ${input.name}`,
    })
    return { ok: true, id }
  }

  const res = await siteExecute(
    siteId,
    `INSERT INTO dunning_levels
       (step, name, min_days_overdue, min_amount, subject, body, blocks_account, requires_call, is_active)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    values,
  )
  const newId = res.insertId
  await logActivity(siteId, actor, {
    entity: 'credit',
    entityId: newId,
    action: 'level.create',
    detail: `Dunning level ${input.step} — ${input.name}`,
  })
  return { ok: true, id: newId }
}

export async function deleteLevel(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const level = await getLevel(siteId, id)
  if (!level) return { ok: false, error: 'That level no longer exists.' }

  // Items keep level_step and level_name of their own, so deleting a level
  // does not rewrite history — but the FK is ON DELETE... nothing. Check.
  const used = await siteQueryOne<Row>(
    siteId,
    'SELECT COUNT(*) AS n FROM dunning_run_items WHERE level_id = ?',
    [id],
  )
  if (Number(used?.n ?? 0) > 0) {
    return {
      ok: false,
      error: 'That level has been used in a run. Deactivate it instead so the history still reads.',
    }
  }

  await siteExecute(siteId, 'DELETE FROM dunning_levels WHERE id = ?', [id])
  await logActivity(siteId, actor, {
    entity: 'credit',
    entityId: id,
    action: 'level.delete',
    detail: `Deleted dunning level ${level.step} — ${level.name}`,
  })
  return { ok: true }
}

/* ── Reading the book ────────────────────────────────────────────────────── */

export type OverdueDoc = {
  id: number
  docNumber: string | null
  docDate: string
  dueDate: string | null
  daysOverdue: number
  outstanding: number
}

export type AccountPosition = {
  customerId: number
  code: string
  name: string
  email: string | null
  phone: string | null
  status: string
  balance: number
  creditLimit: number
  overdueAmount: number
  oldestDays: number
  dunningLevel: number
  lastDunnedAt: string | null
  pausedUntil: string | null
  pauseReason: string | null
  heldAt: Date | null
  holdReason: string | null
  promisesMade: number
  promisesKept: number
  promisesBroken: number
  hasOpenPromise: boolean
  openPromiseDate: string | null
  risk: RiskBand
  riskReason: string
}

/**
 * Every account with something overdue, with the state the rules need.
 *
 * ── ONE QUERY, NOT ONE PER ACCOUNT ───────────────────────────────────────
 *
 * A book of two thousand debtors is ordinary, and asking the ledger about each
 * one separately is two thousand round trips for a screen someone opens every
 * morning. So the overdue position is aggregated in SQL and the per-account
 * judgement happens in memory afterwards, where it is cheap.
 *
 * Unapplied credits (negative outstanding) are deliberately EXCLUDED from the
 * overdue figure: money sitting on account is not a debt, and counting it would
 * chase customers who are in credit.
 */
export async function listPositions(
  siteId: number,
  options: { asAt?: string; onlyOverdue?: boolean } = {},
): Promise<AccountPosition[]> {
  const asAt = options.asAt ?? today()

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT
        c.id, c.code, c.name, c.email, c.phone, c.status, c.balance, c.credit_limit,
        s.dunning_level, s.last_dunned_at, s.paused_until, s.pause_reason,
        s.held_at, s.hold_reason,
        s.promises_made, s.promises_kept, s.promises_broken,
        COALESCE(o.overdue_amount, 0) AS overdue_amount,
        o.oldest_due,
        p.promised_date AS open_promise_date
      FROM customers c
      LEFT JOIN customer_credit_status s ON s.customer_id = c.id
      LEFT JOIN (
        SELECT customer_id,
               SUM(amount_outstanding) AS overdue_amount,
               MIN(due_date) AS oldest_due
          FROM customer_transactions
         WHERE amount_outstanding > 0
           AND due_date IS NOT NULL
           AND due_date < ?
         GROUP BY customer_id
      ) o ON o.customer_id = c.id
      LEFT JOIN (
        SELECT customer_id, MIN(promised_date) AS promised_date
          FROM payment_promises
         WHERE status = 'open'
         GROUP BY customer_id
      ) p ON p.customer_id = c.id
      WHERE c.status <> 'closed'
      ${options.onlyOverdue ? 'HAVING overdue_amount > 0' : ''}
      ORDER BY overdue_amount DESC, c.name`,
    [asAt],
  )

  return rows.map((r) => {
    const overdueAmount = round(toNum(r.overdue_amount), 2)
    const oldestDue = r.oldest_due === null ? null : String(r.oldest_due)
    const oldestDays = oldestDue ? Math.max(0, daysBetween(oldestDue, asAt)) : 0
    const balance = toNum(r.balance)
    const creditLimit = toNum(r.credit_limit)
    const promisesBroken = Number(r.promises_broken ?? 0)
    const dunningLevel = Number(r.dunning_level ?? 0)

    const risk = riskBand({
      oldestDays,
      overdueAmount,
      balance,
      creditLimit,
      promisesBroken,
      dunningLevel,
    })

    return {
      customerId: Number(r.id),
      code: String(r.code),
      name: String(r.name),
      email: (r.email as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
      status: String(r.status),
      balance,
      creditLimit,
      overdueAmount,
      oldestDays,
      dunningLevel,
      lastDunnedAt: r.last_dunned_at === null ? null : String(r.last_dunned_at),
      pausedUntil: r.paused_until === null ? null : String(r.paused_until),
      pauseReason: (r.pause_reason as string | null) ?? null,
      heldAt: (r.held_at as Date | null) ?? null,
      holdReason: (r.hold_reason as string | null) ?? null,
      promisesMade: Number(r.promises_made ?? 0),
      promisesKept: Number(r.promises_kept ?? 0),
      promisesBroken,
      hasOpenPromise: r.open_promise_date !== null,
      openPromiseDate: r.open_promise_date === null ? null : String(r.open_promise_date),
      risk: risk.band,
      riskReason: risk.reason,
    }
  })
}

/** The unpaid documents behind one account's overdue figure. */
export async function overdueDocuments(
  siteId: number,
  customerId: number,
  asAt?: string,
): Promise<OverdueDoc[]> {
  const on = asAt ?? today()
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, doc_number, doc_date, due_date, amount_outstanding
       FROM customer_transactions
      WHERE customer_id = ? AND amount_outstanding > 0
      ORDER BY due_date, doc_date`,
    [customerId],
  )
  return rows.map((r) => {
    const due = r.due_date === null ? null : String(r.due_date)
    return {
      id: Number(r.id),
      docNumber: (r.doc_number as string | null) ?? null,
      docDate: String(r.doc_date),
      dueDate: due,
      daysOverdue: due ? Math.max(0, daysBetween(due, on)) : 0,
      outstanding: toNum(r.amount_outstanding),
    }
  })
}

/** Whether an account has a disputed contact that nobody has resolved. */
async function disputedIds(siteId: number): Promise<Set<number>> {
  // A dispute is "live" until something later is logged on the account. A
  // dispute from two years ago should not shield a debtor forever.
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT c.customer_id
       FROM credit_contacts c
       JOIN (
         SELECT customer_id, MAX(id) AS last_id
           FROM credit_contacts GROUP BY customer_id
       ) l ON l.last_id = c.id
      WHERE c.outcome = 'disputed'`,
  )
  return new Set(rows.map((r) => Number(r.customer_id)))
}

/* ── Building a run ──────────────────────────────────────────────────────── */

export type RunStatus = 'draft' | 'sending' | 'completed' | 'cancelled'
export type ItemStatus = 'queued' | 'sent' | 'failed' | 'skipped' | 'excluded'

export type DunningRun = {
  id: number
  asAt: string
  status: RunStatus
  totalCount: number
  sentCount: number
  failedCount: number
  skippedCount: number
  totalOverdue: number
  userName: string
  sentByName: string | null
  startedAt: Date | null
  finishedAt: Date | null
  error: string | null
  createdAt: Date
}

export type DunningItem = {
  id: number
  runId: number
  customerId: number
  customerCode: string
  customerName: string
  email: string | null
  levelId: number | null
  levelStep: number
  levelName: string
  overdueAmount: number
  totalBalance: number
  oldestDays: number
  status: ItemStatus
  attempts: number
  error: string | null
  sentAt: Date | null
}

function mapRun(r: Row): DunningRun {
  return {
    id: Number(r.id),
    asAt: String(r.as_at),
    status: String(r.status) as RunStatus,
    totalCount: Number(r.total_count),
    sentCount: Number(r.sent_count),
    failedCount: Number(r.failed_count),
    skippedCount: Number(r.skipped_count),
    totalOverdue: toNum(r.total_overdue),
    userName: String(r.user_name ?? ''),
    sentByName: (r.sent_by_name as string | null) ?? null,
    startedAt: (r.started_at as Date | null) ?? null,
    finishedAt: (r.finished_at as Date | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

function mapItem(r: Row): DunningItem {
  return {
    id: Number(r.id),
    runId: Number(r.run_id),
    customerId: Number(r.customer_id),
    customerCode: String(r.customer_code),
    customerName: String(r.customer_name),
    email: (r.email as string | null) ?? null,
    levelId: r.level_id === null ? null : Number(r.level_id),
    levelStep: Number(r.level_step),
    levelName: String(r.level_name),
    overdueAmount: toNum(r.overdue_amount),
    totalBalance: toNum(r.total_balance),
    oldestDays: Number(r.oldest_days),
    status: String(r.status) as ItemStatus,
    attempts: Number(r.attempts),
    error: (r.error as string | null) ?? null,
    sentAt: (r.sent_at as Date | null) ?? null,
  }
}

export async function getRun(siteId: number, id: number): Promise<DunningRun | null> {
  const row = await siteQueryOne<Row>(siteId, 'SELECT * FROM dunning_runs WHERE id = ? LIMIT 1', [
    id,
  ])
  return row ? mapRun(row) : null
}

export async function listRuns(siteId: number, limit = 20): Promise<DunningRun[]> {
  const capped = Math.min(Math.max(limit, 1), 100)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM dunning_runs ORDER BY created_at DESC LIMIT ${capped}`,
  )
  return rows.map(mapRun)
}

export async function listItems(
  siteId: number,
  runId: number,
  status?: ItemStatus,
): Promise<DunningItem[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM dunning_run_items
      WHERE run_id = ? ${status ? 'AND status = ?' : ''}
      ORDER BY level_step DESC, overdue_amount DESC`,
    status ? [runId, status] : [runId],
  )
  return rows.map(mapItem)
}

export type BuildResult =
  | { ok: true; runId: number; queued: number; skipped: number }
  | { ok: false; error: string }

/**
 * Builds a run. SENDS NOTHING.
 *
 * ── WHY BUILDING AND SENDING ARE SEPARATE ────────────────────────────────
 *
 * A statement is a factual record and can go out unread. A final demand
 * threatens to suspend an account, and a mis-set ladder that sends forty of
 * them to good customers is not a bug you can apologise your way out of.
 *
 * So a run is proposed, a human reads it, and only then does anything leave the
 * building. Same shape as the interest and depreciation runs.
 *
 * Accounts that will NOT be chased are recorded as skipped with the reason
 * rather than left out. "Why was Harbour Cafe not chased" is the question the
 * review screen exists to answer, and an account that silently never appears
 * cannot answer it.
 */
export async function buildRun(
  siteId: number,
  actor: Actor,
  options: { asAt?: string; customerIds?: number[] } = {},
): Promise<BuildResult> {
  const asAt = options.asAt ?? today()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asAt)) return { ok: false, error: 'Choose a valid date.' }

  const [levels, positions, disputed, minGapDays] = await Promise.all([
    listLevels(siteId, true),
    listPositions(siteId, { asAt }),
    disputedIds(siteId),
    getNumber(siteId, 'dunning_min_gap_days', 7),
  ])

  if (levels.length === 0) {
    return { ok: false, error: 'No dunning levels are active. Set up the ladder first.' }
  }

  const wanted = options.customerIds?.length ? new Set(options.customerIds) : null
  const considered = wanted
    ? positions.filter((p) => wanted.has(p.customerId))
    : positions.filter((p) => p.overdueAmount > 0)

  if (considered.length === 0) {
    return { ok: false, error: 'Nothing is overdue. There is nobody to chase.' }
  }

  type Planned = {
    position: AccountPosition
    level: DunningLevel | null
    status: ItemStatus
    error: string | null
  }

  const planned: Planned[] = considered.map((p) => {
    const position: CreditPosition = {
      overdueAmount: p.overdueAmount,
      oldestDays: p.oldestDays,
      currentLevel: p.dunningLevel,
      lastDunnedAt: p.lastDunnedAt,
      pausedUntil: p.pausedUntil,
      hasOpenPromise: p.hasOpenPromise,
      isDisputed: disputed.has(p.customerId),
    }

    const decision = decideLevel(position, levels, { asAt, minGapDays })
    if (!decision.chase) {
      return { position: p, level: null, status: 'skipped', error: SKIP_LABELS[decision.reason] }
    }
    // An account with no email cannot be emailed. It is still listed, because a
    // level that requires a call is work for a person either way.
    if (!p.email?.trim()) {
      return {
        position: p,
        level: decision.level,
        status: 'skipped',
        error: 'No email address on file.',
      }
    }
    return { position: p, level: decision.level, status: 'queued', error: null }
  })

  const queued = planned.filter((p) => p.status === 'queued')
  const skipped = planned.length - queued.length
  const totalOverdue = round(
    queued.reduce((sum, p) => sum + p.position.overdueAmount, 0),
    2,
  )

  return siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO dunning_runs (as_at, status, total_count, skipped_count, total_overdue, user_id, user_name)
       VALUES (?,'draft',?,?,?,?,?)`,
      [
        asAt,
        planned.length,
        skipped,
        totalOverdue.toFixed(4),
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )
    const runId = (res as { insertId: number }).insertId

    for (const p of planned) {
      await tx.execute(
        `INSERT INTO dunning_run_items
           (run_id, customer_id, customer_code, customer_name, email,
            level_id, level_step, level_name,
            overdue_amount, total_balance, oldest_days, status, error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          runId,
          p.position.customerId,
          p.position.code,
          p.position.name,
          p.position.email,
          p.level?.id ?? null,
          p.level?.step ?? 0,
          p.level?.name ?? 'Not chased',
          p.position.overdueAmount.toFixed(4),
          p.position.balance.toFixed(4),
          p.position.oldestDays,
          p.status,
          p.error,
        ] as never,
      )
    }

    return { ok: true as const, runId, queued: queued.length, skipped }
  })
}

/** Take an account out of a draft run. A judgement call, recorded as one. */
export async function excludeItem(
  siteId: number,
  actor: Actor,
  itemId: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const item = await siteQueryOne<Row>(
    siteId,
    `SELECT i.*, r.status AS run_status FROM dunning_run_items i
       JOIN dunning_runs r ON r.id = i.run_id WHERE i.id = ? LIMIT 1`,
    [itemId],
  )
  if (!item) return { ok: false, error: 'That line no longer exists.' }
  if (String(item.run_status) !== 'draft') {
    return { ok: false, error: 'That run has already been released.' }
  }
  if (String(item.status) !== 'queued') {
    return { ok: false, error: 'That line was not going to be sent anyway.' }
  }

  await siteExecute(
    siteId,
    `UPDATE dunning_run_items SET status = 'excluded', error = ? WHERE id = ?`,
    [reason.trim().slice(0, 400) || 'Removed during review', itemId],
  )
  await siteExecute(
    siteId,
    `UPDATE dunning_runs SET skipped_count = skipped_count + 1 WHERE id = ?`,
    [Number(item.run_id)],
  )
  await logActivity(siteId, actor, {
    entity: 'credit',
    entityId: Number(item.run_id),
    action: 'run.exclude',
    detail: `Removed ${String(item.customer_name)} from the run`,
  })
  return { ok: true }
}

export async function cancelRun(
  siteId: number,
  actor: Actor,
  runId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const run = await getRun(siteId, runId)
  if (!run) return { ok: false, error: 'That run no longer exists.' }
  if (run.status !== 'draft') return { ok: false, error: 'Only a draft run can be cancelled.' }

  await siteExecute(siteId, `UPDATE dunning_runs SET status = 'cancelled' WHERE id = ?`, [runId])
  await logActivity(siteId, actor, {
    entity: 'credit',
    entityId: runId,
    action: 'run.cancel',
    detail: `Cancelled dunning run #${runId}`,
  })
  return { ok: true }
}

/* ── Sending ─────────────────────────────────────────────────────────────── */

export type SendResult = { sent: number; failed: number }

/**
 * Works a released run's queue.
 *
 * Sequential on purpose, for the same reason statement runs are: most SMTP
 * providers rate-limit hard enough that firing two hundred sends at once is how
 * a run gets throttled halfway through, and each item is committed as it
 * completes so a crash leaves the first half genuinely sent.
 *
 * ── WHAT HAPPENS BESIDES THE EMAIL ───────────────────────────────────────
 *
 * A successful send does three more things, and all of them matter more than
 * the email itself:
 *
 *   The account's level moves up, so next time it escalates rather than
 *   repeating.
 *   A contact is logged, so the next person to open the account can see it
 *   was already chased today.
 *   If the level blocks credit, the account goes on hold WITH a reason
 *   pointing at this run.
 */
export async function processRun(
  siteId: number,
  runId: number,
  actor: Actor,
  deps: {
    companyName: string
    send: (input: {
      to: string
      subject: string
      text: string
    }) => Promise<{ ok: true } | { ok: false; error: string }>
  },
): Promise<SendResult> {
  const run = await getRun(siteId, runId)
  if (!run) return { sent: 0, failed: 0 }
  if (run.status !== 'draft' && run.status !== 'sending') return { sent: 0, failed: 0 }

  await siteExecute(
    siteId,
    `UPDATE dunning_runs SET status = 'sending', started_at = NOW(), sent_by_id = ?, sent_by_name = ? WHERE id = ?`,
    [actor.userId, actor.userName.slice(0, 120), runId],
  )
  await logActivity(siteId, actor, {
    entity: 'credit',
    entityId: runId,
    action: 'run.release',
    detail: `Released dunning run #${runId}`,
  })

  const items = await listItems(siteId, runId, 'queued')
  const levels = new Map((await listLevels(siteId)).map((l) => [l.id, l]))

  let sent = 0
  let failed = 0

  for (const item of items) {
    const level = item.levelId === null ? null : levels.get(item.levelId)
    if (!level || !item.email) {
      failed++
      await siteExecute(
        siteId,
        `UPDATE dunning_run_items SET status='failed', attempts=attempts+1, error=? WHERE id=?`,
        ['The level this line used no longer exists.', item.id],
      )
      continue
    }

    const docs = await overdueDocuments(siteId, item.customerId, run.asAt)
    const values = {
      customer: item.customerName,
      company: deps.companyName,
      overdue: formatMoney(item.overdueAmount),
      balance: formatMoney(item.totalBalance),
      oldest_days: String(item.oldestDays),
      as_at: run.asAt,
      lines: docs
        .map(
          (d) =>
            `  ${d.docNumber ?? `#${d.id}`}  ${d.docDate}  ${formatMoney(d.outstanding)}` +
            (d.daysOverdue > 0 ? `  (${d.daysOverdue} days overdue)` : ''),
        )
        .join('\n'),
    }

    const result = await deps.send({
      to: item.email,
      subject: renderTemplate(level.subject, values),
      text: renderTemplate(level.body, values),
    })

    if (result.ok) {
      sent++
      await siteExecute(
        siteId,
        `UPDATE dunning_run_items SET status='sent', attempts=attempts+1, sent_at=NOW(), error=NULL WHERE id=?`,
        [item.id],
      )
      await recordSend(siteId, actor, item, level, run.asAt)
    } else {
      failed++
      await siteExecute(
        siteId,
        `UPDATE dunning_run_items SET status='failed', attempts=attempts+1, error=? WHERE id=?`,
        [result.error.slice(0, 400), item.id],
      )
    }

    await siteExecute(
      siteId,
      `UPDATE dunning_runs SET sent_count=?, failed_count=? WHERE id=?`,
      [sent, failed, runId],
    )
  }

  await siteExecute(
    siteId,
    `UPDATE dunning_runs SET status='completed', finished_at=NOW() WHERE id=?`,
    [runId],
  )

  return { sent, failed }
}

/**
 * Everything a successful send changes besides the item's own status.
 *
 * Level, contact log, and possibly a credit hold. Kept together so a send can
 * never move the level without logging why, which is how an account ends up
 * unexplainably at level 3.
 */
async function recordSend(
  siteId: number,
  actor: Actor,
  item: DunningItem,
  level: DunningLevel,
  asAt: string,
): Promise<void> {
  await siteExecute(
    siteId,
    `INSERT INTO customer_credit_status (customer_id, dunning_level, last_dunned_at, last_run_id)
     VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE
       dunning_level = GREATEST(dunning_level, VALUES(dunning_level)),
       last_dunned_at = VALUES(last_dunned_at),
       last_run_id = VALUES(last_run_id)`,
    [item.customerId, level.step, asAt, item.runId],
  )

  await siteExecute(
    siteId,
    `INSERT INTO credit_contacts
       (customer_id, contact_date, kind, outcome, summary, balance_at, run_item_id, user_id, user_name)
     VALUES (?,?,'email','none',?,?,?,?,?)`,
    [
      item.customerId,
      asAt,
      `${level.name} sent — ${formatMoney(item.overdueAmount)} overdue`,
      item.overdueAmount.toFixed(4),
      item.id,
      actor.userId,
      actor.userName.slice(0, 120),
    ],
  )

  if (level.blocksAccount) {
    await holdAccount(
      siteId,
      actor,
      item.customerId,
      `${level.name} — ${formatMoney(item.overdueAmount)} overdue`,
    )
  }
}

/* ── Holds and pauses ────────────────────────────────────────────────────── */

/**
 * Suspend an account's credit.
 *
 * Writes customers.status AND the reason, because status alone cannot say
 * whether collections did this or a manager did, and releasing it should be a
 * deliberate act by someone who can see why it happened.
 *
 * An account already on hold is left alone rather than having its original
 * reason overwritten by a later run — the first reason is the true one.
 */
export async function holdAccount(
  siteId: number,
  actor: Actor,
  customerId: number,
  reason: string,
): Promise<void> {
  const existing = await siteQueryOne<Row>(
    siteId,
    'SELECT held_at FROM customer_credit_status WHERE customer_id = ? LIMIT 1',
    [customerId],
  )
  if (existing?.held_at) return

  await siteExecute(
    siteId,
    `INSERT INTO customer_credit_status (customer_id, held_at, hold_reason)
     VALUES (?, NOW(), ?)
     ON DUPLICATE KEY UPDATE held_at = NOW(), hold_reason = VALUES(hold_reason)`,
    [customerId, reason.slice(0, 200)],
  )
  await siteExecute(
    siteId,
    `UPDATE customers SET status = 'on_hold', status_reason = ? WHERE id = ? AND status = 'active'`,
    [reason.slice(0, 200), customerId],
  )
  await logActivity(siteId, actor, {
    entity: 'credit',
    entityId: customerId,
    action: 'account.hold',
    detail: reason.slice(0, 400),
  })
}

export async function releaseAccount(
  siteId: number,
  actor: Actor,
  customerId: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await siteExecute(
    siteId,
    `UPDATE customer_credit_status SET held_at = NULL, hold_reason = NULL WHERE customer_id = ?`,
    [customerId],
  )
  await siteExecute(
    siteId,
    `UPDATE customers SET status = 'active', status_reason = NULL WHERE id = ? AND status = 'on_hold'`,
    [customerId],
  )
  await logActivity(siteId, actor, {
    entity: 'credit',
    entityId: customerId,
    action: 'account.release',
    detail: reason.slice(0, 400) || 'Credit restored',
  })
  return { ok: true }
}

/** Stop chasing for a while without changing what is owed. */
export async function pauseChasing(
  siteId: number,
  actor: Actor,
  customerId: number,
  until: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return { ok: false, error: 'Choose a valid date.' }
  if (until < today()) return { ok: false, error: 'That date has already passed.' }
  if (!reason.trim()) return { ok: false, error: 'Say why chasing is paused.' }

  await siteExecute(
    siteId,
    `INSERT INTO customer_credit_status (customer_id, paused_until, pause_reason)
     VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE paused_until = VALUES(paused_until), pause_reason = VALUES(pause_reason)`,
    [customerId, until, reason.trim().slice(0, 200)],
  )
  await logActivity(siteId, actor, {
    entity: 'credit',
    entityId: customerId,
    action: 'account.pause',
    detail: `Chasing paused until ${until} — ${reason.trim()}`.slice(0, 400),
  })
  return { ok: true }
}

export async function resumeChasing(
  siteId: number,
  actor: Actor,
  customerId: number,
): Promise<{ ok: true }> {
  await siteExecute(
    siteId,
    `UPDATE customer_credit_status SET paused_until = NULL, pause_reason = NULL WHERE customer_id = ?`,
    [customerId],
  )
  await logActivity(siteId, actor, {
    entity: 'credit',
    entityId: customerId,
    action: 'account.resume',
    detail: 'Chasing resumed',
  })
  return { ok: true }
}

/**
 * Reset an account's position on the ladder.
 *
 * Called when an account clears its arrears: the next time it falls behind it
 * should start at a friendly reminder, not resume at the final demand it
 * reached two years ago.
 */
export async function resetLevel(siteId: number, customerId: number): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE customer_credit_status SET dunning_level = 0 WHERE customer_id = ? AND dunning_level > 0`,
    [customerId],
  )
}

/* ── Promises ────────────────────────────────────────────────────────────── */

export type PaymentPromise = {
  id: number
  customerId: number
  customerCode: string
  customerName: string
  promisedDate: string
  promisedAmount: number
  balanceAtPromise: number
  receivedAmount: number
  status: PromiseStatus
  state: PromiseState
  promisedBy: string | null
  notes: string | null
  userName: string
  resolvedAt: Date | null
  createdAt: Date
}

function mapPromise(r: Row, asAt: string, graceDays: number): PaymentPromise {
  const status = String(r.status) as PromiseStatus
  const promisedAmount = toNum(r.promised_amount)
  const receivedAmount = toNum(r.received_amount)
  return {
    id: Number(r.id),
    customerId: Number(r.customer_id),
    customerCode: String(r.customer_code ?? ''),
    customerName: String(r.customer_name ?? ''),
    promisedDate: String(r.promised_date),
    promisedAmount,
    balanceAtPromise: toNum(r.balance_at_promise),
    receivedAmount,
    status,
    state: promiseState({
      status,
      promisedDate: String(r.promised_date),
      promisedAmount,
      receivedAmount,
      asAt,
      graceDays,
    }),
    promisedBy: (r.promised_by as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    userName: String(r.user_name ?? ''),
    resolvedAt: (r.resolved_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

const PROMISE_SELECT = `
  SELECT p.*, c.code AS customer_code, c.name AS customer_name
    FROM payment_promises p
    JOIN customers c ON c.id = p.customer_id`

export async function listPromises(
  siteId: number,
  options: { customerId?: number; status?: PromiseStatus; limit?: number } = {},
): Promise<PaymentPromise[]> {
  const asAt = today()
  const graceDays = await getNumber(siteId, 'promise_grace_days', 2)
  const where: string[] = []
  const params: unknown[] = []
  if (options.customerId) {
    where.push('p.customer_id = ?')
    params.push(options.customerId)
  }
  if (options.status) {
    where.push('p.status = ?')
    params.push(options.status)
  }
  const capped = Math.min(Math.max(options.limit ?? 200, 1), 500)

  const rows = await siteQuery<Row>(
    siteId,
    `${PROMISE_SELECT}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY p.promised_date DESC, p.id DESC LIMIT ${capped}`,
    params,
  )
  return rows.map((r) => mapPromise(r, asAt, graceDays))
}

export type CreatePromiseInput = {
  customerId: number
  promisedDate: string
  promisedAmount: number
  promisedBy?: string | null
  notes?: string | null
  runItemId?: number | null
}

export type PromiseResult = { ok: true; id: number } | { ok: false; error: string }

/**
 * Record what a customer committed to.
 *
 * The balance at the time is captured because without it a promise of 5,000
 * against a 5,000 balance and the same promise against 50,000 read identically
 * a month later, and they are not the same commitment at all.
 */
export async function createPromise(
  siteId: number,
  actor: Actor,
  input: CreatePromiseInput,
): Promise<PromiseResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.promisedDate)) {
    return { ok: false, error: 'Choose a valid date.' }
  }
  if (!(input.promisedAmount > 0)) return { ok: false, error: 'The amount must be more than zero.' }

  const customer = await siteQueryOne<Row>(
    siteId,
    'SELECT id, name, balance FROM customers WHERE id = ? LIMIT 1',
    [input.customerId],
  )
  if (!customer) return { ok: false, error: 'That account no longer exists.' }

  // One open promise at a time. Two live promises on one account cannot both be
  // "the" commitment, and the escalation rules would not know which to honour.
  const open = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM payment_promises WHERE customer_id = ? AND status = 'open' LIMIT 1`,
    [input.customerId],
  )
  if (open) {
    return {
      ok: false,
      error: 'That account already has an open promise. Settle or cancel it first.',
    }
  }

  const balance = toNum(customer.balance)
  const res = await siteExecute(
    siteId,
    `INSERT INTO payment_promises
       (customer_id, promised_date, promised_amount, balance_at_promise,
        promised_by, notes, run_item_id, user_id, user_name)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      input.customerId,
      input.promisedDate,
      input.promisedAmount.toFixed(4),
      balance.toFixed(4),
      input.promisedBy?.trim().slice(0, 120) || null,
      input.notes?.trim() || null,
      input.runItemId ?? null,
      actor.userId,
      actor.userName.slice(0, 120),
    ],
  )
  const id = res.insertId

  await siteExecute(
    siteId,
    `INSERT INTO customer_credit_status (customer_id, promises_made)
     VALUES (?, 1)
     ON DUPLICATE KEY UPDATE promises_made = promises_made + 1`,
    [input.customerId],
  )

  await siteExecute(
    siteId,
    `INSERT INTO credit_contacts
       (customer_id, contact_date, kind, outcome, summary, balance_at, promise_id, user_id, user_name)
     VALUES (?,?,'call','promised',?,?,?,?,?)`,
    [
      input.customerId,
      today(),
      `Promised ${formatMoney(input.promisedAmount)} by ${input.promisedDate}`,
      balance.toFixed(4),
      id,
      actor.userId,
      actor.userName.slice(0, 120),
    ],
  )

  await logActivity(siteId, actor, {
    entity: 'credit',
    entityId: input.customerId,
    action: 'promise.create',
    detail: `${String(customer.name)} promised ${formatMoney(input.promisedAmount)} by ${input.promisedDate}`,
  })

  return { ok: true, id }
}

/**
 * Settle a promise, and keep the counters honest.
 *
 * A broken promise stays broken in the counters even if the money arrives
 * later. That is the point of the record: a customer who has needed three
 * chases to honour every commitment is a different risk from one who pays on
 * the day they said, and flattering the history hides exactly that.
 */
export async function resolvePromise(
  siteId: number,
  actor: Actor,
  promiseId: number,
  outcome: 'kept' | 'broken' | 'cancelled',
  receivedAmount?: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await siteQueryOne<Row>(
    siteId,
    `${PROMISE_SELECT} WHERE p.id = ? LIMIT 1`,
    [promiseId],
  )
  if (!row) return { ok: false, error: 'That promise no longer exists.' }
  if (String(row.status) !== 'open') return { ok: false, error: 'That promise is already settled.' }

  const customerId = Number(row.customer_id)

  await siteExecute(
    siteId,
    `UPDATE payment_promises
        SET status = ?, received_amount = ?, resolved_at = NOW()
      WHERE id = ?`,
    [outcome, (receivedAmount ?? toNum(row.received_amount)).toFixed(4), promiseId],
  )

  // Cancelled does not count either way — it was entered in error or
  // superseded, and counting it as broken would punish a correction.
  if (outcome === 'kept' || outcome === 'broken') {
    const column = outcome === 'kept' ? 'promises_kept' : 'promises_broken'
    await siteExecute(
      siteId,
      `INSERT INTO customer_credit_status (customer_id, ${column})
       VALUES (?, 1)
       ON DUPLICATE KEY UPDATE ${column} = ${column} + 1`,
      [customerId],
    )
  }

  await logActivity(siteId, actor, {
    entity: 'credit',
    entityId: customerId,
    action: `promise.${outcome}`,
    detail: `${String(row.customer_name)} — promise of ${formatMoney(toNum(row.promised_amount))} ${outcome}`,
  })

  return { ok: true }
}

/**
 * Sweep open promises whose date has passed and mark them broken.
 *
 * Run when the collections screen loads rather than on a schedule, because a
 * back office without a cron still needs the list to be right when someone
 * opens it. Idempotent: a promise already resolved is not touched.
 */
export async function sweepPromises(siteId: number, actor: Actor): Promise<number> {
  const graceDays = await getNumber(siteId, 'promise_grace_days', 2)
  const open = await listPromises(siteId, { status: 'open' })
  const broken = open.filter((p) => p.state === 'broken')

  for (const promise of broken) {
    await resolvePromise(siteId, actor, promise.id, 'broken', promise.receivedAmount)
  }
  void graceDays
  return broken.length
}

/* ── Contact log ─────────────────────────────────────────────────────────── */

export type ContactKind = 'email' | 'call' | 'note' | 'meeting' | 'letter'
export type ContactOutcome = 'promised' | 'disputed' | 'no_answer' | 'paid' | 'refused' | 'none'

export const CONTACT_KIND_LABELS: Record<ContactKind, string> = {
  email: 'Email',
  call: 'Call',
  note: 'Note',
  meeting: 'Meeting',
  letter: 'Letter',
}

export const CONTACT_OUTCOME_LABELS: Record<ContactOutcome, string> = {
  promised: 'Promised to pay',
  disputed: 'Disputed',
  no_answer: 'No answer',
  paid: 'Paid',
  refused: 'Refused',
  none: 'Logged',
}

export type CreditContact = {
  id: number
  customerId: number
  contactDate: string
  kind: ContactKind
  outcome: ContactOutcome
  summary: string
  detail: string | null
  balanceAt: number
  runItemId: number | null
  promiseId: number | null
  userName: string
  createdAt: Date
}

function mapContact(r: Row): CreditContact {
  return {
    id: Number(r.id),
    customerId: Number(r.customer_id),
    contactDate: String(r.contact_date),
    kind: String(r.kind) as ContactKind,
    outcome: String(r.outcome) as ContactOutcome,
    summary: String(r.summary),
    detail: (r.detail as string | null) ?? null,
    balanceAt: toNum(r.balance_at),
    runItemId: r.run_item_id === null ? null : Number(r.run_item_id),
    promiseId: r.promise_id === null ? null : Number(r.promise_id),
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
  }
}

export async function listContacts(
  siteId: number,
  customerId: number,
  limit = 50,
): Promise<CreditContact[]> {
  const capped = Math.min(Math.max(limit, 1), 200)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM credit_contacts WHERE customer_id = ?
      ORDER BY contact_date DESC, id DESC LIMIT ${capped}`,
    [customerId],
  )
  return rows.map(mapContact)
}

export type LogContactInput = {
  customerId: number
  contactDate?: string
  kind: ContactKind
  outcome: ContactOutcome
  summary: string
  detail?: string | null
}

export async function logContact(
  siteId: number,
  actor: Actor,
  input: LogContactInput,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  if (!input.summary.trim()) return { ok: false, error: 'Say what happened.' }
  const date = input.contactDate ?? today()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Choose a valid date.' }

  const customer = await siteQueryOne<Row>(
    siteId,
    'SELECT id, balance FROM customers WHERE id = ? LIMIT 1',
    [input.customerId],
  )
  if (!customer) return { ok: false, error: 'That account no longer exists.' }

  const res = await siteExecute(
    siteId,
    `INSERT INTO credit_contacts
       (customer_id, contact_date, kind, outcome, summary, detail, balance_at, user_id, user_name)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      input.customerId,
      date,
      input.kind,
      input.outcome,
      input.summary.trim().slice(0, 300),
      input.detail?.trim() || null,
      toNum(customer.balance).toFixed(4),
      actor.userId,
      actor.userName.slice(0, 120),
    ],
  )

  await logActivity(siteId, actor, {
    entity: 'credit',
    entityId: input.customerId,
    action: 'contact.log',
    detail: `${CONTACT_KIND_LABELS[input.kind]} — ${input.summary.trim()}`.slice(0, 400),
  })

  return { ok: true, id: res.insertId }
}

/* ── Dashboard ───────────────────────────────────────────────────────────── */

export type CreditSummary = {
  overdueTotal: number
  overdueAccounts: number
  chaseable: number
  onHold: number
  promisedTotal: number
  promisesDueThisWeek: number
  promisesBroken: number
  worstDays: number
  byRisk: Record<RiskBand, { count: number; value: number }>
}

/**
 * The numbers the collections screen leads with.
 *
 * Deliberately not "how many debtors" — that is the age analysis' job. This
 * answers "what should someone do this morning": what is chaseable now, whose
 * promise lands today, and which promises were broken while nobody looked.
 */
export async function creditSummary(siteId: number): Promise<CreditSummary> {
  const asAt = today()
  const [positions, promises] = await Promise.all([
    listPositions(siteId, { asAt, onlyOverdue: true }),
    listPromises(siteId, { status: 'open' }),
  ])

  const byRisk: Record<RiskBand, { count: number; value: number }> = {
    good: { count: 0, value: 0 },
    watch: { count: 0, value: 0 },
    poor: { count: 0, value: 0 },
    bad: { count: 0, value: 0 },
  }
  for (const p of positions) {
    byRisk[p.risk].count++
    byRisk[p.risk].value = round(byRisk[p.risk].value + p.overdueAmount, 2)
  }

  const weekOut = new Date(Date.parse(`${asAt}T00:00:00Z`) + 7 * 86_400_000)
    .toISOString()
    .slice(0, 10)

  return {
    overdueTotal: round(
      positions.reduce((sum, p) => sum + p.overdueAmount, 0),
      2,
    ),
    overdueAccounts: positions.length,
    chaseable: positions.filter(
      (p) => !p.hasOpenPromise && !(p.pausedUntil && p.pausedUntil >= asAt),
    ).length,
    onHold: positions.filter((p) => p.heldAt !== null).length,
    promisedTotal: round(
      promises.reduce((sum, p) => sum + p.promisedAmount, 0),
      2,
    ),
    promisesDueThisWeek: promises.filter((p) => p.promisedDate <= weekOut).length,
    promisesBroken: promises.filter((p) => p.state === 'broken').length,
    worstDays: positions.reduce((worst, p) => Math.max(worst, p.oldestDays), 0),
    byRisk,
  }
}

/**
 * One account's full credit picture, for its tab on the customer screen.
 *
 * Null means the account does not exist. When it returns, `position` is always
 * present — hence the non-nullable field rather than a second thing every
 * caller has to check.
 */
export async function accountCredit(
  siteId: number,
  customerId: number,
): Promise<{
  position: AccountPosition
  promises: PaymentPromise[]
  contacts: CreditContact[]
  documents: OverdueDoc[]
  reliability: { rate: number | null; decided: number }
} | null> {
  const positions = await listPositions(siteId, {})
  const position = positions.find((p) => p.customerId === customerId) ?? null
  if (!position) return null

  const [promises, contacts, documents] = await Promise.all([
    listPromises(siteId, { customerId }),
    listContacts(siteId, customerId),
    overdueDocuments(siteId, customerId),
  ])

  return {
    position,
    promises,
    contacts,
    documents,
    reliability: reliability({
      kept: position.promisesKept,
      broken: position.promisesBroken,
    }),
  }
}

/* ── Settings ────────────────────────────────────────────────────────────── */

/**
 * Read a numeric setting without depending on settings.ts' SettingKey union.
 *
 * Deliberate: settings.ts is a shared file that other work is editing, and a
 * new module should not need a change there to function. Falls back to the
 * default when the row is missing or unparseable.
 */
async function getNumber(siteId: number, key: string, fallback: number): Promise<number> {
  const row = await siteQueryOne<RowDataPacket & { setting_value: string | null }>(
    siteId,
    'SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1',
    [key],
  )
  const parsed = Number(row?.setting_value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export { SKIP_LABELS }
export type { SkipReason, DunningLevel, RiskBand, PromiseStatus, PromiseState }
