import { requireSiteId } from '@/lib/auth'
import { listOrderStatuses, getOnlineSettings } from '@/lib/site/onlineStore'
import { listOrders, orderCounts } from '@/lib/site/onlineOrders'
import { PageHeader, PageBody, Badge } from '@/components/ui'
import OrdersQueue from './OrdersQueue'

/**
 * The online order queue — what the shop works through during the day.
 *
 * Server-rendered with the whole list, because a queue is read constantly and
 * a spinner between every status change is worse than a slightly larger first
 * payload. Filtering happens client-side against rows already in hand.
 */

export const dynamic = 'force-dynamic'

export default async function OnlineOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>
}) {
  const siteId = await requireSiteId()
  const params = await searchParams
  const archived = params.archived === '1'

  const [orders, statuses, countMap, settings] = await Promise.all([
    listOrders(siteId, { archived }),
    listOrderStatuses(siteId),
    orderCounts(siteId),
    getOnlineSettings(siteId),
  ])

  // A Map does not survive the server/client boundary — it arrives as {}.
  const counts = Object.fromEntries(countMap)

  const waiting = orders.filter((o) => o.statusRole === 'new').length

  return (
    <>
      <PageHeader
        title="Online orders"
        subtitle={archived ? 'Orders filed away' : 'What customers have ordered online'}
        action={
          <div className="flex items-center gap-2">
            {!settings.isEnabled && <Badge tone="warning">Store closed</Badge>}
            {waiting > 0 && <Badge tone="brand">{waiting} waiting</Badge>}
          </div>
        }
      />
      <PageBody>
        <OrdersQueue
          orders={orders}
          statuses={statuses}
          counts={counts}
          archived={archived}
          storeOpen={settings.isEnabled}
        />
      </PageBody>
    </>
  )
}
