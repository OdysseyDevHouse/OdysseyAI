import { requireCapability } from '@/lib/auth'
import { listOrderStatuses, getOnlineSettings } from '@/lib/site/onlineStore'
import { listOrders, orderCounts } from '@/lib/site/onlineOrders'
import { PageHeader, PageBody, Badge, StatStrip, StatTile } from '@/components/ui'
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
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('online.view')
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

  // The queue's headline numbers, grouped by ROLE rather than status name —
  // statuses are configurable per site, so "Preparing"/"Ready" cannot be
  // assumed to exist, but every pipeline has a new / in-progress / done shape.
  const countByRoles = (roles: string[]) =>
    statuses
      .filter((s) => roles.includes(s.role))
      .reduce((sum, s) => sum + (countMap.get(s.id) ?? 0), 0)
  const waitingCount = countByRoles(['new'])
  const inProgressCount = countByRoles(['', 'dispatched'])
  const completedCount = countByRoles(['completed'])

  return (
    <>
      <PageHeader
        title="Online orders"
        subtitle={archived ? 'Orders filed away' : 'What customers have ordered online'}
        action={
          <div className="flex items-center gap-2">
            {!settings.isEnabled && <Badge tone="warning">Store closed</Badge>}
            {waiting > 0 && <Badge tone="warning">{waiting} waiting</Badge>}
          </div>
        }
      />
      <PageBody>
        {!archived && (
          <StatStrip columns={3}>
            {/* The only tile allowed a tone: waiting orders are the ones a
                shop can lose by not noticing. The rest are plain counts. */}
            <StatTile
              label="Waiting"
              value={waitingCount.toLocaleString('en-ZA')}
              tone={waitingCount > 0 ? 'warning' : 'default'}
              hint="New orders to accept"
            />
            <StatTile
              label="In progress"
              value={inProgressCount.toLocaleString('en-ZA')}
              hint="Accepted and being worked"
            />
            <StatTile
              label="Completed"
              value={completedCount.toLocaleString('en-ZA')}
              hint="Done — file them away when handed over"
            />
          </StatStrip>
        )}
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
