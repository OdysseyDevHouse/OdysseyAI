import { notFound } from 'next/navigation'
import { qrContextFor } from '@/lib/site/qrLinks'
import { requireSite, requireCapability } from '@/lib/auth'
import { getDocument } from '@/lib/site/salesDocuments'
import { getSetting } from '@/lib/site/settings'
import { siteQuery, siteQueryOne } from '@/lib/siteDb'
import { loyaltyQueryOne } from '@/lib/site/loyaltyDb'
import { memberIdForCustomer } from '@/lib/site/loyalty'
import { specialNames } from '@/lib/site/specials'
import { toNum } from '@/lib/decimals'
import { receiptDataFor, type ReceiptTender } from '@/lib/receiptData'
import { ReceiptSlip } from '@/components/pos/ReceiptSlip'
import { slipPreviewHtml } from '@/lib/stationery/slipHtml'
import { activeTemplateBody } from '@/lib/site/stationeryTemplates'
import { parseSlip, validateSlip } from '@/lib/stationery/slip'
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

  const [tenderRows, footerText, promotionNames] = await Promise.all([
    siteQuery<Record<string, unknown>>(
      site.id,
      'SELECT tender_name, amount, change_given, reference FROM sales_tenders WHERE document_id = ? ORDER BY id',
      [id],
    ),
    getSetting(site.id, 'receipt_footer_text').catch(() => ''),
    /* The names behind the specials this sale's lines were discounted by, so
       the slip can say WHICH promotion took the money off rather than only how
       much. Only the ids actually on the document are asked for. */
    specialNames(
      site.id,
      doc.lines.map((l) => l.specialId).filter((v): v is number => v !== null),
    ),
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
  /*
   * The MEMBER's points, read from the loyalty owner.
   *
   * Three things were wrong here and all three were silent, because the whole
   * block is wrapped in a catch that leaves the slip unprinted-with-points
   * rather than failing: the ledger no longer has customer_id; siteQueryOne
   * reads the branch's own empty table on a shared programme; and the earn
   * query matched document_id alone, so branch 2 printing its sale 5001 would
   * show the points from branch 1's sale 5001.
   */
  const memberId = doc.customerId ? await memberIdForCustomer(site.id, doc.customerId) : null
  if (memberId) {
    try {
      const [earn, balance] = await Promise.all([
        loyaltyQueryOne<Record<string, unknown>>(
          site.id,
          `SELECT COALESCE(SUM(points),0) AS points FROM loyalty_ledger
            WHERE document_id = ? AND origin_site_id = ? AND entry_type = 'earn'`,
          [id, site.id],
        ),
        loyaltyQueryOne<Record<string, unknown>>(
          site.id,
          'SELECT COALESCE(SUM(points),0) AS points FROM loyalty_ledger WHERE member_id = ?',
          [memberId],
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
      specialNames: promotionNames,
      qrLinks: await qrContextFor(site.id),
    },
  )

  /*
   * A designed slip when the shop has one, the shipped layout otherwise.
   *
   * The SAME spec the thermal renderer walks, so the paper from the bridge and
   * the paper from this page cannot disagree — the rule stated in
   * lib/escpos/slips.ts. A design that no longer parses or validates falls back
   * rather than failing: a slip that will not print is a queue at the counter.
   */
  const designJson = await activeTemplateBody(site.id, 'slip')
  const design = designJson ? parseSlip(designJson) : null
  const usable = design && validateSlip(design).ok ? design : null

  return (
    <div className="px-4 py-4">
      <SlipPrintClient documentId={doc.id} gift={gift === '1'} auto={auto === '1'} />
      {usable ? (
        /* Composed by the same module the designer previews with, so the screen,
           this page and the thermal roll are three views of one spec. */
        <div dangerouslySetInnerHTML={{ __html: slipPreviewHtml(usable, receipt) }} />
      ) : (
        <ReceiptSlip receipt={receipt} />
      )}
    </div>
  )
}
