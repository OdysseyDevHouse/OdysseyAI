import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listLeaveTypes } from '@/lib/site/leave'
import { PageHeader, PageBody, Card, Icons } from '@/components/ui'
import LeaveTypesScreen from './LeaveTypesScreen'

export const dynamic = 'force-dynamic'

/**
 * Leave types — what each kind of leave grants, and how it arrives.
 *
 * Sits with the staff module rather than under Setup for the same reason pay
 * rules does: it is configuration that decides what every figure on the leave
 * screens comes to, and it is not opened in the course of a normal week. The
 * Setup hub lists it, which is where somebody goes looking.
 *
 * Guarded on `staff.edit` — the capability that already governs correcting
 * somebody's leave. A person who may not amend one person's balance must not
 * be able to change what everybody accrues. The URL is typeable and the
 * actions check the same capability again; a hidden menu entry is not a
 * boundary.
 */
export default async function LeaveTypesPage() {
  const { site, capabilities } = await requireSiteUser()

  const canEdit = can(capabilities, 'staff.edit')
  const canView = canEdit || can(capabilities, 'staff.view_all')

  if (!canView) {
    return (
      <>
        <PageHeader title="Leave types" />
        <PageBody>
          <Card>
            <div className="flex items-start gap-3 px-6 py-4">
              <Icons.Info size={18} className="mt-0.5 shrink-0 text-muted" />
              <div className="text-sm">
                <p className="font-medium text-ink">These are not yours to see.</p>
                <p className="text-muted">
                  Leave types decide what everybody accrues. An owner can grant sight of them in
                  Setup &rarr; Roles.
                </p>
              </div>
            </div>
          </Card>
        </PageBody>
      </>
    )
  }

  const types = await listLeaveTypes(site.id)

  return (
    <>
      <PageHeader
        title="Leave types"
        subtitle="What each kind of leave grants, and how it arrives"
      />

      <PageBody>
        <Card>
          <div className="flex items-start gap-3 px-6 py-4">
            <Icons.Info size={18} className="mt-0.5 shrink-0 text-muted" />
            <div className="text-sm">
              <p className="font-medium text-ink">
                The Basic Conditions of Employment Act sets the floor, not the ceiling.
              </p>
              <p className="text-muted">
                Annual leave is 21 consecutive days a cycle (section 20), sick leave six weeks per
                36 months (section 22), and family responsibility 3 days a year (section 27). The
                figures below start at those minimums so a store that changes nothing is compliant
                on its first day — but a store may be more generous, and many are.
              </p>
              <p className="mt-1 text-muted">
                The defaults assume a <strong className="font-medium text-ink">five-day week</strong>.
                On a six-day week the same entitlement works out higher — 1.75 days a month for
                annual leave rather than 1.25 — so those stores need to raise it here.
              </p>
            </div>
          </div>
        </Card>

        <LeaveTypesScreen types={types} canEdit={canEdit} />
      </PageBody>
    </>
  )
}
