import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext } from '@/lib/site/storefront'
import { getCustomerSession } from '@/lib/customerSession'
import { listCustomerAddresses } from '@/lib/site/customerAddresses'
import AddressesClient from './AddressesClient'

export const dynamic = 'force-dynamic'

/** The shopper's delivery address book — checkout offers these to pick from. */
export default async function AddressesPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) notFound()
  const context = await storefrontContext(siteId)
  if (!context || !context.settings.allowAccount) notFound()

  const session = await getCustomerSession(siteId)
  if (!session) redirect(`/store/${token}/account`)

  const addresses = await listCustomerAddresses(siteId, session.customerId, { kind: 'delivery' })

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold text-ink">Delivery addresses</h1>
        <p className="mt-0.5 text-sm text-muted">
          Saved here, offered at checkout — the default is filled in for you.
        </p>
      </div>

      <AddressesClient
        token={token}
        addresses={addresses.map((a) => ({
          id: a.id,
          label: a.label,
          line1: a.line1 ?? '',
          line2: a.line2 ?? '',
          city: a.city ?? '',
          postalCode: a.postalCode ?? '',
          notes: a.notes ?? '',
          isDefault: a.isDefault,
        }))}
      />

      <Link href={`/store/${token}/account`} className="text-sm text-brand hover:underline">
        ← Back to your account
      </Link>
    </div>
  )
}
