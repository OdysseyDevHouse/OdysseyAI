import { notFound } from 'next/navigation'
import { headers } from 'next/headers'
import { readCallbackToken, callbackPath } from '@/lib/callbackToken'
import { getGateway, getIntent } from '@/lib/site/payments'
import { payableInvoice } from '@/lib/site/paidInvoices'
import { getCustomer } from '@/lib/site/customers'
import { buildCheckoutForm } from '@/lib/payfast/checkout'
import { publicSiteName } from '@/lib/sites'
import { formatMoney } from '@/lib/decimals'
import PayForm from './PayForm'

/**
 * The page an emailed "pay this invoice" link lands on.
 *
 * ── WHY A PAGE AND NOT A DIRECT LINK TO PAYFAST ──────────────────────────
 *
 * PayFast's hosted checkout is a signed form POST — the signature covers the
 * amount, so it cannot be a GET without putting the merchant key and signature
 * in a URL that lands in inboxes, spam filters and browser history. A link in
 * an email can only be a GET. So the link points here, and this page builds the
 * signed form server-side and submits it.
 *
 * The card details still never touch this application: the form posts straight
 * to PayFast, which is the whole reason for a hosted gateway.
 *
 * ── WHAT THIS PAGE MAY SHOW ──────────────────────────────────────────────
 *
 * Anyone holding the link can open it, and the link is emailed and forwarded.
 * So it shows only what a payer must see to pay with confidence — the invoice
 * number, who it is for, and the amount. No line detail, no account balance, no
 * other invoices. The token is identification, never authorisation.
 *
 * ── THE PAGE NEVER MARKS ANYTHING PAID ───────────────────────────────────
 *
 * Only the ITN callback does. This page is reachable by typing a URL; treating
 * a visit to it as payment would be the whole security model undone.
 */

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ token: string }> }

