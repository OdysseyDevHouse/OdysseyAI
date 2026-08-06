import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSite } from '@/lib/auth'
import { getDocument } from '@/lib/site/salesDocuments'
import { creditNotesFor, creditableLines } from '@/lib/site/salesReversal'
import { siteQuery } from '@/lib/siteDb'
import { capabilitiesFor, can } from '@/lib/site/permissions'
import { formatMoney, formatQty, toNum } from '@/lib/decimals'
import {
  PageHeader,
  Card,
  Badge,
  Icons,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import DocumentActions from './DocumentActions'

export const dynamic = 'force-dynamic'

export default async function SalesDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const site = await requireSite()
  const { id } = await params

  const documentId = Number(id)
  if (!Number.isFinite(documentId) || documentId <= 0) notFound()

  const [document, capabilities] = await Promise.all([
    getDocument(site.id, documentId),
    capabilitiesFor(site.id, site.role),
  ])
  if (!document) notFound()

  const [credits, remaining] = await Promise.all([
    creditNotesFor(site.id, documentId),
    document.docType === 'invoice' && document.status === 'finalised'
      ? creditableLines(site.id, documentId)
      : Promise.resolve(null),
  ])

  const tenders = await siteQuery<Record<string, unknown>>(
    site.id,
    'SELECT tender_name, amount, change_given, reference FROM sales_tenders WHERE document_id = ? ORDER BY id',
    [documentId],
  )

  const today = new Date().toISOString().slice(0, 10)
  const voidable =
    document.status === 'finalised' &&
    document.documentDate === today &&
    can(capabilities, 'sales.void')

  // Offered only when there is genuinely something left to credit — a button
  // that leads to "everything has already been credited" is a wasted trip.
  const creditable =
    (remaining ?? []).some((l) => l.creditable > 0) && can(capabilities, 'sales.credit_note')

  /*
   * Why an action is unavailable, computed here where the facts are.
   *
   * Returns null when the button should not appear at all — on a quote, or a
   * document that was never finalised, a Cancel button is noise. It returns a
   * REASON when the action is one this user could plausibly have expected,
   * because a silently missing button sends people looking for a bug.
   */
  const isPostedInvoice = document.docType === 'invoice' && document.status === 'finalised'

  const voidBlockedReason = !isPostedInvoice
    ? null
    : !can(capabilities, 'sales.void')
      ? `Your role (${site.role}) cannot cancel a sale. An owner can grant this in Setup → Permissions.`
      : document.documentDate !== today
        ? `Only same-day sales can be cancelled — this one is dated ${document.documentDate}. Credit it instead.`
        : null

  const creditBlockedReason = !isPostedInvoice
    ? null
    : !can(capabilities, 'sales.credit_note')
      ? `Your role (${site.role}) cannot credit a sale. An owner can grant this in Setup → Permissions.`
      : !(remaining ?? []).some((l) => l.creditable > 0)
        ? 'Every line on this invoice has already been credited.'
        : null

  return (
    <>
      <PageHeader
        title={document.documentNumber ?? `Draft #${document.id}`}
        subtitle={`${document.docLabel} · ${document.documentDate}`}
        backHref="/sales"
        backLabel="Sales"
        action={
          <DocumentActions
            documentId={document.id}
            documentNumber={document.documentNumber}
            voidable={voidable}
            isVoid={document.status === 'cancelled'}
            creditable={creditable}
            voidBlockedReason={voidBlockedReason}
            creditBlockedReason={creditBlockedReason}
          />
        }
      />

      {document.status === 'cancelled' && (
        <div className="px-6 pt-4">
          <p className="flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
            <Icons.Ban size={15} />
            Cancelled{document.cancelledAt ? ` on ${document.cancelledAt.toLocaleDateString('en-ZA')}` : ''}
            {document.cancelReason ? ` — ${document.cancelReason}` : ''}. The number is kept so the
            sequence stays complete.
          </p>
        </div>
      )}

      <div className="grid gap-4 px-6 pt-4 pb-10 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Item</th>
                    <th className={`${TABLE_TH} text-right`}>Qty</th>
                    <th className={`${TABLE_TH} text-right`}>Price</th>
                    <th className={`${TABLE_TH} text-right`}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {document.lines.map((line) => (
                    <tr key={line.id} className={TABLE_ROW}>
                      <td className={TABLE_TD}>
                        <div className="text-ink">{line.description}</div>
                        <div className="text-xs text-muted">
                          {line.productCode}
                          {line.discountPct > 0 && (
                            <span className="ml-2 text-warning">−{line.discountPct}%</span>
                          )}
                          {line.vatRatePct === 0 && <span className="ml-2">zero-rated</span>}
                        </div>
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatQty(line.qty)}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        {formatMoney(line.unitPriceIncl)}
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-ink`}>
                        {formatMoney(line.lineTotalIncl)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card className="p-4">
            <dl className="flex flex-col gap-1.5 text-sm">
              <Row label="Subtotal (excl.)" value={formatMoney(document.subtotalExcl)} />
              {document.discountTotal > 0 && (
                <Row label="Discount" value={`−${formatMoney(document.discountTotal)}`} />
              )}
              <Row label="VAT" value={formatMoney(document.vatTotal)} />
              {document.roundingAdj !== 0 && (
                <Row label="Cash rounding" value={formatMoney(document.roundingAdj)} />
              )}
            </dl>
            <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
              <span className="font-medium text-ink">Total</span>
              <span className="numeric text-xl font-semibold text-ink">
                {formatMoney(document.totalIncl)}
              </span>
            </div>
          </Card>

          {tenders.length > 0 && (
            <Card className="p-4">
              <p className="mb-2 text-xs font-medium text-muted">PAID BY</p>
              <dl className="flex flex-col gap-1.5 text-sm">
                {tenders.map((tender, index) => (
                  <Row
                    key={index}
                    label={String(tender.tender_name)}
                    value={formatMoney(toNum(tender.amount))}
                    hint={tender.reference ? String(tender.reference) : undefined}
                  />
                ))}
                {document.changeGiven > 0 && (
                  <Row label="Change given" value={formatMoney(document.changeGiven)} />
                )}
              </dl>
            </Card>
          )}

          {credits.length > 0 && (
            <Card className="p-4">
              <p className="mb-2 text-xs font-medium text-muted">CREDITED BY</p>
              <ul className="flex flex-col gap-1.5 text-sm">
                {credits.map((credit) => (
                  <li key={credit.id} className="flex items-baseline justify-between gap-3">
                    <Link href={`/sales/${credit.id}`} className="text-brand hover:underline">
                      {credit.documentNumber}
                    </Link>
                    <span className="numeric text-ink-2">
                      {formatMoney(Math.abs(credit.total))}
                    </span>
                  </li>
                ))}
              </ul>
              {credits.some((c) => c.reason) && (
                <p className="mt-2 border-t border-border pt-2 text-xs text-muted">
                  {credits.find((c) => c.reason)?.reason}
                </p>
              )}
            </Card>
          )}

          <Card className="p-4">
            <dl className="flex flex-col gap-1.5 text-sm">
              <Row label="Customer" value={document.customerName ?? 'Walk-in'} />
              <Row label="Cashier" value={document.userName || '—'} />
              <Row label="Till" value={document.terminalCode ?? '—'} />
              {document.reference && <Row label="Reference" value={document.reference} />}
              {document.printCount > 0 && (
                <Row label="Printed" value={`${document.printCount} time${document.printCount === 1 ? '' : 's'}`} />
              )}
            </dl>
            <div className="mt-3 border-t border-border pt-3">
              <Badge tone={document.status === 'finalised' ? 'success' : document.status === 'cancelled' ? 'danger' : 'neutral'}>
                {document.status}
              </Badge>
            </div>
          </Card>
        </div>
      </div>
    </>
  )
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">
        {label}
        {hint && <span className="ml-1 text-xs text-faint">{hint}</span>}
      </dt>
      <dd className="numeric text-ink-2">{value}</dd>
    </div>
  )
}
