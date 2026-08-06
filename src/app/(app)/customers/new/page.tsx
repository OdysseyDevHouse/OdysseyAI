import { requireCapability } from '@/lib/auth'
import { listCustomerGroups, listSalesReps, listCustomerCategories } from '@/lib/site/customerLookups'
import { PageHeader } from '@/components/ui'
import CustomerForm from '../CustomerForm'

export const dynamic = 'force-dynamic'

export default async function NewCustomerPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('customers.edit')

  const [groups, reps, categories] = await Promise.all([
    listCustomerGroups(siteId),
    listSalesReps(siteId),
    listCustomerCategories(siteId),
  ])

  return (
    <>
      <PageHeader title="New customer" backHref="/customers" backLabel="Customers" />
      <CustomerForm customer={null} groups={groups} reps={reps} categories={categories} />
    </>
  )
}
