import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireStoreId, requireSession, canEdit } from '@/lib/auth'
import { getSupplier } from '@/lib/suppliers'
import { PageHeader, Card } from '@/components/ui'
import SupplierForm from '../SupplierForm'
import { deactivateSupplierAction } from '../actions'

export const dynamic = 'force-dynamic'

export default async function EditSupplierPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supplierId = Number(id)
  if (!Number.isFinite(supplierId) || supplierId <= 0) notFound()

  const storeId = await requireStoreId()
  const session = await requireSession()
  const supplier = await getSupplier(storeId, supplierId)
  if (!supplier) notFound()

  return (
    <>
      <PageHeader
        title={supplier.name}
        subtitle={supplier.code}
        action={
          canEdit(session) && supplier.isActive ? (
            <form action={deactivateSupplierAction}>
              <input type="hidden" name="id" value={supplier.id} />
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

      {supplier.productCount > 0 && (
        <div className="px-6 pt-4 text-sm text-muted">
          Supplies{' '}
          <Link href={`/products?supplier=${supplier.id}`} className="text-brand hover:underline">
            {supplier.productCount} active product{supplier.productCount === 1 ? '' : 's'}
          </Link>
          .
        </div>
      )}

      <div className="p-6">
        <Card>
          <SupplierForm supplier={supplier} />
        </Card>
      </div>
    </>
  )
}
