import { notFound, redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { getDocument } from '@/lib/site/salesDocuments'
import { creditableLines } from '@/lib/site/salesReversal'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { can } from '@/lib/site/permissions'
import { isPeriodLocked } from '@/lib/site/settings'
import { PageHeader, PageBody, Card, ButtonLink, EmptyState, Icons } from '@/components/ui'
import CreditNoteForm from './CreditNoteForm'

export const dynamic = 'force-dynamic'

export default async function CreditNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { site, capabilities } = await requireSiteUser()
  const { id } = await params

  const invoiceId = Number(id)
  if (!Number.isFinite(invoiceId) || invoiceId <= 0) notFound()

  const invoice = await getDocument(site.id, invoiceId)
  if (!invoice) notFound()

  // Permission is checked on the way in as well as at post time: offering a
  // screen someone cannot use is worse than not offering it.
  if (!can(capabilities, 'sales.credit_note')) {
    redirect(`/sales/${invoiceId}?error=${encodeURIComponent('You do not have permission to credit a sale.')}`)
  }
  if (invoice.status !== 'finalised') {
    redirect(`/sales/${invoiceId}?error=${encodeURIComponent(`A ${invoice.status} document cannot be credited.`)}`)
  }

  const [lines, tenders, locked] = await Promise.all([
    creditableLines(site.id, invoiceId),
    listTenderTypes(site.id),
    isPeriodLocked(site.id, new Date().toISOString().slice(0, 10)),
  ])

  const remaining = (lines ?? []).filter((l) => l.creditable > 0)

  return (
    <>
      <PageHeader
        title="Credit sale"
        subtitle={`Against ${invoice.documentNumber} · ${invoice.customerName ?? 'Walk-in'}`}
        backHref={`/sales/${invoiceId}`}
        backLabel="Invoice"
      />

      {locked ? (
        <PageBody>
          <Card>
            <EmptyState
              title="The current VAT period is locked"
              hint="Nothing can be credited into it. Unlock the period in Setup → Numbering once the return has been dealt with."
              icon={<Icons.Lock size={22} />}
              action={
                <ButtonLink variant="secondary" href={`/sales/${invoiceId}`}>
                  <Icons.ArrowLeft size={15} />
                  Back to {invoice.documentNumber}
                </ButtonLink>
              }
            />
          </Card>
        </PageBody>
      ) : remaining.length === 0 ? (
        <PageBody>
          <Card>
            <EmptyState
              title="Nothing left to credit"
              hint={`Every line on ${invoice.documentNumber} has already been credited in full.`}
              icon={<Icons.Reverse size={22} />}
              action={
                <ButtonLink variant="secondary" href={`/sales/${invoiceId}`}>
                  <Icons.ArrowLeft size={15} />
                  Back to {invoice.documentNumber}
                </ButtonLink>
              }
            />
          </Card>
        </PageBody>
      ) : (
        <CreditNoteForm
          invoiceId={invoiceId}
          invoiceNumber={invoice.documentNumber ?? ''}
          customerId={invoice.customerId}
          customerName={invoice.customerName}
          terminalId={invoice.terminalId}
          terminalCode={invoice.terminalCode}
          lines={remaining.map((l) => ({
            id: l.id,
            productId: l.productId,
            productCode: l.productCode,
            description: l.description,
            productType: l.productType,
            departmentId: l.departmentId,
            soldQty: Math.abs(l.qty),
            alreadyCredited: l.alreadyCredited,
            creditable: l.creditable,
            unitPriceIncl: l.unitPriceIncl,
            vatRatePct: l.vatRatePct,
            unitCostExcl: l.unitCostExcl,
          }))}
          tenders={tenders.filter((t) => t.allowsRefund).map((t) => ({ id: t.id, name: t.name }))}
        />
      )}
    </>
  )
}
