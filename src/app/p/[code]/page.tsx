import { notFound } from 'next/navigation'
import { headers } from 'next/headers'
import { splitPayCode, resolvePayLink } from '@/lib/site/payLinks'
import { payableSummary } from '@/lib/site/payableSummary'
import { getGateway, createIntent, type IntentTarget } from '@/lib/site/payments'
import { callbackPath } from '@/lib/callbackToken'
import { buildCheckoutForm } from '@/lib/payfast/checkout'
import { publicSiteName } from '@/lib/sites'
import { formatMoney } from '@/lib/decimals'
import PayForm from '../../pay/[token]/PayForm'

/**
 * The page a PRINTED pay code lands on.
 *
 * ── HOW THIS DIFFERS FROM /pay/[token] ────────────────────────────────────
 *
 * /pay carries a signed 24-hour JWT minted per email send, and one intent is
 * created before the link even exists. That is right for an email and wrong for
 * paper: the square on an invoice is scanned weeks later, possibly several
 * times, and by then the token is long dead.
 *
 * So this route resolves a DURABLE slug to whatever is owed right now, and
 * mints the intent at the moment somebody actually decides to pay. One printed
 * square legitimately yields many intents — a lay-by paid off in six
 * instalments scans the same code six times.
 *
 * ── THE CODE NAMES ITS OWN SITE ───────────────────────────────────────────
 *
 * `<site36>-<random>`. Without the prefix the slug would have to be looked for
 * in every shop's database — unbounded work driven by an unauthenticated
 * request. The portal token would also name the site, but measured it makes the
 * URL 149 characters against 43, which is exactly the dense-square problem the
 * slug exists to avoid. See payLinks.ts.
 *
 * ── IT MARKS NOTHING PAID ─────────────────────────────────────────────────
 *
 * Only the verified ITN callback does. This page is reachable by typing a URL,
 * so treating a visit as payment would undo the whole security model.
 */

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ code: string }> }

export default async function PayCodePage({ params }: Props) {
  const { code } = await params

  const split = splitPayCode(code)
  if (!split) notFound()

  // Unknown, revoked, expired and malformed all land here as one 404.
  // Distinguishing them would make the URL an oracle for which codes are live,
  // and a code IS the address of somebody's debt.
  const link = await resolvePayLink(split.siteId, split.slug)
  if (!link) notFound()

  // Only the NAME. publicSiteName exists so an anonymous page cannot serve the
  // shop's VAT number, registration number and postal address to whoever is
  // holding the paper.
  const siteName = await publicSiteName(split.siteId)
  if (!siteName) notFound()

  const summary = await payableSummary(split.siteId, link)
  if (!summary) notFound()

  if (summary.outstanding <= 0.005) {
    return (
      <Shell siteName={siteName}>
        <h1 className="text-xl font-semibold text-ink">Nothing outstanding</h1>
        <p className="mt-2 text-muted">
          {summary.title} has been settled. Thank you.
        </p>
      </Shell>
    )
  }

  const gateway = await getGateway(split.siteId)
  if (!gateway?.isActive || !gateway.credentialsUsable) {
    return (
      <Shell siteName={siteName}>
        <h1 className="text-xl font-semibold text-ink">Online payment is unavailable</h1>
        <p className="mt-2 text-muted">
          Please contact {siteName} to settle {summary.title.toLowerCase()}.
        </p>
      </Shell>
    )
  }

  /*
   * The intent is minted HERE, not when the code was printed.
   *
   * It records what we expect to be paid, and the callback is checked against
   * it — so it has to be created against what is owed NOW. An intent minted at
   * print time would be checked against a figure that was true weeks ago, and
   * a part payment in the meantime would make every callback fail its own
   * amount check.
   */
  const intent = await createIntent(split.siteId, {
    target: targetFor(link.purpose, link.targetId),
    amountIncl: summary.outstanding,
  })
  /* The SHORT path, not a JWT: a signed token puts the notify URL past
     PayFast's 255-character limit, and it then never posts at all. See
     callbackToken.ts. */
  const callback = callbackPath(split.siteId, intent.reference)
  const origin = await publicOrigin()

  const form = buildCheckoutForm({
    merchantId: gateway.merchantId,
    merchantKey: gateway.merchantKey,
    passphrase: gateway.passphrase,
    sandbox: gateway.isSandbox,
    reference: intent.reference,
    amountIncl: intent.amountIncl,
    itemName: summary.title,
    itemDescription: `Payment to ${siteName}`,
    // Neither of these proves payment — only the notify URL does.
    returnUrl: `${origin}/p/${code}/done?r=${encodeURIComponent(intent.reference)}`,
    cancelUrl: `${origin}/p/${code}`,
    notifyUrl: `${origin}/api/payments/payfast/${callback}`,
  })

  return (
    <Shell siteName={siteName}>
      <h1 className="text-2xl font-semibold text-ink">{summary.title}</h1>
      {summary.subtitle ? <p className="mt-1 text-sm text-muted">{summary.subtitle}</p> : null}

      <div className="mt-6 flex items-baseline justify-between border-t border-border pt-4">
        <span className="text-sm text-muted">Amount due</span>
        <span className="text-2xl font-semibold text-ink">
          {formatMoney(summary.outstanding)}
        </span>
      </div>

      <PayForm action={form.action} fields={form.fields} />

      <p className="mt-4 text-xs text-muted">
        You will be taken to PayFast to complete the payment. Your card details are never
        handled by {siteName}.
      </p>
    </Shell>
  )
}

/**
 * The link's purpose, as the intent's target union.
 *
 * The cast-free way round: payLinks and payments agree on the purpose strings,
 * and this is where a link's flat (purpose, targetId) pair becomes the union
 * that cannot hold a mismatched id. See IntentTarget in payments.ts.
 */
function targetFor(
  purpose: Exclude<IntentTarget['purpose'], 'online_order'>,
  targetId: number,
): IntentTarget {
  switch (purpose) {
    case 'debtor_invoice':
      return { purpose, documentId: targetId }
    case 'document_deposit':
      return { purpose, documentId: targetId }
    case 'customer_account':
      return { purpose, customerId: targetId }
    case 'layby':
      return { purpose, laybyId: targetId }
    case 'job_deposit':
      return { purpose, jobId: targetId }
  }
}

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
 * From the request headers rather than hardcoded, because the same build serves
 * localhost in development and a real domain in production — and a notify URL
 * pointing at the wrong host means payments that are never confirmed. The same
 * helper /pay and the storefront checkout use.
 */
async function publicOrigin(): Promise<string> {
  const head = await headers()
  const explicit = process.env.PUBLIC_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/$/, '')

  const host = head.get('x-forwarded-host') ?? head.get('host') ?? 'localhost:4100'
  const proto = head.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}
