import 'server-only'
import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { query, queryOne, transaction } from '@/lib/db'
import { toNum } from '@/lib/decimals'

/**
 * The platform subscription behind a billing account, and every collection
 * PayFast has made against it.
 *
 * Lives in the CONTROL database (odyssey_tickets), alongside the accounts and
 * modules it bills for — not in any site database, because one subscription
 * covers every store on the account.
 */

type Row = RowDataPacket & Record<string, unknown>

export type SubscriptionStatus =
  | 'none'
  | 'pending'
  | 'active'
  | 'past_due'
  | 'paused'
  | 'cancelled'

export type Subscription = {
  id: number
  accountId: number
  pfToken: string | null
  mPaymentId: string | null
  status: SubscriptionStatus
  amountIncl: number
  pendingAmount: number | null
  currency: string
  billingDate: string | null
  nextBillingOn: string | null
  lastPaidOn: string | null
  syncedAt: Date | null
  escalationPercent: number
  anniversaryOn: string | null
  lastEscalatedOn: string | null
}

const SELECT_SUB = `
  SELECT id, account_id, pf_token, m_payment_id, status, amount_incl, pending_amount,
         -- Selected because startCheckoutAttempt compares it against the clock
         -- to decide whether an attempt is still in flight. Leaving it out made
         -- that check read undefined, so every second checkout minted a fresh
         -- reference and the race this function exists to close stayed open --
         -- with the row lock and the timestamps all working perfectly.
         pending_started_at,
         currency, billing_date, next_billing_on, last_paid_on, synced_at,
         escalation_percent, anniversary_on, last_escalated_on
    FROM cp2_billing_subscriptions`

function toSubscription(r: Row): Subscription {
  return {
    id: Number(r.id),
    accountId: Number(r.account_id),
    pfToken: (r.pf_token as string | null) ?? null,
    mPaymentId: (r.m_payment_id as string | null) ?? null,
    status: String(r.status) as SubscriptionStatus,
    amountIncl: toNum(r.amount_incl),
    pendingAmount: r.pending_amount === null ? null : toNum(r.pending_amount),
    currency: String(r.currency ?? 'ZAR'),
    billingDate: r.billing_date ? String(r.billing_date).slice(0, 10) : null,
    nextBillingOn: r.next_billing_on ? String(r.next_billing_on).slice(0, 10) : null,
    lastPaidOn: r.last_paid_on ? String(r.last_paid_on).slice(0, 10) : null,
    syncedAt: (r.synced_at as Date | null) ?? null,
    escalationPercent: toNum(r.escalation_percent),
    anniversaryOn: r.anniversary_on ? String(r.anniversary_on).slice(0, 10) : null,
    lastEscalatedOn: r.last_escalated_on ? String(r.last_escalated_on).slice(0, 10) : null,
  }
}

export async function subscriptionForAccount(accountId: number): Promise<Subscription | null> {
  const row = await queryOne<Row>(`${SELECT_SUB} WHERE account_id = ? LIMIT 1`, [accountId])
  return row ? toSubscription(row) : null
}

export async function subscriptionByPfToken(pfToken: string): Promise<Subscription | null> {
  const row = await queryOne<Row>(`${SELECT_SUB} WHERE pf_token = ? LIMIT 1`, [pfToken])
  return row ? toSubscription(row) : null
}

