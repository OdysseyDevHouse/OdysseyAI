// The AI credits wallet: the ledger, and the top-up ITN route over real HTTP.
//
//   npm run dev        (in another terminal, on :4100)
//   npm run test:ai-credits
//
// Two halves. The first exercises the domain layer directly — balances,
// debits, and the replay behaviour that stops a retried notification crediting
// twice. The second posts genuinely signed payloads at the route, which is the
// only way to cover token resolution, the proxy letting an unauthenticated
// request through, and the 200-for-a-decision / 500-for-a-write-failure split.
//
// PayFast is not involved. Payloads are signed here with the same passphrase
// the app is configured with; the post-back is the one step that cannot be
// faked, so the route is run in sandbox with ALLOW_UNVERIFIED_ITN=1, which also
// skips the source-IP check. Whether PayFast ACCEPTS our checkout signature
// needs their sandbox; everything on this side of the wire is covered here.
import { createHash } from 'node:crypto'
import { query, queryOne, execute } from '../src/lib/db'
import { phpUrlEncode } from '../src/lib/payfast/signature'
import { createAiTopupToken } from '../src/lib/aiTopupToken'
import {
  balanceMicros,
  recordUsage,
  addCredit,
  startTopup,
  pendingByReference,
  settleTopup,
  recentEntries,
} from '../src/lib/aiCredits/ledger'
import {
  usageCostMicros,
  localToMicros,
  microsToLocal,
  formatMicros,
  isValidTopupAmount,
  topupPresets,
  FEATURE_ESTIMATE_MICROS,
} from '../src/lib/aiCredits/pricing'

const BASE = process.env.TEST_BASE ?? 'http://localhost:4100'
const PASSPHRASE = process.env.PAYFAST_PASSPHRASE ?? ''
const MERCHANT = process.env.PAYFAST_MERCHANT_ID ?? ''

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/* A REAL billing account, borrowed. cp2_ai_credit_ledger has a foreign key to
   it, so a fictional id cannot be inserted against — and an account with a real
   site attached is what the route's own lookups expect. Every row this suite
   writes is deleted in teardown; nothing belonging to the account is touched. */
let accountId = 0

/** Every reference and payment id this run created, so teardown is exact. */
const madeReferences: string[] = []

/* Unique per run. pf_payment_id is UNIQUE across the whole table, so a fixed
   prefix makes the suite collide with its own previous run the moment one
   crashes before teardown — which reads as a failure of the code rather than of
   the fixture. The prefix is still recognisable, so a crashed run's rows can be
   found and swept by hand. */
const PF_PREFIX = `pf-aicredit-${Date.now().toString(36)}-`

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
    pf_payment_id: `${PF_PREFIX}1`,
    payment_status: 'COMPLETE',
    item_name: 'Odyssey AI credits',
    amount_gross: '500.00',
    amount_fee: '-11.50',
    amount_net: '488.50',
    merchant_id: MERCHANT,
    ...over,
  }
}

