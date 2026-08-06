/*
 * Deliberately NOT `server-only`.
 *
 * Vocabulary and pure arithmetic shared by the expense screens and the server
 * modules that write them. The capture form runs in the browser and needs the
 * same labels and the same VAT split the server applies; marking this
 * server-only would force mysql2 into the client bundle through anything that
 * re-exports it. The WRITES live in expenses.ts, which is server-only for real.
 *
 * Same split as periodLockModel.ts and cashbookRules.ts.
 */
import { round } from './decimals'

/* ── Vocabulary ──────────────────────────────────────────────────────────── */

export const CATEGORY_TYPES = ['operating', 'cost_of_sales', 'capital', 'other'] as const
export type ExpenseCategoryType = (typeof CATEGORY_TYPES)[number]

export const CATEGORY_TYPE_LABELS: Record<ExpenseCategoryType, string> = {
  operating: 'Operating expense',
  cost_of_sales: 'Cost of sales',
  capital: 'Capital (asset)',
  other: 'Other / financial',
}

/** What each type means for the P&L, shown where the type is chosen. */
export const CATEGORY_TYPE_HINTS: Record<ExpenseCategoryType, string> = {
  operating: 'The ordinary running costs — rent, salaries, electricity. Appears in the P&L.',
  cost_of_sales: 'Bought to resell but not stocked — freight in, subcontractors. Reduces gross profit.',
  capital: 'An asset rather than a cost. Kept OUT of the P&L and depreciated instead.',
  other: 'Below the operating line — interest paid, bank charges.',
}

export const PAYMENT_TYPES = ['direct', 'on_account'] as const
export type ExpensePaymentType = (typeof PAYMENT_TYPES)[number]

export const PAYMENT_TYPE_LABELS: Record<ExpensePaymentType, string> = {
  direct: 'Paid now',
  on_account: 'Bill to pay later',
}

export const PAYMENT_TYPE_HINTS: Record<ExpensePaymentType, string> = {
  direct: 'Money has already left an account — a card swipe, cash, a debit order.',
  on_account: 'A supplier invoice on account. It joins the payables age analysis and a payment run.',
}

export type ExpenseStatus = 'draft' | 'finalised' | 'void'

export const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'annually'] as const
export type RecurringFrequency = (typeof FREQUENCIES)[number]

export const FREQUENCY_LABELS: Record<RecurringFrequency, string> = {
  weekly: 'Every week',
  monthly: 'Every month',
  quarterly: 'Every three months',
  annually: 'Once a year',
}

/* ── Line maths ──────────────────────────────────────────────────────────── */

/** One line as the capture form and the poster both see it. */
export type ExpenseLineInput = {
  categoryId: number
  description?: string | null
  departmentId?: number | null
  /** VAT-inclusive. What is written on the slip, which is what people type. */
  amountIncl: number
  vatRatePct: number
  /** False where the category denies the deduction. */
  vatClaimable?: boolean
}

export type ComputedLine = {
  excl: number
  vat: number
  incl: number
  /** The part of `vat` that may actually be claimed back. */
  claimable: number
}

/**
 * Splits one VAT-inclusive line.
 *
 * VAT by SUBTRACTION, never computed independently — the same rule splitVat()
 * states in ledger.ts and documentMath uses for sale lines. `round2(incl*r/(1+r))`
 * and `incl - round2(incl/(1+r))` disagree by a cent about one time in fifty,
 * and when they do the document total stops equalling net + VAT.
 *
 * An expense MUST split identically to a GRV or the VAT return will not tie
 * back, which is the whole reason this is one shared function.
 */
export function computeLine(line: ExpenseLineInput): ComputedLine {
  const incl = round(line.amountIncl, 2)
  if (line.vatRatePct <= 0) {
    return { excl: incl, vat: 0, incl, claimable: 0 }
  }

  const excl = round(incl / (1 + line.vatRatePct / 100), 2)
  const vat = round(incl - excl, 2)

  return {
    excl,
    vat,
    incl,
    // Denied categories still SHOW the VAT — the supplier charged it and the
    // expense really did cost that much — but none of it is reclaimable, so it
    // stays in the cost. Zeroing `vat` instead would understate the expense.
    claimable: line.vatClaimable === false ? 0 : vat,
  }
}

export type ComputedTotals = {
  subtotalExcl: number
  vatTotal: number
  totalIncl: number
  /** What the VAT return may claim. Never more than vatTotal. */
  vatClaimable: number
  lines: ComputedLine[]
}

/**
 * Totals for a whole expense.
 *
 * Summed from the already-rounded lines rather than computed on the gross, so
 * the document total always equals the sum of what is displayed. A total
 * derived independently can differ from its own lines by a cent, and that is
 * the discrepancy nobody can ever explain.
 */
export function computeTotals(lines: readonly ExpenseLineInput[]): ComputedTotals {
  const computed = lines.map(computeLine)

  return {
    subtotalExcl: computed.reduce((sum, l) => round(sum + l.excl, 2), 0),
    vatTotal: computed.reduce((sum, l) => round(sum + l.vat, 2), 0),
    totalIncl: computed.reduce((sum, l) => round(sum + l.incl, 2), 0),
    vatClaimable: computed.reduce((sum, l) => round(sum + l.claimable, 2), 0),
    lines: computed,
  }
}

/**
 * Why this expense cannot be captured. Null means it can.
 *
 * Pure, so the form can show the same refusal the server would give before the
 * user presses Save rather than after.
 */