/** Make sure a dormant row exists, for an account created after migration 010. */
export async function ensureSubscriptionRow(accountId: number): Promise<void> {
  await transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO cp2_billing_subscriptions (account_id, status) VALUES (?, 'none')
       ON DUPLICATE KEY UPDATE account_id = account_id`,
      [accountId],
    )
  })
}

/* ── Starting a checkout ────────────────────────────────────────────────── */

export type CheckoutAttempt =
  | { ok: true; reference: string; amountIncl: number }
  | { ok: false; error: string }

/** How long a started attempt is reused rather than superseded. */
const ATTEMPT_WINDOW_MINUTES = 15

/**
 * A DATETIME from the driver as epoch milliseconds.
 *
 * ── THE COLUMN IS WRITTEN WITH UTC_TIMESTAMP(), NOT NOW() ──────────────────
 *
 * The pool connects with `timezone: 'Z'`, so it reads every DATETIME back as
 * UTC. `NOW()` writes the database server's LOCAL time, which on a UTC+2 host
 * comes back looking two hours in the future — an "age" of minus two hours,
 * and any freshness window silently always true.
 *
 * That is why `pending_started_at` is written with `UTC_TIMESTAMP()` while the
 * rest of the control database still uses NOW(): this is the only column here
 * whose value is compared against `Date.now()` in JavaScript, so it is the only
 * one where the skew is a bug rather than a cosmetic offset.
 */
function startedAtMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    const ms = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

/**
 * Claim a checkout attempt for this account.
 *
 * ── THE ROW LOCK IS THE POINT ──────────────────────────────────────────────
 *
 * The previous system read the subscription, compared its status, then wrote —
 * with no transaction and no lock. Two checkouts started at once both passed
 * the "not active" test and the second overwrote the first's reference. The
 * first customer then paid, their notification carried a reference that
 * matched nothing, and the money arrived with no subscription to attach it to.
 *
 * `FOR UPDATE` serialises the two: the second either gets the first's
 * reference back or supersedes it under the lock. There is no interleaving.
 *
 * A double-click inside the window deliberately returns the SAME reference, so
 * both form posts converge on one payment rather than racing.
 */
export async function startCheckoutAttempt(
  accountId: number,
  amountIncl: number,
): Promise<CheckoutAttempt> {
  if (!(amountIncl > 0)) {
    /* A zero subscription is a mandate that collects nothing for ever and
       looks perfectly healthy. The price book seeds unpriced, so this is
       reachable by simply not having set the prices yet. */
    return { ok: false, error: 'This plan comes to nothing — set the module prices first.' }
  }

  return transaction(async (tx) => {
    /* FOR UPDATE serialises two checkouts on this row: the second waits, and
       its locking read then sees what the first actually committed rather than
       a snapshot from before it. That is what stops both minting a reference
       and the second overwriting the first — which in the previous system left
       the first customer's payment carrying a reference that matched nothing. */
    const [rows] = await tx.execute(`${SELECT_SUB} WHERE account_id = ? FOR UPDATE`, [accountId])
    const existing = (rows as Row[])[0]
    if (!existing) {
      return { ok: false as const, error: 'This account has no billing record yet.' }
    }

    const sub = toSubscription(existing)

    if (sub.status === 'active' || sub.status === 'past_due' || sub.status === 'paused') {
      /* Refused outright rather than started alongside. A second mandate means
         two debit orders against one customer, and nothing on any screen would
         look wrong until they saw their bank statement. */
      return {
        ok: false as const,
        error: 'This account already has a debit order. Change the plan instead of starting a new one.',
      }
    }

    /* A second click inside the window reuses the attempt in flight, so both
       form posts converge on one payment instead of racing.

       `pending_started_at` is read through `startedAtMs` rather than as a Date:
       the driver hands DATETIME back as a string or a Date depending on the
       column and the pool's settings, and calling .getTime() on a string
       throws inside this condition — which JavaScript then swallows as a
       falsy `fresh`, silently minting a second reference. That was a real bug
       here, and it looked exactly like the row lock not working. */
    const startedAt = startedAtMs(existing.pending_started_at)
    const fresh =
      sub.status === 'pending' &&
      sub.mPaymentId &&
      startedAt !== null &&
      Date.now() - startedAt < ATTEMPT_WINDOW_MINUTES * 60_000

    if (fresh && sub.mPaymentId) {
      return { ok: true as const, reference: sub.mPaymentId, amountIncl: sub.pendingAmount ?? amountIncl }
    }

    const reference = randomUUID()
    const [result] = await tx.execute(
      `UPDATE cp2_billing_subscriptions
          SET m_payment_id = ?, pending_amount = ?, pending_started_at = UTC_TIMESTAMP(), status = 'pending'
        WHERE account_id = ? AND status IN ('none','pending','cancelled')`,
      [reference, amountIncl.toFixed(2), accountId],
    )

    // The status set narrowed under the lock — somebody else activated it.
    if ((result as { affectedRows?: number }).affectedRows !== 1) {
      return { ok: false as const, error: 'This account already has a debit order.' }
    }

    return { ok: true as const, reference, amountIncl }
  })
}

/* ── Recording a notification ───────────────────────────────────────────── */

export type RecordItnInput = {
  accountId: number
  pfPaymentId: string
  mPaymentId: string | null
  pfToken: string | null
  amountGross: number
  amountFee: number
  amountNet: number
  paymentStatus: string
  verified: boolean
  rejectReason: string | null
  billingDate: string | null
  rawPayload: string
  sourceIp: string | null
}

export type RecordOutcome =
  /** Never seen before; the mandate went live. */
  | { outcome: 'activated'; subscriptionId: number }
  /** A later collection on a mandate already live. */
  | { outcome: 'renewed'; subscriptionId: number }
  /** Recorded, but the collection failed or was cancelled. */
  | { outcome: 'failed'; subscriptionId: number }
  /** Recorded, and our verification refused it. Subscription untouched. */
  | { outcome: 'rejected' }
  /** Seen before. Nothing was read, locked or written. */
  | { outcome: 'duplicate' }

function isDuplicateKey(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: string }).code === 'ER_DUP_ENTRY'
  )
}

/**
 * Write a notification down, then decide what it means.
 *
 * ── THE INSERT COMES FIRST, AND THAT IS THE WHOLE IDEMPOTENCY STORY ────────
 *
 * A subscription is `active` before AND after a renewal, so there is no status
 * to guard on the way the store-payment path guards `status = 'pending'`. The
 * only thing separating collection #7 from a replay of collection #7 is
 * PayFast's own payment id — so it is a UNIQUE key, and the guard is held by
 * InnoDB at the moment of insert rather than by logic two concurrent
 * deliveries could both pass.
 *
 * A duplicate therefore rolls back having read nothing and locked nothing. The
 * subscription row is not merely left unchanged; it is never touched.
 *
 * Writing the raw payload in that same insert also means every payload that
 * names a payment id becomes exactly one row — verified or not. That is what
 * makes "I paid and nothing happened" answerable.
 */
export async function recordItnPayment(input: RecordItnInput): Promise<RecordOutcome> {
  return transaction(async (tx) => {
    try {
      await tx.execute(
        `INSERT INTO cp2_billing_payments
           (account_id, pf_payment_id, m_payment_id, pf_token, amount_gross, amount_fee,
            amount_net, payment_status, verified, reject_reason, billing_date,
            raw_payload, source_ip)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          input.accountId,
          input.pfPaymentId,
          input.mPaymentId,
          input.pfToken,
          input.amountGross.toFixed(2),
          input.amountFee.toFixed(2),
          input.amountNet.toFixed(2),
          input.paymentStatus,
          input.verified ? 1 : 0,
          input.rejectReason,
          input.billingDate,
          input.rawPayload,
          input.sourceIp,
        ],
      )
    } catch (error) {
      if (isDuplicateKey(error)) return { outcome: 'duplicate' as const }
      // Anything else is a real write failure. Rethrow so the route can answer
      // 500 and PayFast retries — see the route's docblock.
      throw error
    }

    // Verification failed: the attempt is on file, the mandate is untouched.
    if (!input.verified) return { outcome: 'rejected' as const }

    const [rows] = await tx.execute(
      `${SELECT_SUB} WHERE account_id = ? FOR UPDATE`,
      [input.accountId],
    )
    const row = (rows as Row[])[0]
    if (!row) return { outcome: 'rejected' as const }
    const sub = toSubscription(row)

    await tx.execute('UPDATE cp2_billing_payments SET subscription_id = ? WHERE pf_payment_id = ?', [
      sub.id,
      input.pfPaymentId,
    ])

    const status = input.paymentStatus.toUpperCase()

    if (status !== 'COMPLETE') {
      /* A bounced collection on a live mandate is past_due; PayFast will try
         again. A cancellation is terminal. Neither touches entitlements here —
         losing access is a decision for the dunning process, not a side effect
         of one failed debit. */
      const next: SubscriptionStatus = status === 'CANCELLED' ? 'cancelled' : 'past_due'
      await tx.execute(
        `UPDATE cp2_billing_subscriptions
            SET status = ?, cancelled_at = CASE WHEN ? = 'cancelled' THEN NOW() ELSE cancelled_at END
          WHERE id = ?`,
        [next, next, sub.id],
      )
      return { outcome: 'failed' as const, subscriptionId: sub.id }
    }

    const first = sub.status === 'pending' || sub.status === 'none'

    if (first) {
      const [result] = await tx.execute(
        `UPDATE cp2_billing_subscriptions
            SET status = 'active',
                pf_token = ?,
                -- The amount WE recorded when the form was built, never the
                -- payload's own claim about itself.
                amount_incl = COALESCE(pending_amount, amount_incl),
                pending_amount = NULL,
                pending_started_at = NULL,
                anniversary_on = COALESCE(anniversary_on, CURDATE()),
                last_paid_on = CURDATE(),
                synced_at = NOW()
          WHERE id = ? AND status IN ('pending','none')`,
        [input.pfToken, sub.id],
      )
      if ((result as { affectedRows?: number }).affectedRows !== 1) {
        // The row moved under the lock. Recorded, not silently "successful".
        return { outcome: 'rejected' as const }
      }
      return { outcome: 'activated' as const, subscriptionId: sub.id }
    }

    await tx.execute(
      `UPDATE cp2_billing_subscriptions
          SET status = 'active', last_paid_on = CURDATE(),
              pf_token = COALESCE(pf_token, ?)
        WHERE id = ?`,
      [input.pfToken, sub.id],
    )
    return { outcome: 'renewed' as const, subscriptionId: sub.id }
  })
}

