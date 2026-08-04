import { requireStoreId } from '@/lib/auth'
import { listDepartments, listVatRates } from '@/lib/lookups'
import { listSuppliers } from '@/lib/suppliers'
import { PageHeader, Card } from '@/components/ui'
import ProductForm from '../ProductForm'

export const dynamic = 'force-dynamic'

export default async function NewProductPage() {
  const storeId = await requireStoreId()

  const [departments, suppliers, vatRates] = await Promise.all([
    listDepartments(storeId),
    listSuppliers(storeId, { limit: 500 }),
    listVatRates(storeId),
  ])

  return (
    <>
      <PageHeader title="New product" subtitle="Create a product for this store." />
      <div className="p-6">
        <Card>
          <ProductForm
            product={null}
            departments={departments}
            suppliers={suppliers.items}
            vatRates={vatRates}
          />
        </Card>
      </div>
    </>
  )
}