export default async function PayPage({ params }: Props) {
  const { token } = await params

  // The token names the site and the intent. Expired (24h) or forged tokens
  // fall through to notFound rather than explaining themselves — an error that
  // distinguishes "expired" from "never existed" is an oracle.
  const claim = await readCallbackToken(token)
  if (!claim) notFound()

  const intent = await getIntent(claim.siteId, claim.reference)
  /*
   * ── TWO PURPOSES REACH THIS PAGE, NOT ONE ────────────────────────────
   *
   * `debtor_invoice` is the emailed invoice link this page was built for.
   * `customer_account` is a payment onto the BALANCE, which the customer
   * portal mints when somebody settles or tops up their account — a
   * statement is not a document, so it has no invoice to point at.
   *
   * The other four purposes are printed-paper links and belong to /p/[code],
   * which resolves a durable slug and mints its intent on arrival. They are
   * refused here rather than half-handled: this route assumes an intent that
   * already exists, which a scanned square does not have.
   */
  if (!intent) notFound()
  if (intent.purpose !== 'debtor_invoice' && intent.purpose !== 'customer_account') {
    notFound()
  }

  // Only the NAME. publicSiteName exists precisely so an anonymous page cannot
  // accidentally serve the site's VAT number, registration number and postal
  // address to whoever holds the link.
  const siteName = await publicSiteName(claim.siteId)
  if (!siteName) notFound()

  /*
   * ── WHAT IS BEING PAID, IN THE PAYER’S WORDS ─────────────────────────
   *
   * Both branches produce the same three things — a heading, at most one
   * line under it, and the figure — because that is everything this page is
   * allowed to say. Anyone holding the link can open it and links get
   * forwarded, so there is no line detail, no other document and no history
   * on either path. The token is identification, never authorisation.
   *
   * The ACCOUNT branch is deliberately thinner than the invoice one: it names
   * the account and nothing else. A balance is the sum of everything somebody
   * has bought, and printing it beside their trading name on a page reachable
   * by URL says more about them than paying requires.
   */
  let heading: string
  let subheading: string | null = null
  let rows: { label: string; value: string }[] = []
  /** What this page calls the thing, mid-sentence. */
  let noun: string

  if (intent.purpose === 'debtor_invoice') {
    const invoice = await payableInvoice(claim.siteId, intent.targetId)
    if (!invoice) notFound()

    /*
     * Already paid — through this link, or by EFT in the meantime. Saying so
     * is the entire job of this branch: a customer who pays twice because the
     * page still offered a Pay button is a refund and a phone call.
     */
    if (intent.status === 'paid') {
      return (
        <Shell siteName={siteName}>
          <h1 className="text-xl font-semibold text-ink">Already paid</h1>
          <p className="mt-2 text-muted">
            Invoice {invoice.documentNumber} has been paid. Thank you.
          </p>
        </Shell>
      )
    }

    if (invoice.outstanding <= 0) {
      return (
        <Shell siteName={siteName}>
          <h1 className="text-xl font-semibold text-ink">Nothing outstanding</h1>
          <p className="mt-2 text-muted">
            Invoice {invoice.documentNumber} has been settled. Thank you.
          </p>
        </Shell>
      )
    }

    heading = invoice.documentNumber ?? `#${intent.targetId}`
    subheading = 'Invoice'
    rows = [
      { label: 'Billed to', value: invoice.customerName ?? '—' },
      { label: 'Invoice date', value: invoice.documentDate },
      ...(invoice.dueDate ? [{ label: 'Due date', value: invoice.dueDate }] : []),
    ]
    noun = `invoice ${invoice.documentNumber ?? ''}`.trim()
  } else {
    const customer = await getCustomer(claim.siteId, intent.targetId)
    if (!customer) notFound()

    /*
     * ── AN ACCOUNT PAYMENT IS NEVER “NOTHING OUTSTANDING” ───────────────
     *
     * The invoice branch refuses once the debt is gone, because paying a
     * settled invoice is always a mistake. Here it is not: the amount was
     * chosen by the customer, and paying onto an account that owes nothing is
     * a top-up — the balance simply goes into credit. Refusing on the balance
     * would break the case this branch exists for.
     *
     * The `paid` guard still stands, because that one is about THIS intent
     * having been settled already, which is a duplicate however much is owed.
     */
    if (intent.status === 'paid') {
      return (
        <Shell siteName={siteName}>
          <h1 className="text-xl font-semibold text-ink">Already paid</h1>
          <p className="mt-2 text-muted">This payment has gone through. Thank you.</p>
        </Shell>
      )
    }

    heading = `Account ${customer.code}`
    subheading = 'Payment to your account'
    noun = 'your account'
  }

  const gateway = await getGateway(claim.siteId)
  if (!gateway?.isActive || !gateway.credentialsUsable) {
    return (
      <Shell siteName={siteName}>
        <h1 className="text-xl font-semibold text-ink">Online payment is unavailable</h1>
        <p className="mt-2 text-muted">
          Please contact {siteName} to settle {noun}.
        </p>
      </Shell>
    )
  }

  const origin = await publicOrigin()

  // The amount comes from the INTENT, not from the invoice as it stands now.
  // The intent is what the callback is checked against, and a form asking for a
  // different figure would be refused by our own verification.
  const form = buildCheckoutForm({
    merchantId: gateway.merchantId,
    merchantKey: gateway.merchantKey,
    passphrase: gateway.passphrase,
    sandbox: gateway.isSandbox,
    reference: intent.reference,
    amountIncl: intent.amountIncl,
    /* What the customer sees on the gateway and on their card statement, so
       it has to name the thing they thought they were paying. */
    itemName: heading,
    itemDescription: `Payment to ${siteName}`,
    // Neither of these proves payment — only the notify URL does.
    returnUrl: `${origin}/pay/${token}/done`,
    cancelUrl: `${origin}/pay/${token}`,
    /*
     * The SHORT callback path, NOT this page's own token.
     *
     * Reusing `token` here was neat and produced a 296-character notify URL —
     * past PayFast's documented 255-character limit for that field. PayFast
     * accepts the checkout form anyway and then never posts the callback, so
     * the money moves and nothing on our side ever hears about it. The link in
     * the email keeps its JWT, which is right for a mailed link; only the
     * machine-to-machine address is shortened. See callbackToken.ts.
     */
    notifyUrl: `${origin}/api/payments/payfast/${callbackPath(claim.siteId, intent.reference)}`,
  })

  return (
    <Shell siteName={siteName}>
      {subheading ? <p className="text-sm text-muted">{subheading}</p> : null}
      <h1 className="text-2xl font-semibold text-ink">{heading}</h1>

      {rows.length > 0 && (
        <dl className="mt-6 space-y-2 text-sm">
          {rows.map((row) => (
            <Row key={row.label} label={row.label} value={row.value} />
          ))}
        </dl>
      )}

      <div className="mt-6 flex items-baseline justify-between border-t border-border pt-4">
        <span className="text-sm text-muted">Amount due</span>
        <span className="text-2xl font-semibold text-ink">
          {formatMoney(intent.amountIncl)}
        </span>
      </div>

      <PayForm action={form.action} fields={form.fields} />

      <p className="mt-4 text-xs text-muted">
        You will be taken to PayFast to complete the payment. Your card details are
        never handled by {siteName}.
      </p>
    </Shell>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  )
}

/**
 * The page's own chrome.
 *
 * Deliberately not the app shell: there is no session here, no navigation and
 * no site switcher, and rendering those to an anonymous payer would be both
 * broken and a small information leak.
 */
function Shell({ siteName, children }: { siteName: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <div className="rounded-card border border-border bg-surface p-6 shadow-pop">
        <p className="mb-6 text-sm font-medium text-muted">{siteName}</p>
        {children}
      </div>
    </main>
  )
}

/**
 * The public origin, for the URLs the gateway is given.
 *
 * Read from the request headers rather than hardcoded, because the same build
 * serves localhost in development and a real domain in production — and a
 * notify URL pointing at the wrong host means payments that are never
 * confirmed. Same helper the storefront checkout uses.
 */
async function publicOrigin(): Promise<string> {
  const head = await headers()
  const explicit = process.env.PUBLIC_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/$/, '')

  const host = head.get('x-forwarded-host') ?? head.get('host') ?? 'localhost:4100'
  const proto = head.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}
