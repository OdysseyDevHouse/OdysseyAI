import { requireCapability } from '@/lib/auth'
import { listSequences, verifySequence, previewNext } from '@/lib/site/sequences'
import { getSettings } from '@/lib/site/settings'
import { PageHeader, PageBody } from '@/components/ui'
import NumberingClient from './NumberingClient'

export const dynamic = 'force-dynamic'

const DOC_LABELS: Record<string, string> = {
  invoice: 'Tax invoices',
  credit_sale: 'Credit sales',
  quote: 'Quotes',
  sales_order: 'Sales orders',
}

export default async function NumberingPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  const sequences = await listSequences(siteId)
  const [checks, settings] = await Promise.all([
    Promise.all(sequences.map((s) => verifySequence(siteId, s.docType))),
    getSettings(siteId, ['sales_cash_rounding', 'vat_period_locked_to', 'sales_allow_finalised_edit']),
  ])

  const rows = sequences.map((sequence, index) => ({
    docType: sequence.docType,
    label: DOC_LABELS[sequence.docType] ?? sequence.docType,
    prefix: sequence.prefix,
    nextNumber: sequence.nextNumber,
    padding: sequence.padding,
    resetPeriod: sequence.resetPeriod,
    preview: previewNext(sequence),
    check: checks[index],
  }))

  return (
    <>
      <PageHeader
        title="Numbering & posting"
        subtitle="Document numbers, cash rounding and the VAT period lock."
      />
      <PageBody>
        <NumberingClient sequences={rows} settings={settings} />
      </PageBody>
    </>
  )
}
