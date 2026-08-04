import { notFound } from 'next/navigation'
import { requireStoreId, requireSession, canEdit } from '@/lib/auth'
import { getProduct } from '@/lib/products'
import { listDepartments, listVatRates } from '@/lib/lookups'
import { listSuppliers } from '@/lib/suppliers'
import { PageHeader, Card } from '@/components/ui'
import ProductForm from '../ProductForm'
import { deactivateProductAction } from '../actions'

export const dynamic = 'force-dynamic'

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const productId = Number(id)
  if (!Number.isFinite(productId) || productId <= 0) notFound()

  const storeId = await requireStoreId()
  const session = await requireSession()

  const [product, departments, suppliers, vatRates] = await Promise.all([
    getProduct(storeId, productId),
    listDepartments(storeId),
    listSuppliers(storeId, { limit: 500 }),
    listVatRates(storeId),
  ])

  if (!product) notFound()

  return (
    <>
      <PageHeader
        title={product.name}
        subtitle={product.sku}
        action={
          canEdit(session) && product.isActive ? (
            <form action={deactivateProductAction}>
              <input type="hidden" name="id" value={product.id} />
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
      <div className="p-6">
        <Card>
          <ProductForm
            product={product}
            departments={departments}
            suppliers={suppliers.items}
            vatRates={vatRates}
          />
        </Card>
      </div>
    </>
  )
}
