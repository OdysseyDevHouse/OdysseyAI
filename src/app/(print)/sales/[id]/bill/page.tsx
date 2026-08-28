import { notFound } from 'next/navigation'
import { requireSite, requireCapability } from '@/lib/auth'
import { taxLabel } from '@/lib/site/taxIdentity'
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
 * ── IT LIVES IN THE (print) GROUP ─────────────────────────────────────────
 *
 * It used to sit under (app), which meant it rendered inside the back office's
 * layout: the sidebar and the top bar have no print rules of their own, so
 * "print the document and not the application around it" was exactly what it
 * did NOT do. In the bare group it gets the 80mm @page and no chrome at all,
 * which is what the paragraph above always claimed.
 *
 * `?auto=1` prints once on mount, for the till's Print button.
 *
 * SAVED documents only. A finalised sale has a real invoice to print, a draft
 * has not been parked, and a cancelled one is nobody's bill — all three 404
 * rather than rendering a slip whose banner would be a lie.
 */
export default async function BillPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ auto?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  await requireCapability('sales.till')
  const site = await requireSite()
  const { id: raw } = await params
  const { auto } = await searchParams

  const id = Number(raw)
  if (!Number.isFinite(id) || id <= 0) notFound()

  const doc = await getDocument(site.id, id)
  if (!doc || doc.status !== 'saved') notFound()

  const bill = billDataFor(
    doc,
    { name: site.displayName, vatNumber: site.vatNumber, taxLabel: await taxLabel(site.id) },
    {
      printedAt: new Date().toLocaleString('en-ZA', {
        dateStyle: 'short',
        timeStyle: 'short',
      }),
    },
  )

  return (
    <div className="px-6 py-6">
      <PrintButton auto={auto === '1'} />
      <BillSlip bill={bill} />
    </div>
  )
}
