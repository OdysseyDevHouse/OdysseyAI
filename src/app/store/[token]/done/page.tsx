import Link from 'next/link'
import { notFound } from 'next/navigation'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { readOrderTrackToken } from '@/lib/orderTrackToken'
import { storefrontContext } from '@/lib/site/storefront'
import { Button, Card, Icons } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'

/**
 * "Thanks, we've got it."
 *
 * Reads the order number from the URL rather than the database: the shopper is
 * anonymous, so there is nothing to authenticate them against an order, and
 * looking one up by number alone would let anybody read anybody's order by
 * guessing. The number came from the redirect that placed it, and it is only
 * echoed back — no order data is fetched here at all.
 *
 * ── THE TRACKING LINK IS PASSED, NOT DERIVED ─────────────────────────────
 *
 * `t` carries a SIGNED token minted by the action that placed the order. That
 * keeps the rule above intact: this page still looks nothing up, and the link
 * cannot be forged by editing the order number in the address bar. A missing
 * or malformed one simply means no link is offered.
 */

export const dynamic = 'force-dynamic'

export default async function DonePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ order?: string; total?: string; t?: string }>
}) {
  const { token } = await params
  const query = await searchParams

  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) notFound()
  const context = await storefrontContext(siteId)
  if (!context) notFound()

  const orderNumber = (query.order ?? '').slice(0, 32)
  const total = Number(query.total)

  /*
   * Verified rather than trusted, even though this page shows nothing from it.
   *
   * The token goes into an <a href>. Checking it here means a junk value in the
   * address bar produces no link at all, instead of a link that 404s — and it
   * confirms the token is for THIS store before offering it.
   */
  const claim = query.t ? await readOrderTrackToken(query.t) : null
  const trackHref =
    claim && claim.siteId === siteId ? `/store/${token}/o/${query.t}` : null

  return (
    <Card>
      <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <span className="flex size-12 items-center justify-center rounded-pill bg-success-soft text-success">
          <Icons.Check size={26} />
        </span>

        <h1 className="text-lg font-semibold text-ink">Thanks — we&apos;ve got your order</h1>

        {orderNumber && (
          <p className="text-sm text-muted">
            Your order number is{' '}
            <span className="font-medium text-ink">{orderNumber}</span>
            {Number.isFinite(total) && total > 0 && <> · {formatMoney(total)}</>}
          </p>
        )}

        <p className="max-w-md text-sm text-muted">
          {context.storeName} will confirm it before preparing anything, and will be in touch on
          the details you gave us. You pay when you collect or receive it.
        </p>

        {/* The link is the PRIMARY action here. Someone who has just ordered
            wants to know what happens next far more than they want to carry on
            shopping, and this is the only place a guest is ever handed it
            outside their email. */}
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {trackHref && (
            <Link href={trackHref}>
              <Button variant="primary">Follow your order</Button>
            </Link>
          )}
          <Link href={`/store/${token}`}>
            <Button variant="secondary">Back to the shop</Button>
          </Link>
        </div>

        {trackHref && (
          <p className="max-w-md text-xs text-muted">
            Keep this page or the email we send you — the link shows you where your order has
            got to.
          </p>
        )}
      </div>
    </Card>
  )
}
