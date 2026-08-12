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
  stock_adjustment: 'Stock adjustments',
  job_card: 'Job cards',
}

/**
 * Master-data codes, and the setting that switches each one on.
 *
 * Kept apart from DOC_LABELS rather than merged into it: these are not
 * documents, they are not verified against a document table, and they get
 * their own card. See sql/site/062_master_data_codes.sql.
 */
const CODE_TYPES = [
  { docType: 'customer', label: 'Customer codes', setting: 'autocode_customer' },
  { docType: 'supplier', label: 'Supplier codes', setting: 'autocode_supplier' },
  { docType: 'product', label: 'Product codes', setting: 'autocode_product' },
] as const

export default async function NumberingPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  const sequences = await listSequences(siteId)
  const codeTypes = new Set<string>(CODE_TYPES.map((c) => c.docType))
  // Documents get counted against their table; master-data codes have nothing
  // to verify, so verifySequence is not called for them — it would look in
  // sales_documents and report every code as missing.
  const documents = sequences.filter((s) => !codeTypes.has(s.docType))

  const [checks, settings] = await Promise.all([
    Promise.all(documents.map((s) => verifySequence(siteId, s.docType))),
    getSettings(siteId, [
      'sales_cash_rounding',
      'vat_period_locked_to',
      'sales_allow_finalised_edit',
      'autocode_customer',
      'autocode_supplier',
      'autocode_product',
    ]),
  ])

  const rows = documents.map((sequence, index) => ({
    docType: sequence.docType,
    label: DOC_LABELS[sequence.docType] ?? sequence.docType,
    prefix: sequence.prefix,
    nextNumber: sequence.nextNumber,
    padding: sequence.padding,
    resetPeriod: sequence.resetPeriod,
    preview: previewNext(sequence),
    check: checks[index],
  }))

  // A site that has not run 062 yet simply has no rows here, and the card
  // renders empty rather than the screen failing.
  const codeRows = CODE_TYPES.flatMap((type) => {
    const sequence = sequences.find((s) => s.docType === type.docType)
    if (!sequence) return []
    return [
      {
        docType: sequence.docType,
        label: type.label,
        setting: type.setting,
        enabled: settings[type.setting] === '1',
        prefix: sequence.prefix,
        nextNumber: sequence.nextNumber,
        padding: sequence.padding,
        preview: previewNext(sequence),
      },
    ]
  })

  return (
    <>
      <PageHeader
        title="Numbering & posting"
        subtitle="Document numbers, cash rounding and the VAT period lock."
      />
      <PageBody>
        <NumberingClient sequences={rows} codes={codeRows} settings={settings} />
      </PageBody>
    </>
  )
}
