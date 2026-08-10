import { requireCapability } from '@/lib/auth'
import { listTables } from '@/lib/site/posTables'
import { getSetting } from '@/lib/site/settings'
import { PageHeader, PageBody } from '@/components/ui'
import { listRooms, listFeatures } from '@/lib/site/posFloor'
import { listVisitTypes } from '@/lib/site/visitTypes'
import TablesClient from './TablesClient'
import FloorDesigner from './FloorDesigner'
import VisitTypesCard from './VisitTypesCard'

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

  const [tables, mode, rooms, features, visitTypes] = await Promise.all([
    listTables(siteId),
    getSetting(siteId, 'pos_mode'),
    listRooms(siteId),
    listFeatures(siteId),
    /* Everything, not just the active ones — a hidden type has to be visible here in
       order to be brought back, the same rule the quick-key designer follows. */
    listVisitTypes(siteId),
  ])
  const hospitality = mode === 'hospitality'

  return (
    <>
      <PageHeader
        title="Tables"
        subtitle="The floor a waiter sees, and whether the till shows it at all"
      />
      <PageBody>
        <TablesClient tables={tables} hospitality={hospitality} visitTypes={visitTypes} />
        {/*
          The designer, BELOW the list and only in hospitality mode.
          Below because the list is what has to exist first — somebody must be able to add
          a table without dragging one — and because a retail shop has no floor to draw. In
          that order the screen reads as "these are the tables, and here is where they
          stand", which is the order a manager builds them in.
        */}
        {/* Only in hospitality mode, and above the designer: how service is filed is a
            decision about the FLOOR, so it belongs with the tables rather than after the
            drawing of them. A counter shop has no visits to type. */}
        {hospitality && <VisitTypesCard types={visitTypes} />}
        {hospitality && (
          <FloorDesigner tables={tables} rooms={rooms} features={features} />
        )}
      </PageBody>
    </>
  )
}
