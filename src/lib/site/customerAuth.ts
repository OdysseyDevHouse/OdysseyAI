import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQuery, siteQueryOne } from '../siteDb'
import { hashPassword, verifyPassword } from '../password'
import { toNum } from '../decimals'
// The shared credit rules — the till, sales posting and this all ask the same
// module, so the storefront can never extend credit the counter would refuse.
import {
  availableCredit,
  creditBlockedReason,
  headroomRefusal,
  type CreditPosition,
} from '../creditRules'
import { toAccountType } from '../accountTypes'

/**
 * Signing an ACCOUNT CUSTOMER in to the online store.
 *
 * Entirely separate from staff authentication in lib/auth.ts. A customer is
 * not a user of this application: they can see their own account and place
 * their own orders, and nothing else. Sharing the staff session machinery
 * would mean one bug away from a shopper holding a back-office session.
 *
 * ── EVERY FAILURE LOOKS THE SAME ─────────────────────────────────────────
 *
 * Wrong email, wrong password, no login, deactivated login, account on hold:
 * one message. Distinguishing them turns the sign-in form into a tool for
 * discovering which of a shop's customers have accounts.
 *
 * ── LOCKOUT IS PER LOGIN, NOT PER ADDRESS ────────────────────────────────
 *
 * A company's buyers may all sit behind one office IP. Locking the address
 * because one person mistyped their password would shut out the whole firm.
 */

type Row = RowDataPacket & Record<string, unknown>

/** Wrong often enough to be someone guessing rather than someone forgetting. */
const MAX_ATTEMPTS = 8
const LOCK_MINUTES = 15

export type CustomerIdentity = {
  customerId: number
  loginId: number
  customerName: string
  email: string
  mustChange: boolean
}

/**
 * What the storefront may know about the signed-in customer.
 *
 * Deliberately NOT the customer row. That carries the VAT number, the rep,
 * payment terms, interest settings and notes staff wrote about them — none of
 * which belongs in a page served to a browser.
 */
export type CustomerAccount = {
  customerId: number
  name: string
  email: string
  /** The contact number on the customer record, for prefilling checkout. */
  phone: string
  /** What is left before the limit. Never negative. */
  availableCredit: number
  /** The raw position, so callers can re-ask the shared rules. */
  position: CreditPosition
  /** False when the account is on hold, closed, or otherwise not trading. */
  accountOpen: boolean
}

export type SignInResult =
  | { ok: true; identity: CustomerIdentity }
  | { ok: false; error: string }

/** One message for every failure — see the note at the top. */
const REFUSED = 'That email and password do not match an account.'

