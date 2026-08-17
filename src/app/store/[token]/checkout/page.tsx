import { notFound } from 'next/navigation'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext } from '@/lib/site/storefront'
import { resolveStoreRouting, rememberedBranch } from '@/lib/storeRouting'
import { tradingRules } from '@/lib/site/branchTrading'
import { collectionSlots, openState, slotLabel } from '@/lib/tradingHours'
import { customerAccount } from '@/lib/site/customerAuth'
import { getCustomerSession } from '@/lib/customerSession'
import { defaultAddressFor, listCustomerAddresses } from '@/lib/site/customerAddresses'
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

  const routing = await resolveStoreRouting(token, await rememberedBranch(token))
  if (!routing) notFound()
  const context = await storefrontContext(routing.catalogueSiteId, routing.branchSiteId)
  if (!context) notFound()

  /*
   * The BRANCH from here down. The account, the address book, the delivery
   * quote and the collection times are all this shop's commitments rather than
   * head office's — see StorefrontContext on which id answers which question.
   */
  const siteId = context.siteId
  const { settings } = context

  /*
   * When this shop is open, and the times it could have an order ready.
   *
   * Resolved HERE and handed down. A browser with a wrong clock would otherwise
   * offer a slot the kitchen has never heard of, and the shopper would be the
   * last to find out. placePublicOrder re-derives the same answer when the
   * order arrives, exactly as it re-quotes the delivery fee.
   */
  const trading = await tradingRules(siteId)
  const now = new Date()
  const open = openState(trading, now)
  const slots = collectionSlots(trading, now).slice(0, 24)

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
        /* The shop that will actually pack this. Equal to storeName for a single
           store, and the branch's own name for a chain — every sentence about
           collecting, delivering or waiting has to name the right shop. */
        branchName={context.branchName}
        /* Dates cross into a client component as strings, so they are formatted
           here where the server's clock is the one that counts. */
        collectionSlots={slots.map((s) => ({ iso: s.toISOString(), label: slotLabel(s, now) }))}
        openState={{
          state: open.state,
          note: open.state === 'paused' || open.state === 'closed' ? open.note : '',
          opensAt: open.state === 'closed' && open.opensAt ? slotLabel(open.opensAt, now) : null,
          closesAt: open.state === 'open' ? open.closesAt : null,
        }}
        account={
          account && {
            name: account.name,
            phone: account.phone,
            email: account.email,
            availableCredit: account.availableCredit,
            accountOpen: account.accountOpen,
            delivery,
            addresses: session
              ? (await listCustomerAddresses(siteId, session.customerId, { kind: 'delivery' }).catch(
                  () => [],
                )).map((a) => ({
                  id: a.id,
                  label: a.label,
                  line1: a.line1 ?? '',
                  suburb: a.line2 ?? a.city ?? '',
                  postcode: a.postalCode ?? '',
                  notes: a.notes ?? '',
                }))
              : [],
          }
        }
      />
    </>
  )
}
