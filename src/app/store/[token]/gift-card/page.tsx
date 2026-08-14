import { notFound } from 'next/navigation'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext } from '@/lib/site/storefront'
import { BalanceChecker } from './BalanceChecker'

export const dynamic = 'force-dynamic'

/**
 * Gift card balance enquiry. Public by design: the bearer code IS the
 * credential — 26^12 codes, CSPRNG-drawn — so knowing one proves holding it.
 */
export default async function GiftCardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) notFound()
  const context = await storefrontContext(siteId)
  if (!context) notFound()

  return <BalanceChecker token={token} storeName={context.storeName} />
}
