import Link from 'next/link'
import { notFound } from 'next/navigation'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
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
 */

export const dynamic = 'force-dynamic'

export default async function DonePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ order?: string; total?: string }>
}) {
  const { token } = await params
  const query = await searchParams

  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) notFound()
  const context = await storefrontContext(siteId)
  if (!context) notFound()

  const orderNumber = (query.order ?? '').slice(0, 32)
  const total = Number(query.total)

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

        <Link href={`/store/${token}`} className="mt-2">
          <Button variant="secondary">Back to the shop</Button>
        </Link>
      </div>
    </Card>
  )
}
