import { Plus, CornerDownRight } from '@/components/ui/icons'
import { requireCapability } from '@/lib/auth'
import { listDepartments, flattenTree } from '@/lib/site/departments'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  ButtonLink,
  Card,
  Callout,
  EmptyState,
  Badge,
  RowTile,
  TextLink,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_ROW,
  TABLE_TD,
  TABLE_NUMERIC,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function DepartmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; deleted?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('products.view')
  const { saved, deleted } = await searchParams

  // Inactive rows are shown too — hiding them here would make a department that
  // still holds products look as though it had vanished.
  const departments = await listDepartments(siteId, true)
  const rows = flattenTree(departments)

  return (
    <>
      <PageHeader
        title="Departments"
        subtitle={`${departments.length} department${departments.length === 1 ? '' : 's'} · nest as deep as you like`}
        action={
          <PrimaryLink href="/departments/new">
            <Plus size={15} />
            New department
          </PrimaryLink>
        }
      />

      <PageBody>
        {(saved || deleted) && (
          <Callout tone="success" title={saved ? 'Department saved.' : 'Department deleted.'} />
        )}

        <Card>
          {rows.length === 0 ? (
            <EmptyState
              title="No departments yet"
              hint="Create a top-level department, then add sub-departments beneath it."
              action={
                <PrimaryLink href="/departments/new">
                  <Plus size={15} />
                  New department
                </PrimaryLink>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              {/* Hand-built rather than DataTable for ONE reason: the tree
                  indent, which per-row padding carries and DataTable cannot
                  express. It still wears the shared table skin. */}
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Department</th>
                    <th className={TABLE_TH}>Code</th>
                    <th className={`${TABLE_TH} text-right`}>Products</th>
                    <th className={`${TABLE_TH} text-right`}>Sub-departments</th>
                    <th className={TABLE_TH}>Status</th>
                    <th className={`${TABLE_TH} w-px`} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ department: d, depth }) => (
                    <tr key={d.id} className={TABLE_ROW}>
                      <td className={TABLE_TD}>
                        {/* data-kit-ok: the indent IS the hierarchy — computed
                            per row, so it cannot be a class. */}
                        <span
                          data-kit-ok
                          className="flex items-center gap-2"
                          style={{ paddingLeft: `${depth * 20}px` }}
                        >
                          {depth > 0 && (
                            <CornerDownRight size={13} className="shrink-0 text-muted opacity-60" />
                          )}
                          <RowTile label={d.name} token={d.color} />
                          <TextLink href={`/departments/${d.id}`}>{d.name}</TextLink>
                        </span>
                      </td>
                      <td className={`${TABLE_TD} text-muted`}>{d.code ?? '—'}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        {d.productCount > 0 ? (
                          <TextLink href={`/products?department=${d.id}`}>
                            {d.productCount}
                          </TextLink>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-muted`}>
                        {d.childCount > 0 ? d.childCount : <span className="text-faint">—</span>}
                      </td>
                      <td className={TABLE_TD}>
                        {/* Active is the normal state — badging it on every row
                            would drown the one Inactive that matters. */}
                        {!d.isActive && <Badge>Inactive</Badge>}
                      </td>
                      <td className={`${TABLE_TD} w-px`}>
                        <div className="flex justify-end">
                          <ButtonLink
                            href={`/departments/new?parent=${d.id}`}
                            variant="ghost"
                            size="sm"
                            iconOnly
                            aria-label={`Add sub-department under ${d.name}`}
                          >
                            <Plus size={14} />
                          </ButtonLink>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </PageBody>
    </>
  )
}
