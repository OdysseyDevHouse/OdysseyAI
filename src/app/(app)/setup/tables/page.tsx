import { requireCapability } from '@/lib/auth'
import { listTables } from '@/lib/site/posTables'
import { getSetting } from '@/lib/site/settings'
import { PageHeader, PageBody } from '@/components/ui'
import TablesClient from './TablesClient'

export const dynamic = 'force-dynamic'

/**
 * The floor, and the switch that turns it on.
 *
 * Both on one screen because they are one decision: a shop that serves tables needs the
 * mode AND the tables, and splitting them across two screens is how somebody ends up with
 * a floor built and the switch off, or the switch on and nothing to show. Each state has
 * its own note on the screen for exactly that reason.
 */
export default async function TablesPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  const [tables, mode] = await Promise.all([
    listTables(siteId),
    getSetting(siteId, 'pos_mode'),
  ])

  return (
    <>
      <PageHeader
        title="Tables"
        subtitle="The floor a waiter sees, and whether the till shows it at all"
      />
      <PageBody>
        <TablesClient tables={tables} hospitality={mode === 'hospitality'} />
      </PageBody>
    </>
  )
}
