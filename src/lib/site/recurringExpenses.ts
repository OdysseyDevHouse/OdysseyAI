import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { saveDraft } from './expenses'
import { today } from './ledger'
import {
  FREQUENCIES,
  FREQUENCY_LABELS,
  isDue,
  nextOccurrence,
  type ExpensePaymentType,
  type RecurringFrequency,
} from '../expenseModel'

/**
 * Recurring expenses — the ones that arrive every month.
 *
 * Rent on the first, the insurance debit order on the fifteenth, the
 * accountant's retainer every quarter. Re-keying them is both tedious and
 * unreliable: the month somebody forgets, the P&L is simply wrong and nothing
 * reports it.
 *
 * ── A TEMPLATE GENERATES A DRAFT, NEVER A POSTING ────────────────────────
 *
 * This is the whole design. An amount that changed, a bill that never arrived,
 * a lease that ended are all things a person must see before money moves. What
 * the schedule removes is the TYPING, not the judgement — so `generate()`
 * produces drafts and stops, and somebody finalises them.
 *
 * `last_generated_for` is the idempotence key: running generation twice in a
 * month must not produce two rent bills. See nextOccurrence in expenseModel.ts
 * for the date arithmetic, including the 31st-in-February case.
 */

export type RecurringLine = {
  id: number
  lineNumber: number
  categoryId: number
  categoryName?: string | null
  description: string | null
  departmentId: number | null
  vatRatePct: number
  lineIncl: number
}

export type RecurringExpense = {
  id: number
  name: string
  frequency: RecurringFrequency
  frequencyLabel: string
  dayOfMonth: number | null
  dayOfWeek: number | null
  paymentType: ExpensePaymentType
  supplierId: number | null
  supplierName: string | null
  bankAccountId: number | null
  bankAccountName?: string | null
  description: string | null
  reference: string | null
  totalIncl: number
  startsOn: string
  endsOn: string | null
  lastGeneratedFor: string | null
  isActive: boolean
  notes: string | null
  userName: string
  createdAt: Date
  /** Computed: when this will next produce a draft. Null once it has ended. */
  nextDue: string | null
  /** Computed: whether it has an occurrence waiting to be generated now. */
  due: boolean
  lines: RecurringLine[]
}

type Row = RowDataPacket & Record<string, unknown>

function mapRecurring(r: Row, lines: RecurringLine[] = [], asAt = today()): RecurringExpense {
  const frequency = String(r.frequency) as RecurringFrequency
  const schedule = {
    frequency,
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
    frequency,
    frequencyLabel: FREQUENCY_LABELS[frequency] ?? frequency,
    dayOfMonth: schedule.dayOfMonth,
    dayOfWeek: schedule.dayOfWeek,
    paymentType: String(r.payment_type) as ExpensePaymentType,
    supplierId: r.supplier_id === null ? null : Number(r.supplier_id),
    supplierName: (r.supplier_name as string | null) ?? null,
    bankAccountId: r.bank_account_id === null ? null : Number(r.bank_account_id),
    bankAccountName: (r.bank_account_name as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    reference: (r.reference as string | null) ?? null,
    totalIncl: toNum(r.total_incl),
    startsOn: schedule.startsOn,
    endsOn: schedule.endsOn,
    lastGeneratedFor: schedule.lastGeneratedFor,
    isActive: active,
    notes: (r.notes as string | null) ?? null,
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
    nextDue: active ? nextOccurrence(schedule, asAt) : null,
    due: active && isDue(schedule, asAt),
    lines,
  }
}

const SELECT_RECURRING = `
  SELECT r.*, b.name AS bank_account_name
    FROM recurring_expenses r
    LEFT JOIN bank_accounts b ON b.id = r.bank_account_id
`

export async function listRecurring(
  siteId: number,
  opts: { includeInactive?: boolean } = {},
): Promise<RecurringExpense[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_RECURRING}
      ${opts.includeInactive ? '' : 'WHERE r.is_active = TRUE'}
      ORDER BY r.is_active DESC, r.name`,
  )
  const asAt = today()
  return rows.map((r) => mapRecurring(r, [], asAt))
}

export async function getRecurring(siteId: number, id: number): Promise<RecurringExpense | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_RECURRING} WHERE r.id = ? LIMIT 1`, [id])
  if (!row) return null

  const lines = await siteQuery<Row>(
    siteId,
    `SELECT l.*, c.name AS category_name
       FROM recurring_expense_lines l
       LEFT JOIN expense_categories c ON c.id = l.category_id
      WHERE l.recurring_id = ? ORDER BY l.line_number`,
    [id],
  )

  return mapRecurring(
    row,
    lines.map((l) => ({
      id: Number(l.id),
      lineNumber: Number(l.line_number),
      categoryId: Number(l.category_id),
      categoryName: (l.category_name as string | null) ?? null,
      description: (l.description as string | null) ?? null,
      departmentId: l.department_id === null ? null : Number(l.department_id),
      vatRatePct: toNum(l.vat_rate_pct),
      lineIncl: toNum(l.line_incl),
    })),
  )
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export type RecurringInput = {
  name: string
  frequency: RecurringFrequency
  dayOfMonth?: number | null
  dayOfWeek?: number | null
  paymentType: ExpensePaymentType
  supplierId?: number | null
  supplierName?: string | null
  bankAccountId?: number | null
  description?: string | null
  reference?: string | null
  startsOn: string
  endsOn?: string | null
  notes?: string | null
  lines: {
    categoryId: number
    description?: string | null
    departmentId?: number | null
    vatRatePct: number
    lineIncl: number
  }[]
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

export function validateRecurring(input: RecurringInput): string | null {
  if (!input.name?.trim()) return 'Give the schedule a name.'
  if (!FREQUENCIES.includes(input.frequency)) return 'Choose how often it repeats.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startsOn)) return 'Choose a start date.'
  if (input.endsOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.endsOn)) return 'That end date is not valid.'
  if (input.endsOn && input.endsOn < input.startsOn) return 'It ends before it starts.'
  if (input.lines.length === 0) return 'Add at least one line.'
  if (input.lines.some((l) => !l.categoryId)) return 'Every line needs a category.'
  if (input.lines.some((l) => !Number.isFinite(l.lineIncl) || l.lineIncl <= 0)) {
    return 'Every line needs a positive amount.'
  }

  if (input.frequency === 'weekly') {
    const day = input.dayOfWeek ?? 0
    if (day < 1 || day > 7) return 'Choose which day of the week it falls on.'
  } else {
    const day = input.dayOfMonth ?? 0
    if (day < 1 || day > 31) return 'Choose which day of the month it falls on.'
  }

  if (input.paymentType === 'on_account' && !input.supplierId) {
    return 'A recurring bill needs a supplier account.'
  }
  if (input.paymentType === 'direct' && !input.bankAccountId) {
    return 'Choose the account the money comes out of.'
  }
  return null
}

