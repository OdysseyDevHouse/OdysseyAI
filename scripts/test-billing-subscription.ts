// The subscription state machine, against the real control database.
//
// The pure signing is covered by test:payfast-subscription. What only shows up
// here is what happens when two things arrive at once: a replayed notification,
// two checkouts started together, an escalation job run twice. Those are the
// cases the previous system got wrong, and none of them are visible without a
// database that can actually enforce a unique key.
import { createHash } from 'node:crypto'
import { query, execute } from '../src/lib/db'
import { phpUrlEncode } from '../src/lib/payfast/signature'
import {
  startCheckoutAttempt,
  recordItnPayment,
  subscriptionForAccount,
  setAmount,
  markStatus,
  dueForEscalation,
  markEscalated,
  paymentsForAccount,
  type RecordItnInput,
} from '../src/lib/control/subscriptions'
import {
  createBillingCallbackToken,
  readBillingCallbackToken,
} from '../src/lib/billingCallbackToken'
import { createCallbackToken, readCallbackToken } from '../src/lib/callbackToken'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** Far outside any real account id, so a leak is obvious and cannot collide. */
const TEST_ACCOUNT_NAME = 'ZZ scratch (test-billing-subscription)'
let accountId = 0

const base = (over: Partial<RecordItnInput> = {}): RecordItnInput => ({
  accountId,
  pfPaymentId: 'pf-1',
  mPaymentId: null,
  pfToken: 'tok-abc',
  amountGross: 100,
  amountFee: 3.45,
  amountNet: 96.55,
  paymentStatus: 'COMPLETE',
  verified: true,
  rejectReason: null,
  billingDate: '2026-09-01',
  rawPayload: 'm_payment_id=x&amount_gross=100.00',
  sourceIp: '127.0.0.1',
  ...over,
})

async function setup() {
  await teardown()
  const res = await execute(
    `INSERT INTO cp2_billing_accounts (name, billing_email, status, billing_day)
     VALUES (?, 'scratch@example.test', 'active', 1)`,
    [TEST_ACCOUNT_NAME],
  )
  accountId = res.insertId
  await execute(
    `INSERT INTO cp2_billing_subscriptions (account_id, status) VALUES (?, 'none')`,
    [accountId],
  )
}

async function teardown() {
  // Payments and subscriptions cascade from the account, but delete explicitly
  // so a failed cascade cannot leave rows behind unnoticed.
  const rows = await query<{ id: number }>('SELECT id FROM cp2_billing_accounts WHERE name = ?', [
    TEST_ACCOUNT_NAME,
  ])
  for (const r of rows) {
    await execute('DELETE FROM cp2_billing_payments WHERE account_id = ?', [r.id])
    await execute('DELETE FROM cp2_billing_subscriptions WHERE account_id = ?', [r.id])
    await execute('DELETE FROM cp2_billing_account_sites WHERE account_id = ?', [r.id])
    await execute('DELETE FROM cp2_billing_accounts WHERE id = ?', [r.id])
  }
}

