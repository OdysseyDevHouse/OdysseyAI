import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { logActivity, type Actor } from './activityLog'
import { today } from './ledger'
import { insertDraft, postDraft, type PostResult } from './journals'
import { refuseJournal, type JournalLineInput } from '../glModel'
import { isDue, nextOccurrence, type RecurringFrequency } from '../expenseModel'

/**
 * Recurring journals — the monthly accrual, the prepayment release, the
 * recharge that is the same entry every period.
 *
 * A structural port of recurringExpenses.ts, and deliberately so: one
 * doctrine ("a template generates a DRAFT, never a posting — the schedule
 * removes the TYPING, not the judgement"), one date arithmetic (isDue /
 * nextOccurrence from expenseModel, which contracts also reuse), one
 * catch-up rule (a schedule left alone for three months produces three
 * drafts, each stamped before the next is considered).
 *
 * The one departure: `auto_post`. An accrual that never varies by a cent may
 * opt into posting unattended — and when the post is REFUSED (a locked
 * period, a deactivated account), the occurrence falls back to a draft with
 * the reason recorded, because a schedule that silently skips a month is the
 * exact failure this feature exists to prevent.
 */

export type RecurringJournalLine = {
  id: number
  lineNumber: number
  accountId: number
  accountCode?: string | null
  accountName?: string | null
  /** Signed: positive debit, negative credit. */
  amount: number
  description: string | null
  departmentId: number | null
}

export type RecurringJournal = {
  id: number
  name: string
  frequency: RecurringFrequency
  dayOfMonth: number | null
  dayOfWeek: number | null
  description: string
  reference: string | null
  startsOn: string
  endsOn: string | null
  lastGeneratedFor: string | null
  autoPost: boolean
  isActive: boolean
  notes: string | null
  userName: string
  createdAt: Date
  /** Computed: when this will next produce an entry. Null once ended. */
  nextDue: string | null
  due: boolean
  lines: RecurringJournalLine[]
}

type Row = RowDataPacket & Record<string, unknown>

function mapRecurring(r: Row, lines: RecurringJournalLine[] = [], asAt = today()): RecurringJournal {
  const schedule = {
    frequency: String(r.frequency) as RecurringFrequency,
    dayOfMonth: r.day_of_month === null ? null : Number(r.day_of_month),
    dayOfWeek: r.day_of_week === null ? null : Number(r.day_of_week),
    startsOn: String(r.starts_on),
    endsOn: r.ends_on === null ? null : String(r.ends_on),
    lastGeneratedFor: r.last_generated_for === null ? null : String(r.last_generated_for),
  }
  const active = Boolean(r.is_active)

  return {
    id: Number(r.id),
    name: String(r.name),
    frequency: schedule.frequency,
    dayOfMonth: schedule.dayOfMonth,
    dayOfWeek: schedule.dayOfWeek,
    description: String(r.description),
    reference: (r.reference as string | null) ?? null,
    startsOn: schedule.startsOn,
    endsOn: schedule.endsOn,
    lastGeneratedFor: schedule.lastGeneratedFor,
    autoPost: Boolean(r.auto_post),
    isActive: active,
    notes: (r.notes as string | null) ?? null,
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
    nextDue: active ? nextOccurrence(schedule, asAt) : null,
    due: active && isDue(schedule, asAt),
    lines,
  }
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

/**
 * `asAt` threads through to the dueness computation — generation "as at" a
 * date must evaluate schedules AT that date, or a caller replaying a missed
 * window (or a test in 2097) finds every schedule "not due" against today.
 */
export async function listRecurringJournals(
  siteId: number,
  asAt = today(),
): Promise<RecurringJournal[]> {
  const rows = await siteQuery<Row>(
    siteId,
    'SELECT * FROM recurring_journals ORDER BY is_active DESC, name',
  )
  return rows.map((r) => mapRecurring(r, [], asAt))
}

export async function getRecurringJournal(
  siteId: number,
  id: number,
): Promise<RecurringJournal | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT * FROM recurring_journals WHERE id = ? LIMIT 1',
    [id],
  )
  if (!row) return null

  const lines = await siteQuery<Row>(
    siteId,
    `SELECT rl.*, a.account_code, a.name AS account_name
       FROM recurring_journal_lines rl
       LEFT JOIN gl_accounts a ON a.id = rl.account_id
      WHERE rl.recurring_id = ? ORDER BY rl.line_number`,
    [id],
  )
  return mapRecurring(
    row,
    lines.map((l) => ({
      id: Number(l.id),
      lineNumber: Number(l.line_number),
      accountId: Number(l.account_id),
      accountCode: (l.account_code as string | null) ?? null,
      accountName: (l.account_name as string | null) ?? null,
      amount: toNum(l.amount),
      description: (l.description as string | null) ?? null,
      departmentId: l.department_id === null ? null : Number(l.department_id),
    })),
  )
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export type RecurringJournalInput = {
  name: string
  frequency: RecurringFrequency
  dayOfMonth?: number | null
  dayOfWeek?: number | null
  description: string
  reference?: string | null
  startsOn: string
  endsOn?: string | null
  autoPost?: boolean
  notes?: string | null
  lines: JournalLineInput[]
}

