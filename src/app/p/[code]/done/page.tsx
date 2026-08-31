import { notFound } from 'next/navigation'
import { splitPayCode, resolvePayLink } from '@/lib/site/payLinks'
import { getIntent } from '@/lib/site/payments'
import { publicSiteName } from '@/lib/sites'

/**
 * Where PayFast returns a payer who scanned a printed code.
 *
 * ── THIS PAGE PROVES NOTHING ──────────────────────────────────────────────
 *
 * The return URL is under the payer's control — it can simply be typed — so
 * arriving here is not evidence that money moved. Only the ITN marks a payment
 * received, server to server.
 *
 * So this READS the intent's status rather than setting it. When the callback
 * has landed the status is 'paid' and the page says so plainly. When it has
 * not, the honest answer is "we are confirming it": the callback usually
 * arrives within seconds, and a page claiming failure would send somebody to
 * phone the shop about a payment that is about to succeed.
 *
 * ── WHY THE REFERENCE IS IN THE QUERY ─────────────────────────────────────
 *
 * Unlike /pay/[token], the printed code names a THING and not one payment —
 * that is the whole point of a durable link, and a lay-by scans the same code
 * for every instalment. So the code alone cannot say which attempt just
 * happened, and the reference rides back on the return URL to name it.
 *
 * It is not trusted for anything: it only selects which intent to READ, and the
 * intent has to belong to this link's own site. A reference for another site's
 * payment resolves to nothing.
 */

export const dynamic = 'force-dynamic'

type Props = {
  params: Promise<{ code: string }>
  searchParams: Promise<{ r?: string }>
}

export default async function PayCodeDonePage({ params, searchParams }: Props) {
  const { code } = await params
  const { r } = await searchParams

  const split = splitPayCode(code)
  if (!split) notFound()

  const link = await resolvePayLink(split.siteId, split.slug)
  if (!link) notFound()

  const siteName = await publicSiteName(split.siteId)
  if (!siteName) notFound()

  // Scoped to THIS link's site, so a reference cannot be replayed from another.
  const intent = r ? await getIntent(split.siteId, r) : null

  const paid = intent?.status === 'paid'
  const failed = intent?.status === 'failed' || intent?.status === 'cancelled'

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <div className="rounded-card border border-border bg-surface p-6 shadow-pop">
        <p className="mb-6 text-sm font-medium text-muted">{siteName}</p>

        {paid ? (
          <>
            <h1 className="text-xl font-semibold text-success">Payment received</h1>
            <p className="mt-2 text-muted">
              Thank you. Your payment has been received and recorded.
            </p>
          </>
        ) : failed ? (
          <>
            <h1 className="text-xl font-semibold text-ink">Payment not completed</h1>
            <p className="mt-2 text-muted">
              The payment did not go through, so nothing has been charged. You can scan the
              code again to try once more, or contact {siteName}.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-ink">Confirming your payment</h1>
            <p className="mt-2 text-muted">
              Thank you. We are waiting for confirmation from PayFast — this usually takes a
              few seconds. There is no need to pay again.
            </p>
          </>
        )}
      </div>
    </main>
  )
}
