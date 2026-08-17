import { requireModuleCapability } from '@/lib/auth'
import { listCustomerGroups, listSalesReps, listCustomerCategories } from '@/lib/site/customerLookups'
import { listPriceStructures } from '@/lib/site/lookups'
import { suggestedMasterCode } from '@/lib/site/masterCodes'
import { PageHeader, PageBody } from '@/components/ui'
import CustomerForm from '../CustomerForm'

export const dynamic = 'force-dynamic'

export default async function NewCustomerPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('customers', 'customers.edit')

  const [groups, reps, categories, structures, suggestedCode] = await Promise.all([
    listCustomerGroups(siteId),
    listSalesReps(siteId),
    listCustomerCategories(siteId),
    listPriceStructures(siteId),
    // Null when auto-numbering is off — the field then behaves exactly as it
    // always has. Claims nothing, so leaving this page burns no code.
    suggestedMasterCode(siteId, 'customer'),
  ])

  return (
    <>
      <PageHeader title="New customer" backHref="/customers" backLabel="Customers" />
      <PageBody>
        <CustomerForm
          customer={null}
          groups={groups}
          reps={reps}
          categories={categories}
          structures={structures.map((s) => ({ id: s.id, name: s.name }))}
          suggestedCode={suggestedCode}
        />
      </PageBody>
    </>
  )
}
