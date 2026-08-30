// Build a real PayFast checkout page for the current plan, to click through by
// hand against the sandbox.
//
//   npx tsx --conditions=react-server --env-file=.env scripts/payfast-checkout-page.ts
//   then open the file it writes
//
// ── WHY THIS EXISTS RATHER THAN JUST USING THE SCREEN ──────────────────────
//
// The Subscribe button does exactly this, and for a normal test that is the
// thing to use. This is for when the interesting part is what happens AFTER —
// watching the notification arrive, checking the row it writes — and you want
// the reference in your hand before you start rather than fishing it out of
// the database afterwards.
//
// ── THE TUNNEL ─────────────────────────────────────────────────────────────
//
// PayFast can never reach localhost: the notification is THEIR server calling
// YOURS. So PAYFAST_NOTIFY_URL has to be a public host:
//
//   npx localtunnel --port 4100
//
// and all three PAYFAST_*_URL values updated to whatever it prints. A stale
// tunnel host is the nastiest failure here — the payment still succeeds and
// the callback silently goes nowhere, with no error on either side. This
// script refuses to run against localhost for that reason.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { query } from '../src/lib/db'
import { quoteForAccount } from '../src/lib/billing/accountQuote'
import { platformPayFast } from '../src/lib/payfast/platformConfig'
import { buildSubscriptionForm } from '../src/lib/payfast/subscription'
import { createBillingCallbackToken } from '../src/lib/billingCallbackToken'
import { nextBillingDate, safeBillingDay } from '../src/lib/billing/period'
import { startCheckoutAttempt } from '../src/lib/control/subscriptions'

async function main() {
  const config = platformPayFast()

  if (/localhost|127\.0\.0\.1/.test(config.notifyUrl)) {
    console.error('PAYFAST_NOTIFY_URL points at localhost, which PayFast cannot reach.')
    console.error('The payment would succeed and the callback would never arrive.')
    console.error('')
    console.error('  npx localtunnel --port 4100')
    console.error('  then set PAYFAST_NOTIFY_URL / _RETURN_URL / _CANCEL_URL to that host')
    process.exit(1)
  }

  const [account] = await query<{
    id: number
    name: string
    billing_email: string | null
    billing_day: number
  }>('SELECT id, name, billing_email, billing_day FROM cp2_billing_accounts ORDER BY id LIMIT 1')

  if (!account) {
    console.error('No billing account exists.')
    process.exit(1)
  }

  const { total } = await quoteForAccount(account.id)
  const attempt = await startCheckoutAttempt(account.id, total)
  if (!attempt.ok) {
    console.error(attempt.error)
    console.error('')
    console.error('To start over:')
    console.error("  UPDATE cp2_billing_subscriptions SET status='none', m_payment_id=NULL,")
    console.error('         pending_amount=NULL, pending_started_at=NULL;')
    process.exit(1)
  }

  const token = await createBillingCallbackToken(account.id)
  const today = new Date().toISOString().slice(0, 10)
  const firstCollection = nextBillingDate(today, safeBillingDay(account.billing_day))

  const form = buildSubscriptionForm({
    config,
    reference: attempt.reference,
    amountIncl: attempt.amountIncl,
    billingDate: firstCollection,
    itemName: `Odyssey — ${account.name}`.slice(0, 100),
    itemDescription: 'Monthly platform subscription',
    notifyUrl: `${config.notifyUrl.replace(/\/$/, '')}/${token}`,
    buyerName: 'Sandbox Test',
    buyerEmail: account.billing_email ?? '',
    accountId: account.id,
  })

  const escape = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const inputs = Object.entries(form.fields)
    .map(([k, v]) => `    <input type="hidden" name="${escape(k)}" value="${escape(String(v))}">`)
    .join('\n')

  const html = `<!doctype html>
<meta charset="utf-8">
<title>Odyssey — PayFast sandbox checkout</title>
<body style="font:16px/1.5 system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem">
  <h1 style="font-size:1.3rem">Odyssey — ${escape(account.name)}</h1>
  <p><strong>R ${attempt.amountIncl.toFixed(2)}</strong> a month, first collection ${firstCollection}.</p>
  <p style="color:#666;font-size:.9rem">Reference <code>${escape(attempt.reference)}</code></p>
  <form method="post" action="${escape(form.action)}">
${inputs}
    <button style="font:inherit;padding:.6rem 1.2rem;cursor:pointer">Pay on the PayFast sandbox</button>
  </form>
  <p style="color:#666;font-size:.85rem;margin-top:2rem">
    Sandbox card: <code>4000 0000 0000 0002</code>, any future expiry, any CVV.
  </p>
</body>`

  const out = path.join(process.cwd(), '.screenshots', 'payfast-checkout.html')
  writeFileSync(out, html)

  console.log('account   :', account.name, `(#${account.id})`)
  console.log('amount    : R' + attempt.amountIncl.toFixed(2), '/month')
  console.log('first due :', firstCollection)
  console.log('reference :', attempt.reference)
  console.log('notify    :', form.fields.notify_url)
  console.log('')
  console.log('open      :', out)
  console.log('')
  console.log('Afterwards, check it arrived:')
  console.log('  SELECT status, pf_token, amount_incl FROM cp2_billing_subscriptions;')
  console.log('  SELECT pf_payment_id, payment_status, verified, reject_reason')
  console.log('    FROM cp2_billing_payments ORDER BY id DESC LIMIT 5;')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
