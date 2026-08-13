import { notFound } from 'next/navigation'
import { requireSite, requireCapability } from '@/lib/auth'
import { getDocument } from '@/lib/site/salesDocuments'
import { getSetting } from '@/lib/site/settings'
import { siteQuery, siteQueryOne } from '@/lib/siteDb'
import { toNum } from '@/lib/decimals'
import { receiptDataFor, type ReceiptTender } from '@/lib/receiptData'
import { ReceiptSlip } from '@/components/pos/ReceiptSlip'
import SlipPrintClient from './SlipPrintClient'

export const dynamic = 'force-dynamic'

/**
 * The 80mm till slip — a TAX INVOICE — in the bare (print) group, so the
 * paper carries the slip and nothing else.
 *
 * FINALISED invoices only. A draft has no number, a credit note's slip is the
 * credit-note print (deferred, stated), and a cancelled sale is nobody's
 * receipt — all 404.
 *
 * `?gift=1` renders the gift variant (prices suppressed by the renderer);
 * `?auto=1` prints once on mount, for the till's Print button.
 */
export default async function SlipPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ gift?: string; auto?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  await requireCapability('sales.till')
  const site = await requireSite()
  const { id: raw } = await params
  const { gift, auto } = await searchParams

  const id = Number(raw)
  if (!Number.isFinite(id) || id <= 0) notFound()

  const doc = await getDocument(site.id, id)
  if (!doc || doc.status !== 'finalised' || doc.docType !== 'invoice') notFound()

  const [tenderRows, footerText] = await Promise.all([
    siteQuery<Record<string, unknown>>(
      site.id,
      'SELECT tender_name, amount, change_given, reference FROM sales_tenders WHERE document_id = ? ORDER BY id',
      [id],
    ),
    getSetting(site.id, 'receipt_footer_text').catch(() => ''),
  ])
  const tenders: ReceiptTender[] = tenderRows.map((t) => ({
    name: String(t.tender_name),
    amount: toNum(t.amount),
    changeGiven: toNum(t.change_given),
    reference: (t.reference as string | null) ?? null,
  }))

  /* The loyalty footer — best-effort, a slip must print even if loyalty
     hiccups, so both reads collapse to null on any failure. */
  let loyalty: { pointsEarned: number; balance: number } | null = null
  if (doc.customerId) {
    try {
      const [earn, balance] = await Promise.all([
        siteQueryOne<Record<string, unknown>>(
          site.id,
          `SELECT COALESCE(SUM(points),0) AS points FROM loyalty_ledger
            WHERE document_id = ? AND entry_type = 'earn'`,
          [id],
        ),
        siteQueryOne<Record<string, unknown>>(
          site.id,
          'SELECT COALESCE(SUM(points),0) AS points FROM loyalty_ledger WHERE customer_id = ?',
          [doc.customerId],
        ),
      ])
      const earned = Math.round(toNum(earn?.points))
      if (earned > 0) loyalty = { pointsEarned: earned, balance: Math.round(toNum(balance?.points)) }
    } catch {
      loyalty = null
    }
  }

  const receipt = receiptDataFor(
    doc,
    { name: site.displayName, vatNumber: site.vatNumber },
    tenders,
    {
      printedAt: new Date().toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' }),
      gift: gift === '1',
      loyalty,
      copyNumber: doc.printCount,
      footerText,
    },
  )

  return (
    <div className="px-4 py-4">
      <SlipPrintClient documentId={doc.id} gift={gift === '1'} auto={auto === '1'} />
      <ReceiptSlip receipt={receipt} />
    </div>
  )
}
