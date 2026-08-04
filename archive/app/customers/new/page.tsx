import { requireStoreId } from '@/lib/auth'
import { PageHeader, Card } from '@/components/ui'
import CustomerForm from '../CustomerForm'

export const dynamic = 'force-dynamic'

export default async function NewCustomerPage() {
  await requireStoreId()

  return (
    <>
      <PageHeader title="New customer" subtitle="Add a customer account for this store." />
      <div className="p-6">
        <Card>
          <CustomerForm customer={null} />
        </Card>
      </div>
    </>
  )
}