async function post(token: string, body: string) {
  const res = await fetch(`${BASE}/api/billing/topup/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  return { status: res.status, text: await res.text() }
}

/** Start a top-up and remember it, so teardown can find it. */
async function newTopup(amountPay: number, currency = 'ZAR') {
  const reference = await startTopup({
    accountId,
    siteId: null,
    amountMicros: localToMicros(amountPay, currency),
    amountPay,
    payCurrency: currency,
  })
  madeReferences.push(reference)
  return reference
}

async function setup() {
  const row = await queryOne<{ id: number }>(
    `SELECT ba.id
       FROM cp2_billing_accounts ba
       JOIN cp2_billing_account_sites bas ON bas.account_id = ba.id
      ORDER BY ba.id
      LIMIT 1`,
  )
  if (!row) throw new Error('No billing account with a site attached — nothing to test against.')
  accountId = Number(row.id)

  /* The balance is a SUM over every row this account has, including any real
     ones. Every assertion below is written as a DELTA against this, so the
     suite is correct on a fresh account and on one with history. */
  return balanceMicros(accountId)
}

async function teardown() {
  if (!accountId) return

  /* One placeholder per reference, built by hand.
     `execute()` prepares its statement, and a prepared statement does NOT
     expand an array into an IN list — it binds the whole array as one value,
     matches nothing, and deletes nothing. The first version of this teardown
     did exactly that and left a real credit behind on a real account; the
     closing-balance assertion at the end of main() is what caught it. */
  const marks = madeReferences.map(() => '?').join(',')

  if (madeReferences.length) {
    await execute(
      `DELETE FROM cp2_ai_credit_ledger WHERE account_id = ? AND reference IN (${marks})`,
      [accountId, ...madeReferences],
    )
    await execute(
      `DELETE FROM cp2_ai_topup_pending WHERE account_id = ? AND reference IN (${marks})`,
      [accountId, ...madeReferences],
    )
  }

  await execute(
    `DELETE FROM cp2_ai_credit_ledger WHERE account_id = ? AND note LIKE 'test:%'`,
    [accountId],
  )
  /* Usage rows carry no reference and no note, so they are identified by the
     model label this suite alone writes. */
  await execute(
    `DELETE FROM cp2_ai_credit_ledger WHERE account_id = ? AND model = 'test-model'`,
    [accountId],
  )
}

async function main() {
  const opening = await setup()
  console.log(`\nAccount ${accountId}, opening balance ${opening} micros\n`)

  /* ── Pricing, which is pure and needs no database ───────────────────────── */

  console.log('-- pricing --')

  // 1000 in + 1000 out on opus 5 = (1000*5 + 1000*25)/1e6 USD = $0.03 = 30000
  // micros, times the markup of 3.
  const cost = usageCostMicros({ input_tokens: 1000, output_tokens: 1000 })
  ok('a known usage prices exactly', cost === 90_000, `got ${cost}`)

  ok(
    'a tiny call never rounds to free',
    usageCostMicros({ input_tokens: 1, output_tokens: 0 }) > 0,
    'rounding must be up',
  )

  ok('an empty usage costs nothing', usageCostMicros({}) === 0)

  ok(
    'cache reads are cheaper than fresh input',
    usageCostMicros({ cache_read_input_tokens: 1000 }) <
      usageCostMicros({ input_tokens: 1000 }),
  )

  ok(
    'cache writes cost more than fresh input',
    usageCostMicros({ cache_creation_input_tokens: 1000 }) >
      usageCostMicros({ input_tokens: 1000 }),
  )

  const roundTrip = microsToLocal(localToMicros(500, 'ZAR'), 'ZAR')
  ok('currency survives a round trip', Math.abs(roundTrip - 500) < 0.01, `got ${roundTrip}`)

  ok('an unknown currency falls back rather than throwing', formatMicros(1_000_000, 'XYZ').length > 0)

  ok('a preset is accepted', isValidTopupAmount(topupPresets('ZAR')[0], 'ZAR'))
  ok('an arbitrary amount is refused', !isValidTopupAmount(7, 'ZAR'))
  ok('a tampered decimal is refused', !isValidTopupAmount(499.99, 'ZAR'))

  /* The gate has to cover what the call actually costs, or a shop passes it
     holding a fraction of the bill. Checked against a realistic call for each
     feature, not a token one — this assertion is what caught estimates
     inherited from an older, cheaper model. */
  const typicalScan = usageCostMicros({ input_tokens: 20_000, output_tokens: 6_000 })
  ok(
    'doc_scan is estimated above a typical scan',
    FEATURE_ESTIMATE_MICROS.doc_scan >= typicalScan,
    `estimate ${FEATURE_ESTIMATE_MICROS.doc_scan}, typical ${typicalScan}`,
  )

  /* askReport makes TWO calls, capped at 2000 and 4000 output tokens. A
     per-call estimate would pass a shop on the first and overdraw on the
     second. */
  const bothCalls =
    usageCostMicros({ input_tokens: 3_000, output_tokens: 2_000 }) +
    usageCostMicros({ input_tokens: 3_000, output_tokens: 4_000 })
  ok(
    'ask_report is estimated for BOTH of its calls at their ceilings',
    FEATURE_ESTIMATE_MICROS.ask_report >= bothCalls,
    `estimate ${FEATURE_ESTIMATE_MICROS.ask_report}, both calls ${bothCalls}`,
  )

  /* ── The ledger ─────────────────────────────────────────────────────────── */

  console.log('\n-- ledger --')

  await addCredit({ accountId, amountMicros: 1_000_000, note: 'test: opening credit' })
  ok(
    'a manual credit raises the balance',
    (await balanceMicros(accountId)) === opening + 1_000_000,
  )

  const debited = await recordUsage({
    accountId,
    siteId: null,
    userId: null,
    feature: 'doc_scan',
    model: 'test-model',
    usage: { input_tokens: 1000, output_tokens: 1000 },
  })
  ok('recordUsage returns what it charged', debited === 90_000, `got ${debited}`)
  ok(
    'usage lowers the balance by exactly that',
    (await balanceMicros(accountId)) === opening + 1_000_000 - 90_000,
  )

  await addCredit({ accountId, amountMicros: -500_000, note: 'test: clawback', kind: 'adjustment' })
  ok(
    'an adjustment may be negative',
    (await balanceMicros(accountId)) === opening + 1_000_000 - 90_000 - 500_000,
  )

  await addCredit({ accountId, amountMicros: -250_000, note: 'test: not a debit' })
  ok(
    'a manual credit can never subtract',
    (await balanceMicros(accountId)) === opening + 1_000_000 - 90_000 - 500_000 + 250_000,
    'a negative manual amount must be clamped positive',
  )

  const history = await recentEntries(accountId, 10)
  ok('history returns newest first', history.length >= 4 && history[0].id > history[1].id)

  /* ── Settling, and the replay guard ─────────────────────────────────────── */

  console.log('\n-- settlement --')

  const before = await balanceMicros(accountId)
  const ref1 = await newTopup(500)
  const pending1 = await pendingByReference(ref1)
  ok('a pending top-up is found by its reference', pending1 !== null)
  ok('a pending top-up is not yet in the balance', (await balanceMicros(accountId)) === before)

  const first = await settleTopup({
    pending: pending1!,
    paymentStatus: 'COMPLETE',
    pfPaymentId: `${PF_PREFIX}settle`,
    rawPayload: 'test',
    verified: true,
  })
  ok('a verified COMPLETE credits', first === 'credited', `got ${first}`)
  ok(
    'the credit is the amount recorded at checkout',
    (await balanceMicros(accountId)) === before + localToMicros(500, 'ZAR'),
  )

  const replay = await settleTopup({
    pending: pending1!,
    paymentStatus: 'COMPLETE',
    pfPaymentId: `${PF_PREFIX}settle`,
    rawPayload: 'test',
    verified: true,
  })
  ok('a replay is recognised', replay === 'duplicate', `got ${replay}`)
  ok(
    'A REPLAY DOES NOT CREDIT TWICE',
    (await balanceMicros(accountId)) === before + localToMicros(500, 'ZAR'),
  )

  const ref2 = await newTopup(250)
  const failed = await settleTopup({
    pending: (await pendingByReference(ref2))!,
    paymentStatus: 'FAILED',
    pfPaymentId: `${PF_PREFIX}failed`,
    rawPayload: 'test',
    verified: true,
  })
  const afterFailed = await balanceMicros(accountId)
  ok('a failed payment says so', failed === 'failed', `got ${failed}`)
  ok('a failed payment credits nothing', afterFailed === before + localToMicros(500, 'ZAR'))

  /* A retried FAILED notification. It must return a decision rather than
     throwing on the unique key: a throw makes the route answer 500, PayFast
     treats that as undelivered, and it retries for ever on a payment that
     already failed and will collide every single time. */
  const ref2b = await newTopup(250)
  let threw = false
  try {
    await settleTopup({
      pending: (await pendingByReference(ref2b))!,
      paymentStatus: 'FAILED',
      pfPaymentId: `${PF_PREFIX}failed`,
      rawPayload: 'test',
      verified: true,
    })
  } catch {
    threw = true
  }
  ok('A RETRIED FAILURE DOES NOT THROW', !threw, 'a throw becomes an endless PayFast retry')

  const ref3 = await newTopup(250)
  const rejected = await settleTopup({
    pending: (await pendingByReference(ref3))!,
    paymentStatus: 'COMPLETE',
    pfPaymentId: `${PF_PREFIX}unverified`,
    rawPayload: 'test',
    verified: false,
  })
  ok('an unverified payload is rejected', rejected === 'rejected', `got ${rejected}`)
  ok(
    'AN UNVERIFIED COMPLETE CREDITS NOTHING',
    (await balanceMicros(accountId)) === afterFailed,
    'a forged payload claiming COMPLETE must not pay',
  )

  /* ── The route ──────────────────────────────────────────────────────────── */

  console.log('\n-- route --')

  let reachable = true
  try {
    const probe = await fetch(`${BASE}/api/billing/topup/probe`, { method: 'GET' })
    ok('the route is public (GET is not a redirect to login)', probe.status === 200, `got ${probe.status}`)
  } catch {
    reachable = false
    console.log('SKIP  route tests — no dev server on ' + BASE)
  }

  if (reachable) {
    const routeBefore = await balanceMicros(accountId)
    const ref4 = await newTopup(500)
    const token = await createAiTopupToken(accountId, ref4)

    const bad = await post('not-a-token', signedBody(itnFields({ m_payment_id: ref4 })))
    ok('an unreadable token is acknowledged, not retried', bad.status === 200)
    ok('an unreadable token credits nothing', (await balanceMicros(accountId)) === routeBefore)

    const noId = await post(
      token,
      signedBody(itnFields({ m_payment_id: ref4, pf_payment_id: '' })),
    )
    ok('a payload with no pf_payment_id is refused', noId.status === 200)
    ok('...and credits nothing', (await balanceMicros(accountId)) === routeBefore)

    const wrongAmount = await post(
      token,
      signedBody(itnFields({ m_payment_id: ref4, pf_payment_id: `${PF_PREFIX}wrong`, amount_gross: '5.00' })),
    )
    ok('a payload claiming the wrong amount is acknowledged', wrongAmount.status === 200)
    ok(
      'A WRONG AMOUNT CREDITS NOTHING',
      (await balanceMicros(accountId)) === routeBefore,
      'the charge we recorded is what counts, never the payload',
    )

    /* The amount check consumed that reference by marking it failed, so the
       happy path needs a fresh one. */
    const ref5 = await newTopup(500)
    const token5 = await createAiTopupToken(accountId, ref5)
    const good = await post(
      token5,
      signedBody(itnFields({ m_payment_id: ref5, pf_payment_id: `${PF_PREFIX}good` })),
    )
    ok('a good payload is acknowledged', good.status === 200, `got ${good.status}`)
    ok(
      'A GOOD PAYLOAD CREDITS THE WALLET',
      (await balanceMicros(accountId)) === routeBefore + localToMicros(500, 'ZAR'),
    )

    const afterGood = await balanceMicros(accountId)
    const again = await post(
      token5,
      signedBody(itnFields({ m_payment_id: ref5, pf_payment_id: `${PF_PREFIX}good` })),
    )
    ok('a retried notification is acknowledged', again.status === 200)
    ok(
      'A RETRIED NOTIFICATION DOES NOT CREDIT TWICE',
      (await balanceMicros(accountId)) === afterGood,
      'this is the single most expensive bug this feature could have',
    )

    /* A token for one account paired with another account's reference. The
       token is valid and the signature is valid; only the pairing is wrong. */
    const ref6 = await newTopup(250)
    const mismatched = await createAiTopupToken(accountId + 99_999, ref6)
    const crossed = await post(
      mismatched,
      signedBody(itnFields({ m_payment_id: ref6, pf_payment_id: `${PF_PREFIX}crossed` })),
    )
    ok('a token naming another account is acknowledged', crossed.status === 200)
    ok(
      'A MISMATCHED TOKEN CREDITS NOTHING',
      (await balanceMicros(accountId)) === afterGood,
    )
  }

  await teardown()

  const closing = await balanceMicros(accountId)
  ok(
    'teardown left the account as it found it',
    closing === opening,
    `opened ${opening}, closed ${closing}`,
  )

  console.log(fails === 0 ? '\nAll good.\n' : `\n${fails} FAILED\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error(err)
  try {
    await teardown()
  } catch {
    /* Report the original failure, not a cleanup failure on top of it. */
  }
  process.exit(1)
})
