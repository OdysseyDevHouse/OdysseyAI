import { requireModuleCapability } from '@/lib/auth'
import { listOrderStatuses, statusOrderCounts } from '@/lib/site/onlineStore'
import { isConfiguredFor } from '@/lib/mail'
import { PageHeader, PageBody } from '@/components/ui'
import OrderStatuses from './OrderStatuses'

/**
 * The order pipeline and its notifications.
 *
 * Statuses are read INCLUDING the switched-off ones: retiring a status must
 * not make it vanish from the screen where it is managed, and orders sitting
 * in one still need their label explained.
 */

export const dynamic = 'force-dynamic'

export default async function StatusesPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('online_store', 'online.edit')

  const [statuses, counts] = await Promise.all([
    listOrderStatuses(siteId),
    statusOrderCounts(siteId),
  ])

  return (
    <>
      <PageHeader
        title="Order statuses"
        subtitle="The steps an order moves through, and what each one tells the customer"
      />
      <PageBody>
        <OrderStatuses
          statuses={statuses}
          orderCounts={Object.fromEntries(counts)}
          // Checked here rather than in the client: whether SMTP is set up is
          // a server fact, and a screen that promised to send when it cannot
          // would be worse than one that says so up front.
          mailConfigured={await isConfiguredFor(siteId)}
        />
      </PageBody>
    </>
  )
}
