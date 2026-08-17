import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { resolveStorefront } from '@/lib/storeRouting'
import { publishedProducts, storefrontContext } from '@/lib/site/storefront'
import { getPublishedLayout } from '@/lib/site/storefrontLayout'
import WishlistView from './WishlistView'

/**
 * Saved for later.
 *
 * ── THE SAVED IDS ARE RESOLVED BY AN ACTION, NOT BY THIS PAGE ────────────
 *
 * The list lives in the browser, so the server cannot know it at render time.
 * An earlier shape sent the first 120 published products and matched in the
 * browser — which was wrong for any shop with a bigger catalogue: something
 * saved from page four would fail to resolve and be reported as "no longer
 * available", when it was on the shelf all along.
 *
 * So the page renders the frame, and the client asks for exactly the ids it
 * holds. That query applies the same publish rules as every other storefront
 * read, so an id someone typed into localStorage by hand still resolves to
 * nothing.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your wishlist',
  // Unconditional, regardless of any indexing preference: this page renders
  // nothing at all to a crawler, since the list is per-device.
  robots: { index: false, follow: false },
}

export default async function WishlistPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  const resolved = await resolveStorefront(token)
  if (!resolved) notFound()
  const { context } = resolved

  // Branding is the shop front's, which for a chain is head office's — a
  // branch does not get its own product layout.
  const layout = await getPublishedLayout(context.catalogueSiteId)

  return (
    <WishlistView
      token={token}
      layout={layout.theme.productLayout}
      showStock={context.settings.showStock}
      showPhotos={context.settings.showPhotos}
      showBrands={context.settings.showBrands}
    />
  )
}
