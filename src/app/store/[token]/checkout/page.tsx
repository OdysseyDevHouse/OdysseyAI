import { notFound } from 'next/navigation'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext } from '@/lib/site/storefront'
import Checkout from './Checkout'

export const dynamic = 'force-dynamic'

export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) notFound()
  const context = await storefrontContext(siteId)
  if (!context) notFound()

  const { settings } = context

  return (
    <Checkout
      token={token}
      collectEnabled={settings.collectEnabled}
      deliverEnabled={settings.deliverEnabled}
      minOrderIncl={settings.minOrderIncl}
      leadTimeMinutes={settings.leadTimeMinutes}
      payOnline={settings.paymentMode === 'online'}
    />
  )
}