export async function signInCustomer(
  siteId: number,
  emailRaw: string,
  password: string,
): Promise<SignInResult> {
  const email = emailRaw.trim().toLowerCase()
  if (!email || !password) return { ok: false, error: REFUSED }

  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT cl.id, cl.customer_id, cl.password_hash, cl.failed_attempts, cl.locked_until,
            cl.must_change, cl.is_active,
            c.name AS customer_name, c.status
       FROM customer_logins cl
       JOIN customers c ON c.id = cl.customer_id
      WHERE cl.email = ?`,
    [email],
  )

  /*
   * No such login. Still spend the time a real comparison would, so the
   * response time does not reveal which addresses exist — an unknown email
   * answering instantly while a known one takes 100ms is an enumeration
   * oracle regardless of what the message says.
   */
  if (!row) {
    await verifyPassword(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin')
    return { ok: false, error: REFUSED }
  }

  const lockedUntil = row.locked_until instanceof Date ? row.locked_until : null
  if (lockedUntil && lockedUntil > new Date()) {
    // The ONE case that gets its own message. Someone locked out needs to know
    // waiting fixes it, and by this point they have already proved the email
    // exists by locking it — so there is nothing left to leak.
    return {
      ok: false,
      error: 'Too many attempts. Please try again in a few minutes.',
    }
  }

  const good = await verifyPassword(password, String(row.password_hash))

  if (!good) {
    const attempts = Number(row.failed_attempts) + 1
    await siteExecute(
      siteId,
      `UPDATE customer_logins
          SET failed_attempts = ?,
              locked_until = ${attempts >= MAX_ATTEMPTS ? `DATE_ADD(NOW(), INTERVAL ${LOCK_MINUTES} MINUTE)` : 'NULL'}
        WHERE id = ?`,
      [attempts, row.id],
    )
    return { ok: false, error: REFUSED }
  }

  /*
   * The password was right, but the login or the account may still be closed.
   * Checked AFTER the password so a deactivated login cannot be distinguished
   * from a wrong password by anyone who does not already know the password.
   */
  if (!row.is_active || String(row.status) !== 'active') {
    return { ok: false, error: REFUSED }
  }

  await siteExecute(
    siteId,
    `UPDATE customer_logins
        SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW()
      WHERE id = ?`,
    [row.id],
  )

  return {
    ok: true,
    identity: {
      customerId: Number(row.customer_id),
      loginId: Number(row.id),
      customerName: String(row.customer_name),
      email,
      mustChange: !!row.must_change,
    },
  }
}

/**
 * The account, as the storefront may see it.
 *
 * Re-read on every request rather than carried in the session token: a credit
 * limit or a hold applied by staff this morning must take effect now, not
 * whenever the shopper next signs in.
 */
export async function customerAccount(
  siteId: number,
  customerId: number,
): Promise<CustomerAccount | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT c.id, c.name, c.status, c.account_type, c.credit_limit, c.balance, c.phone,
            -- The login email is what they sign in with; the customer record's
            -- own email may differ, and the sign-in one is the one they know.
            COALESCE(cl.email, c.email) AS email
       FROM customers c
       LEFT JOIN customer_logins cl ON cl.customer_id = c.id
      WHERE c.id = ?`,
    [customerId],
  )
  if (!row) return null

  /*
   * The SAME position object the till and the posting engine use, so all three
   * ask lib/creditRules.ts rather than each deciding for itself what "can this
   * account take credit" means. An earlier version of this file had its own
   * arithmetic and disagreed with both — it read a zero limit as "no limit
   * set" where the rest of the app reads it as "no credit granted", which
   * would have let the storefront extend credit the till refuses.
   */
  const position: CreditPosition = {
    name: String(row.name),
    status: String(row.status),
    accountType: toAccountType(row.account_type),
    creditLimit: toNum(row.credit_limit),
    balance: toNum(row.balance),
  }

  return {
    customerId: Number(row.id),
    name: position.name,
    email: String(row.email ?? ''),
    phone: String(row.phone ?? ''),
    position,
    availableCredit: availableCredit(position),
    // "Can this account take credit at all", by the shared rule — not merely
    // whether the status string says active.
    accountOpen: creditBlockedReason(position) === null,
  }
}

/**
 * Whether an order of this size may go on this account.
 *
 * A thin wrapper over `headroomRefusal` so every caller here returns the same
 * shape as the rest of this module. The RULE lives in lib/creditRules.ts and
 * is shared with the till and with sales posting; this only adds the
 * not-signed-in case, which the till cannot have.
 */
export function accountCanCover(
  account: CustomerAccount | null,
  total: number,
): { ok: true } | { ok: false; reason: string } {
  // No account resolved — not signed in, or the customer was deleted between
  // signing in and ordering. Fails closed.
  if (!account) {
    return { ok: false, reason: 'You are not signed in to an account.' }
  }
  const refusal = headroomRefusal(account.position, total)
  return refusal ? { ok: false, reason: refusal } : { ok: true }
}

/**
 * A customer's own orders, for their account page.
 *
 * Its own query rather than an option on the staff `listOrders`, deliberately.
 * A shared function whose customer filter is a parameter is one forgotten
 * argument away from serving every order in the shop to whoever asks; here the
 * WHERE clause cannot be widened by a caller because there is nothing to pass.
 *
 * It returns only what the shopper already knows — their own order, its total
 * and where it has got to. No internal note, no decline reason staff wrote for
 * themselves, no margin.
 */
export type CustomerOrder = {
  id: number
  orderNumber: string
  placedAt: Date | null
  totalIncl: number
  statusName: string
  fulfilment: string
  onAccount: boolean
}

