import { notFound } from 'next/navigation'
import { CheckCircle2, Trash2, Archive, ArchiveRestore } from 'lucide-react'
import { requireSiteId } from '@/lib/auth'
import { getProduct } from '@/lib/site/products'
import { listBrands, listVatRates, listPriceStructures, getCostBasis } from '@/lib/site/lookups'
import { listDepartments } from '@/lib/site/departments'
import { PageHeader } from '@/components/ui'
import ProductForm from '../ProductForm'
import { archiveProductAction, deleteProductAction } from '../actions'

export const dynamic = 'force-dynamic'

export default async function EditProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ saved?: string }>
}) {
  const { id } = await params
  const { saved } = await searchParams
  const productId = Number(id)
  if (!Number.isFinite(productId) || productId <= 0) notFound()

  const siteId = await requireSiteId()

  const [product, departments, brands, vatRates, structures, costBasis] = await Promise.all([
    getProduct(siteId, productId),
    listDepartments(siteId),
    listBrands(siteId),
    listVatRates(siteId),
    listPriceStructures(siteId),
    getCostBasis(siteId),
  ])

  if (!product) notFound()

  return (
    <>
      <PageHeader
        title="Edit product"
        subtitle={product.description}
        action={
          <div className="flex items-center gap-2">
            <form action={archiveProductAction}>
              <input type="hidden" name="id" value={product.id} />
              <input type="hidden" name="archived" value={product.isArchived ? '0' : '1'} />
              <button
                type="submit"
                className="flex items-center gap-1.5 rounded-md border border-border px-3.5 py-2 text-sm text-muted transition hover:bg-surface-2 hover:text-ink"
              >
                {product.isArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                {product.isArchived ? 'Restore' : 'Archive'}
              </button>
            </form>

            <form action={deleteProductAction}>
              <input type="hidden" name="id" value={product.id} />
              <button
                type="submit"
                className="flex items-center gap-1.5 rounded-md border border-border px-3.5 py-2 text-sm text-danger transition hover:bg-danger/10"
              >
                <Trash2 size={15} />
                Delete
              </button>
            </form>
          </div>
        }
      />

      {saved === '1' && (
        <div className="px-6 pt-4">
          <p className="flex items-center gap-2 rounded-md bg-positive/10 px-3 py-2 text-sm text-positive">
            <CheckCircle2 size={15} />
            Product saved.
          </p>
        </div>
      )}

      <div className="p-6">
        <ProductForm
          product={product}
          departments={departments}
          brands={brands}
          vatRates={vatRates}
          structures={structures}
          costBasis={costBasis}
        />
      </div>
    </>
  )
}