export function refuseExpense(input: {
  expenseDate?: string
  paymentType: ExpensePaymentType
  supplierId?: number | null
  supplierName?: string | null
  bankAccountId?: number | null
  lines: readonly ExpenseLineInput[]
}): string | null {
  if (input.expenseDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.expenseDate)) {
    return 'That date is not valid.'
  }
  if (input.lines.length === 0) return 'Add at least one line.'
  if (input.lines.some((l) => !l.categoryId)) return 'Every line needs a category.'
  if (input.lines.some((l) => !Number.isFinite(l.amountIncl) || round(l.amountIncl, 2) === 0)) {
    return 'Every line needs an amount.'
  }
  // Negative lines are allowed — a credit note from a supplier, or a correction
  // on a multi-line slip — but the expense as a whole must not be negative.
  const total = computeTotals(input.lines).totalIncl
  if (total < 0) return 'The total cannot be negative. Capture a supplier credit note instead.'
  if (total === 0) return 'The total comes to zero.'
  if (Math.abs(total) > 99_999_999) return 'That amount is too large.'

  // A bill needs somebody to owe; a payment needs somewhere to have come from.
  if (input.paymentType === 'on_account' && !input.supplierId) {
    return 'A bill needs a supplier account — that is who it is owed to.'
  }
  if (input.paymentType === 'direct' && !input.bankAccountId) {
    return 'Choose the account the money came out of.'
  }
  if (
    input.paymentType === 'direct' &&
    !input.supplierId &&
    !input.supplierName?.trim()
  ) {
    return 'Say who was paid.'
  }
  return null
}

/* ── Recurring schedule ──────────────────────────────────────────────────── */

/**
 * The next date a schedule should produce, after `lastGeneratedFor`.
 *
 * Returns null once the schedule has ended. Pure so the screen can show "next
 * on 1 September" without asking the server, and so the awkward cases — a 31st
 * in February, a quarter that crosses a year — are testable on their own.
 */
export function nextOccurrence(
  schedule: {
    frequency: RecurringFrequency
    dayOfMonth?: number | null
    dayOfWeek?: number | null
    startsOn: string
    endsOn?: string | null
    lastGeneratedFor?: string | null
  },
  asAt: string,
): string | null {
  const start = new Date(`${schedule.startsOn}T00:00:00`)
  if (Number.isNaN(start.getTime())) return null

  let candidate: Date

  if (!schedule.lastGeneratedFor) {
    candidate = alignToSchedule(start, schedule)
    // An aligned date before the start belongs to the previous period.
    if (toIso(candidate) < schedule.startsOn) {
      candidate = advance(candidate, schedule)
    }
  } else {
    const last = new Date(`${schedule.lastGeneratedFor}T00:00:00`)
    if (Number.isNaN(last.getTime())) return null
    candidate = advance(last, schedule)
  }

  const iso = toIso(candidate)
  if (schedule.endsOn && iso > schedule.endsOn) return null
  // Deliberately allowed to be in the future: the screen shows what is coming.
  // Callers that only want what is DUE compare against asAt themselves.
  void asAt
  return iso
}

/** Whether a schedule has an occurrence ready to generate on or before a date. */
export function isDue(
  schedule: Parameters<typeof nextOccurrence>[0],
  asAt: string,
): boolean {
  const next = nextOccurrence(schedule, asAt)
  return next !== null && next <= asAt
}

function alignToSchedule(
  date: Date,
  schedule: { frequency: RecurringFrequency; dayOfMonth?: number | null; dayOfWeek?: number | null },
): Date {
  const out = new Date(date)

  if (schedule.frequency === 'weekly') {
    const want = schedule.dayOfWeek ?? 1
    // JS Sunday is 0; the schema uses 1=Monday…7=Sunday.
    const current = out.getDay() === 0 ? 7 : out.getDay()
    out.setDate(out.getDate() + ((want - current + 7) % 7))
    return out
  }

  if (schedule.dayOfMonth) {
    setDayClamped(out, schedule.dayOfMonth)
  }
  return out
}

function advance(
  from: Date,
  schedule: { frequency: RecurringFrequency; dayOfMonth?: number | null; dayOfWeek?: number | null },
): Date {
  const out = new Date(from)

  switch (schedule.frequency) {
    case 'weekly':
      out.setDate(out.getDate() + 7)
      return out
    case 'monthly':
      return addMonthsClamped(out, 1, schedule.dayOfMonth)
    case 'quarterly':
      return addMonthsClamped(out, 3, schedule.dayOfMonth)
    case 'annually':
      out.setFullYear(out.getFullYear() + 1)
      if (schedule.dayOfMonth) setDayClamped(out, schedule.dayOfMonth)
      return out
  }
}

/**
 * Adds months, keeping the intended day of the month.
 *
 * The 31st of January plus one month must be the 28th of February, then the
 * 31st of March again — NOT drift to the 28th for ever, which is what naive
 * date arithmetic does and why a rent schedule slowly walks backwards through
 * the month.
 */
function addMonthsClamped(date: Date, months: number, dayOfMonth?: number | null): Date {
  const want = dayOfMonth ?? date.getDate()
  const out = new Date(date.getFullYear(), date.getMonth() + months, 1)
  setDayClamped(out, want)
  return out
}

function setDayClamped(date: Date, day: number): void {
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  date.setDate(Math.min(Math.max(day, 1), lastDay))
}

export function toIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
