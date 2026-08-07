import { round } from './decimals'

/**
 * The rules of credit control, as pure functions.
 *
 * No database, no siteId, no `server-only` — so these can be reasoned about
 * and tested on their own, and so a client component can import a label or a
 * formatter without dragging mysql2 into the browser bundle.
 *
 * Everything here answers a question of judgement rather than of storage:
 * which letter is this account due, is that promise broken yet, should we be
 * chasing this at all. The SQL that feeds them lives in site/creditControl.ts.
 */

/* ── Dunning levels ──────────────────────────────────────────────────────── */

export type DunningLevel = {
  id: number
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

/** What an account looks like to the escalation rules. */
export type CreditPosition = {
  /** Sum of items past their due date. Excludes anything not yet due. */
  overdueAmount: number
  /** Days past due of the OLDEST unpaid item. 0 when nothing is overdue. */
  oldestDays: number
  /** The highest level already sent to this account. 0 = never chased. */
  currentLevel: number
  /** When the last letter went, if one ever did. */
  lastDunnedAt: string | null
  /** Chasing is suspended until this date. */
  pausedUntil: string | null
  /** An open promise covering this debt, if there is one. */
  hasOpenPromise: boolean
  /** The account is disputed — someone says an invoice is wrong. */
  isDisputed: boolean
}

export type SkipReason =
  | 'nothing-overdue'
  | 'below-threshold'
  | 'paused'
  | 'promise-open'
  | 'disputed'
  | 'too-soon'
  | 'no-level'
  | 'top-of-ladder'

export const SKIP_LABELS: Record<SkipReason, string> = {
  'nothing-overdue': 'Nothing overdue',
  'below-threshold': 'Below the chase threshold',
  paused: 'Chasing is paused on this account',
  'promise-open': 'An open promise to pay covers this',
  disputed: 'The account is disputed',
  'too-soon': 'Contacted too recently',
  'no-level': 'Not overdue enough for any level',
  'top-of-ladder': 'Already at the final level',
}

export type LevelDecision =
  | { chase: true; level: DunningLevel }
  | { chase: false; reason: SkipReason }

/**
 * Which letter, if any, this account is due.
 *
 * ── WHY ESCALATION IS NOT JUST "WHICH BUCKET IS IT IN" ───────────────────
 *
 * The naive version picks the level whose `minDaysOverdue` the account has
 * passed. That sends the same level-2 letter every week to an account stuck at
 * 45 days, and the customer learns within a month that the reminders mean
 * nothing.
 *
 * So the rule is: an account moves to the NEXT step above the one it has
 * already had, and only if it also qualifies on days and amount. An account
 * that has had level 2 does not get level 2 again — it either climbs to 3 or
 * it is left alone.
 *
 * ── THE THINGS THAT STOP A CHASE ─────────────────────────────────────────
 *
 * Four, and each of them is a real way an automated chase damages a
 * relationship:
 *
 *   A PROMISE. They said they would pay on Friday. Chasing before Friday is
 *   telling a customer their word counts for nothing.
 *
 *   A DISPUTE. Chasing for money over an invoice the customer says is wrong
 *   escalates an argument instead of collecting a debt.
 *
 *   A PAUSE. A payment plan, a claim in progress, a manager's decision.
 *
 *   RECENCY. Whatever the ladder says, nobody gets two letters in three days.
 *
 * Each returns a REASON rather than silence, because "why was this account not
 * chased" is the question a collections screen exists to answer.
 */
export function decideLevel(
  position: CreditPosition,
  levels: DunningLevel[],
  options: { asAt: string; minGapDays: number },
): LevelDecision {
  if (position.overdueAmount <= 0 || position.oldestDays <= 0) {
    return { chase: false, reason: 'nothing-overdue' }
  }
  if (position.isDisputed) return { chase: false, reason: 'disputed' }
  if (position.pausedUntil && position.pausedUntil >= options.asAt) {
    return { chase: false, reason: 'paused' }
  }
  if (position.hasOpenPromise) return { chase: false, reason: 'promise-open' }

  // Whatever the ladder says. A mis-set level with minDaysOverdue of 1 would
  // otherwise chase someone every single day the run is built.
  if (position.lastDunnedAt && options.minGapDays > 0) {
    const gap = daysBetween(position.lastDunnedAt, options.asAt)
    if (gap < options.minGapDays) return { chase: false, reason: 'too-soon' }
  }

  const ladder = levels
    .filter((l) => l.isActive)
    .slice()
    .sort((a, b) => a.step - b.step)

  if (ladder.length === 0) return { chase: false, reason: 'no-level' }

  // Only steps above where the account already sits. This is the escalation.
  const ahead = ladder.filter((l) => l.step > position.currentLevel)
  if (ahead.length === 0) return { chase: false, reason: 'top-of-ladder' }

  // The HIGHEST step it now qualifies for, not the next one up. An account
  // that has gone quiet for three months should get the final demand, not
  // start again at a friendly reminder and take another two months to arrive.
  const qualified = ahead.filter(
    (l) => position.oldestDays >= l.minDaysOverdue && position.overdueAmount >= l.minAmount,
  )
  if (qualified.length === 0) {
    // Distinguish "not old enough" from "too small to bother with", because
    // they call for different fixes to the ladder.
    const onDays = ahead.filter((l) => position.oldestDays >= l.minDaysOverdue)
    return {
      chase: false,
      reason: onDays.length > 0 ? 'below-threshold' : 'no-level',
    }
  }

  return { chase: true, level: qualified[qualified.length - 1] }
}

/* ── Promises to pay ─────────────────────────────────────────────────────── */

export type PromiseStatus = 'open' | 'kept' | 'broken' | 'cancelled'

export const PROMISE_LABELS: Record<PromiseStatus, string> = {
  open: 'Open',
  kept: 'Kept',
  broken: 'Broken',
  cancelled: 'Cancelled',
}

/** An open promise, once the date has passed, is one of these. */
export type PromiseState = PromiseStatus | 'due-today' | 'overdue'

/**
 * What an open promise actually is today.
 *
 * A promise is not a ledger entry and nothing about it changes automatically —
 * so its live state has to be derived rather than read. Stored status wins
 * where a human or a payment has already settled the question; only `open`
 * promises are interpreted against the calendar.
 *
 * The grace window matters: a customer who promised Friday and paid Friday
 * afternoon should not be marked broken because a run happened Friday morning.
 */
export function promiseState(input: {
  status: PromiseStatus
  promisedDate: string
  promisedAmount: number
  receivedAmount: number
  asAt: string
  graceDays: number
}): PromiseState {
  if (input.status !== 'open') return input.status

  // Enough arrived. Kept, whatever the date says.
  if (input.receivedAmount >= input.promisedAmount) return 'kept'

  const deadline = addDays(input.promisedDate, Math.max(0, input.graceDays))
  if (input.asAt > deadline) return 'broken'
  if (input.asAt >= input.promisedDate) return 'due-today'
  return 'open'
}

/**
 * How much of a promise is still outstanding.
 *
 * Never negative: an overpayment settles the promise, it does not create a
 * credit against the next one.
 */
export function promiseShortfall(promisedAmount: number, receivedAmount: number): number {
  return round(Math.max(0, promisedAmount - receivedAmount), 2)
}

/**
 * Does this customer keep their word?
 *
 * Returned as a rate plus the counts behind it, because a 100% record over one
 * promise and over forty are different facts and a bare percentage hides
 * which one you are looking at. Null when there is nothing to judge — a new
 * account is not a bad one.
 */
export function reliability(input: {
  kept: number
  broken: number
}): { rate: number | null; decided: number } {
  const decided = input.kept + input.broken
  if (decided === 0) return { rate: null, decided: 0 }
  return { rate: Math.round((input.kept / decided) * 100), decided }
}

/* ── Risk ────────────────────────────────────────────────────────────────── */

export type RiskBand = 'good' | 'watch' | 'poor' | 'bad'

export const RISK_LABELS: Record<RiskBand, string> = {
  good: 'Good',
  watch: 'Watch',
  poor: 'Poor',
  bad: 'Bad',
}

/**
 * A single read on how worried to be about an account.
 *
 * ── WHY THIS IS NOT A CREDIT SCORE ───────────────────────────────────────
 *
 * It deliberately does not produce a number out of a weighted formula. A
 * fabricated 0-100 score invites people to treat it as objective when the
 * weights were a guess, and it hides which fact caused it.
 *
 * Instead: four plain rules, evaluated worst-first, each of which a person can
 * disagree with out loud. The band always comes with the reason that produced
 * it, so a collector reads "3 broken promises" rather than "score 41".
 */
export function riskBand(input: {
  oldestDays: number
  overdueAmount: number
  balance: number
  creditLimit: number
  promisesBroken: number
  dunningLevel: number
}): { band: RiskBand; reason: string } {
  if (input.promisesBroken >= 3) {
    return { band: 'bad', reason: `${input.promisesBroken} promises broken` }
  }
  if (input.oldestDays >= 90) {
    return { band: 'bad', reason: `${input.oldestDays} days overdue` }
  }
  if (input.dunningLevel >= 3) {
    return { band: 'bad', reason: 'Reached final demand' }
  }
  if (input.promisesBroken >= 1) {
    return {
      band: 'poor',
      reason: `${input.promisesBroken} promise${input.promisesBroken === 1 ? '' : 's'} broken`,
    }
  }
  if (input.oldestDays >= 60) return { band: 'poor', reason: `${input.oldestDays} days overdue` }
  // Over the limit matters even when nothing is late — it is exposure beyond
  // what was agreed, which is a different problem from slow payment.
  if (input.creditLimit > 0 && input.balance > input.creditLimit) {
    return { band: 'poor', reason: 'Over its credit limit' }
  }
  if (input.oldestDays >= 30) return { band: 'watch', reason: `${input.oldestDays} days overdue` }
  if (input.overdueAmount > 0) return { band: 'watch', reason: 'Something is overdue' }
  return { band: 'good', reason: 'Nothing overdue' }
}

/**
 * How much of the credit limit is used.
 *
 * Null where no limit is set — an unlimited account is not one at 0%, and
 * showing 0% would read as "plenty of room" on an account with no ceiling at
 * all. Uncapped above 100 so being over the limit is visible as a fact rather
 * than flattened to a full bar.
 */
export function limitUsage(balance: number, creditLimit: number): number | null {
  if (creditLimit <= 0) return null
  return Math.round((balance / creditLimit) * 100)
}

/* ── Letter templates ────────────────────────────────────────────────────── */

/**
 * The placeholders a level's subject and body may use.
 *
 * Substitution is deliberately dumb: an unknown token is left exactly as
 * written rather than replaced with an empty string. A letter that goes out
 * saying "{ovrdue} is outstanding" is embarrassing but obvious and gets fixed;
 * one saying "is outstanding" reads as a system bug the customer noticed
 * before you did.
 */
export const TEMPLATE_TOKENS = [
  { token: '{customer}', hint: 'The account name' },
  { token: '{company}', hint: 'Your business name' },
  { token: '{overdue}', hint: 'The overdue amount, formatted' },
  { token: '{balance}', hint: 'The full account balance' },
  { token: '{oldest_days}', hint: 'Days the oldest unpaid item is past due' },
  { token: '{lines}', hint: 'The list of unpaid documents' },
  { token: '{as_at}', hint: 'The date the run was built' },
] as const

export function renderTemplate(template: string, values: Record<string, string>): string {
  let out = template
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{${key}}`).join(value)
  }
  return out
}

/* ── Dates ───────────────────────────────────────────────────────────────── */

/**
 * Whole days from `from` to `to`, positive when `to` is later.
 *
 * UTC on purpose. These are calendar dates, not instants, and building them in
 * local time makes a date near midnight land on the wrong day depending on
 * which side of a DST change the server is.
 */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`)
  if (Number.isNaN(t)) return date
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10)
}
