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
}

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
 * Whether this amount fits on top of what is already owed.
 *
 * Returns the sentence to show, or null. Checked on the till as the basket
 * changes AND again at finalise — a basket can sit on screen for ten minutes
 * while someone else settles the account.
 */
export function headroomRefusal(account: CreditPosition, amount: number): string | null {
  const blocked = creditBlockedReason(account)
  if (blocked) return blocked

  const after = round(account.balance + amount, 2)
  if (after > account.creditLimit) {
    const over = round(after - account.creditLimit, 2)
    return `${account.name} would be ${over.toFixed(2)} over their ${account.creditLimit.toFixed(2)} limit.`
  }
  return null
}
