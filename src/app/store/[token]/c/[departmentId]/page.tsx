import Link from 'next/link'
import type { Metadata } from 'next'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import {
  publishedDepartments,
  publishedProducts,
  storefrontContext,
} from '@/lib/site/storefront'
import { getPublishedLayout } from '@/lib/site/storefrontLayout'
import { Icons } from '@/components/ui'
import CategoryBrowser from './CategoryBrowser'

/**
 * One department.
 *
 * ── KEYED ON ID, NEVER NAME ──────────────────────────────────────────────
 *
 * Department names contain slashes, ampersands and apostrophes, and they get
 * renamed. A link a shopper saved or a shop put on a poster must keep working
 * through a rename, which a name-keyed URL cannot do.
 *
 * ── A DEPARTMENT NOBODY PUBLISHES LOOKS LIKE ONE THAT NEVER EXISTED ──────
 *
 * Same message either way, deliberately. Distinguishing them would let anyone
 * enumerate which departments a shop has but keeps private.
 */

export const dynamic = 'force-dynamic'

/** Enough to browse without paging; far short of rendering a 900-product wall. */
const MAX_PRODUCTS = 120

async function resolve(token: string, departmentId: string) {
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return null
  const context = await storefrontContext(siteId)
  if (!context) return null

  const id = Number(departmentId)
  if (!Number.isInteger(id) || id <= 0) return null

  // Must be a department the shop actually publishes — not merely one that
  // exists. `publishedDepartments` already applies the publish rules.
  const department = (await publishedDepartments(context)).find((d) => d.id === id)
  if (!department) return null

  return { context, department }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string; departmentId: string }>
}): Promise<Metadata> {
  const { token, departmentId } = await params
  const found = await resolve(token, departmentId)
  if (!found) return { title: 'Not found', robots: { index: false, follow: false } }

  return {
    title: `${found.department.name} · ${found.context.storeName}`,
    robots: { index: false, follow: false },
  }
}

export default async function DepartmentPage({
  params,
}: {
  params: Promise<{ token: string; departmentId: string }>
}) {
  const { token, departmentId } = await params
  const found = await resolve(token, departmentId)

  /*
   * Rendered inline rather than notFound(). A not-found boundary would lose
   * the shop's own chrome, and a shopper who mistypes a link should land in
   * the shop they were heading for, not on a bare error page.
   */
  if (!found) {
    return (
      <div className="py-10 text-center">
        <h1 className="text-lg font-semibold text-ink">We couldn&rsquo;t find that department</h1>
        <p className="mt-2 text-sm text-muted">
          It may have been taken off the online store.
        </p>
        <Link
          href={`/store/${token}`}
          className="mt-5 inline-block text-sm font-medium text-brand hover:underline"
        >
          Browse everything
        </Link>
      </div>
    )
  }

  const { context, department } = found
  // The grid/list choice lives on the THEME, with the rest of the shop's
  // appearance — it is a look, not a rule about what may be sold.
  const [products, layout] = await Promise.all([
    publishedProducts(context, { departmentId: department.id, limit: MAX_PRODUCTS }),
    getPublishedLayout(context.siteId),
  ])

  return (
    <div>
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-sm">
        <Link href={`/store/${token}`} className="font-medium text-brand hover:underline">
          All products
        </Link>
        <Icons.ChevronRight size={14} className="shrink-0 text-muted" aria-hidden />
        <span aria-current="page" className="text-ink">
          {department.name}
        </span>
      </nav>

      <h1 className="mt-2 text-xl font-semibold text-ink">{department.name}</h1>

      <CategoryBrowser
        token={token}
        departmentName={department.name}
        products={products}
        layout={layout.theme.productLayout}
        showStock={context.settings.showStock}
        showPhotos={context.settings.showPhotos}
        showBrands={context.settings.showBrands}
      />

      {/* Said only when the cap actually bit, so a small department never sees
          a message about paging that does not apply to it. */}
      {products.length === MAX_PRODUCTS && (
        <p className="mt-5 text-center text-xs text-muted">
          Showing the first {MAX_PRODUCTS}. Use the search above to narrow it down.
        </p>
      )}
    </div>
  )
}