export async function saveRecurring(
  siteId: number,
  actor: Actor,
  input: RecurringInput,
  existingId?: number,
): Promise<SaveResult> {
  const invalid = validateRecurring(input)
  if (invalid) return { ok: false, error: invalid }

  const total = input.lines.reduce((sum, l) => round(sum + l.lineIncl, 2), 0)

  return siteTransaction(siteId, async (tx) => {
    let id = existingId ?? 0

    if (id) {
      await tx.execute(
        `UPDATE recurring_expenses
            SET name = ?, frequency = ?, day_of_month = ?, day_of_week = ?, payment_type = ?,
                supplier_id = ?, supplier_name = ?, bank_account_id = ?, description = ?,
                reference = ?, total_incl = ?, starts_on = ?, ends_on = ?, notes = ?
          WHERE id = ?`,
        [
          input.name.trim(),
          input.frequency,
          input.dayOfMonth ?? null,
          input.dayOfWeek ?? null,
          input.paymentType,
          input.supplierId ?? null,
          input.supplierName?.trim() || null,
          input.bankAccountId ?? null,
          input.description?.trim() || null,
          input.reference?.trim() || null,
          total.toFixed(4),
          input.startsOn,
          input.endsOn || null,
          input.notes?.trim() || null,
          id,
        ] as never,
      )
      await tx.execute('DELETE FROM recurring_expense_lines WHERE recurring_id = ?', [id] as never)
    } else {
      const [res] = await tx.execute(
        `INSERT INTO recurring_expenses
           (name, frequency, day_of_month, day_of_week, payment_type, supplier_id, supplier_name,
            bank_account_id, description, reference, total_incl, starts_on, ends_on, notes,
            user_id, user_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          input.name.trim(),
          input.frequency,
          input.dayOfMonth ?? null,
          input.dayOfWeek ?? null,
          input.paymentType,
          input.supplierId ?? null,
          input.supplierName?.trim() || null,
          input.bankAccountId ?? null,
          input.description?.trim() || null,
          input.reference?.trim() || null,
          total.toFixed(4),
          input.startsOn,
          input.endsOn || null,
          input.notes?.trim() || null,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      id = (res as { insertId: number }).insertId
    }

    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i]
      await tx.execute(
        `INSERT INTO recurring_expense_lines
           (recurring_id, line_number, category_id, description, department_id, vat_rate_pct, line_incl)
         VALUES (?,?,?,?,?,?,?)`,
        [
          id,
          i + 1,
          line.categoryId,
          line.description?.trim() || null,
          line.departmentId ?? null,
          line.vatRatePct,
          round(line.lineIncl, 2).toFixed(4),
        ] as never,
      )
    }

    await logActivityTx(tx, actor, {
      entity: 'expense',
      entityId: id,
      action: existingId ? 'recurring_update' : 'recurring_create',
      detail: `${existingId ? 'Updated' : 'Created'} recurring expense "${input.name.trim()}" — ${FREQUENCY_LABELS[input.frequency].toLowerCase()}, ${total.toFixed(2)}`,
    })

    return { ok: true as const, id }
  })
}

export async function setRecurringActive(
  siteId: number,
  actor: Actor,
  id: number,
  active: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const schedule = await getRecurring(siteId, id)
  if (!schedule) return { ok: false, error: 'That schedule no longer exists.' }

  await siteExecute(siteId, 'UPDATE recurring_expenses SET is_active = ? WHERE id = ?', [active, id])
  await logActivity(siteId, actor, {
    entity: 'expense',
    entityId: id,
    action: active ? 'recurring_resume' : 'recurring_pause',
    detail: `${active ? 'Resumed' : 'Paused'} "${schedule.name}"`,
  })
  return { ok: true }
}

export async function deleteRecurring(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const schedule = await getRecurring(siteId, id)
  if (!schedule) return { ok: false, error: 'That schedule no longer exists.' }

  // The FK from expenses is SET NULL, so deleting a schedule orphans rather
  // than destroys what it produced — the expenses stay, they just stop saying
  // where they came from. Worth warning about rather than silently doing.
  await siteExecute(siteId, 'DELETE FROM recurring_expenses WHERE id = ?', [id])
  await logActivity(siteId, actor, {
    entity: 'expense',
    entityId: null,
    action: 'recurring_delete',
    detail: `Deleted recurring expense "${schedule.name}"`,
  })
  return { ok: true }
}

/* ── Generation ──────────────────────────────────────────────────────────── */

export type GenerateResult = {
  generated: { recurringId: number; name: string; expenseId: number; forDate: string }[]
  skipped: { recurringId: number; name: string; reason: string }[]
}

/**
 * Produces a draft expense for every schedule that is due.
 *
 * DRAFTS ONLY — see the note at the top. Nothing is posted, no money moves, and
 * the person reviewing them corrects an amount that changed before finalising.
 *
 * Each schedule is stamped with the period it produced BEFORE the next one is
 * considered, so a failure part-way leaves the earlier ones generated rather
 * than repeating them on the next run.
 */
export async function generateDue(
  siteId: number,
  actor: Actor,
  asAt = today(),
): Promise<GenerateResult> {
  const schedules = await listRecurring(siteId)
  const result: GenerateResult = { generated: [], skipped: [] }

  for (const summary of schedules) {
    if (!summary.due) continue

    const schedule = await getRecurring(siteId, summary.id)
    if (!schedule || schedule.lines.length === 0) {
      result.skipped.push({
        recurringId: summary.id,
        name: summary.name,
        reason: 'The schedule has no lines.',
      })
      continue
    }

    // Catch up one period at a time: a schedule left alone for three months
    // produces three drafts, not one. Otherwise the two missing months simply
    // never appear in the P&L.
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

      const draft = await saveDraft(siteId, actor, {
        expenseDate: due,
        paymentType: schedule.paymentType,
        supplierId: schedule.supplierId,
        supplierName: schedule.supplierName,
        bankAccountId: schedule.bankAccountId,
        reference: schedule.reference,
        description: schedule.description ?? schedule.name,
        recurringId: schedule.id,
        lines: schedule.lines.map((l) => ({
          categoryId: l.categoryId,
          description: l.description,
          departmentId: l.departmentId,
          amountIncl: l.lineIncl,
          vatRatePct: l.vatRatePct,
        })),
      })

      if (!draft.ok) {
        result.skipped.push({
          recurringId: schedule.id,
          name: schedule.name,
          reason: draft.error,
        })
        break
      }

      await siteExecute(
        siteId,
        'UPDATE recurring_expenses SET last_generated_for = ? WHERE id = ?',
        [due, schedule.id],
      )
      cursor = due

      result.generated.push({
        recurringId: schedule.id,
        name: schedule.name,
        expenseId: draft.id,
        forDate: due,
      })
    }
  }

  if (result.generated.length > 0) {
    await logActivity(siteId, actor, {
      entity: 'expense',
      entityId: null,
      action: 'recurring_generate',
      detail: `Generated ${result.generated.length} draft expense${result.generated.length === 1 ? '' : 's'} from recurring schedules`,
    })
  }

  return result
}

/** What the drafts produced by a schedule were, for its detail screen. */
export async function generatedBy(
  siteId: number,
  recurringId: number,
  limit = 24,
): Promise<{ id: number; expenseDate: string; totalIncl: number; status: string; documentNumber: string | null }[]> {
  const capped = Math.min(Math.max(limit, 1), 100)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, expense_date, total_incl, status, document_number
       FROM expenses WHERE recurring_id = ?
      ORDER BY expense_date DESC LIMIT ${capped}`,
    [recurringId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    expenseDate: String(r.expense_date),
    totalIncl: toNum(r.total_incl),
    status: String(r.status),
    documentNumber: (r.document_number as string | null) ?? null,
  }))
}

export { FREQUENCIES, FREQUENCY_LABELS }
export type { RecurringFrequency }
