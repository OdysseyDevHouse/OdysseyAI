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
  MODEL_LABEL,
} from '../src/lib/aiCredits/pricing'
import { assertBalance, meterCall, isAiCreditsError } from '../src/lib/aiCredits/meter'

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

/* When this run started, so the usage sweep in teardown cannot reach a real
   row written before it. DATETIME is read back as UTC by this pool, so the
   comparison value is built the same way. */
const startedAt = new Date().toISOString().slice(0, 19).replace('T', ' ')

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
  /* Usage rows carry no reference and no note, so they go by model label.
     'test-model' is what recordUsage is called with directly; MODEL_LABEL is
     what meterCall writes, and the gate checks below drive it with a stub. Both
     are swept, bounded to rows this run created. */
  await execute(
    `DELETE FROM cp2_ai_credit_ledger
      WHERE account_id = ? AND model IN ('test-model', ?) AND created_at >= ?`,
    [accountId, MODEL_LABEL, startedAt],
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
  let retriedOutcome = ''
  try {
    retriedOutcome = await settleTopup({
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
  ok(
    '...and reports it as a duplicate',
    retriedOutcome === 'duplicate',
    `got ${retriedOutcome}`,
  )

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

  /* ── The row must survive an answer that is not final ────────────────────
     Both of these are the same bug in two costumes: an outcome that is NOT
     terminal must leave the row settleable, or the retry that carries the real
     answer arrives to find the checkout already spent. */

  ok(
    'an unverified payload leaves the checkout OPEN',
    (await pendingByReference(ref3))!.status === 'pending',
    'verifyItn returns false on a post-back NETWORK failure — the retry must still settle it',
  )

  const recovered = await settleTopup({
    pending: (await pendingByReference(ref3))!,
    paymentStatus: 'COMPLETE',
    pfPaymentId: `${PF_PREFIX}unverified`,
    rawPayload: 'test',
    verified: true,
  })
  ok(
    'THE RETRY AFTER A FAILED POST-BACK STILL CREDITS',
    recovered === 'credited',
    `got ${recovered} — money collected and never delivered if this fails`,
  )
  const afterRecovered = await balanceMicros(accountId)
  ok(
    '...for the full amount',
    afterRecovered === afterFailed + localToMicros(250, 'ZAR'),
  )

  /* An EFT that has not cleared. PayFast sends PENDING now and COMPLETE later,
     both for the same reference. */
  const ref3b = await newTopup(250)
  const stillClearing = await settleTopup({
    pending: (await pendingByReference(ref3b))!,
    paymentStatus: 'PENDING',
    pfPaymentId: `${PF_PREFIX}clearing`,
    rawPayload: 'test',
    verified: true,
  })
  ok('a payment still clearing says so', stillClearing === 'pending', `got ${stillClearing}`)
  ok('...and credits nothing yet', (await balanceMicros(accountId)) === afterRecovered)
  ok(
    '...and leaves the checkout OPEN',
    (await pendingByReference(ref3b))!.status === 'pending',
  )

  const cleared = await settleTopup({
    pending: (await pendingByReference(ref3b))!,
    paymentStatus: 'COMPLETE',
    pfPaymentId: `${PF_PREFIX}clearing`,
    rawPayload: 'test',
    verified: true,
  })
  ok('THE LATER COMPLETE SETTLES IT', cleared === 'credited', `got ${cleared}`)
  ok(
    '...for the full amount',
    (await balanceMicros(accountId)) === afterRecovered + localToMicros(250, 'ZAR'),
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
    /* An amount mismatch reaches settleTopup as verified:false, the same shape
       a failed post-back has — so it leaves the checkout open too. That is the
       right way round: a wrong amount credits nothing either way, and the cost
       of being wrong is a genuine payment nobody can settle. */
    ok(
      '...and leaves the checkout open rather than burning it',
      (await pendingByReference(ref4))!.status === 'pending',
    )

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

  /* ── The gate ───────────────────────────────────────────────────────────── */

  console.log('\n-- the gate --')

  /* An empty wallet must refuse BOTH features. Asserted against the live
     estimates rather than a literal, so tuning a price cannot quietly make this
     pass for the wrong reason. */
  const siteRow = await queryOne<{ site_id: number }>(
    `SELECT site_id FROM cp2_billing_account_sites WHERE account_id = ? LIMIT 1`,
    [accountId],
  )
  const siteId = Number(siteRow?.site_id ?? 0)

  const spent = await balanceMicros(accountId)
  if (spent > 0) {
    await addCredit({
      accountId,
      amountMicros: -spent,
      note: 'test: empty the wallet',
      kind: 'adjustment',
    })
  }
  ok('the wallet is empty for the gate checks', (await balanceMicros(accountId)) === 0)

  for (const feature of ['doc_scan', 'ask_report'] as const) {
    let refusedWith = ''
    try {
      await assertBalance(siteId, feature)
    } catch (e) {
      refusedWith = isAiCreditsError(e) ? e.reason : 'wrong error type'
    }
    ok(
      `an empty wallet refuses ${feature}`,
      refusedWith === 'insufficient',
      `got ${refusedWith || 'NO REFUSAL — the call would have run unpaid'}`,
    )
  }

  /* Enough for one, not the other. The gate is per feature, so a shop with a
     little credit can still ask a question while a scan waits. */
  await addCredit({
    accountId,
    amountMicros: FEATURE_ESTIMATE_MICROS.ask_report,
    note: 'test: enough for a question only',
  })

  let askTicket: Awaited<ReturnType<typeof assertBalance>> | null = null
  try {
    askTicket = await assertBalance(siteId, 'ask_report')
  } catch {
    askTicket = null
  }
  ok('a wallet holding the smaller estimate allows ask_report', askTicket !== null)
  ok('...and the ticket names the account', askTicket?.accountId === accountId)

  let scanRefused = ''
  try {
    await assertBalance(siteId, 'doc_scan')
  } catch (e) {
    scanRefused = isAiCreditsError(e) ? e.reason : 'wrong error type'
  }
  ok('...but still refuses the dearer doc_scan', scanRefused === 'insufficient', `got ${scanRefused}`)

  /* meterCall charges what the response reports, not the estimate. Driven with
     a stub rather than a real Claude call: this is testing the meter, and a
     live call would make the assertion depend on how many tokens a model
     happened to use. */
  if (askTicket) {
    const beforeMeter = await balanceMicros(accountId)
    const stub = { usage: { input_tokens: 1000, output_tokens: 1000 } }
    const returned = await meterCall(askTicket, null, async () => stub)
    ok('meterCall returns the response untouched', returned === stub)
    ok(
      'meterCall debits what the RESPONSE used, not the estimate',
      (await balanceMicros(accountId)) === beforeMeter - 90_000,
      `expected a 90000 debit, balance moved to ${await balanceMicros(accountId)}`,
    )
  }

  /* A call that overruns its estimate takes the wallet negative rather than
     being silently discounted. The ledger records what happened. */
  if (askTicket) {
    const beforeOverrun = await balanceMicros(accountId)
    await meterCall(askTicket, null, async () => ({
      usage: { input_tokens: 500_000, output_tokens: 100_000 },
    }))
    const afterOverrun = await balanceMicros(accountId)
    ok('a call may overdraw the wallet', afterOverrun < 0, `balance ${afterOverrun}`)
    ok('...by exactly what it cost', afterOverrun < beforeOverrun)

    let refusedAfter = ''
    try {
      await assertBalance(siteId, 'ask_report')
    } catch (e) {
      refusedAfter = isAiCreditsError(e) ? e.reason : 'wrong'
    }
    ok('...and the NEXT call is then refused', refusedAfter === 'insufficient')
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
