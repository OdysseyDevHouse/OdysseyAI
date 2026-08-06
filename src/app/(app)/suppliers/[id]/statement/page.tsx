import { notFound } from 'next/navigation'
import { requireSite } from '@/lib/auth'
import { buildSupplierStatement, type StatementFormat } from '@/lib/statements/render'
import { PageHeader, Card, ButtonLink, Icons, LinkTabs } from '@/components/ui'
import { StatementDocument } from '@/components/statements/StatementDocument'
import { withParams } from '@/lib/searchParams'
import PeriodPicker from './PeriodPicker'

export const dynamic = 'force-dynamic'

/**
 * Where a supplier account stands, on screen.
 *
 * The creditors twin of the customer statement, and it exists for
 * reconciliation: at month-end someone holds the supplier's own statement next
 * to this one and finds the difference. That is why "Full activity" matters
 * more here than on the debtors side — the discrepancy is usually a document
 * one side has and the other does not.
 *
 * No "Send" menu. This is our record of their account, not something we issue
 * to them; what we send a supplier is a remittance advice, which lives on the
 * payment run.
 */
export default async function SupplierStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ format?: string; from?: string; to?: string }>
}) {
  const site = await requireSite()
  const { id } = await params
  const { format: formatRaw, from, to } = await searchParams

  const supplierId = Number(id)
  if (!Number.isFinite(supplierId) || supplierId <= 0) notFound()

  const format: StatementFormat = formatRaw === 'activity' ? 'activity' : 'open-item'

  const data = await buildSupplierStatement(
    site.id,
    site.displayName,
    site.vatNumber,
    supplierId,
    { format, from: iso(from), to: iso(to) },
  )
  if (!data) notFound()

  const basePath = `/suppliers/${supplierId}/statement`
  const period = { from: iso(from), to: iso(to) }

  return (
    <>
      <PageHeader
        title="Supplier account"
        subtitle={`${data.account.code} — ${data.account.name}`}
        backHref={`/suppliers/${supplierId}?tab=transactions`}
        backLabel="Account"
        action={
          <ButtonLink
            href={`/api/suppliers/${supplierId}/statement${withParams(period, { format })}`}
            variant="secondary"
          >
            <Icons.Printer size={15} />
            Open PDF
          </ButtonLink>
        }
      />

      <div className="flex flex-col gap-4 px-6 pt-4">
        <LinkTabs
          items={[
            {
              value: 'open-item',
              label: 'Open items',
              icon: <Icons.Receipt size={15} />,
              href: `${basePath}${withParams(period, { format: 'open-item' })}`,
            },
            {
              value: 'activity',
              label: 'Full activity',
              icon: <Icons.History size={15} />,
              href: `${basePath}${withParams(period, { format: 'activity' })}`,
            },
          ]}
          value={format}
          aria-label="Statement format"
        />

        {format === 'activity' && (
          <PeriodPicker basePath={basePath} from={data.period.from} to={data.period.to} />
        )}
      </div>

      <div className="px-6 pt-4 pb-10">
        <Card className="overflow-hidden">
          <StatementDocument data={data} variant="supplier-statement" />
        </Card>
      </div>
    </>
  )
}

function iso(value: string | undefined): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}
