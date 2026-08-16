import { requireCapability } from '@/lib/auth'
import { listCustomerGroups } from '@/lib/site/customerLookups'
import { listPriceStructuresForSetup } from '@/lib/site/pricingSetup'
import { PageHeader, PageBody } from '@/components/ui'
import CustomerGroupsClient from './CustomerGroupsClient'

export const dynamic = 'force-dynamic'

export default async function CustomerGroupsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  // Inactive groups are shown here and nowhere else: this is the screen that
  // brings one back, so hiding them would make that impossible. Every other
  // screen calls listCustomerGroups(siteId) and gets the active ones only.
  const [groups, structures] = await Promise.all([
    listCustomerGroups(siteId, true),
    listPriceStructuresForSetup(siteId),
  ])

  return (
    <>
      <PageHeader
        title="Customer groups"
        subtitle="The terms and price structure a new account starts on. Changing a group never restates accounts that already exist."
      />
      <PageBody>
        <CustomerGroupsClient
          groups={groups}
          structures={structures.map((s) => ({ id: s.id, name: s.name, isDefault: s.isDefault }))}
        />
      </PageBody>
    </>
  )
}
