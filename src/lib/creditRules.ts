import { round } from './decimals'
import { allowsCredit, accountTypeLabel, type AccountType } from './accountTypes'

/**
 * Who may buy on account, and for how much.
 *
 * Pure, and deliberately not inside site/tillCustomers.ts: that module is
 * `server-only` because it queries, while the till is a Client Component that
 * must grey out the Account button live as the basket grows. Duplicating these
 * rules on the client is how the screen and the posting engine end up
 * disagreeing about whether a sale is allowed — and the disagreement would only
 * show up with a customer standing at the counter.
 *
 * Same shape as documentMath.ts and tenderMath.ts: rules here, SQL there.
 */

/** The parts of an account that decide whether it can take credit. */
export type CreditPosition = {
  name: string
  status: string
  accountType: AccountType
  creditLimit: number
  balance: number
  /**
   * Spend caps over a window. Zero means NO limit — the opposite of
   * creditLimit, where zero means no credit at all.
   *
   * That asymmetry is deliberate and worth stating: a credit limit is a GRANT,
   * so nothing granted means nothing allowed; a spend limit is a RESTRICTION,
   * so nothing restricted means nothing stopped. Both forms say so in as many
   * words.
   *
   * Optional so every existing caller that builds a CreditPosition by hand —
   * the test suites, the checkout, customerAuth — keeps compiling and keeps
   * its current behaviour of "no spend cap".
   */
  dailyLimit?: number
  monthlyLimit?: number
}

/**
 * What has already been charged to the account in each window.
 *
 * Passed IN rather than queried, because this module is imported by the till,
 * which is a Client Component — the same reason the whole file is pure. The
 * SQL that produces these lives in site/customerSpend.ts, and both the till
 * and the posting engine feed the identical numbers into the identical rules.
 *
 * Absent means "not measured", which is treated as zero spent. That is the
 * honest default for a caller that has not asked: a limit nobody measured
 * cannot refuse anybody, and silently blocking a sale on an unmeasured figure
 * would be worse than not enforcing it there.
 */
export type PeriodSpend = {
  /** Charged to the account since midnight today. */
  today: number
  /** Charged to the account since the first of the current month. */
  month: number
}

export const NO_SPEND: PeriodSpend = { today: 0, month: 0 }

/**
 * Why this account cannot take credit AT ALL. Null means it can.
 *
 * About the account itself, not about any particular sale — so the till can
 * answer it before a basket total exists.
 */
export function creditBlockedReason(account: CreditPosition): string | null {
  if (account.status === 'on_hold') return `${account.name} is on hold.`
  if (account.status === 'closed') return `${account.name}'s account is closed.`
  if (account.status === 'inactive') return `${account.name}'s account is inactive.`
  if (!allowsCredit(account.accountType)) {
    return `${account.name} is a ${accountTypeLabel(account.accountType).toLowerCase()} account — no credit.`
  }
  // A zero limit means "no credit granted", not "unlimited".
  if (account.creditLimit <= 0) return `${account.name} has no credit limit set.`
  if (account.balance > account.creditLimit) return `${account.name} is already over their limit.`
  return null
}

/** What is left before the limit is reached. Never negative. */
export function availableCredit(account: CreditPosition): number {
  return Math.max(round(account.creditLimit - account.balance, 2), 0)
}

/**
 * What is left of a spend limit in its window. Null where no limit is set.
 *
 * Null rather than Infinity so a screen can tell "unlimited" from "plenty
 * left" and render nothing at all rather than a meaningless bar — the same
 * distinction limitUsage() draws in creditModel.ts.
 */
export function remainingDaily(account: CreditPosition, spend: PeriodSpend): number | null {
  if (!account.dailyLimit || account.dailyLimit <= 0) return null
  return Math.max(round(account.dailyLimit - spend.today, 2), 0)
}

export function remainingMonthly(account: CreditPosition, spend: PeriodSpend): number | null {
  if (!account.monthlyLimit || account.monthlyLimit <= 0) return null
  return Math.max(round(account.monthlyLimit - spend.month, 2), 0)
}

/**
 * Whether this amount fits on top of what is already owed.
 *
 * Returns the sentence to show, or null. Checked on the till as the basket
 * changes AND again at finalise — a basket can sit on screen for ten minutes
 * while someone else settles the account.
 *
 * ── THE THREE CEILINGS ───────────────────────────────────────────────────
 *
 * A sale must clear all of them, and they are genuinely different questions:
 *
 *   THE CREDIT LIMIT caps EXPOSURE — how much of our money is out with this
 *   customer at once. Paying it down frees it up.
 *
 *   THE DAILY and MONTHLY LIMITS cap VELOCITY — how fast the account may be
 *   drawn down. Paying does NOT free them up, which is the entire point: a
 *   customer with a R50,000 limit who settles every afternoon could otherwise
 *   draw R50,000 every day without ever breaching the credit limit once.
 *
 * Reported worst-first by how much each is over, so the cashier is told the
 * binding constraint rather than whichever happened to be checked first. A
 * sale R5,000 over the monthly and R50 over the daily is a monthly problem.
 */
export function headroomRefusal(
  account: CreditPosition,
  amount: number,
  spend: PeriodSpend = NO_SPEND,
): string | null {
  const blocked = creditBlockedReason(account)
  if (blocked) return blocked

  const breaches: { over: number; message: string }[] = []

  const after = round(account.balance + amount, 2)
  if (after > account.creditLimit) {
    const over = round(after - account.creditLimit, 2)
    breaches.push({
      over,
      message: `${account.name} would be ${over.toFixed(2)} over their ${account.creditLimit.toFixed(2)} limit.`,
    })
  }

  if (account.dailyLimit && account.dailyLimit > 0) {
    const afterToday = round(spend.today + amount, 2)
    if (afterToday > account.dailyLimit) {
      const over = round(afterToday - account.dailyLimit, 2)
      breaches.push({
        over,
        message:
          `${account.name} would be ${over.toFixed(2)} over their ${account.dailyLimit.toFixed(2)} daily limit — ` +
          `${spend.today.toFixed(2)} already charged today.`,
      })
    }
  }

  if (account.monthlyLimit && account.monthlyLimit > 0) {
    const afterMonth = round(spend.month + amount, 2)
    if (afterMonth > account.monthlyLimit) {
      const over = round(afterMonth - account.monthlyLimit, 2)
      breaches.push({
        over,
        message:
          `${account.name} would be ${over.toFixed(2)} over their ${account.monthlyLimit.toFixed(2)} monthly limit — ` +
          `${spend.month.toFixed(2)} already charged this month.`,
      })
    }
  }

  if (breaches.length === 0) return null
  breaches.sort((a, b) => b.over - a.over)
  return breaches[0].message
}
