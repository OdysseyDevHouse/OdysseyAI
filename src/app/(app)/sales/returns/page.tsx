import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { listSalesReasons } from '@/lib/site/salesReasons'
import { PageHeader, PageBody, Callout } from '@/components/ui'
import ReturnForm from './ReturnForm'

export const dynamic = 'force-dynamic'

export default async function ReturnsPage() {
  const { site, user, capabilities } = await requireSiteUser()

  const [tenders, reasons] = await Promise.all([
    listTenderTypes(site.id),
    listSalesReasons(site.id, 'return'),
  ])

  const allowed = can(capabilities, 'sales.credit_note')

  return (
    <>
      <PageHeader
        title="Return without a receipt"
        subtitle="For goods coming back when the customer has no invoice"
        backHref="/sales/invoicing?status=all"
        backLabel="Invoicing"
      />

      <PageBody>
        {!allowed ? (
          <Callout
            tone="danger"
            title={`Your role${user.roleName ? ` (${user.roleName})` : ''} cannot credit a sale.`}
          >
            An owner can grant this in Setup → Permissions. Returns without a receipt are usually
            restricted deliberately.
          </Callout>
        ) : (
          <>
            <Callout tone="warning" title="Nothing caps what can be returned here.">
              Crediting an invoice can never exceed what was sold. With no invoice there is no such
              limit, so every one of these is recorded against you by name and appears on the
              exception report. Use the invoice where there is one — Sales → Invoicing → the sale →
              Credit.
            </Callout>

            <ReturnForm tenders={tenders.filter((t) => t.allowsRefund)} reasons={reasons} />
          </>
        )}
      </PageBody>
    </>
  )
}
