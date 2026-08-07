import { requireCapability } from '@/lib/auth'
import { listSpecials, resolveSpecialItems } from '@/lib/site/specials'
import { listDepartments } from '@/lib/site/departments'
import { PageHeader, PageBody } from '@/components/ui'
import SpecialsList from './SpecialsList'

/**
 * The shop's promotions.
 *
 * Reads EVERY special, including the switched-off and finished ones: this is
 * the screen where they are managed, and a special that vanished the moment it
 * ended could not be looked at, copied or restarted.
 */

export const dynamic = 'force-dynamic'

export default async function SpecialsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('products.edit')

  const [specials, items, departments] = await Promise.all([
    listSpecials(siteId),
    // Resolved once for the whole screen rather than per special.
    resolveSpecialItems(siteId),
    listDepartments(siteId),
  ])

  return (
    <>
      <PageHeader
        title="Specials"
        subtitle="Deals the till and your online shop apply by themselves"
      />
      <PageBody>
        <SpecialsList
          specials={specials}
          items={items}
          departments={departments.map((d) => ({ id: d.id, name: d.name }))}
        />
      </PageBody>
    </>
  )
}
