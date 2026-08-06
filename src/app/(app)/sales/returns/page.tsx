import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { PageHeader, PageBody, Card, Icons } from '@/components/ui'
import ReturnForm from './ReturnForm'

export const dynamic = 'force-dynamic'

export default async function ReturnsPage() {
  const { site, user, capabilities } = await requireSiteUser()

  const tenders = await listTenderTypes(site.id)

  const allowed = can(capabilities, 'sales.credit_note')

  return (
    <>
      <PageHeader
        title="Return without a receipt"
        subtitle="For goods coming back when the customer has no invoice"
        backHref="/sales"
        backLabel="Sales"
      />

      <PageBody>
        {!allowed ? (
          <Card>
            <div className="flex items-start gap-3 px-6 py-4">
              <Icons.Ban size={18} className="mt-0.5 shrink-0 text-danger" />
              <div>
                <p className="font-medium text-ink">
                  Your role{user.roleName ? ` (${user.roleName})` : ''} cannot credit a sale.
                </p>
                <p className="text-sm text-muted">
                  An owner can grant this in Setup → Permissions. Returns without a receipt are
                  usually restricted deliberately.
                </p>
              </div>
            </div>
          </Card>
        ) : (
          <>
            <Card>
              <div className="flex items-start gap-3 px-6 py-4">
                <Icons.StatusWarning size={18} className="mt-0.5 shrink-0 text-warning" />
                <div className="text-sm">
                  <p className="font-medium text-ink">Nothing caps what can be returned here.</p>
                  <p className="text-muted">
                    Crediting an invoice can never exceed what was sold. With no invoice there is no
                    such limit, so every one of these is recorded against you by name and appears on
                    the exception report. Use the invoice where there is one — Sales → Documents →
                    the sale → Credit.
                  </p>
                </div>
              </div>
            </Card>

            <ReturnForm tenders={tenders.filter((t) => t.allowsRefund)} />
          </>
        )}
      </PageBody>
    </>
  )
}
