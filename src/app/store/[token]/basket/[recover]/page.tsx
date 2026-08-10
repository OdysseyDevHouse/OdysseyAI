import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext, publishedProducts } from '@/lib/site/storefront'
import { basketByToken, markRecovered } from '@/lib/site/savedBaskets'
import RestoreBasket from './RestoreBasket'

/**
 * "Pick up where you left off."
 *
 * ── THE BASKET IS RE-PRICED, NOT REPLAYED ────────────────────────────────
 *
 * What was saved is product ids and quantities. Everything else — the price,
 * whether it is still sold, whether it is in stock — is read from the catalogue
 * HERE, at the moment the shopper returns. A basket restored at last week's
 * prices would be a promise the checkout then breaks, and checkout re-prices
 * anyway, so the honest thing is to show today's figures now and say what
 * changed.
 *
 * ── A LINE THAT VANISHED IS DROPPED AND NAMED ────────────────────────────
 *
 * A product archived or unpublished since the basket was saved cannot be
 * bought. It is left out of the restored basket and listed separately, because
 * a shopper who came back for one specific thing needs to know it is that thing
 * which is gone — not discover a smaller total and wonder.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your basket',
  robots: { index: false, follow: false },
}

export default async function RecoverBasketPage({
  params,
}: {
  params: Promise<{ token: string; recover: string }>
}) {
  const { token, recover } = await params

  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) notFound()
  const context = await storefrontContext(siteId)
  if (!context) notFound()

  const basket = await basketByToken(siteId, recover)
  if (!basket) notFound()

  // Priced from the catalogue, now. `ids` also applies the store's publish
  // rules, so anything the shop has since unpublished simply does not come
  // back — which is what makes the "no longer available" list below correct.
  const live = await publishedProducts(context, {
    ids: basket.lines.map((l) => l.productId),
    limit: 200,
  })
  const byId = new Map(live.map((p) => [p.id, p]))

  const restored = basket.lines
    .map((line) => {
      const product = byId.get(line.productId)
      if (!product) return null
      return {
        productId: product.id,
        code: product.code,
        description: product.description,
        priceIncl: product.priceIncl,
        qty: line.qty,
        inStock: product.inStock,
      }
    })
    .filter((l): l is NonNullable<typeof l> => l !== null)

  const missing = basket.lines.length - restored.length

  /*
   * Marked recovered on ARRIVAL, not on restore.
   *
   * They clicked the link — that is the event worth recording, and it is what
   * stops a second reminder. Waiting for the button would leave someone who
   * came back, looked, and decided later still on the chase list.
   */
  if (!basket.recoveredAt) {
    await markRecovered(siteId, basket.id).catch(() => {})
  }

  return (
    <RestoreBasket
      token={token}
      lines={restored}
      missingCount={missing}
      storeName={context.storeName}
      showStock={context.settings.showStock}
    />
  )
}
