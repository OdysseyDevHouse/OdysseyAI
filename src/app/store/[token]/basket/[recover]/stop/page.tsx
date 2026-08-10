import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import Link from 'next/link'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext } from '@/lib/site/storefront'
import { unsubscribeBasket } from '@/lib/site/savedBaskets'
import { Button, Card, Icons } from '@/components/ui'

/**
 * "Stop emailing me about baskets."
 *
 * ── IT ACTS ON ARRIVAL ───────────────────────────────────────────────────
 *
 * No confirm button. Someone who followed an unsubscribe link has already told
 * us what they want, and a page that asks "are you sure?" before honouring it
 * is the pattern that makes people report mail as spam instead. The link is in
 * their own email and names their own basket, so there is nobody else it could
 * be acting on behalf of.
 *
 * ── IT DOES NOT DELETE THE BASKET ────────────────────────────────────────
 *
 * The row is flagged, not removed. They may still want to recover the basket
 * from the link in the same email, and a deleted row would simply be recreated
 * the next time they saved anything — quietly re-subscribing someone who had
 * just opted out.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Unsubscribed',
  robots: { index: false, follow: false },
}

export default async function StopBasketEmailsPage({
  params,
}: {
  params: Promise<{ token: string; recover: string }>
}) {
  const { token, recover } = await params

  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) notFound()
  const context = await storefrontContext(siteId)
  if (!context) notFound()

  const stopped = await unsubscribeBasket(siteId, recover)
  // An unknown token is a 404 rather than a cheerful "done": it means the link
  // is wrong, and telling someone they are unsubscribed when nothing changed
  // is worse than telling them the link did not work.
  if (!stopped) notFound()

  return (
    <Card>
      <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <span className="flex size-12 items-center justify-center rounded-pill bg-success-soft text-success">
          <Icons.Check size={26} />
        </span>
        <h1 className="text-lg font-semibold text-ink">You won&rsquo;t hear from us again</h1>
        <p className="max-w-md text-sm text-muted">
          {context.storeName} will not email you about saved baskets. Your orders and their
          updates are separate and are not affected.
        </p>
        <Link href={`/store/${token}`} className="mt-2">
          <Button variant="secondary">Back to the shop</Button>
        </Link>
      </div>
    </Card>
  )
}
