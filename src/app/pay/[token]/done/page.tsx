import { notFound } from 'next/navigation'
import { readCallbackToken } from '@/lib/callbackToken'
import { getIntent } from '@/lib/site/payments'
import { publicSiteName } from '@/lib/sites'

/**
 * Where PayFast returns the payer after checkout.
 *
 * ── THIS PAGE PROVES NOTHING ─────────────────────────────────────────────
 *
 * The return URL is under the payer's control — it can simply be typed into a
 * browser — so arriving here is not evidence that any money moved. Only the ITN
 * callback marks a payment received, and it does so server-to-server.
 *
 * That is why this page READS the intent's status rather than setting it. When
 * the ITN has already landed the status is 'paid' and the page can say so
 * plainly. When it has not yet, the honest answer is "we are confirming it" —
 * not a receipt, and not an error either, because the callback usually arrives
 * within seconds and a page claiming failure would send the customer to phone
 * about a payment that is about to succeed.
 */

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ token: string }> }

export default async function PayDonePage({ params }: Props) {
  const { token } = await params

  const claim = await readCallbackToken(token)
  if (!claim) notFound()

  const intent = await getIntent(claim.siteId, claim.reference)
  if (!intent || intent.purpose !== 'debtor_invoice') notFound()

  const siteName = await publicSiteName(claim.siteId)
  if (!siteName) notFound()

  const paid = intent.status === 'paid'
  const failed = intent.status === 'failed' || intent.status === 'cancelled'

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <div className="rounded-card border border-border bg-surface p-6 shadow-pop">
        <p className="mb-6 text-sm font-medium text-muted">{siteName}</p>

        {paid ? (
          <>
            <h1 className="text-xl font-semibold text-success">Payment received</h1>
            <p className="mt-2 text-muted">
              Thank you. Your payment has been received and applied to your account.
            </p>
          </>
        ) : failed ? (
          <>
            <h1 className="text-xl font-semibold text-ink">Payment not completed</h1>
            <p className="mt-2 text-muted">
              The payment did not go through, so nothing has been charged. You can try
              again from the link in your invoice email, or contact {siteName}.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-ink">Confirming your payment</h1>
            <p className="mt-2 text-muted">
              Thank you. We are waiting for confirmation from PayFast — this usually takes
              a few seconds. You will receive a receipt once it clears, and there is no
              need to pay again.
            </p>
          </>
        )}
      </div>
    </main>
  )
}
