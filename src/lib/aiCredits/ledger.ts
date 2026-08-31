import 'server-only'
import { randomUUID } from 'crypto'
import type { RowDataPacket } from 'mysql2'
import { query, queryOne, execute, transaction } from '@/lib/db'
import { toNum } from '@/lib/decimals'
import { cacheTokensOf, usageCostMicros, type AiFeature, type TokenUsage } from './pricing'

/**
 * The AI credits wallet, against the control database.
 *
 * Every amount here is micro-USD (see ./pricing). The balance is a SUM over
 * cp2_ai_credit_ledger and is never stored — see the migration for why, but
 * briefly: rows only INSERT, so two AI calls finishing together cannot lose one
 * another's debit.
 *
 * ── THIS FILE TALKS SQL, WHICH IS NOT ALWAYS AVAILABLE ─────────────────────
 *
 * A desktop install should reach the control panel over HTTPS rather than
 * opening MySQL to it. That routing decision does NOT live here — it lives in
 * the caller, which tries the portal first and falls back to these. Keeping the
 * transport out of this file is what lets the same functions serve a cloud
 * request, a portal endpoint, and a test.
 */

type Row = RowDataPacket & Record<string, unknown>

/* ── Balance ─────────────────────────────────────────────────────────────── */

/**
 * What the account has left, in micro-USD.
 *
 * Can be negative. A call is metered on what it actually used, which is only
 * known afterwards, so a call that ran far over its estimate overdraws the
 * wallet rather than being silently discounted. The ledger says what happened;
 * clamping at zero would make it say something else.
 */
export async function balanceMicros(accountId: number): Promise<number> {
  const row = await queryOne<Row>(
    `SELECT COALESCE(SUM(amount_micros), 0) AS balance
       FROM cp2_ai_credit_ledger
      WHERE account_id = ?`,
    [accountId],
  )
  return Math.round(toNum(row?.balance))
}

/* ── Usage ───────────────────────────────────────────────────────────────── */

export type UsageEntry = {
  accountId: number
  siteId: number | null
  userId: number | null
  feature: AiFeature
  model: string
  usage: TokenUsage
}

/**
 * Charge one AI call to the wallet.
 *
 * Returns the debit written, so a caller can log or show it. The amount is
 * derived from `usage` here rather than passed in — a cost the caller computed
 * is a cost the caller could get wrong, and this is the only place that
 * decision should be made.
 */
export async function recordUsage(entry: UsageEntry): Promise<number> {
  const costMicros = usageCostMicros(entry.usage)
  await execute(
    `INSERT INTO cp2_ai_credit_ledger
       (account_id, amount_micros, entry_type, feature, site_id, user_id,
        model, input_tokens, output_tokens, cache_tokens)
     VALUES (?,?, 'usage', ?,?,?,?,?,?,?)`,
    [
      entry.accountId,
      // Negative, always. Math.abs first so a caller that somehow produced a
      // negative cost cannot credit the wallet by spending.
      -Math.abs(costMicros),
      entry.feature,
      entry.siteId,
      entry.userId,
      entry.model,
      Math.max(0, Math.floor(Number(entry.usage.input_tokens ?? 0))),
      Math.max(0, Math.floor(Number(entry.usage.output_tokens ?? 0))),
      cacheTokensOf(entry.usage),
    ],
  )
  return costMicros
}

/* ── Credits granted by a person ─────────────────────────────────────────── */

/**
 * Put credit in by hand — an EFT from a shop PayFast cannot charge, a refund, a
 * goodwill gesture after an outage.
 *
 * Deliberately has no UI. It is called from a script by somebody who has
 * decided to do it, and `note` is what makes that decision explicable a year
 * later. 'adjustment' is the same mechanism for a correction, kept separate so
 * "we gave them credit" and "we fixed a mistake" do not read alike in the
 * history.
 */
export async function addCredit(input: {
  accountId: number
  amountMicros: number
  note: string
  kind?: 'manual' | 'adjustment'
}): Promise<void> {
  await execute(
    `INSERT INTO cp2_ai_credit_ledger (account_id, amount_micros, entry_type, note)
     VALUES (?,?,?,?)`,
    [
      input.accountId,
      // An adjustment may legitimately be negative — a correction takes credit
      // back. A manual credit may not, so it is the one that gets clamped.
      input.kind === 'adjustment' ? Math.round(input.amountMicros) : Math.abs(Math.round(input.amountMicros)),
      input.kind ?? 'manual',
      input.note.slice(0, 255),
    ],
  )
}

/* ── Top-up lifecycle ────────────────────────────────────────────────────── */

export type PendingTopup = {
  id: number
  accountId: number
  reference: string
  amountMicros: number
  amountPay: number
  payCurrency: string
  siteId: number | null
  status: 'pending' | 'complete' | 'failed'
}

