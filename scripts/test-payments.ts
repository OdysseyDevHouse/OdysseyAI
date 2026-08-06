/**
 * Payments, against a live site database.
 *
 * This is money, and the callback endpoint is reachable by anyone on the
 * internet, so the checks here are adversarial. Each corresponds to a way a
 * store could otherwise be defrauded or its books corrupted:
 *
 *   a forged callback marking an order paid;
 *   a replayed callback invoicing one payment twice;
 *   a payment for R1 settling an order for R1 000;
 *   a callback for store A settling store B's order;
 *   credentials sitting in the database in plaintext.
 *
 *   npm run test:payments
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { buildCheckoutSignature, verifyItnSignature, phpUrlEncode } from '../src/lib/payfast/signature'
import { buildCheckoutForm } from '../src/lib/payfast/checkout'
import { verifyItn, parseItnBody } from '../src/lib/payfast/itn'
import { createCallbackToken, readCallbackToken } from '../src/lib/callbackToken'
import {
  canTakePayments,
  createIntent,
  getGateway,
  getIntent,
  saveGateway,
  settleIntent,
} from '../src/lib/site/payments'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const TAG = '__TEST_PAY__'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const MERCHANT = '10000100'
const PASSPHRASE = 'test-passphrase-do-not-use'

/** Build a signed ITN body exactly as PayFast would. */
function signedItn(fields: Record<string, string>, passphrase = PASSPHRASE): string {
  const entries = Object.entries(fields)
  const parts = entries
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${phpUrlEncode(v.trim())}`)
  const withPass = passphrase ? [...parts, `passphrase=${phpUrlEncode(passphrase)}`] : parts
  const signature = require('node:crypto').createHash('md5').update(withPass.join('&')).digest('hex')
  return [...entries.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%20/g, '+')}`), `signature=${signature}`].join('&')
}

/** Verification with the network steps stubbed, so branches are reachable. */
const passingDeps = { postBack: async () => true, resolveIps: async () => new Set<string>() }

async function cleanup() {
  await siteExecute(SITE, `DELETE FROM payment_intents WHERE reference LIKE ?`, [`%${TAG}%`])
  const orders = await siteQuery<{ id: number; document_id: number | null }>(
    SITE,
    `SELECT id, document_id FROM online_orders WHERE contact_name = ?`,
    [TAG],
  )
  for (const o of orders) {
    await siteExecute(SITE, `UPDATE online_orders SET document_id = NULL WHERE id = ?`, [o.id])
    if (o.document_id) {
      await siteExecute(SITE, `DELETE FROM sales_documents WHERE id = ? AND status = 'draft'`, [o.document_id])
    }
    await siteExecute(SITE, `DELETE FROM online_order_lines WHERE order_id = ?`, [o.id])
  }
  await siteExecute(SITE, `DELETE FROM online_orders WHERE contact_name = ?`, [TAG])
}

