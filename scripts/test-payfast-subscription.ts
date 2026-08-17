// PayFast subscription signing, the management API, and the config loader.
//
// All pure — no network, no database. The parts that need a live gateway are
// listed at the bottom of the plan; everything here is the arithmetic and the
// field ordering, which is where the silent failures live: a wrong index in
// CHECKOUT_FIELD_ORDER produces a perfectly well-formed md5 that PayFast
// rejects with nothing more useful than "signature mismatch".
import { createHash } from 'node:crypto'
import {
  CHECKOUT_FIELD_ORDER,
  buildCheckoutSignature,
  buildApiSignature,
  phpUrlEncode,
} from '../src/lib/payfast/signature'
import { buildCheckoutForm } from '../src/lib/payfast/checkout'
import { buildSubscriptionForm } from '../src/lib/payfast/subscription'
import { updateSubscriptionAmount, pauseSubscription, fetchSubscription } from '../src/lib/payfast/api'
import type { PlatformPayFastConfig } from '../src/lib/payfast/platformConfig'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex')

const CFG: PlatformPayFastConfig = {
  merchantId: '10000100',
  merchantKey: '46f0cd694581a',
  passphrase: 'test-passphrase',
  sandbox: true,
  notifyUrl: 'https://example.test/api/billing/payfast/tok',
  returnUrl: 'https://example.test/billing/done',
  cancelUrl: 'https://example.test/billing/cancelled',
}

