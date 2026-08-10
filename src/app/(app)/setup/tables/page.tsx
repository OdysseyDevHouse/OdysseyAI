import { requireCapability } from '@/lib/auth'
import { listTables } from '@/lib/site/posTables'
import { getSetting } from '@/lib/site/settings'
import { PageHeader, PageBody } from '@/components/ui'
import { listRooms, listFeatures } from '@/lib/site/posFloor'
import TablesClient from './TablesClient'
import FloorDesigner from './FloorDesigner'

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

  const [tables, mode, rooms, features] = await Promise.all([
    listTables(siteId),
    getSetting(siteId, 'pos_mode'),
    listRooms(siteId),
    listFeatures(siteId),
  ])
  const hospitality = mode === 'hospitality'

  return (
    <>
      <PageHeader
        title="Tables"
        subtitle="The floor a waiter sees, and whether the till shows it at all"
      />
      <PageBody>
        <TablesClient tables={tables} hospitality={hospitality} />
        {/*
          The designer, BELOW the list and only in hospitality mode.
          Below because the list is what has to exist first — somebody must be able to add
          a table without dragging one — and because a retail shop has no floor to draw. In
          that order the screen reads as "these are the tables, and here is where they
          stand", which is the order a manager builds them in.
        */}
        {hospitality && (
          <FloorDesigner tables={tables} rooms={rooms} features={features} />
        )}
      </PageBody>
    </>
  )
}
