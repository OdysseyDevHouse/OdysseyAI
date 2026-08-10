import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext, publishedDepartments } from '@/lib/site/storefront'
import { getPublishedLayout, getTheme } from '@/lib/site/storefrontLayout'
import { navPages } from '@/lib/site/storefrontPages'
import { announcementShowing } from '@/lib/storefrontModel'
import { fontClass } from './fonts'
import { getCustomerSession } from '@/lib/customerSession'
import ShopSession from './ShopSession'
import { CartProvider } from './CartContext'
import { WishlistProvider } from './WishlistContext'
import StoreChrome from './StoreChrome'

/**
 * The public storefront.
 *
 * Every route under here resolves the signed token to a store and then reads
 * ONLY what that store publishes. A bad token, a closed store and a suspended
 * site are all a plain 404 — identical from outside, so the link cannot be
 * used to probe which stores exist.
 */

export const dynamic = 'force-dynamic'

async function resolve(token: string) {
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return null
  return storefrontContext(siteId)
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>
}): Promise<Metadata> {
  const { token } = await params
  const context = await resolve(token)
  if (!context) return { title: 'Shop' }

  const theme = await getTheme(context.siteId)
  const description = context.settings.blurb || `Order online from ${context.storeName}.`

  return {
    title: context.storeName,
    description,
    // A storefront link is shared on WhatsApp and Facebook far more often than
    // it is typed, so the preview card is the shop's actual front door.
    openGraph: {
      title: context.storeName,
      description,
      type: 'website',
      /*
       * The picture, at last.
       *
       * This block has existed since the storefront did and has never carried
       * an image — so every shop link pasted into a chat has shown a bare grey
       * card. The public image route, which re-checks the store is open before
       * serving a byte, so an image cannot outlive the shop being closed.
       */
      ...(theme.shareImageId
        ? { images: [{ url: `/api/store-images/${token}/shop/${theme.shareImageId}` }] }
        : {}),
    },
    /*
     * Indexing is the shop's own call — see 077.
     *
     * A storefront URL carries a signed token, so indexing it publishes that
     * token into a search engine. Right for a shop that wants foot traffic,
     * wrong for one using the link as a semi-private ordering channel. Default
     * is off, which is what every shop has had until now.
     */
    robots: theme.allowIndexing
      ? { index: true, follow: true }
      : { index: false, follow: false },
  }
}

export default async function StoreLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const context = await resolve(token)
  if (!context) notFound()


  // Read here so the masthead can show who is signed in on every page.
  const session = await getCustomerSession(context.siteId)

  const [departments, layout, pages] = await Promise.all([
    publishedDepartments(context),
    getPublishedLayout(context.siteId),
    navPages(context.siteId),
  ])

  return (
    <CartProvider token={token}>
      {/* Mints the analytics session id if this browser has none. Renders
          nothing; see shopSession.ts for why it is a random number and not an
          identity. */}
      <ShopSession />
      {/* Inside the cart provider so a tile can reach both — the same tile
          carries an Add button and a heart. */}
      <WishlistProvider token={token}>
        <StoreChrome
        token={token}
        storeName={context.storeName}
        blurb={context.settings.blurb}
        departments={departments}
        showDepartmentImages={context.settings.showDepartmentImages}
        theme={layout.theme}
        allowAccount={context.settings.allowAccount}
        customerName={session?.name ?? null}
        offerSaveBasket={context.settings.basketReminders}
        // Slug and title only — see the prop's note on why whole rows do not
        // cross into the browser bundle.
        pages={pages.map((p) => ({ slug: p.slug, title: p.title }))}
        // Resolved here rather than in the chrome: next/font is a build-time
        // transform and cannot run in a client component. See fonts.ts.
        fontClassName={fontClass(layout.theme.fontKey)}
        /*
         * The strip, or nothing. The schedule is evaluated HERE, with the
         * shop's own clock, so an out-of-season announcement never reaches the
         * browser at all — rather than being sent and hidden with CSS, which
         * would put next month's promotion in this month's page source.
         */
        announce={
          announcementShowing(layout.theme)
            ? { text: layout.theme.announceText, href: layout.theme.announceLink }
            : null
        }
      >
        {children}
        </StoreChrome>
      </WishlistProvider>
    </CartProvider>
  )
}