/* ── Amount, status, history ────────────────────────────────────────────── */

/** Persist the local price. Pushing it to PayFast is the caller's next step. */
export async function setAmount(accountId: number, amountIncl: number): Promise<void> {
  await transaction(async (tx) => {
    await tx.execute(
      `UPDATE cp2_billing_subscriptions
          SET amount_incl = ?, synced_at = NULL
        WHERE account_id = ?`,
      [amountIncl.toFixed(2), accountId],
    )
  })
}

/** Record that PayFast now agrees with the local amount. */
export async function markSynced(accountId: number): Promise<void> {
  await transaction(async (tx) => {
    await tx.execute('UPDATE cp2_billing_subscriptions SET synced_at = NOW() WHERE account_id = ?', [
      accountId,
    ])
  })
}

export async function markStatus(
  accountId: number,
  status: SubscriptionStatus,
  reason?: string,
): Promise<void> {
  await transaction(async (tx) => {
    await tx.execute(
      `UPDATE cp2_billing_subscriptions
          SET status = ?,
              cancelled_at = CASE WHEN ? = 'cancelled' THEN NOW() ELSE cancelled_at END,
              cancel_reason = CASE WHEN ? = 'cancelled' THEN ? ELSE cancel_reason END
        WHERE account_id = ?`,
      [status, status, status, reason ?? null, accountId],
    )
  })
}

