import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext, publishedDepartments } from '@/lib/site/storefront'
import { getPublishedLayout } from '@/lib/site/storefrontLayout'
import { CartProvider } from './CartContext'
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

  return {
    title: context.storeName,
    description: context.settings.blurb || `Order online from ${context.storeName}.`,
    // A storefront link is shared on WhatsApp and Facebook far more often than
    // it is typed, so the preview card is the shop's actual front door.
    openGraph: {
      title: context.storeName,
      description: context.settings.blurb || `Order online from ${context.storeName}.`,
      type: 'website',
    },
    // The catalogue is a shop's own listing, not something to be indexed and
    // ranked against it. A store that wants search traffic can opt in later.
    robots: { index: false, follow: false },
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

  const [departments, layout] = await Promise.all([
    publishedDepartments(context),
    getPublishedLayout(context.siteId),
  ])

  return (
    <CartProvider token={token}>
      <StoreChrome
        token={token}
        storeName={context.storeName}
        blurb={context.settings.blurb}
        departments={departments}
        theme={layout.theme}
      >
        {children}
      </StoreChrome>
    </CartProvider>
  )
}
