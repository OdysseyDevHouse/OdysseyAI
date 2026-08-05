import { requireSiteId } from '@/lib/auth'
import { listCustomerGroups, listSalesReps, listCustomerCategories } from '@/lib/site/customerLookups'
import { PageHeader } from '@/components/ui'
import CustomerForm from '../CustomerForm'

export const dynamic = 'force-dynamic'

export default async function NewCustomerPage() {
  const siteId = await requireSiteId()

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