async function main() {
  await setup()

  try {
    // ── Cross-audience: the two token kinds cannot meet ──────────────────
    // A store token resolving on the billing route would settle a shopper's
    // basket against a platform subscription, and vice versa.
    const billingToken = await createBillingCallbackToken(accountId, 'ref-1')
    const storeToken = await createCallbackToken(1, 'ref-1')

    ok('a billing token reads back', (await readBillingCallbackToken(billingToken))?.accountId === accountId)
    ok('*** a STORE token is refused by the billing reader ***',
      (await readBillingCallbackToken(storeToken)) === null)
    ok('*** a BILLING token is refused by the store reader ***',
      (await readCallbackToken(billingToken)) === null)
    ok('a forged token is refused', (await readBillingCallbackToken('a.b.c')) === null)

    /* The renewal token must never expire — PayFast reuses the notify URL for
       every collection, so an expiry silently discards month 2 onward while
       the card keeps being debited. Assert there is no exp claim at all. */
    const claims = JSON.parse(Buffer.from(billingToken.split('.')[1], 'base64url').toString())
    ok('*** the billing token carries NO expiry ***', claims.exp === undefined, JSON.stringify(claims))

    // ── The checkout race ────────────────────────────────────────────────
    const zero = await startCheckoutAttempt(accountId, 0)
    ok('a zero-priced plan is refused', !zero.ok)

    const [a, b] = await Promise.all([
      startCheckoutAttempt(accountId, 500),
      startCheckoutAttempt(accountId, 500),
    ])
    ok('both concurrent checkouts succeed', a.ok && b.ok)
    /* The previous system let the second overwrite the first's reference, so
       the first payer's notification matched nothing and their money arrived
       with no subscription to attach it to. */
    ok('*** two concurrent checkouts share ONE reference ***',
      a.ok && b.ok && a.reference === b.reference,
      a.ok && b.ok ? `${a.reference} / ${b.reference}` : 'n/a')

    const afterStart = await subscriptionForAccount(accountId)
    ok('the row holds that reference', a.ok && afterStart?.mPaymentId === a.reference)
    ok('and is pending', afterStart?.status === 'pending')
    ok('with the amount recorded for the ITN to check', afterStart?.pendingAmount === 500)

    // ── Idempotency: the whole point ─────────────────────────────────────
    const first = await recordItnPayment(base({ pfPaymentId: 'pf-100', amountGross: 500 }))
    ok('the first notification activates', first.outcome === 'activated', first.outcome)

    const active = await subscriptionForAccount(accountId)
    ok('status is active', active?.status === 'active')
    ok('the token is stored', active?.pfToken === 'tok-abc')
    /* The amount comes from what WE recorded, never from the payload — a
       payload that vouches for its own amount vouches for nothing. */
    ok('the amount is the one we recorded', active?.amountIncl === 500)
    ok('the pending amount is cleared', active?.pendingAmount === null)
    ok('the anniversary is stamped', active?.anniversaryOn !== null)

    const beforeReplay = await subscriptionForAccount(accountId)
    const replay = await recordItnPayment(base({ pfPaymentId: 'pf-100', amountGross: 500 }))
    ok('*** a replayed notification is a duplicate ***', replay.outcome === 'duplicate', replay.outcome)

    const afterReplay = await subscriptionForAccount(accountId)
    /* Not merely "the outcome was right" — the row must be untouched. The old
       code re-stamped the payment date and pushed next_billing forward another
       month on every replay. */
    ok('*** and the subscription was never touched ***',
      JSON.stringify(beforeReplay) === JSON.stringify(afterReplay))

    const onePayment = await paymentsForAccount(accountId)
    ok('exactly one payment row exists', onePayment.length === 1, String(onePayment.length))

    // Concurrency: the guard has to be the database's, not a read-then-write.
    const [c, d] = await Promise.all([
      recordItnPayment(base({ pfPaymentId: 'pf-200' })),
      recordItnPayment(base({ pfPaymentId: 'pf-200' })),
    ])
    const outcomes = [c.outcome, d.outcome].sort()
    ok('*** two simultaneous identical notifications: one wins, one duplicates ***',
      outcomes.length === 2 && outcomes.includes('duplicate') && !outcomes.every((o) => o === 'duplicate'),
      outcomes.join('+'))
    ok('and only one row was written for it',
      (await paymentsForAccount(accountId)).filter((p) => p.pfPaymentId === 'pf-200').length === 1)

    // ── A rejected payload is still recorded ─────────────────────────────
    const rejected = await recordItnPayment(
      base({ pfPaymentId: 'pf-300', verified: false, rejectReason: 'signature mismatch' }),
    )
    ok('a failed verification is rejected', rejected.outcome === 'rejected')

    const withReject = (await paymentsForAccount(accountId)).find((p) => p.pfPaymentId === 'pf-300')
    /* The evidence when somebody says "I paid and nothing happened". Without
       the row there is nothing to look at but a rotated log line. */
    ok('*** but a row is still written, with the reason ***',
      Boolean(withReject) && withReject!.verified === false && withReject!.rejectReason === 'signature mismatch')

    const stillActive = await subscriptionForAccount(accountId)
    ok('and the mandate is untouched by it', stillActive?.status === 'active')

    // ── A bounced collection ─────────────────────────────────────────────
    await recordItnPayment(base({ pfPaymentId: 'pf-400', paymentStatus: 'FAILED' }))
    ok('a failed collection marks past_due', (await subscriptionForAccount(accountId))?.status === 'past_due')

    // A later success brings it back without opening a second mandate.
    const renewed = await recordItnPayment(base({ pfPaymentId: 'pf-500' }))
    ok('a later success renews rather than re-activating', renewed.outcome === 'renewed', renewed.outcome)
    ok('and it is active again', (await subscriptionForAccount(accountId))?.status === 'active')

    // ── A second mandate must be impossible ──────────────────────────────
    const again = await startCheckoutAttempt(accountId, 600)
    /* Two debit orders against one customer is the worst outcome available,
       and nothing on any screen would look wrong until their bank statement. */
    ok('*** an active account cannot start a second checkout ***', !again.ok, again.ok ? 'allowed!' : again.error)

    // ── Escalation ───────────────────────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10)
    const lastYear = new Date(`${today}T00:00:00Z`)
    lastYear.setUTCFullYear(lastYear.getUTCFullYear() - 1)
    const anniversary = lastYear.toISOString().slice(0, 10)

    await execute(
      `UPDATE cp2_billing_subscriptions
          SET escalation_percent = 10, anniversary_on = ?, last_escalated_on = NULL, amount_incl = 500
        WHERE account_id = ?`,
      [anniversary, accountId],
    )

    const due = await dueForEscalation(today)
    ok('an account on its anniversary is due', due.some((s) => s.accountId === accountId), String(due.length))

    const claimed = await markEscalated(due.find((s) => s.accountId === accountId)!.id, 550, today)
    ok('the escalation is claimed', claimed)
    ok('the amount rose', (await subscriptionForAccount(accountId))?.amountIncl === 550)

    /* Run twice and the second run must escalate nobody. The old job applied
       the increase again — compounding a price rise by accident. */
    const dueAgain = await dueForEscalation(today)
    ok('*** a second run the same year finds nothing ***',
      !dueAgain.some((s) => s.accountId === accountId), String(dueAgain.length))

    const sub = await subscriptionForAccount(accountId)
    ok('  and claiming again is refused outright', !(await markEscalated(sub!.id, 605, today)))
    ok('  so the amount did not move', (await subscriptionForAccount(accountId))?.amountIncl === 550)

    // Not on the anniversary: not due, however overdue it looks.
    const tomorrow = new Date(`${today}T00:00:00Z`)
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    await execute('UPDATE cp2_billing_subscriptions SET last_escalated_on = NULL WHERE account_id = ?', [accountId])
    const notToday = await dueForEscalation(tomorrow.toISOString().slice(0, 10))
    ok('*** an account whose anniversary is not today is skipped ***',
      !notToday.some((s) => s.accountId === accountId))

    // Escalation off by default — a feature that quietly raises prices on
    // deploy is not acceptable.
    await execute('UPDATE cp2_billing_subscriptions SET escalation_percent = 0 WHERE account_id = ?', [accountId])
    ok('zero percent is never due', !(await dueForEscalation(today)).some((s) => s.accountId === accountId))

    // ── The amount sync flag ─────────────────────────────────────────────
    await setAmount(accountId, 777)
    const resynced = await subscriptionForAccount(accountId)
    ok('setting the amount clears synced_at for reconciliation',
      resynced?.amountIncl === 777 && resynced?.syncedAt === null)

    // ── Cancellation ─────────────────────────────────────────────────────
    await markStatus(accountId, 'cancelled', 'testing')
    ok('cancelling records the status', (await subscriptionForAccount(accountId))?.status === 'cancelled')
    const afterCancel = await startCheckoutAttempt(accountId, 500)
    ok('a cancelled account may subscribe again', afterCancel.ok)
  } finally {
    await teardown()
    const leaked = await query<{ c: number }>(
      'SELECT COUNT(*) c FROM cp2_billing_accounts WHERE name = ?',
      [TEST_ACCOUNT_NAME],
    )
    ok('scratch rows are cleaned up', Number(leaked[0]?.c) === 0, String(leaked[0]?.c))
  }

  console.log(fails ? `\n${fails} failure(s)` : '\nall subscription state checks passed')
  if (fails) process.exitCode = 1
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error('**FAIL**  suite threw', error)
    process.exit(1)
  })
