import { requireCapability } from '@/lib/auth'
import { listSupplierCategories } from '@/lib/site/customerLookups'
import { PageHeader } from '@/components/ui'
import SupplierForm from '../SupplierForm'

export const dynamic = 'force-dynamic'

export default async function NewSupplierPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('suppliers.edit')
  const categories = await listSupplierCategories(siteId)

  return (
    <>
      <PageHeader title="New supplier" backHref="/suppliers" backLabel="Suppliers" />
      <SupplierForm supplier={null} categories={categories} />
    </>
  )
}
