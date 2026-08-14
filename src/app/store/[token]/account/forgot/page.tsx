import { notFound } from 'next/navigation'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext } from '@/lib/site/storefront'
import { ForgotForm } from './ForgotForm'

export const dynamic = 'force-dynamic'

export default async function ForgotPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) notFound()
  const context = await storefrontContext(siteId)
  if (!context || !context.settings.allowAccount) notFound()

  return <ForgotForm token={token} />
}