export type PaymentRow = {
  id: number
  pfPaymentId: string
  amountGross: number
  paymentStatus: string
  verified: boolean
  rejectReason: string | null
  receivedAt: Date | null
}

/** The billing history, newest first — what a customer was actually charged. */
export async function paymentsForAccount(accountId: number, limit = 24): Promise<PaymentRow[]> {
  const rows = await query<Row>(
    `SELECT id, pf_payment_id, amount_gross, payment_status, verified, reject_reason, received_at
       FROM cp2_billing_payments
      WHERE account_id = ?
      ORDER BY received_at DESC, id DESC
      LIMIT ?`,
    [accountId, Math.max(1, Math.min(200, Math.floor(limit)))],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    pfPaymentId: String(r.pf_payment_id),
    amountGross: toNum(r.amount_gross),
    paymentStatus: String(r.payment_status),
    verified: Number(r.verified) === 1,
    rejectReason: (r.reject_reason as string | null) ?? null,
    receivedAt: (r.received_at as Date | null) ?? null,
  }))
}

/* ── Escalation ─────────────────────────────────────────────────────────── */

/**
 * Subscriptions whose escalation anniversary is today and which have not
 * already been escalated this year.
 *
 * Both halves matter. The previous system escalated EVERY active subscription
 * on whatever day the job happened to run, and running it twice applied the
 * increase twice — compounding a price rise by accident.
 */
export async function dueForEscalation(today: string): Promise<Subscription[]> {
  const rows = await query<Row>(
    `${SELECT_SUB}
      WHERE status = 'active'
        AND pf_token IS NOT NULL
        AND escalation_percent > 0
        AND anniversary_on IS NOT NULL
        AND MONTH(anniversary_on) = MONTH(?)
        AND DAY(anniversary_on) = DAY(?)
        AND YEAR(?) > YEAR(anniversary_on)
        AND (last_escalated_on IS NULL OR YEAR(last_escalated_on) < YEAR(?))`,
    [today, today, today, today],
  )
  return rows.map(toSubscription)
}

/**
 * Claim the escalation and raise the local amount, in one statement.
 *
 * Returns false when another worker got there first. The year guard is in the
 * WHERE of the WRITE, not only in the SELECT above — two workers reading at
 * the same instant would both pass a read-side check, and only one may win.
 */
export async function markEscalated(
  subscriptionId: number,
  newAmount: number,
  today: string,
): Promise<boolean> {
  return transaction(async (tx) => {
    const [result] = await tx.execute(
      `UPDATE cp2_billing_subscriptions
          SET amount_incl = ?, last_escalated_on = ?, synced_at = NULL
        WHERE id = ?
          AND (last_escalated_on IS NULL OR YEAR(last_escalated_on) < YEAR(?))`,
      [newAmount.toFixed(2), today, subscriptionId, today],
    )
    return (result as { affectedRows?: number }).affectedRows === 1
  })
}

/** Subscriptions whose local amount has not been confirmed with PayFast. */
export async function needingSync(): Promise<Subscription[]> {
  const rows = await query<Row>(
    `${SELECT_SUB}
      WHERE status IN ('active','past_due')
        AND pf_token IS NOT NULL
        AND synced_at IS NULL`,
  )
  return rows.map(toSubscription)
}
