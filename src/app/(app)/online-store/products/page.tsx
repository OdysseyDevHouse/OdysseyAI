import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import {
  getOnlineSettings,
  getPublishCounts,
  listProductVisibility,
} from '@/lib/site/onlineStore'
import { listDepartments, departmentPath, descendantIds } from '@/lib/site/departments'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  ButtonLink,
  Card,
  FilterChip,
  Icons,
  LinkSegmentedControl,
  LinkSelect,
  PageBody,
  PageHeader,
  Pagination,
  SearchBar,
  TableToolbar,
} from '@/components/ui'
import ProductVisibilityList from './ProductVisibilityList'

/**
 * Which individual products the online store shows.
 *
 * VISIBILITY ONLY, exactly like the department screen beside it: names, prices
 * and everything else belong to the Inventory product screen, which owns those
 * columns and shares them with the till.
 *
 * This screen is what makes 'flagged' publish mode usable at all. The column it
 * writes has existed since 034_online_store.sql and the storefront has always
 * read it, but nothing could SET it — so choosing "only products I tick" left
 * an owner with a permanently empty shop and no way out.
 */

export const dynamic = 'force-dynamic'

/** Rows per page. Matches the Inventory product list. */
const PAGE_SIZE = 50

export default async function OnlineProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; department?: string; show?: string; page?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('online.edit')
  const params = await searchParams
  const { q, department, show } = params

  const departments = await listDepartments(siteId, true)

  // Filtering by a department includes everything beneath it, so picking
  // "Fresh Produce" does not hide what is filed under its sub-levels.
  const departmentId = Number(department)
  const filterIds =
    Number.isFinite(departmentId) && departmentId > 0
      ? [...descendantIds(departments, departmentId)]
      : undefined

  const only = show === 'shown' ? 'shown' : show === 'hidden' ? 'hidden' : undefined
  const page = pageFrom(params.page)

  const [{ items, total }, counts, settings] = await Promise.all([
    listProductVisibility(siteId, {
      search: q,
      departmentIds: filterIds,
      only,
      limit: PAGE_SIZE,
      offset: offsetFor(page, PAGE_SIZE),
    }),
    getPublishCounts(siteId),
    getOnlineSettings(siteId),
  ])

  const filterLabel = filterIds ? departmentPath(departments, departmentId) : null

  const href = hrefBuilder('/online-store/products', params)
  // Any filter change returns to page 1 — page 7 of the old result set is
  // rarely a page of the new one.
  const filterHref = (changes: Record<string, string | null>) => href({ ...changes, page: null })

  const empty = q
    ? {
        title: `Nothing matches “${q}”`,
        hint: 'Check the spelling, or search by code or barcode.',
        action: (
          <ButtonLink variant="secondary" href={filterHref({ q: null })}>
            Clear search
          </ButtonLink>
        ),
      }
    : filterLabel || only
      ? {
          title: 'No products match this filter',
          hint: 'Nothing on file fits the current slice.',
          action: (
            <ButtonLink variant="secondary" href="/online-store/products">
              Clear filters
            </ButtonLink>
          ),
        }
      : {
          title: 'No products to publish',
          hint: 'Only stocked and returnable products can be sold online. Add some to your product file first.',
          action: (
            <ButtonLink variant="secondary" href="/products">
              Go to products
            </ButtonLink>
          ),
        }

  return (
    <>
      <PageHeader title="Products" subtitle="What your online store shows" />

      <PageBody>
        <TableToolbar>
          <div className="w-80 max-w-full">
            <SearchBar
              action="/online-store/products"
              defaultValue={q}
              placeholder="Search description, code or barcode…"
              className="p-0"
              /* A GET form submits only its own fields, so without these a
                 search would silently clear whichever filters were applied. */
              keep={{ department, show }}
            />
          </div>

          {/* Options carry their own href, built on the server: a function
              prop cannot cross into a client component, and this keeps the URL
              helpers out of the browser bundle entirely. */}
          <LinkSelect
            aria-label="Filter by department"
            icon={<Icons.LayoutGrid size={16} />}
            value={department ?? ''}
            options={[
              { value: '', label: 'All departments', href: filterHref({ department: null }) },
              ...departments.map((d) => ({
                value: String(d.id),
                label: departmentPath(departments, d.id),
                href: filterHref({ department: String(d.id) }),
              })),
            ]}
          />

          <LinkSegmentedControl
            aria-label="Filter by visibility"
            value={only ?? 'all'}
            options={[
              { value: 'all', label: 'All', href: filterHref({ show: null }) },
              { value: 'shown', label: 'Ticked', href: filterHref({ show: 'shown' }) },
              { value: 'hidden', label: 'Not ticked', href: filterHref({ show: 'hidden' }) },
            ]}
          />

          {filterLabel && (
            <FilterChip
              label="Department"
              value={filterLabel}
              clearHref={filterHref({ department: null })}
            />
          )}
        </TableToolbar>

        {/* The mode this screen serves. Ticking products does nothing under
            "departments" or "all", and finding that out from an unchanged
            storefront would be maddening — the same warning the department
            screen carries, pointing the other way. */}
        {settings.publishMode !== 'flagged' && (
          <Card>
            <div className="flex items-start gap-3 px-6 py-4">
              <Icons.StatusWarning size={18} className="mt-0.5 shrink-0 text-warning" />
              <div className="text-sm">
                <p className="font-medium text-ink">
                  These ticks are not what decides your catalogue right now.
                </p>
                <p className="text-muted">
                  Your store publishes{' '}
                  {settings.publishMode === 'all'
                    ? 'everything in your product file'
                    : 'every product in a ticked department'}
                  . Switch to “Only products I tick” for this screen to take effect.{' '}
                  <Link
                    href="/online-store/setup"
                    className="font-medium text-brand hover:underline"
                  >
                    Go to setup
                  </Link>
                </p>
              </div>
            </div>
          </Card>
        )}

        <Card>
          <ProductVisibilityList
            items={items}
            total={total}
            counts={counts}
            publishMode={settings.publishMode}
            departmentPaths={Object.fromEntries(
              departments.map((d) => [d.id, departmentPath(departments, d.id)]),
            )}
            // What "show/hide all" acts on: exactly the slice on screen.
            filter={{ search: q, departmentIds: filterIds, only }}
            empty={empty}
          />

          <Pagination
            page={page}
            pageCount={pageCountFor(total, PAGE_SIZE)}
            total={total}
            pageSize={PAGE_SIZE}
            hrefFor={(next) => href({ page: next === 1 ? null : next })}
          />
        </Card>
      </PageBody>
    </>
  )
}