async function main() {
  // ── The field order ────────────────────────────────────────────────────
  // Positions, not membership. A field present at the wrong index signs
  // cleanly and is refused by the gateway.
  const order = [...CHECKOUT_FIELD_ORDER] as string[]
  const at = (name: string) => order.indexOf(name)

  ok('merchant_id is first', at('merchant_id') === 0)
  ok('the URLs follow the merchant', at('return_url') === 2 && at('cancel_url') === 3 && at('notify_url') === 4)
  ok('m_payment_id precedes amount', at('m_payment_id') < at('amount'))
  ok('amount precedes item_name', at('amount') < at('item_name'))

  /* The counter-intuitive one: PayFast documents custom_int BEFORE custom_str.
     Everyone assumes the opposite, and getting it wrong is invisible until the
     gateway refuses the form. */
  ok('*** custom_int comes BEFORE custom_str ***', at('custom_int1') < at('custom_str1'),
    `int1@${at('custom_int1')} str1@${at('custom_str1')}`)
  ok('custom_int1..5 are contiguous',
    at('custom_int5') - at('custom_int1') === 4)
  ok('custom_str1..5 are contiguous',
    at('custom_str5') - at('custom_str1') === 4)

  // The recurring block sits after payment_method, at the end.
  ok('subscription_type follows payment_method', at('subscription_type') > at('payment_method'))
  for (const f of ['subscription_type', 'billing_date', 'recurring_amount', 'frequency', 'cycles']) {
    ok(`${f} is in the order`, at(f) !== -1)
  }
  ok('billing_date precedes recurring_amount', at('billing_date') < at('recurring_amount'))
  ok('recurring_amount precedes frequency', at('recurring_amount') < at('frequency'))
  ok('frequency precedes cycles', at('frequency') < at('cycles'))

  /* No currency field. PayFast's checkout signature has none — the merchant
     account fixes it — and adding one that is then populated breaks every
     signature at once. */
  ok('*** there is no currency field ***', at('currency') === -1)

  // ── The regression guard for the shared file ───────────────────────────
  // Widening CHECKOUT_FIELD_ORDER must not change what a once-off store
  // payment signs. buildCheckoutSignature skips empties, so it should not —
  // this asserts it rather than assuming it.
  const onceOff = buildCheckoutForm({
    merchantId: '10000100',
    merchantKey: '46f0cd694581a',
    passphrase: 'shop-pass',
    sandbox: true,
    reference: 'REF-1',
    amountIncl: 80,
    itemName: 'Groceries',
    returnUrl: 'https://shop.test/done',
    cancelUrl: 'https://shop.test/cancel',
    notifyUrl: 'https://shop.test/api/payments/payfast/t',
    buyerName: 'Jo Soap',
    buyerEmail: 'jo@example.test',
  })
  const expectedOnceOff = md5(
    [
      'merchant_id=10000100',
      'merchant_key=46f0cd694581a',
      'return_url=' + phpUrlEncode('https://shop.test/done'),
      'cancel_url=' + phpUrlEncode('https://shop.test/cancel'),
      'notify_url=' + phpUrlEncode('https://shop.test/api/payments/payfast/t'),
      'name_first=Jo',
      'name_last=Soap',
      'email_address=' + phpUrlEncode('jo@example.test'),
      'm_payment_id=REF-1',
      'amount=80.00',
      'item_name=Groceries',
      'passphrase=' + phpUrlEncode('shop-pass'),
    ].join('&'),
  )
  ok('*** a once-off store payment signs exactly as before ***',
    onceOff.fields.signature === expectedOnceOff,
    onceOff.fields.signature)
  ok('a once-off form sends no subscription fields',
    !('subscription_type' in onceOff.fields) && !('recurring_amount' in onceOff.fields))

  // ── The subscription form ──────────────────────────────────────────────
  const sub = buildSubscriptionForm({
    config: CFG,
    reference: 'a1b2',
    amountIncl: 3457.42,
    billingDate: '2026-09-01',
    itemName: 'Odyssey subscription',
    notifyUrl: CFG.notifyUrl,
    buyerName: 'Tiaan Smith',
    buyerEmail: 'tiaan@example.test',
    accountId: 4,
  })

  ok('subscription_type is 1', sub.fields.subscription_type === '1')
  ok('frequency is 3 (monthly)', sub.fields.frequency === '3')
  ok('cycles is 0 (until cancelled)', sub.fields.cycles === '0')
  /* The classic subscription bug: the first collection right and every one
     after it some other number, with nothing erroring because both are
     individually valid. */
  ok('*** amount and recurring_amount are the same string ***',
    sub.fields.amount === sub.fields.recurring_amount,
    `${sub.fields.amount} vs ${sub.fields.recurring_amount}`)
  ok('both carry two decimals', sub.fields.amount === '3457.42')
  ok('billing_date is passed through', sub.fields.billing_date === '2026-09-01')
  ok('the account id rides as a breadcrumb', sub.fields.custom_int1 === '4')
  ok('the passphrase never leaves the server', !('passphrase' in sub.fields))
  ok('sandbox posts to the sandbox host', sub.action.includes('sandbox.payfast.co.za'))
  ok('a signature is attached', typeof sub.fields.signature === 'string' && sub.fields.signature.length === 32)

  // Only what was signed is posted — an unsigned extra field breaks the check.
  const signable = new Set(order)
  const unsigned = Object.keys(sub.fields).filter((k) => k !== 'signature' && !signable.has(k))
  ok('every posted field is one the signature covers', unsigned.length === 0, unsigned.join(','))

  // ── The API signature is a DIFFERENT algorithm ─────────────────────────
  // Alphabetical, empties kept, values untrimmed, passphrase as an ordinary
  // sorted key. Each asserted against a hand-built digest rather than by
  // comparison with the checkout function.
  const apiSig = buildApiSignature({ zeta: '1', alpha: '2', 'merchant-id': '3' }, 'pp')
  ok('*** API fields sort alphabetically ***',
    apiSig === md5('alpha=2&merchant-id=3&passphrase=pp&zeta=1'), apiSig)

  ok('*** the passphrase sorts as an ordinary key, not appended ***',
    buildApiSignature({ zzz: '1' }, 'pp') === md5('passphrase=pp&zzz=1'))
  ok('  (appending it would be wrong)',
    buildApiSignature({ zzz: '1' }, 'pp') !== md5('zzz=1&passphrase=pp'))

  ok('empty strings are INCLUDED, unlike the checkout signature',
    buildApiSignature({ a: '', b: '1' }) === md5('a=&b=1'))
  ok('null and undefined are dropped',
    buildApiSignature({ a: null, b: undefined, c: '1' }) === md5('c=1'))
  ok('values are NOT trimmed',
    buildApiSignature({ a: ' x ' }) === md5('a=' + phpUrlEncode(' x ')))
  ok('a signature never covers itself',
    buildApiSignature({ a: '1', signature: 'zzz' }) === md5('a=1'))

  // Contrast, to prove the two really do differ.
  ok('the checkout signature DOES skip empties',
    buildCheckoutSignature({ merchant_id: '1', merchant_key: '' }) === md5('merchant_id=1'))

  // ── The management client ──────────────────────────────────────────────
  let seen: { url: string; init: RequestInit } | null = null
  const spy: typeof fetch = async (url, init) => {
    seen = { url: String(url), init: init ?? {} }
    return new Response('{"status":"ok"}', { status: 200 })
  }

  await updateSubscriptionAmount(CFG, 'tok-1', 179, { fetchImpl: spy })
  ok('update PATCHes the right path', seen!.init.method === 'PATCH' && seen!.url.includes('subscriptions/tok-1/update'))
  /* Rands here, cents on the wire. Getting this wrong sets the subscription to
     a hundredth of the price and errors nowhere. */
  ok('*** R179.00 goes over the wire as 17900 cents ***',
    JSON.parse(String(seen!.init.body)).amount === 17900,
    String(seen!.init.body))
  ok('sandbox adds ?testing=true', seen!.url.includes('testing=true'))

  const headers = seen!.init.headers as Record<string, string>
  ok('the merchant id is a header', headers['merchant-id'] === '10000100')
  ok('version v1 is sent', headers.version === 'v1')
  /* A real offset, never Z — PayFast rejects Z. */
  ok('*** the timestamp carries a numeric offset, not Z ***',
    /[+-]\d{2}:\d{2}$/.test(headers.timestamp), headers.timestamp)
  ok('a signature header is attached', typeof headers.signature === 'string' && headers.signature.length === 32)

  await pauseSubscription(CFG, 'tok-2', 2, { fetchImpl: spy })
  ok('pause PUTs with a cycle count',
    seen!.init.method === 'PUT' && JSON.parse(String(seen!.init.body)).cycles === 2)

  await fetchSubscription(CFG, 'tok-3', { fetchImpl: spy })
  ok('fetch GETs and sends no body', seen!.init.method === 'GET' && !seen!.init.body)

  const live: PlatformPayFastConfig = { ...CFG, sandbox: false }
  await fetchSubscription(live, 'tok-4', { fetchImpl: spy })
  ok('live omits testing=true', !seen!.url.includes('testing='))
  ok('the API host is the same in both modes', seen!.url.startsWith('https://api.payfast.co.za/'))

  // A gateway that is down is a result, not a throw — the caller has to decide
  // what a failure means locally.
  const dead: typeof fetch = async () => {
    throw new Error('ECONNREFUSED')
  }
  const failed = await fetchSubscription(CFG, 'tok-5', { fetchImpl: dead })
  ok('an unreachable gateway returns ok:false rather than throwing', failed.ok === false)

  const rejected: typeof fetch = async () => new Response('nope', { status: 400 })
  const bad = await updateSubscriptionAmount(CFG, 'tok-6', 10, { fetchImpl: rejected })
  ok('a 400 is reported, not thrown', bad.ok === false && !bad.ok && bad.status === 400)

  console.log(fails ? `\n${fails} failure(s)` : '\nall PayFast subscription checks passed')
  if (fails) process.exitCode = 1
}

main().catch((e) => {
  console.error('**FAIL**  suite threw', e)
  process.exit(1)
})