function toPending(row: Row): PendingTopup {
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    reference: String(row.reference),
    amountMicros: Number(row.amount_micros),
    amountPay: toNum(row.amount_pay),
    payCurrency: String(row.pay_currency ?? 'ZAR'),
    siteId: row.site_id === null || row.site_id === undefined ? null : Number(row.site_id),
    status: String(row.status ?? 'pending') as PendingTopup['status'],
  }
}

/**
 * Start a checkout. Returns the reference to send as m_payment_id.
 *
 * The credit to grant is fixed HERE, from the amount being charged, and stored
 * on the row — so an exchange rate that moves between paying and the
 * notification arriving cannot change what the shop bought.
 */
export async function startTopup(input: {
  accountId: number
  siteId: number | null
  amountMicros: number
  amountPay: number
  payCurrency: string
}): Promise<string> {
  const reference = randomUUID()
  await execute(
    `INSERT INTO cp2_ai_topup_pending
       (account_id, reference, amount_micros, amount_pay, pay_currency, site_id, status)
     VALUES (?,?,?,?,?,?, 'pending')`,
    [
      input.accountId,
      reference,
      Math.round(input.amountMicros),
      input.amountPay.toFixed(2),
      input.payCurrency,
      input.siteId,
    ],
  )
  return reference
}

/** The checkout a notification belongs to, by the reference we minted. */
export async function pendingByReference(reference: string): Promise<PendingTopup | null> {
  const row = await queryOne<Row>(
    `SELECT id, account_id, reference, amount_micros, amount_pay, pay_currency,
            site_id, status
       FROM cp2_ai_topup_pending
      WHERE reference = ?
      LIMIT 1`,
    [reference],
  )
  return row ? toPending(row) : null
}

/**
 * What a notification did.
 *
 * `rejected` and `pending` both mean NOTHING WAS WRITTEN and the checkout is
 * still open — the first because we could not verify the payload, the second
 * because PayFast says the money has not cleared yet. Both expect a further
 * notification for the same reference, and both must leave the row settleable.
 */
export type SettleOutcome = 'credited' | 'duplicate' | 'failed' | 'rejected' | 'pending'

/**
 * Settle a verified notification.
 *
 * ── STAMPING THE PAYMENT ID IS WHAT MAKES A REPLAY FREE ────────────────────
 *
 * PayFast retries anything it did not see acknowledged, so the same payment
 * arrives more than once as a matter of routine. The UPDATE that stamps
 * pf_payment_id runs first and is guarded by `status = 'pending'`; a replay
 * either fails that guard (the row already moved) or trips the unique key on
 * pf_payment_id. Either way it returns 'duplicate' having written nothing, and
 * the ledger credit below is never reached twice.
 *
 * Both writes are in ONE transaction. A credit without its pending row settled
 * would be re-credited by the next retry; a settled row without its credit is
 * money taken and not delivered. Neither is allowed to happen alone.
 *
 * ── THE ROW IS SINGLE-USE, SO ONLY A FINAL ANSWER MAY SPEND IT ─────────────
 *
 * Every write here is guarded by `status = 'pending'`, which is what makes a
 * replay free — but it also means the FIRST write wins and no later
 * notification for the same checkout can do anything at all.
 *
 * That is correct for an answer that is final (credited, genuinely failed) and
 * catastrophic for one that is not. A payload we could not verify, or a payment
 * PayFast says is still clearing, must therefore write NOTHING and leave the
 * row exactly as it found it — see the branches below, each of which says why.
 *
 * Throws on a real write failure — the caller answers 500 and PayFast retries,
 * which is the behaviour that saves the payment.
 */
