import { requireStoreId } from '@/lib/auth'
import { PageHeader, Card } from '@/components/ui'
import SupplierForm from '../SupplierForm'

export const dynamic = 'force-dynamic'

export default async function NewSupplierPage() {
  await requireStoreId()

  return (
    <>
      <PageHeader title="New supplier" subtitle="Add a supplier for this store." />
      <div className="p-6">
        <Card>
          <SupplierForm supplier={null} />
        </Card>
      </div>
    </>
  )
}
