import { notFound } from 'next/navigation'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext } from '@/lib/site/storefront'
import { passwordResetValid } from '@/lib/site/customerAuth'
import { Card } from '@/components/ui'
import { ResetForm } from './ResetForm'

export const dynamic = 'force-dynamic'

export default async function ResetPage({
  params,
}: {
  params: Promise<{ token: string; resetToken: string }>
}) {
  const { token, resetToken } = await params
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) notFound()
  const context = await storefrontContext(siteId)
  if (!context || !context.settings.allowAccount) notFound()

  const valid = await passwordResetValid(siteId, resetToken)
  if (!valid) {
    return (
      <Card className="mx-auto max-w-md">
        <div className="flex flex-col gap-2 p-5">
          <h1 className="text-lg font-semibold text-ink">That link has expired</h1>
          <p className="text-sm text-muted">
            Reset links work once, for an hour. Request another and try again.
          </p>
          <a
            href={`/store/${token}/account/forgot`}
            className="text-sm text-brand hover:underline"
          >
            Request a new link
          </a>
        </div>
      </Card>
    )
  }

  return <ResetForm token={token} resetToken={resetToken} />
}
