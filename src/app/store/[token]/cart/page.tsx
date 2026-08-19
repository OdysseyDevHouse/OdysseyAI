import type { Metadata } from 'next'
import { resolveStorefront } from '@/lib/storeRouting'
import { resolvePageContent } from '@/lib/site/storefront'
import { getPublishedLayout } from '@/lib/site/storefrontLayout'
import { cartPage, getPublishedPageLayout } from '@/lib/site/storefrontPages'
import { NEVER_INDEXED } from '@/lib/site/storefrontSeo'
import HomeSections, { type SectionContent } from '../HomeSections'
import CartClient from './CartClient'

/**
 * The basket.
 *
 * ── NEVER INDEXED ────────────────────────────────────────────────────────
 *
 * A basket is one shopper's, held in their own browser, and a search result
 * pointing at it is a result pointing at nothing. `NEVER_INDEXED` is the same
 * constant the checkout and account pages use — a separate value rather than a
 * flag somebody could pass wrongly.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your basket',
  robots: NEVER_INDEXED,
}

export default async function CartPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const resolved = await resolveStorefront(token)

  if (!resolved) {
    return (
      <div className="py-10 text-center">
        <h1 className="text-lg font-semibold text-ink">This shop is not open</h1>
      </div>
    )
  }

  const { context } = resolved

  /*
   * The shop's own words under the basket, if it wrote any.
   *
   * ── WHY THIS PAGE GETS SECTIONS AND CHECKOUT DOES NOT ────────────────
   *
   * A basket is where a shopper hesitates: the delivery threshold they are
   * short of, the returns promise, the thing they forgot. Those are exactly
   * what a merchant wants to say and has nowhere to say it. Checkout is the
   * opposite — the one page where an extra row between somebody and the Pay
   * button costs a sale — so it stays fixed, and `kindsFor('cart')` keeps the
   * blocks here to the ones that reassure rather than distract.
   */
  const [layout, page] = await Promise.all([
    getPublishedLayout(context.catalogueSiteId),
    cartPage(context.catalogueSiteId),
  ])
  const sections = page?.isPublished
    ? await getPublishedPageLayout(context.catalogueSiteId, page.id)
    : []
  const content: SectionContent[] =
    sections.length > 0 ? await resolvePageContent(context, sections) : []

  return (
    <div>
      <CartClient token={token} />

      {content.length > 0 && (
        <div className="mt-10 border-t border-border pt-6">
          <HomeSections
            token={token}
            content={content}
            theme={layout.theme}
            display={{
              layout: layout.theme.productLayout,
              showStock: context.settings.showStock,
              showPhotos: context.settings.showPhotos,
              showBrands: context.settings.showBrands,
              showDepartmentImages: context.settings.showDepartmentImages,
            }}
            imageSrc={(imageId) => `/api/store-images/${token}/shop/${imageId}`}
          />
        </div>
      )}
    </div>
  )
}
