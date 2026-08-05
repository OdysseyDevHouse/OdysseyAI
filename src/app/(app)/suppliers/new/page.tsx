import { requireSiteId } from '@/lib/auth'
import { listSupplierCategories } from '@/lib/site/customerLookups'
import { PageHeader } from '@/components/ui'
import SupplierForm from '../SupplierForm'

export const dynamic = 'force-dynamic'

export default async function NewSupplierPage() {
  const siteId = await requireSiteId()
  const categories = await listSupplierCategories(siteId)

  return (
    <>
      <PageHeader title="New supplier" backHref="/suppliers" backLabel="Suppliers" />
      <SupplierForm supplier={null} categories={categories} />
    </>
  )
}
