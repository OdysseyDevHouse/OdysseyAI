import { notFound } from 'next/navigation'
import { AlertCircle } from 'lucide-react'
import { requireStoreId, requireSession, canEdit } from '@/lib/auth'
import { getCustomer } from '@/lib/customers'
import { formatMoney } from '@/lib/decimals'
import { PageHeader, Card, StatTile } from '@/components/ui'
import CustomerForm from '../CustomerForm'
import { deactivateCustomerAction } from '../actions'

export const dynamic = 'force-dynamic'

export default async function EditCustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ error?: string }>
}) {
  const { id } = await params
  const { error } = await searchParams
  const customerId = Number(id)
  if (!Number.isFinite(customerId) || customerId <= 0) notFound()

  const storeId = await requireStoreId()
  const session = await requireSession()
  const customer = await getCustomer(storeId, customerId)
  if (!customer) notFound()

  return (
    <>
      <PageHeader
        title={customer.name}
        subtitle={customer.code}
        action={
          canEdit(session) && customer.isActive ? (
            <form action={deactivateCustomerAction}>
              <input type="hidden" name="id" value={customer.id} />
              <button
                type="submit"
                className="rounded-md border border-border px-3.5 py-2 text-sm text-danger transition hover:bg-danger/10"
              >
                Deactivate
              </button>
            </form>
          ) : null
        }
      />

      {error && (
        <div className="px-6 pt-4">
          <p
            role="alert"
            className="flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            <AlertCircle size={15} />
            {error}
          </p>
        </div>
      )}

      <div className="grid gap-4 p-6 sm:grid-cols-3">
        <StatTile
          label="Balance"
          value={formatMoney(customer.balance)}
          tone={customer.overLimit ? 'danger' : 'default'}
        />
        <StatTile label="Credit limit" value={formatMoney(customer.creditLimit)} />
        <StatTile
          label="Available credit"
          value={formatMoney(customer.availableCredit)}
          tone={customer.availableCredit > 0 ? 'positive' : 'warning'}
        />
      </div>

      <div className="px-6 pb-6">
        <Card>
          <CustomerForm customer={customer} />
        </Card>
      </div>
    </>
  )
}
