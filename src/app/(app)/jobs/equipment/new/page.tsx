import { requireCapability } from '@/lib/auth'
import { listAssetTypes } from '@/lib/site/jobAssets'
import { listCustomers } from '@/lib/site/customers'
import { PageHeader, PageBody } from '@/components/ui'
import EquipmentForm from '../EquipmentForm'

export const dynamic = 'force-dynamic'

/**
 * Record a piece of customer equipment.
 *
 * `jobs.edit`, not `jobs.setup`: a technician who finds an undocumented unit on
 * site should be able to record it there and then. Making that an administrator
 * task means it gets written on the back of a hand instead.
 */
export default async function NewEquipmentPage() {
  const { siteId } = await requireCapability('jobs.edit')

  const [types, customers] = await Promise.all([
    listAssetTypes(siteId, false),
    // A plain list, because equipment is recorded against an existing account or
    // against nobody. Creating a customer from here would be a second form inside
    // the first, and /customers/new already exists.
    listCustomers(siteId, { limit: 500 }),
  ])

  return (
    <>
      <PageHeader
        title="Add equipment"
        subtitle="Something we look after for a customer — or something in the workshop nobody has claimed yet."
      />
      <PageBody>
        <EquipmentForm
          asset={null}
          types={types.map((t) => ({
            id: t.id,
            name: t.name,
            identifierLabel: t.identifierLabel,
          }))}
          customers={customers.items.map((c) => ({ id: c.id, name: c.name }))}
          initialAddresses={[]}
        />
      </PageBody>
    </>
  )
}
