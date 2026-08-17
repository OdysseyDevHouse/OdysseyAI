// The ITN route, over real HTTP, with genuinely signed payloads.
//
//   npm run dev        (in another terminal, on :4100)
//   npm run test:billing-itn-route
//
// What the other two suites cannot reach: the route itself. Token resolution,
// the proxy letting the request through unauthenticated, the 200/500 split,
// and — the point of the whole feature — that paying provisions the till
// licences somebody ordered.
//
// PayFast is not involved. The payloads are signed here with the same
// passphrase the app is configured with, and the post-back step is the one
// thing that cannot be faked, so this suite runs against a route configured
// for sandbox where verifyItn skips the source-IP check. Whether PayFast
// ACCEPTS our checkout signature still needs their sandbox; everything on this
// side of the wire is covered here.
import { createHash } from 'node:crypto'
import { query, execute } from '../src/lib/db'
import { phpUrlEncode } from '../src/lib/payfast/signature'
import { createBillingCallbackToken } from '../src/lib/billingCallbackToken'
import { setRequestedDevices, provisionDevices } from '../src/lib/control/modules'
import { startCheckoutAttempt, subscriptionForAccount } from '../src/lib/control/subscriptions'

const BASE = process.env.TEST_BASE ?? 'http://localhost:4100'
const PASSPHRASE = process.env.PAYFAST_PASSPHRASE ?? ''
const MERCHANT = process.env.PAYFAST_MERCHANT_ID ?? ''

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/* The real account that already owns SCRATCH_SITE. cp2_billing_account_sites
   is UNIQUE on site_id — a site is billed to exactly one account — so a
   throwaway account cannot borrow a real site. Its subscription row is
   captured and restored. */
let restoreSub: Record<string, unknown> | null = null
/* A REAL site, because sitesForAccount inner-joins cp2_sites — a fictional id
   is silently filtered out and the route then provisions nothing, which looks
   exactly like provisioning being broken. Its licence and order state are
   captured in setup() and put back in teardown(). */
const SCRATCH_SITE = 2
let restoreRequested = 1
let existingDeviceIds: number[] = []
let accountId = 0

/** A body signed exactly the way PayFast signs one: arrival order, passphrase last. */
function signedBody(fields: Record<string, string>): string {
  const entries = Object.entries(fields)
  const parts = entries
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${phpUrlEncode(v.trim())}`)
  if (PASSPHRASE) parts.push(`passphrase=${phpUrlEncode(PASSPHRASE)}`)
  const signature = createHash('md5').update(parts.join('&')).digest('hex')

  return [
    ...entries.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%20/g, '+')}`),
    `signature=${signature}`,
  ].join('&')
}

function itnFields(over: Record<string, string> = {}): Record<string, string> {
  return {
    m_payment_id: 'ref-x',
    pf_payment_id: 'pf-route-1',
    payment_status: 'COMPLETE',
    item_name: 'Odyssey subscription',
    amount_gross: '500.00',
    amount_fee: '-11.50',
    amount_net: '488.50',
    merchant_id: MERCHANT,
    token: 'tok-route-abc',
    billing_date: '2026-09-01',
    ...over,
  }
}