async function main() {
  await cleanup()
  const gatewayBefore = await getGateway(SITE)

  /* ── Signatures ───────────────────────────────────────────────────────── */
  console.log('\n— Signing —')
  // PHP's urlencode, not encodeURIComponent. A shop called "Joe's Butchery" is
  // exactly the case that breaks if this is wrong.
  ok("space encodes as '+'", phpUrlEncode('a b') === 'a+b', phpUrlEncode('a b'))
  ok("apostrophe is escaped", phpUrlEncode("Joe's") === 'Joe%27s', phpUrlEncode("Joe's"))
  ok('tilde is escaped', phpUrlEncode('~') === '%7E')

  const sigA = buildCheckoutSignature({ merchant_id: MERCHANT, amount: '100.00' }, PASSPHRASE)
  const sigB = buildCheckoutSignature({ merchant_id: MERCHANT, amount: '100.00' }, PASSPHRASE)
  ok('the same fields sign the same way', sigA === sigB)
  ok(
    'a different amount signs differently',
    sigA !== buildCheckoutSignature({ merchant_id: MERCHANT, amount: '1.00' }, PASSPHRASE),
  )
  ok(
    'a different passphrase signs differently',
    sigA !== buildCheckoutSignature({ merchant_id: MERCHANT, amount: '100.00' }, 'other'),
  )

  const body = signedItn({ m_payment_id: 'REF1', amount_gross: '100.00', payment_status: 'COMPLETE' })
  const entries = parseItnBody(body)
  const received = Object.fromEntries(entries).signature
  ok('a genuine ITN signature verifies', verifyItnSignature(entries.filter(([k]) => k !== 'signature'), received, PASSPHRASE))
  ok(
    'the wrong passphrase does NOT verify',
    !verifyItnSignature(entries.filter(([k]) => k !== 'signature'), received, 'wrong'),
  )

  /* ── The checkout form ────────────────────────────────────────────────── */
  console.log('\n— The checkout form —')
  const form = buildCheckoutForm({
    merchantId: MERCHANT,
    merchantKey: 'mkey',
    passphrase: PASSPHRASE,
    sandbox: true,
    reference: 'REF-XYZ',
    amountIncl: 123.4,
    itemName: 'Order WEB-00001',
    returnUrl: 'https://example.com/done',
    cancelUrl: 'https://example.com/cancel',
    notifyUrl: 'https://example.com/notify',
    buyerName: 'Thandi Mokoena',
    buyerEmail: 'thandi@example.com',
  })
  ok('it posts to the sandbox when in test mode', form.action.includes('sandbox.payfast'))
  ok('the amount is always 2dp', form.fields.amount === '123.40', form.fields.amount)
  ok('our reference rides along', form.fields.m_payment_id === 'REF-XYZ')
  ok('the name is split', form.fields.name_first === 'Thandi' && form.fields.name_last === 'Mokoena')
  ok('it is signed', typeof form.fields.signature === 'string' && form.fields.signature.length === 32)
  // The passphrase authenticates us to PayFast. In the form it would be public.
  ok('the PASSPHRASE is never in the form', !JSON.stringify(form.fields).includes(PASSPHRASE))

  /* ── The callback token ───────────────────────────────────────────────── */
  console.log('\n— The callback token —')
  const token = await createCallbackToken(SITE, 'REF-XYZ')
  const claim = await readCallbackToken(token)
  ok('it names the store and the payment', claim?.siteId === SITE && claim?.reference === 'REF-XYZ')
  ok('a forged token is rejected', (await readCallbackToken('a.b.c')) === null)
  // Binding BOTH is what stops a token for one store being aimed at another.
  const otherStore = await createCallbackToken(SITE + 1, 'REF-XYZ')
  ok('a token for another store resolves to that store, not this one', (await readCallbackToken(otherStore))?.siteId === SITE + 1)

  /* ── Credentials at rest ──────────────────────────────────────────────── */
  console.log('\n— Credentials at rest —')
  const saved = await saveGateway(
    SITE,
    { isActive: true, isSandbox: true, merchantId: MERCHANT, merchantKey: 'super-secret-key', passphrase: PASSPHRASE },
    'test',
  )
  ok('the gateway saves', saved.ok, saved.ok ? '' : saved.error)

  const stored = await siteQueryOne<Record<string, unknown>>(
    SITE,
    `SELECT merchant_id, merchant_key, passphrase FROM payment_gateways WHERE provider = 'payfast'`,
  )
  ok('the merchant key is NOT stored in plaintext', !String(stored?.merchant_key).includes('super-secret-key'))
  ok('the passphrase is NOT stored in plaintext', !String(stored?.passphrase).includes(PASSPHRASE))
  ok('the merchant id IS plaintext (it is public)', String(stored?.merchant_id) === MERCHANT)

  const readBack = await getGateway(SITE)
  ok('they decrypt back correctly', readBack?.merchantKey === 'super-secret-key' && readBack.passphrase === PASSPHRASE)
  ok('the store can now take payments', await canTakePayments(SITE))

  ok(
    'a non-numeric merchant id is refused',
    !(await saveGateway(SITE, { isActive: true, isSandbox: true, merchantId: 'abc', merchantKey: 'k', passphrase: '' }, 'test')).ok,
  )

  /* ── Verification ─────────────────────────────────────────────────────── */
  console.log('\n— Verifying a callback —')
  const config = { merchantId: MERCHANT, passphrase: PASSPHRASE, sandbox: true }
  const good = signedItn({
    m_payment_id: 'REF-A', pf_payment_id: 'PF1', payment_status: 'COMPLETE',
    amount_gross: '100.00', merchant_id: MERCHANT,
  })

  ok('a genuine callback verifies', (await verifyItn(good, null, config, 100, passingDeps)).valid)

  const forged = good.replace(/signature=[0-9a-f]+/, 'signature=' + '0'.repeat(32))
  ok('a forged signature is rejected', !(await verifyItn(forged, null, config, 100, passingDeps)).valid)

  // The classic attack: intercept and change the amount.
  const tampered = signedItn({
    m_payment_id: 'REF-A', pf_payment_id: 'PF1', payment_status: 'COMPLETE',
    amount_gross: '1.00', merchant_id: MERCHANT,
  })
  const amountResult = await verifyItn(tampered, null, config, 100, passingDeps)
  ok('an amount that differs from ours is rejected', !amountResult.valid, amountResult.valid ? '' : amountResult.reason)

  const wrongMerchant = signedItn({
    m_payment_id: 'REF-A', payment_status: 'COMPLETE', amount_gross: '100.00', merchant_id: '99999999',
  })
  ok('a payment for another merchant is rejected', !(await verifyItn(wrongMerchant, null, config, 100, passingDeps)).valid)

  ok(
    'a callback PayFast will not confirm is rejected',
    !(await verifyItn(good, null, config, 100, { ...passingDeps, postBack: async () => false })).valid,
  )

  ok(
    'in LIVE mode a non-PayFast source IP is rejected',
    !(await verifyItn(good, '203.0.113.7', { ...config, sandbox: false }, 100, {
      postBack: async () => true,
      resolveIps: async () => new Set(['197.97.145.144']),
    })).valid,
  )

  /* ── Intents and idempotency ──────────────────────────────────────────── */
  console.log('\n— Settlement is idempotent —')
  const order = await siteExecute(
    SITE,
    `INSERT INTO online_orders (order_number, status_id, fulfilment, contact_name, total_incl)
     SELECT ?, id, 'collect', ?, 250 FROM online_order_statuses WHERE role = 'new' LIMIT 1`,
    [`${TAG}-1`, TAG],
  )
  const intent = await createIntent(SITE, { targetId: order.insertId, amountIncl: 250 })

  ok('a reference is unguessable', intent.reference.length > 20, intent.reference)
  ok('the expected amount is recorded up front', intent.amountIncl === 250)
  ok('it starts pending', intent.status === 'pending')

  const first = await settleIntent(SITE, intent.reference, { paid: true, providerRef: 'PF-1' })
  ok('the first callback settles it', first.outcome === 'settled', first.outcome)

  // THE one that matters: a gateway retry must not pay for the order twice.
  const second = await settleIntent(SITE, intent.reference, { paid: true, providerRef: 'PF-1' })
  ok('a replayed callback does NOT settle again', second.outcome === 'already_settled', second.outcome)

  const third = await settleIntent(SITE, intent.reference, { paid: false, failureReason: 'late failure' })
  ok('a later contradiction cannot un-pay it', third.outcome === 'already_settled')

  const finalIntent = await getIntent(SITE, intent.reference)
  ok('it stayed paid', finalIntent?.status === 'paid')
  ok('the provider reference was kept', finalIntent?.providerRef === 'PF-1')

  ok(
    'an unknown reference settles nothing',
    (await settleIntent(SITE, 'no-such-reference', { paid: true })).outcome === 'unknown_reference',
  )

  console.log('\n— A failed payment —')
  const order2 = await siteExecute(
    SITE,
    `INSERT INTO online_orders (order_number, status_id, fulfilment, contact_name, total_incl)
     SELECT ?, id, 'collect', ?, 99 FROM online_order_statuses WHERE role = 'new' LIMIT 1`,
    [`${TAG}-2`, TAG],
  )
  const intent2 = await createIntent(SITE, { targetId: order2.insertId, amountIncl: 99 })
  const failed = await settleIntent(SITE, intent2.reference, { paid: false, failureReason: 'Card declined' })
  ok('a declined payment is recorded as failed', failed.outcome === 'failed')
  ok('with its reason', (await getIntent(SITE, intent2.reference))?.failureReason === 'Card declined')

  /* ── Restore ──────────────────────────────────────────────────────────── */
  console.log('\n— Cleanup —')
  await cleanup()
  if (gatewayBefore) {
    await saveGateway(
      SITE,
      {
        isActive: gatewayBefore.isActive,
        isSandbox: gatewayBefore.isSandbox,
        merchantId: gatewayBefore.merchantId,
        merchantKey: gatewayBefore.merchantKey,
        passphrase: gatewayBefore.passphrase,
      },
      gatewayBefore.updatedBy || 'test',
    )
  } else {
    await siteExecute(SITE, `DELETE FROM payment_gateways WHERE provider = 'payfast'`)
  }

  ok('gateway restored', (await getGateway(SITE))?.isActive === (gatewayBefore?.isActive ?? undefined) || gatewayBefore === null)
  ok('test intents removed', (await siteQuery(SITE, `SELECT id FROM payment_intents WHERE reference LIKE ?`, [`%${TAG}%`])).length === 0)
  ok('test orders removed', (await siteQuery(SITE, `SELECT id FROM online_orders WHERE contact_name = ?`, [TAG])).length === 0)

  console.log(`\n${fails === 0 ? 'All payment checks passed.' : `${fails} FAILED.`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await cleanup().catch(() => {})
  process.exit(1)
})
