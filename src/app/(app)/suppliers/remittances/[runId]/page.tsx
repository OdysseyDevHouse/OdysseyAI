import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { getPaymentRun, listPaymentItems } from '@/lib/site/paymentRuns'
import { isConfiguredFor } from '@/lib/mail'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Badge,
  Callout,
  Card,
  CardHeader,
  StatStrip,
  StatTile,
  Icons,
} from '@/components/ui'
import RunActions from './RunActions'
import RunItemsTable, { type RunItemRow } from './RunItemsTable'

export const dynamic = 'force-dynamic'

const RUN_STATUS_TONE = {
  draft: 'warning',
  posted: 'success',
  cancelled: 'neutral',
} as const

const RUN_STATUS_LABEL: Record<keyof typeof RUN_STATUS_TONE, string> = {
  draft: 'Draft',
  posted: 'Posted',
  cancelled: 'Cancelled',
}

export default async function PaymentRunPage({
  params,
}: {
  params: Promise<{ runId: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('purchasing.pay')
  const { runId: raw } = await params

  const runId = Number(raw)
  if (!Number.isFinite(runId) || runId <= 0) notFound()

  const [run, items] = await Promise.all([getPaymentRun(siteId, runId), listPaymentItems(siteId, runId)])
  if (!run) notFound()

  const invoiceCount = items.reduce((sum, i) => sum + i.allocations.length, 0)
  const withoutEmail = items.filter((i) => !i.email).length

  // Only plain data crosses to the client table — the invoice count is
  // computed here so the allocations themselves stay behind.
  const itemRows: RunItemRow[] = items.map((item) => ({
    id: item.id,
    supplierId: item.supplierId,
    supplierCode: item.supplierCode,
    supplierName: item.supplierName,
    email: item.email,
    remittanceStatus: item.remittanceStatus,
    remittanceError: item.remittanceError,
    invoiceCount: item.allocations.length,
    amount: item.amount,
  }))

  return (
    <>
      <PageHeader
        title={`Payment run · ${run.paymentDate}`}
        subtitle={run.reference ? `Reference ${run.reference}` : 'No bank reference'}
        backHref="/suppliers/remittances"
        backLabel="Pay suppliers"
        action={
          <>
            <Badge tone={RUN_STATUS_TONE[run.status]}>{RUN_STATUS_LABEL[run.status]}</Badge>
            <RunActions
              runId={run.id}
              status={run.status}
              mailReady={await isConfiguredFor(siteId)}
              hasItems={items.length > 0}
            />
          </>
        }
      />

      <PageBody>
        {run.status === 'draft' && (
          <Callout tone="warning" title="Nothing has been paid yet.">
            Check the allocations below, then post the run. Posting writes one payment per supplier
            and settles exactly the invoices listed.
          </Callout>
        )}

        <StatStrip columns={3}>
          <StatTile
            label="Total"
            value={formatMoney(run.totalAmount)}
            hint={
              run.status === 'posted'
                ? `Paid · ${run.postedAt?.toLocaleString('en-ZA') ?? ''}`
                : 'To be paid'
            }
            icon={<Icons.Coins size={16} />}
          />
          <StatTile
            label="Suppliers"
            value={String(items.length)}
            hint={`${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'} settled`}
            icon={<Icons.Truck size={16} />}
          />
          <StatTile
            label="Remittances sent"
            value={String(items.filter((i) => i.remittanceStatus === 'sent').length)}
            hint={withoutEmail > 0 ? `${withoutEmail} with no email` : 'All reachable'}
            tone={withoutEmail > 0 ? 'warning' : 'default'}
            icon={<Icons.Mail size={16} />}
          />
        </StatStrip>

        <Card>
          <CardHeader
            title="Who gets paid"
            description="A supplier's own invoices are on its statement; once posted, the advice PDF lists exactly what this run settled."
          />
          <RunItemsTable rows={itemRows} runId={run.id} posted={run.status === 'posted'} />
        </Card>
      </PageBody>
    </>
  )
}