export type SaveRecurringResult = { ok: true; id: number } | { ok: false; error: string }

export async function saveRecurringJournal(
  siteId: number,
  actor: Actor,
  input: RecurringJournalInput,
  id?: number,
): Promise<SaveRecurringResult> {
  if (!input.name?.trim()) return { ok: false, error: 'Name the schedule.' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startsOn)) return { ok: false, error: 'That start date is not valid.' }
  if (input.endsOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.endsOn)) {
    return { ok: false, error: 'That end date is not valid.' }
  }

  /*
   * The template is refused UNBALANCED AT SAVE TIME — the same rule and the
   * same message the journal form gives, via the same pure refuseJournal. A
   * template that cannot post is a trap armed for a morning three months away.
   */
  const refusal = refuseJournal({
    journalDate: input.startsOn,
    description: input.description,
    lines: input.lines,
  })
  if (refusal) return { ok: false, error: refusal }

  const savedId = await siteTransaction(siteId, async (tx) => {
    let recurringId = id ?? 0
    if (id) {
      const [res] = await tx.execute(
        `UPDATE recurring_journals
            SET name = ?, frequency = ?, day_of_month = ?, day_of_week = ?, description = ?,
                reference = ?, starts_on = ?, ends_on = ?, auto_post = ?, notes = ?
          WHERE id = ?`,
        [
          input.name.trim().slice(0, 120),
          input.frequency,
          input.dayOfMonth ?? null,
          input.dayOfWeek ?? null,
          input.description.trim().slice(0, 255),
          input.reference?.trim() || null,
          input.startsOn,
          input.endsOn ?? null,
          input.autoPost ? 1 : 0,
          input.notes?.trim() || null,
          id,
        ] as never,
      )
      if ((res as { affectedRows: number }).affectedRows === 0) {
        throw new Error('That schedule no longer exists.')
      }
      await tx.execute('DELETE FROM recurring_journal_lines WHERE recurring_id = ?', [id] as never)
    } else {
      const [res] = await tx.execute(
        `INSERT INTO recurring_journals
           (name, frequency, day_of_month, day_of_week, description, reference,
            starts_on, ends_on, auto_post, notes, user_id, user_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          input.name.trim().slice(0, 120),
          input.frequency,
          input.dayOfMonth ?? null,
          input.dayOfWeek ?? null,
          input.description.trim().slice(0, 255),
          input.reference?.trim() || null,
          input.startsOn,
          input.endsOn ?? null,
          input.autoPost ? 1 : 0,
          input.notes?.trim() || null,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      recurringId = (res as { insertId: number }).insertId
    }

    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i]
      await tx.execute(
        `INSERT INTO recurring_journal_lines
           (recurring_id, line_number, account_id, amount, description, department_id)
         VALUES (?,?,?,?,?,?)`,
        [
          recurringId,
          i + 1,
          line.accountId,
          round(line.amount, 2).toFixed(4),
          line.description?.trim().slice(0, 190) || null,
          line.departmentId ?? null,
        ] as never,
      )
    }
    return recurringId
  }).catch((error): number => {
    throw error
  })

  await logActivity(siteId, actor, {
    entity: 'gl',
    entityId: savedId,
    action: id ? 'recurring_journal_update' : 'recurring_journal_create',
    detail: input.name.trim(),
  }).catch(() => undefined)

  return { ok: true, id: savedId }
}

export async function setRecurringJournalActive(
  siteId: number,
  actor: Actor,
  id: number,
  active: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await siteExecute(siteId, 'UPDATE recurring_journals SET is_active = ? WHERE id = ?', [
    active ? 1 : 0,
    id,
  ])
  await logActivity(siteId, actor, {
    entity: 'gl',
    entityId: id,
    action: active ? 'recurring_journal_resume' : 'recurring_journal_pause',
    detail: `Schedule #${id} ${active ? 'resumed' : 'paused'}`,
  }).catch(() => undefined)
  return { ok: true }
}

export async function deleteRecurringJournal(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Generated batches survive — they carry their own snapshot of the lines
  // and their source_doc_id simply stops resolving, exactly as 125 treats a
  // retired visit type. Only the TEMPLATE goes.
  await siteExecute(siteId, 'DELETE FROM recurring_journals WHERE id = ?', [id])
  await logActivity(siteId, actor, {
    entity: 'gl',
    entityId: id,
    action: 'recurring_journal_delete',
    detail: `Schedule #${id} deleted`,
  }).catch(() => undefined)
  return { ok: true }
}

/* ── Generation ──────────────────────────────────────────────────────────── */

export type GenerateJournalsResult = {
  generated: { recurringId: number; name: string; batchId: number; forDate: string; posted: boolean }[]
  skipped: { recurringId: number; name: string; reason: string }[]
}

/**
 * Produces an entry for every schedule that is due — a DRAFT normally, a
 * posted journal when the schedule opted in AND the post is not refused.
 *
 * The catch-up loop and per-occurrence stamping are recurringExpenses'
 * generateDue, verbatim in structure: a failure part-way leaves the earlier
 * occurrences generated rather than repeating them next run.
 */
export async function generateDueJournals(
  siteId: number,
  actor: Actor,
  asAt = today(),
): Promise<GenerateJournalsResult> {
  const schedules = await listRecurringJournals(siteId, asAt)
  const result: GenerateJournalsResult = { generated: [], skipped: [] }

  for (const summary of schedules) {
    if (!summary.due) continue

    const schedule = await getRecurringJournal(siteId, summary.id)
    if (!schedule || schedule.lines.length === 0) {
      result.skipped.push({ recurringId: summary.id, name: summary.name, reason: 'The schedule has no lines.' })
      continue
    }

    let cursor = schedule.lastGeneratedFor
    let guard = 0

    while (guard++ < 24) {
      const due = nextOccurrence(
        {
          frequency: schedule.frequency,
          dayOfMonth: schedule.dayOfMonth,
          dayOfWeek: schedule.dayOfWeek,
          startsOn: schedule.startsOn,
          endsOn: schedule.endsOn,
          lastGeneratedFor: cursor,
        },
        asAt,
      )
      if (!due || due > asAt) break

      const lines: JournalLineInput[] = schedule.lines.map((l) => ({
        accountId: l.accountId,
        amount: l.amount,
        description: l.description,
        departmentId: l.departmentId,
      }))

      const draft = await insertDraft(siteId, actor, {
        journalDate: due,
        description: schedule.description,
        reference: schedule.reference,
        source: 'recurring',
        sourceDocId: schedule.id,
        lines,
      })
      if (!draft.ok) {
        result.skipped.push({ recurringId: schedule.id, name: schedule.name, reason: draft.error })
        break
      }

      let posted = false
      if (schedule.autoPost) {
        const outcome: PostResult = await postDraft(siteId, actor, draft.id)
        if (outcome.ok) {
          posted = true
        } else {
          // The draft STAYS — a refused auto-post must not vanish the month.
          result.skipped.push({
            recurringId: schedule.id,
            name: schedule.name,
            reason: `${due}: left as a draft — ${outcome.error}`,
          })
        }
      }

      await siteExecute(
        siteId,
        'UPDATE recurring_journals SET last_generated_for = ? WHERE id = ?',
        [due, schedule.id],
      )
      cursor = due

      result.generated.push({
        recurringId: schedule.id,
        name: schedule.name,
        batchId: draft.id,
        forDate: due,
        posted,
      })
    }
  }

  if (result.generated.length > 0) {
    await logActivity(siteId, actor, {
      entity: 'gl',
      entityId: null,
      action: 'recurring_journal_generate',
      detail: `Generated ${result.generated.length} journal${result.generated.length === 1 ? '' : 's'} from recurring schedules`,
    }).catch(() => undefined)
  }

  return result
}

/** The batches a schedule has produced, newest first, for its detail screen. */
export async function journalsGeneratedBy(
  siteId: number,
  recurringId: number,
  limit = 24,
): Promise<{ batchId: number; journalNumber: string | null; journalDate: string; status: string }[]> {
  const capped = Math.min(Math.max(limit, 1), 100)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, journal_number, journal_date, status
       FROM journal_batches
      WHERE source = 'recurring' AND source_doc_id = ?
      ORDER BY journal_date DESC, id DESC
      LIMIT ${capped}`,
    [recurringId],
  )
  return rows.map((r) => ({
    batchId: Number(r.id),
    journalNumber: (r.journal_number as string | null) ?? null,
    journalDate: String(r.journal_date),
    status: String(r.status),
  }))
}