export async function settleTopup(input: {
  pending: PendingTopup
  paymentStatus: string
  pfPaymentId: string
  rawPayload: string
  verified: boolean
}): Promise<SettleOutcome> {
  const status = input.paymentStatus.toUpperCase()
  const complete = status === 'COMPLETE'
  /* What PayFast calls terminal. Anything else — PENDING on an EFT that has not
     cleared, or a status this code has never seen — is an interim report on a
     payment still in flight. */
  const terminal = status === 'FAILED' || status === 'CANCELLED'

  return transaction(async (tx) => {
    /* ── AN UNVERIFIED PAYLOAD LEAVES THE ROW ALONE ────────────────────────
     *
     * READ THIS BEFORE "TIDYING" IT INTO THE BRANCH BELOW.
     *
     * `verified: false` does NOT mean "this payment failed". It means we could
     * not confirm it — and the commonest cause is step 3 of verifyItn, the
     * post-back, whose own comment says a network failure is not a pass and
     * that the payment should be left pending for the retry to settle.
     *
     * This row is single-use: every write below is guarded by
     * `status = 'pending'`. So marking it failed here would CONSUME it, and
     * PayFast's retry — arriving a minute later, when the network is back and
     * the post-back succeeds — would fail that guard and return 'duplicate'
     * having credited nothing. Money collected, wallet untouched, and no error
     * anywhere.
     *
     * So: write nothing, and let the retry try again. The attempt is reported
     * to the caller, which logs it. If the payload was genuinely forged the
     * retries stop of their own accord and the row ages out as an abandoned
     * checkout, which is exactly what it is. */
    if (!input.verified) return 'rejected'

    /* Terminal from PayFast, and verified: the payment really is dead. Consume
       the row — a shop that wants to try again starts a new checkout, and a
       fresh reference is what keeps that attempt separate from this one. */
    if (!complete) {
      if (!terminal) {
        /* In flight — an EFT that has not cleared. Leave it pending so the
           COMPLETE that follows can still settle it. Consuming the row here
           would make the real payment unsettleable, which is the same bug as
           the unverified case above wearing a different hat. */
        return 'pending'
      }
      try {
        await tx.execute(
          `UPDATE cp2_ai_topup_pending
              SET status = 'failed', pf_payment_id = ?, raw_payload = ?
            WHERE id = ? AND status = 'pending'`,
          [input.pfPaymentId, input.rawPayload, input.pending.id],
        )
      } catch (error) {
        /* The unique key: this payment id is stamped on some row already, so
           this notification has been seen. Swallowed rather than rethrown
           BECAUSE of what a throw costs — the route answers 500, PayFast treats
           that as undelivered, and retries for ever on a payment that will
           collide every single time. */
        if (!isDuplicateKey(error)) throw error
        return 'duplicate'
      }
      return 'failed'
    }

    let claimed = 0
    try {
      const [result] = await tx.execute(
        `UPDATE cp2_ai_topup_pending
            SET status = 'complete', pf_payment_id = ?, raw_payload = ?
          WHERE id = ? AND status = 'pending'`,
        [input.pfPaymentId, input.rawPayload, input.pending.id],
      )
      claimed = (result as { affectedRows?: number }).affectedRows ?? 0
    } catch (error) {
      // The unique key on pf_payment_id: this payment already settled, against
      // this row or another. Nothing to do and nothing wrong.
      if (isDuplicateKey(error)) return 'duplicate'
      throw error
    }

    // The row was already complete or failed — a retry of something settled.
    if (claimed !== 1) return 'duplicate'

    await tx.execute(
      `INSERT INTO cp2_ai_credit_ledger (account_id, amount_micros, entry_type, reference)
       VALUES (?,?, 'topup', ?)`,
      [
        input.pending.accountId,
        Math.abs(Math.round(input.pending.amountMicros)),
        input.pending.reference,
      ],
    )

    return 'credited'
  })
}

function isDuplicateKey(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: string }).code === 'ER_DUP_ENTRY'
  )
}

/* ── History ─────────────────────────────────────────────────────────────── */

export type LedgerEntry = {
  id: number
  amountMicros: number
  entryType: 'topup' | 'usage' | 'manual' | 'adjustment'
  feature: string | null
  siteId: number | null
  userId: number | null
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  note: string | null
  createdAt: Date
}

/**
 * Recent activity, newest first.
 *
 * ── THE LIMIT IS IN THE QUERY, NOT AFTER IT ────────────────────────────────
 *
 * A busy account writes a ledger row per AI call, so this table grows without
 * bound and reading it whole to show fifty rows would get slower every month.
 * ix_acl_account covers the ORDER BY, so the LIMIT is applied by the index
 * rather than to a sorted copy of everything.
 */
export async function recentEntries(accountId: number, limit = 50): Promise<LedgerEntry[]> {
  const rows = await query<Row>(
    `SELECT id, amount_micros, entry_type, feature, site_id, user_id, model,
            input_tokens, output_tokens, note, created_at
       FROM cp2_ai_credit_ledger
      WHERE account_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [accountId, Math.max(1, Math.min(500, Math.floor(limit)))],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    amountMicros: Number(r.amount_micros),
    entryType: String(r.entry_type) as LedgerEntry['entryType'],
    feature: r.feature === null || r.feature === undefined ? null : String(r.feature),
    siteId: r.site_id === null || r.site_id === undefined ? null : Number(r.site_id),
    userId: r.user_id === null || r.user_id === undefined ? null : Number(r.user_id),
    model: r.model === null || r.model === undefined ? null : String(r.model),
    inputTokens:
      r.input_tokens === null || r.input_tokens === undefined ? null : Number(r.input_tokens),
    outputTokens:
      r.output_tokens === null || r.output_tokens === undefined ? null : Number(r.output_tokens),
    note: r.note === null || r.note === undefined ? null : String(r.note),
    createdAt: r.created_at as Date,
  }))
}
