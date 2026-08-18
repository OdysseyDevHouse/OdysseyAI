import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
 import { resolveStoreRouting, rememberedBranch } from '@/lib/storeRouting'
import { storefrontContext, publishedDepartments } from '@/lib/site/storefront'
import { getPublishedLayout, getPublishedTokens, getTheme } from '@/lib/site/storefrontLayout'
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

/**
 * The store this request is for.
 *
 * For a single shop — every shop today — this is the token's site and nothing
 * else happens. For a chain running one storefront it is TWO shops: the group's
 * primary owns the catalogue and the branding, and the branch owns the stock,
 * the delivery charges and the order. See storeRouting.ts.
 */
async function resolve(token: string) {
  const routing = await resolveStoreRouting(token, await rememberedBranch(token))
  if (!routing) return null

  const context = await storefrontContext(routing.catalogueSiteId, routing.branchSiteId)
  return context ? { context, routing } : null
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>
}): Promise<Metadata> {
  const { token } = await params
  const resolved = await resolve(token)
  if (!resolved) return { title: 'Shop' }
  const { context } = resolved

  // Branding is the CATALOGUE's — one chain, one shop front, whichever branch
  // is packing the order.
  const theme = await getTheme(context.catalogueSiteId)
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
  const resolved = await resolve(token)
  if (!resolved) notFound()
  const { context, routing } = resolved

  // Read here so the masthead can show who is signed in on every page.
  // The BRANCH's session: customer accounts are per-site, so a shopper signed
  // in at one branch is a different account at the next.
  const session = await getCustomerSession(context.siteId)

  const [departments, layout, pages, tokens] = await Promise.all([
    publishedDepartments(context),
    // Layout, theme and pages are the shop front's, which for a chain is the
    // primary's. A branch does not get its own branding — see the plan.
    getPublishedLayout(context.catalogueSiteId),
    navPages(context.catalogueSiteId),
    // The shop’s look, from the same site its branding comes from: a branch
    // does not restyle the chain it belongs to.
    getPublishedTokens(context.catalogueSiteId),
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
        tokens={tokens}
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
        /*
         * Null for a single shop, and the chrome then renders nothing new at
         * all — no band, no picker, not a byte of that bundle. Every storefront
         * that exists today is this case and must stay pixel-identical.
         */
        branch={
          routing.isGroup
            ? {
                name: context.branchName,
                needsChoice: routing.needsBranchChoice,
                pinned: routing.isPinned,
                choices: routing.branches.map((b) => ({
                  siteId: b.siteId,
                  name: b.displayName,
                  address: b.addressLine,
                  latitude: b.latitude,
                  longitude: b.longitude,
                  sortOrder: b.sortOrder,
                })),
              }
            : null
        }
      >
        {children}
        </StoreChrome>
      </WishlistProvider>
    </CartProvider>
  )
}
