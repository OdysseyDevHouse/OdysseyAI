/*
 * Deliberately NOT `server-only`.
 *
 * Vocabulary and pure arithmetic shared by the contract screens and the server
 * modules that write them. The contract form runs in the browser and needs to
 * preview the same schedule and the same escalated prices the tick will apply;
 * marking this server-only would force mysql2 into the client bundle through
 * anything that re-exports it. The WRITES live in site/contracts.ts, which is
 * server-only for real.
 *
 * Same split as expenseModel.ts, periodLockModel.ts and cashbookRules.ts.
 */
import { round } from './decimals'
import { nextOccurrence, isDue, toIso, type RecurringFrequency } from './expenseModel'

/* ── Vocabulary ──────────────────────────────────────────────────────────── */

/*
 * A subset of the expense frequencies: weekly is deliberately absent. A weekly
 * contract invoice is 52 debtor postings and 52 emails a year, which is a
 * statement's job rather than an invoice's — and nobody has asked for one. It
 * can be added here without a schema change if that turns out to be wrong.
 */
export const CONTRACT_FREQUENCIES = ['monthly', 'quarterly', 'annually'] as const
export type ContractFrequency = (typeof CONTRACT_FREQUENCIES)[number]

export const CONTRACT_FREQUENCY_LABELS: Record<ContractFrequency, string> = {
  monthly: 'Every month',
  quarterly: 'Every three months',
  annually: 'Once a year',
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

export type ContractState = 'draft' | 'scheduled' | 'active' | 'ended' | 'paused'

export const CONTRACT_STATE_LABELS: Record<ContractState, string> = {
  draft: 'Draft',
  scheduled: 'Starts later',
  active: 'Active',
  ended: 'Ended',
  paused: 'Paused',
}

/* ── State ───────────────────────────────────────────────────────────────── */

/**
 * What a contract IS right now, derived rather than stored.
 *
 * Stored status on a date-driven entity is a lie waiting to happen: a contract
 * whose ends_on passed last night is ended whether or not anything ran to say
 * so. Deriving it means the list is never stale and no nightly job exists
 * purely to flip flags. The same argument quoteState makes in site/quotes.ts.
 */
export function contractState(input: {
  isActive: boolean
  contractNumber?: string | null
  startsOn: string
  endsOn?: string | null
}, asAt: string): ContractState {
  if (!input.contractNumber) return 'draft'
  if (!input.isActive) return 'paused'
  if (input.endsOn && input.endsOn < asAt) return 'ended'
  if (input.startsOn > asAt) return 'scheduled'
  return 'active'
}

/* ── Escalation ──────────────────────────────────────────────────────────── */

export type EscalationTerms = {
  /** 0 means the price never moves. */
  escalationPct: number
  /** 1-12. Null (with pct 0) means no escalation. */
  escalationMonth?: number | null
  startsOn: string
  endsOn?: string | null
  /** The last escalation already applied, as its own 1st-of-month date. */
  lastEscalatedFor?: string | null
}

/**
 * The escalation dates that have fallen due on or before `asAt`.
 *
 * Returned as a list rather than a count because a contract left un-ticked for
 * two years owes TWO raises, and applying them one at a time — each compounding
 * on the last — is the only way the result matches what a year-by-year
 * calculation would have produced. Collapsing them into "multiply by 1.08²"
 * gives the same answer today but diverges the moment escalation_pct is edited
 * mid-life, which is exactly when somebody is checking the arithmetic.
 *
 * Each date is the 1st of the escalation month, which is what
 * `last_escalated_for` stores — the day within the month is irrelevant, since
 * the raise applies to every invoice from that month onward.
 *
 * The first escalation is the first escalation-month STRICTLY AFTER the start
 * date. A contract signed in March with a March escalation does not get a raise
 * in its first month; it gets one a year later. Anything else means signing on
 * the 1st of the escalation month costs the customer an immediate increase,
 * which no one would accept as an explanation.
 */
export function escalationsDue(terms: EscalationTerms, asAt: string): string[] {
  const month = terms.escalationMonth
  if (!month || month < 1 || month > 12) return []
  if (!terms.escalationPct) return []

  const start = parseIso(terms.startsOn)
  if (!start) return []

  const limit = parseIso(asAt)
  if (!limit) return []

  // Never escalate past the end of the contract: a agreement that ended in
  // June does not take July's increase, even if the tick runs in August.
  const end = terms.endsOn ? parseIso(terms.endsOn) : null
  const ceiling = end && end < limit ? end : limit

  // The first candidate: the escalation month in the start year, moved on a
  // year if that month is not strictly after the start date.
  let year = start.getFullYear()
  if (month - 1 <= start.getMonth()) year++

  const out: string[] = []
  const already = terms.lastEscalatedFor ?? ''

  // A contract cannot outlive its own dates by more than a working lifetime;
  // the guard is a runaway backstop, not a business rule.
  for (let guard = 0; guard < 100; guard++) {
    const candidate = new Date(year, month - 1, 1)
    if (candidate > ceiling) break

    const iso = toIso(candidate)
    // Strictly after what has already been applied — the idempotence key.
    if (iso > already) out.push(iso)
    year++
  }

  return out
}

/**
 * One line's price after a number of compounding raises.
 *
 * Rounded to the cent AT EACH STEP, not once at the end. Year three's price
 * must be what year two's price actually was plus the percentage — because
 * that is the figure on last year's invoice and the one a customer checks
 * against. Rounding once at the end produces a price that is arithmetically
 * defensible and impossible to reconcile against the invoices that preceded it.
 */
export function escalatedPrice(price: number, escalationPct: number, times: number): number {
  let out = round(price, 2)
  for (let i = 0; i < times; i++) {
    out = round(out * (1 + escalationPct / 100), 2)
  }
  return out
}

/**
 * When the price next changes, and to what — for the contract screen.
 *
 * Null when nothing is scheduled: no escalation configured, or the contract
 * ends before the next one would land. Showing "next increase: none" is more
 * honest than showing a date the contract will never reach.
 */
export function nextEscalation(
  terms: EscalationTerms,
  currentTotal: number,
  asAt: string,
): { on: string; from: number; to: number } | null {
  const month = terms.escalationMonth
  if (!month || !terms.escalationPct) return null

  const start = parseIso(terms.startsOn)
  const limit = parseIso(asAt)
  if (!start || !limit) return null

  // Walk forward from whichever is later: the last applied raise, or now.
  const from = terms.lastEscalatedFor && terms.lastEscalatedFor > asAt
    ? parseIso(terms.lastEscalatedFor)!
    : limit

  let year = from.getFullYear()
  if (month - 1 <= start.getMonth() && year === start.getFullYear()) year++

  for (let guard = 0; guard < 100; guard++) {
    const candidate = new Date(year, month - 1, 1)
    const iso = toIso(candidate)
    if (iso > asAt && (!terms.lastEscalatedFor || iso > terms.lastEscalatedFor)) {
      if (terms.endsOn && iso > terms.endsOn) return null
      return {
        on: iso,
        from: round(currentTotal, 2),
        to: escalatedPrice(currentTotal, terms.escalationPct, 1),
      }
    }
    year++
  }

  return null
}

/* ── Schedule ────────────────────────────────────────────────────────────── */

export type ContractSchedule = {
  frequency: ContractFrequency
  billingDay: number
  startsOn: string
  endsOn?: string | null
  lastGeneratedFor?: string | null
}

/**
 * When this contract next produces an invoice. Null once it has ended.
 *
 * Delegates to the recurring-expense arithmetic rather than restating it: the
 * 31st-in-February clamp, the quarter that crosses a year and the
 * does-the-first-period-count edge are all solved there and tested there.
 * A schedule is a schedule regardless of which way the money flows.
 */
export function nextBillingDate(schedule: ContractSchedule, asAt: string): string | null {
  return nextOccurrence(toRecurring(schedule), asAt)
}

/** Whether an invoice is waiting to be generated on or before a date. */
export function isBillingDue(schedule: ContractSchedule, asAt: string): boolean {
  return isDue(toRecurring(schedule), asAt)
}

/**
 * Every period this contract owes, oldest first.
 *
 * A contract left un-ticked for three months owes THREE invoices, not one —
 * the two missing months are revenue that otherwise never appears. Same
 * catch-up rule generateDue follows for recurring expenses.
 *
 * Capped at 24 periods: past that, something is wrong that generating two years
 * of back-invoices would make worse rather than better, and a person should
 * look. The cap is reported by the caller, never silently applied.
 */
export function duePeriods(schedule: ContractSchedule, asAt: string, cap = 24): string[] {
  const out: string[] = []
  let cursor = schedule.lastGeneratedFor ?? null

  for (let guard = 0; guard < cap; guard++) {
    const next = nextOccurrence(toRecurring({ ...schedule, lastGeneratedFor: cursor }), asAt)
    if (!next || next > asAt) break
    out.push(next)
    cursor = next
  }

  return out
}

/**
 * How many escalations had been applied by a given billing date.
 *
 * Needed because catch-up generates the past: an invoice for March must carry
 * March's price even when it is produced in June, after two later raises. The
 * naive version — bill everything at today's price — silently overcharges every
 * back-dated invoice, and it is the customer who finds it.
 */
export function escalationsAppliedBy(terms: EscalationTerms, billingDate: string): number {
  return escalationsDue(terms, billingDate).length
}

function toRecurring(schedule: ContractSchedule): {
  frequency: RecurringFrequency
  dayOfMonth: number
  startsOn: string
  endsOn?: string | null
  lastGeneratedFor?: string | null
} {
  return {
    frequency: schedule.frequency,
    dayOfMonth: schedule.billingDay,
    startsOn: schedule.startsOn,
    endsOn: schedule.endsOn,
    lastGeneratedFor: schedule.lastGeneratedFor,
  }
}

/* ── Validation ──────────────────────────────────────────────────────────── */

export type ContractLineInput = {
  productId?: number | null
  productCode?: string | null
  description: string
  qty: number
  unitPriceIncl: number
  vatRatePct: number
  departmentId?: number | null
}

export type ContractInput = {
  name: string
  customerId: number
  frequency: ContractFrequency
  billingDay: number
  startsOn: string
  endsOn?: string | null
  escalationPct: number
  escalationMonth?: number | null
  autoSend: boolean
  offerPaymentLink: boolean
  paymentTermsDays: number
  reference?: string | null
  notes?: string | null
  internalNote?: string | null
  lines: ContractLineInput[]
}

/**
 * Why this contract cannot be saved. Null means it can.
 *
 * Pure, so the form shows the same refusal the server would give BEFORE the
 * user presses Save rather than after — the same contract refuseExpense keeps.
 */
export function refuseContract(input: ContractInput): string | null {
  if (!input.name?.trim()) return 'Give the contract a name.'
  if (!input.customerId) return 'Choose the customer to bill.'
  if (!CONTRACT_FREQUENCIES.includes(input.frequency)) return 'Choose how often it bills.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startsOn)) return 'Choose a start date.'
  if (input.endsOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.endsOn)) {
    return 'That end date is not valid.'
  }
  if (input.endsOn && input.endsOn < input.startsOn) return 'It ends before it starts.'

  if (!Number.isFinite(input.billingDay) || input.billingDay < 1 || input.billingDay > 31) {
    return 'Choose which day of the month it bills on.'
  }

  if (input.lines.length === 0) return 'Add at least one product to bill.'
  if (input.lines.some((l) => !l.description?.trim())) {
    return 'Every line needs a description.'
  }
  if (input.lines.some((l) => !Number.isFinite(l.qty) || l.qty <= 0)) {
    return 'Every line needs a quantity above zero.'
  }
  // Zero-priced lines are allowed — an included service listed for the
  // customer's benefit — but the contract as a whole must bill something, or
  // it generates R0.00 invoices for ever and nobody notices.
  if (input.lines.some((l) => !Number.isFinite(l.unitPriceIncl) || l.unitPriceIncl < 0)) {
    return 'A price cannot be negative.'
  }
  if (contractTotal(input.lines) <= 0) {
    return 'The contract comes to zero. Add a priced line.'
  }

  if (!Number.isFinite(input.escalationPct) || input.escalationPct < 0) {
    return 'An escalation cannot be negative.'
  }
  // A guard against a typo, not a policy. 100% is a doubling; anything past it
  // is far more likely to be "1000" typed into a percent field than intent.
  if (input.escalationPct > 100) return 'That escalation looks wrong — over 100%.'
  if (input.escalationPct > 0 && !input.escalationMonth) {
    return 'Choose which month the escalation happens in.'
  }
  if (
    input.escalationMonth &&
    (input.escalationMonth < 1 || input.escalationMonth > 12)
  ) {
    return 'That escalation month is not valid.'
  }

  if (
    !Number.isFinite(input.paymentTermsDays) ||
    input.paymentTermsDays < 0 ||
    input.paymentTermsDays > 365
  ) {
    return 'Payment terms must be between 0 and 365 days.'
  }

  return null
}

/** The contract's VAT-inclusive value per billing period. */
export function contractTotal(lines: readonly ContractLineInput[]): number {
  return lines.reduce((sum, l) => round(sum + round(l.qty * l.unitPriceIncl, 2), 2), 0)
}

/**
 * What a contract is worth over a year, for the list and the dashboard.
 *
 * At the CURRENT price, ignoring escalations still to come — a forecast that
 * quietly included next year's raise would not tie back to any invoice yet
 * issued, and this figure's job is to be comparable against actual billings.
 */
export function annualValue(total: number, frequency: ContractFrequency): number {
  const perYear: Record<ContractFrequency, number> = {
    monthly: 12,
    quarterly: 4,
    annually: 1,
  }
  return round(total * perYear[frequency], 2)
}

function parseIso(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

export { toIso }