export async function customerOrders(
  siteId: number,
  customerId: number,
  limit = 25,
): Promise<CustomerOrder[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT o.id, o.order_number, o.placed_at, o.total_incl, o.fulfilment, o.pay_on_account,
            s.name AS status_name
       FROM online_orders o
       LEFT JOIN online_order_statuses s ON s.id = o.status_id
      WHERE o.customer_id = ? AND o.is_archived = 0
      ORDER BY o.placed_at DESC, o.id DESC
      LIMIT ${Math.min(Math.max(limit, 1), 100)}`,
    [customerId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    orderNumber: String(r.order_number),
    placedAt: r.placed_at instanceof Date ? r.placed_at : null,
    totalIncl: toNum(r.total_incl),
    statusName: String(r.status_name ?? ''),
    fulfilment: String(r.fulfilment),
    onAccount: !!r.pay_on_account,
  }))
}

/* ── Staff-side management ────────────────────────────────────────────────── */

export type LoginSummary = {
  email: string
  isActive: boolean
  mustChange: boolean
  lastLoginAt: Date | null
  lockedUntil: Date | null
}

export async function getCustomerLogin(
  siteId: number,
  customerId: number,
): Promise<LoginSummary | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT email, is_active, must_change, last_login_at, locked_until
       FROM customer_logins WHERE customer_id = ?`,
    [customerId],
  )
  if (!row) return null
  return {
    email: String(row.email),
    isActive: !!row.is_active,
    mustChange: !!row.must_change,
    lastLoginAt: row.last_login_at instanceof Date ? row.last_login_at : null,
    lockedUntil: row.locked_until instanceof Date ? row.locked_until : null,
  }
}

export type SaveResult = { ok: true } | { ok: false; error: string }

/**
 * Give a customer online access, or reset the password of an existing login.
 *
 * Staff choose the password and pass it on, and `must_change` is set so it
 * stops working as a shared secret the moment the customer signs in. There is
 * no self-service reset because there is no email sending in this app yet —
 * offering "forgot password" that silently does nothing is worse than not
 * offering it.
 */
export async function setCustomerLogin(
  siteId: number,
  customerId: number,
  emailRaw: string,
  password: string,
): Promise<SaveResult> {
  const email = emailRaw.trim().toLowerCase()
  if (!email || !email.includes('@')) return { ok: false, error: 'Enter a valid email address.' }
  // bcrypt silently truncates past 72 bytes, so a longer password would give
  // a false sense of strength.
  if (password.length < 8) return { ok: false, error: 'Use at least 8 characters.' }
  if (password.length > 72) return { ok: false, error: 'Use 72 characters or fewer.' }

  const clash = await siteQueryOne<Row>(
    siteId,
    `SELECT customer_id FROM customer_logins WHERE email = ? AND customer_id <> ?`,
    [email, customerId],
  )
  if (clash) return { ok: false, error: 'Another customer already signs in with that email.' }

  const hash = await hashPassword(password)
  await siteExecute(
    siteId,
    `INSERT INTO customer_logins (customer_id, email, password_hash, must_change)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       email = VALUES(email),
       password_hash = VALUES(password_hash),
       must_change = 1,
       is_active = 1,
       -- A reset clears the lockout: staff resetting a password for someone
       -- who locked themselves out should not leave them still locked out.
       failed_attempts = 0,
       locked_until = NULL`,
    [customerId, email, hash],
  )
  return { ok: true }
}

/** The customer's own password change, after signing in with a temporary one. */
export async function changeCustomerPassword(
  siteId: number,
  customerId: number,
  current: string,
  next: string,
): Promise<SaveResult> {
  if (next.length < 8) return { ok: false, error: 'Use at least 8 characters.' }
  if (next.length > 72) return { ok: false, error: 'Use 72 characters or fewer.' }

  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT id, password_hash FROM customer_logins WHERE customer_id = ?`,
    [customerId],
  )
  if (!row) return { ok: false, error: 'No online access on this account.' }

  // The current password is required even though they are already signed in:
  // it is what stops someone who found an unattended phone from locking the
  // real customer out of their own account.
  if (!(await verifyPassword(current, String(row.password_hash)))) {
    return { ok: false, error: 'That is not your current password.' }
  }

  await siteExecute(
    siteId,
    `UPDATE customer_logins SET password_hash = ?, must_change = 0 WHERE id = ?`,
    [await hashPassword(next), row.id],
  )
  return { ok: true }
}

/** Withdraw online access without deleting the customer. */
export async function setCustomerLoginActive(
  siteId: number,
  customerId: number,
  active: boolean,
): Promise<SaveResult> {
  await siteExecute(
    siteId,
    `UPDATE customer_logins SET is_active = ? WHERE customer_id = ?`,
    [active ? 1 : 0, customerId],
  )
  return { ok: true }
}
