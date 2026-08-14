import { notFound } from 'next/navigation'
import Link from 'next/link'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext } from '@/lib/site/storefront'
import { customerAccount, customerOrders } from '@/lib/site/customerAuth'
import { getCustomerSession } from '@/lib/customerSession'
import { Badge, Card, EmptyState, Icons } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { ChangePasswordForm, SignInForm, SignOutButton } from './AccountClient'

/**
 * The customer's own account.
 *
 * Signed out it is a sign-in form; signed in it is their balance, their credit
 * and their own orders. Nothing here is reachable without the session cookie,
 * and every figure is read fresh — a hold staff applied this morning shows up
 * on the next page load rather than at the next sign-in.
 */

export const dynamic = 'force-dynamic'

export default async function AccountPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) notFound()
  const context = await storefrontContext(siteId)
  if (!context) notFound()

  // A shop that does not offer accounts has no account page. 404 rather than
  // an explanation, so the URL cannot be used to ask which shops do.
  if (!context.settings.allowAccount) notFound()

  const session = await getCustomerSession(siteId)
  if (!session) {
    return <SignInForm token={token} storeName={context.storeName} />
  }

  const [account, orders] = await Promise.all([
    customerAccount(siteId, session.customerId),
    customerOrders(siteId, session.customerId),
  ])

  // Signed in, but the customer has since been removed. Treat as signed out.
  if (!account) return <SignInForm token={token} storeName={context.storeName} />

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-ink">{account.name}</h1>
          <p className="mt-0.5 text-sm text-muted">{account.email}</p>
        </div>
        <SignOutButton token={token} />
      </div>

      <Card>
        <div className="flex flex-col gap-3 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <span className="text-sm text-muted">Your account</span>
            {account.accountOpen ? (
              <Badge tone="success">Open</Badge>
            ) : (
              <Badge tone="danger">On hold</Badge>
            )}
          </div>

          <p className="text-sm text-ink">
            <span className="numeric text-2xl font-semibold">
              {formatMoney(account.availableCredit)}
            </span>
            <span className="ml-2 text-muted">available to spend</span>
          </p>

          {!account.accountOpen && (
            <p className="text-sm text-muted">
              Please contact {context.storeName} — new orders cannot go on this account
              until it is settled.
            </p>
          )}

          <div className="flex flex-wrap gap-4 border-t border-border pt-3 text-sm">
            <Link href={`/store/${token}/account/statement`} className="text-brand hover:underline">
              Statement &amp; invoices
            </Link>
            <Link href={`/store/${token}/account/addresses`} className="text-brand hover:underline">
              Delivery addresses
            </Link>
          </div>

          <div className="border-t border-border pt-3">
            <ChangePasswordForm token={token} required={session.mustChange} />
          </div>
        </div>
      </Card>

      <div>
        <h2 className="mb-3 text-base font-semibold text-ink">Your orders</h2>
        {orders.length === 0 ? (
          <EmptyState
            icon={<Icons.Receipt size={22} />}
            title="No orders yet"
            hint="Anything you order here will show up in this list."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {orders.map((order) => (
              <li
                key={order.id}
                className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface px-4 py-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="numeric block text-sm font-medium text-ink">
                    {order.orderNumber}
                  </span>
                  <span className="block text-xs text-muted">
                    {order.placedAt
                      ? order.placedAt.toLocaleDateString('en-ZA')
                      : 'Just now'}{' '}
                    · {order.fulfilment === 'deliver' ? 'Delivery' : 'Collection'}
                  </span>
                </span>
                {order.onAccount && <Badge tone="brand">On account</Badge>}
                <Badge tone="neutral">{order.statusName}</Badge>
                <span className="numeric text-sm font-medium text-ink">
                  {formatMoney(order.totalIncl)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Link href={`/store/${token}`} className="text-sm text-brand hover:underline">
        ← Back to the shop
      </Link>
    </div>
  )
}
