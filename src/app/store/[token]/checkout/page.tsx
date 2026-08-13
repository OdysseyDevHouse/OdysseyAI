import { notFound } from 'next/navigation'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext } from '@/lib/site/storefront'
import { customerAccount } from '@/lib/site/customerAuth'
import { getCustomerSession } from '@/lib/customerSession'
import { defaultAddressFor } from '@/lib/site/customerAddresses'
import { getCustomer } from '@/lib/site/customers'
import TrackEvent from '../TrackEvent'
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

  /*
   * The account is resolved here, server-side, and only what the checkout
   * needs to DRAW is sent: the name, whether it is open, and how much credit
   * is left. Whether the order may actually go on it is decided again when the
   * order is placed — this is for the panel, not for the decision.
   */
  const session = settings.allowAccount ? await getCustomerSession(siteId) : null
  const account = session ? await customerAccount(siteId, session.customerId) : null

  /*
   * The delivery prefill: the address book's default delivery address, falling
   * back to the account's own billing columns. Prefill ONLY — what is typed at
   * checkout goes on this order and never back onto the customer record.
   */
  let delivery: { line1: string; suburb: string; postcode: string; notes: string } | null = null
  if (session) {
    const book = await defaultAddressFor(siteId, session.customerId, 'delivery').catch(() => null)
    if (book) {
      delivery = {
        line1: book.line1 ?? '',
        suburb: book.line2 ?? book.city ?? '',
        postcode: book.postalCode ?? '',
        notes: book.notes ?? '',
      }
    } else {
      const customer = await getCustomer(siteId, session.customerId).catch(() => null)
      if (customer?.addressLine1) {
        delivery = {
          line1: customer.addressLine1,
          suburb: customer.addressLine2 ?? customer.city ?? '',
          postcode: customer.postalCode ?? '',
          notes: '',
        }
      }
    }
  }

  return (
    <>
      {/* Reaching checkout is a funnel stage in its own right: the gap between
          this and "Ordered" is where a shop finds out its delivery fee or its
          minimum is losing baskets. */}
      <TrackEvent token={token} kind="begin_checkout" />

      <Checkout
        token={token}
        collectEnabled={settings.collectEnabled}
        deliverEnabled={settings.deliverEnabled}
        minOrderIncl={settings.minOrderIncl}
        leadTimeMinutes={settings.leadTimeMinutes}
        payOnline={settings.paymentMode === 'online'}
        allowAccount={settings.allowAccount}
        storeName={context.storeName}
        account={
          account && {
            name: account.name,
            phone: account.phone,
            email: account.email,
            availableCredit: account.availableCredit,
            accountOpen: account.accountOpen,
            delivery,
          }
        }
      />
    </>
  )
}