async function post(token: string, body: string) {
  const res = await fetch(`${BASE}/api/billing/payfast/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  return { status: res.status, text: await res.text() }
}

/**
 * Borrow the REAL account that owns this site, and put everything back after.
 *
 * A throwaway account cannot be used: `cp2_billing_account_sites` is UNIQUE on
 * site_id — a site is billed to exactly one account, which is the constraint
 * that stops a bill being counted twice — so the site cannot be lent out. And
 * the site itself has to be real, because `sitesForAccount` inner-joins
 * `cp2_sites`; a fictional id is silently dropped and the route then
 * provisions nothing, which looks exactly like provisioning being broken.
 *
 * So the suite works on live rows and restores them. Everything it touches is
 * captured first: the subscription row, the till order, and which licence ids
 * already existed.
 */
async function setup() {
  const owner = await query<{ account_id: number }>(
    'SELECT account_id FROM cp2_billing_account_sites WHERE site_id = ?',
    [SCRATCH_SITE],
  )
  if (!owner[0]) throw new Error(`site ${SCRATCH_SITE} is on no billing account`)
  accountId = Number(owner[0].account_id)

  const subs = await query<Record<string, unknown>>(
    'SELECT * FROM cp2_billing_subscriptions WHERE account_id = ?',
    [accountId],
  )
  restoreSub = subs[0] ?? null

  const order = await query<{ requested: number }>(
    'SELECT requested FROM cp2_site_device_orders WHERE site_id = ?',
    [SCRATCH_SITE],
  )
  restoreRequested = Number(order[0]?.requested ?? 1)

  existingDeviceIds = (
    await query<{ id: number }>('SELECT id FROM cp2_devices WHERE site_id = ?', [SCRATCH_SITE])
  ).map((d) => d.id)

  // Start from a clean mandate so the activation path is the one under test.
  await execute(
    `UPDATE cp2_billing_subscriptions
        SET status = 'none', pf_token = NULL, m_payment_id = NULL,
            pending_amount = NULL, pending_started_at = NULL, anniversary_on = NULL
      WHERE account_id = ?`,
    [accountId],
  )
}

async function teardown() {
  // Only this run's payment rows — identified by the pf- prefixes it uses.
  await execute(
    "DELETE FROM cp2_billing_payments WHERE account_id = ? AND pf_payment_id LIKE 'pf-%'",
    [accountId],
  )

  if (restoreSub) {
    await execute(
      `UPDATE cp2_billing_subscriptions
          SET status = ?, pf_token = ?, m_payment_id = ?, pending_amount = ?,
              pending_started_at = ?, amount_incl = ?, anniversary_on = ?, last_paid_on = ?
        WHERE account_id = ?`,
      [
        restoreSub.status,
        restoreSub.pf_token,
        restoreSub.m_payment_id,
        restoreSub.pending_amount,
        restoreSub.pending_started_at,
        restoreSub.amount_incl,
        restoreSub.anniversary_on,
        restoreSub.last_paid_on,
        accountId,
      ],
    )
  }

  /* Only rows whose ids did not exist before this run. Matching on a name or a
     null serial would eventually delete somebody's real licence. */
  if (existingDeviceIds.length > 0) {
    await execute(
      `DELETE FROM cp2_devices WHERE site_id = ? AND id NOT IN (${existingDeviceIds.map(() => '?').join(',')})`,
      [SCRATCH_SITE, ...existingDeviceIds],
    )
  }
  await execute(
    'UPDATE cp2_site_device_orders SET requested = ?, pending_from = NULL WHERE site_id = ?',
    [restoreRequested, SCRATCH_SITE],
  )
  await execute("DELETE FROM cp2_module_change_log WHERE site_id = ? AND actor_name = 'PayFast'", [
    SCRATCH_SITE,
  ])
}

async function main() {
  if (!PASSPHRASE) {
    console.log('**FAIL**  PAYFAST_PASSPHRASE is not set — run with --env-file=.env')
    process.exit(1)
  }

  // The server has to be up; without it every assertion below is vacuous.
  try {
    await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) })
  } catch {
    console.log(`**FAIL**  no server on ${BASE} — start it with: npm run dev`)
    process.exit(1)
  }

  /* The post-back to PayFast is the one step a test cannot simulate: the
     payload is correctly signed, but PayFast has never seen the payment and
     refuses to vouch for it — correctly. The server must therefore be running
     with ALLOW_UNVERIFIED_ITN=1, or every assertion past "the notification is
     acknowledged" silently checks nothing.

       ALLOW_UNVERIFIED_ITN=1 npm run dev

     Asserted rather than assumed: a suite that quietly proves nothing is worse
     than one that fails. */
  if (process.env.ALLOW_UNVERIFIED_ITN !== '1') {
    console.log('**FAIL**  the server must run with ALLOW_UNVERIFIED_ITN=1 for this suite')
    console.log('          (the PayFast post-back cannot be faked; see the route)')
    console.log('          restart it as:  ALLOW_UNVERIFIED_ITN=1 npm run dev')
    process.exit(1)
  }

  await setup()

  try {
    // ── The route is reachable without a session ─────────────────────────
    // If the proxy is not letting it through, PayFast gets a 307 to the login
    // page, retries a few times and gives up — silent, total loss of billing.
    const probe = await post('garbage-token', 'nothing=here')
    ok('*** the route answers without a session ***', probe.status === 200, `status ${probe.status}`)
    ok('an unreadable token is acknowledged, not errored', probe.text.trim() === 'OK')

    const getProbe = await fetch(`${BASE}/api/billing/payfast/x`)
    ok('a GET probe is answered', getProbe.status === 200)

    // ── A payload with no payment id cannot be keyed ─────────────────────
    const token = await createBillingCallbackToken(accountId, 'ref-x')
    const noId = await post(token, signedBody(itnFields({ pf_payment_id: '' })))
    ok('a payload with no pf_payment_id is refused', noId.status === 200)
    ok('  and nothing was recorded for it',
      (await query('SELECT id FROM cp2_billing_payments WHERE account_id = ?', [accountId])).length === 0)

    // ── A forged signature ───────────────────────────────────────────────
    const forged = `${signedBody(itnFields({ pf_payment_id: 'pf-forged' }))}x`
    await post(token, forged)
    const forgedRow = await query<{ verified: number; reject_reason: string }>(
      'SELECT verified, reject_reason FROM cp2_billing_payments WHERE pf_payment_id = ?',
      ['pf-forged'],
    )
    /* Recorded, not merely refused. This row is the evidence when somebody
       says they paid and nothing happened. */
    ok('*** a forged payload is still written down ***', forgedRow.length === 1)
    ok('  marked unverified, with the reason', forgedRow[0]?.verified === 0 && Boolean(forgedRow[0]?.reject_reason))
    ok('  and the mandate is untouched', (await subscriptionForAccount(accountId))?.status === 'none')

    // ── The real thing: pay, activate, provision ─────────────────────────
    const attempt = await startCheckoutAttempt(accountId, 500)
    ok('a checkout attempt is claimed', attempt.ok)
    if (!attempt.ok) throw new Error('cannot continue without an attempt')

    // Two tills ordered but unpaid — the state a real customer is in when the
    // money arrives.
    await setRequestedDevices(SCRATCH_SITE, existingDeviceIds.length + 1, { name: 'test', email: null })
    const beforeLicences = await query('SELECT id FROM cp2_devices WHERE site_id = ?', [SCRATCH_SITE])
    ok('the site starts at its known licence count', beforeLicences.length === existingDeviceIds.length, String(beforeLicences.length))

    const payToken = await createBillingCallbackToken(accountId, attempt.reference)
    const paid = await post(
      payToken,
      signedBody(itnFields({ m_payment_id: attempt.reference, pf_payment_id: 'pf-live-1' })),
    )
    ok('the notification is acknowledged', paid.status === 200)

    const activated = await subscriptionForAccount(accountId)
    ok('*** the mandate is active ***', activated?.status === 'active', activated?.status)
    ok('  the PayFast token is stored', activated?.pfToken === 'tok-route-abc')
    ok('  the amount is the one WE recorded, not the payload', activated?.amountIncl === 500)

    /* The whole point of the feature: paying turns an order into licences that
       may actually trade. Until now this needed somebody to press a button. */
    const afterLicences = await query<{ id: number; serial_number: string | null }>(
      'SELECT id, serial_number FROM cp2_devices WHERE site_id = ?',
      [SCRATCH_SITE],
    )
    ok(
      '*** paying provisioned the till licences ***',
      afterLicences.length === existingDeviceIds.length + 1,
      `${afterLicences.length} licences, expected ${existingDeviceIds.length + 1}`,
    )
    ok('  and they are unclaimed spots a till can take',
      afterLicences.filter((d) => !existingDeviceIds.includes(d.id)).every((d) => d.serial_number === null))

    const order = await query<{ pending_from: string | null }>(
      'SELECT pending_from FROM cp2_site_device_orders WHERE site_id = ?',
      [SCRATCH_SITE],
    )
    ok('  the order is no longer awaiting payment', order[0]?.pending_from === null)

    // ── A replay must change nothing ─────────────────────────────────────
    const before = JSON.stringify(await subscriptionForAccount(accountId))
    const replay = await post(
      payToken,
      signedBody(itnFields({ m_payment_id: attempt.reference, pf_payment_id: 'pf-live-1' })),
    )
    ok('a replay is acknowledged', replay.status === 200)
    ok('*** a replay leaves the mandate byte-identical ***',
      JSON.stringify(await subscriptionForAccount(accountId)) === before)
    ok('  and writes no second payment row',
      (await query('SELECT id FROM cp2_billing_payments WHERE pf_payment_id = ?', ['pf-live-1'])).length === 1)
    ok('  and provisions no extra licences',
      (await query('SELECT id FROM cp2_devices WHERE site_id = ?', [SCRATCH_SITE])).length === existingDeviceIds.length + 1)

    // ── A renewal ────────────────────────────────────────────────────────
    const renewal = await post(
      payToken,
      signedBody(itnFields({ m_payment_id: attempt.reference, pf_payment_id: 'pf-live-2' })),
    )
    ok('a later collection is accepted', renewal.status === 200)
    ok('  it stays active', (await subscriptionForAccount(accountId))?.status === 'active')
    ok('  and it is a second payment row',
      (await query('SELECT id FROM cp2_billing_payments WHERE account_id = ?', [accountId])).length >= 3)

    // ── A bounced collection ─────────────────────────────────────────────
    await post(
      payToken,
      signedBody(itnFields({ m_payment_id: attempt.reference, pf_payment_id: 'pf-fail-1', payment_status: 'FAILED' })),
    )
    ok('a failed collection marks past_due', (await subscriptionForAccount(accountId))?.status === 'past_due')

    // ── An account that is not ours ──────────────────────────────────────
    const otherToken = await createBillingCallbackToken(999_999, 'ref-y')
    const other = await post(otherToken, signedBody(itnFields({ pf_payment_id: 'pf-other' })))
    ok('a token for an unknown account is acknowledged', other.status === 200)
    ok('  and records nothing',
      (await query('SELECT id FROM cp2_billing_payments WHERE pf_payment_id = ?', ['pf-other'])).length === 0)
  } finally {
    await teardown()
    const leftover = await query(
      "SELECT id FROM cp2_billing_payments WHERE account_id = ? AND pf_payment_id LIKE 'pf-%'",
      [accountId],
    )
    ok('the payment rows this run wrote are cleaned up', leftover.length === 0, String(leftover.length))
  }

  console.log(fails ? `\n${fails} failure(s)` : '\nall ITN route checks passed')
  if (fails) process.exitCode = 1
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error('**FAIL**  suite threw', error)
    process.exit(1)
  })
