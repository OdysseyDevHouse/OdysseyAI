import { notFound } from 'next/navigation'
import { requireSite, requireCapability } from '@/lib/auth'
import { getDocument } from '@/lib/site/salesDocuments'
import { billDataFor } from '@/lib/billData'
import { BillSlip } from '@/components/pos/BillSlip'
import PrintButton from './PrintButton'

export const dynamic = 'force-dynamic'

/**
 * The printable pro-forma bill for an open tab.
 *
 * Its own route rather than a modal, so the browser prints the document and
 * not the application around it — the same reason the lay-by agreement and
 * the statement have one.
 *
 * SAVED documents only. A finalised sale has a real invoice to print, a draft
 * has not been parked, and a cancelled one is nobody's bill — all three 404
 * rather than rendering a slip whose banner would be a lie.
 */
export default async function BillPrintPage({ params }: { params: Promise<{ id: string }> }) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  await requireCapability('sales.till')
  const site = await requireSite()
  const { id: raw } = await params

  const id = Number(raw)
  if (!Number.isFinite(id) || id <= 0) notFound()

  const doc = await getDocument(site.id, id)
  if (!doc || doc.status !== 'saved') notFound()

  const bill = billDataFor(
    doc,
    { name: site.displayName, vatNumber: site.vatNumber },
    {
      printedAt: new Date().toLocaleString('en-ZA', {
        dateStyle: 'short',
        timeStyle: 'short',
      }),
    },
  )

  return (
    <div className="px-6 py-6">
      <PrintButton />
      <BillSlip bill={bill} />
    </div>
  )
}
