import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { getDocument } from '@/lib/site/salesDocuments'
import { creditNotesFor, creditableLines } from '@/lib/site/salesReversal'
import { listSalesReasons } from '@/lib/site/salesReasons'
import { getCustomer } from '@/lib/site/customers'
import { lastEmailed } from '@/lib/site/invoiceEmail'
import { isConfigured as mailIsConfigured } from '@/lib/mail'
import { siteQuery } from '@/lib/siteDb'
import { can } from '@/lib/site/permissions'
import { today as localToday } from '@/lib/site/ledger'
import { formatMoney, formatQty, toNum } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  Callout,
  Badge,
  Icons,
  SummaryList,
  SummaryRow,
  SummaryTotal,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import { STATUS_LABELS, STATUS_TONE } from '../status'
import DocumentActions from './DocumentActions'

export const dynamic = 'force-dynamic'

export default async function SalesDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { site, capabilities } = await requireSiteUser()
  const { id } = await params

  const documentId = Number(id)
  if (!Number.isFinite(documentId) || documentId <= 0) notFound()

  const document = await getDocument(site.id, documentId)
  if (!document) notFound()

  const emailable =
    document.status === 'finalised' &&
    (document.docType === 'invoice' || document.docType === 'credit_sale')
  const mailReady = mailIsConfigured()

  const [credits, remaining, voidReasons, returnReasons, emailCustomer, lastSend] =
    await Promise.all([
      creditNotesFor(site.id, documentId),
      document.docType === 'invoice' && document.status === 'finalised'
        ? creditableLines(site.id, documentId)
        : Promise.resolve(null),
    // Active only: these are the lists somebody picks FROM. Retired reasons stay
    // readable on the documents that used them.
    listSalesReasons(site.id, 'void'),
    listSalesReasons(site.id, 'return'),
    emailable && document.customerId
      ? getCustomer(site.id, document.customerId)
      : Promise.resolve(null),
    emailable ? lastEmailed(site.id, documentId) : Promise.resolve(null),
  ])

  const tenders = await siteQuery<Record<string, unknown>>(
    site.id,
    'SELECT tender_name, amount, change_given, reference FROM sales_tenders WHERE document_id = ? ORDER BY id',
    [documentId],
  )

  // Local date, matching voidDocument's own check — toISOString() is UTC and
  // hid the Void button from a sale rung up after local midnight.
  const today = localToday()
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
        backHref="/invoicing?status=all"
        backLabel="Invoicing"
        action={
          <>
            <Badge tone={STATUS_TONE[document.status]}>{STATUS_LABELS[document.status]}</Badge>
            <DocumentActions
              documentId={document.id}
              documentNumber={document.documentNumber}
              voidable={voidable}
              isVoid={document.status === 'cancelled'}
              creditable={creditable}
              voidReasons={voidReasons}
              returnReasons={returnReasons}
              voidBlockedReason={voidBlockedReason}
              creditBlockedReason={creditBlockedReason}
              emailable={emailable}
              mailConfigured={mailReady}
              emailDefaultTo={emailCustomer?.email ?? ''}
              lastEmailedNote={
                lastSend ? `${lastSend.detail ?? ''} · ${lastSend.userName}` : null
              }
            />
          </>
        }
      />

      <PageBody className="grid lg:grid-cols-3">
        {document.status === 'cancelled' && (
          <Callout tone="danger" title="This sale is cancelled" className="lg:col-span-3">
            Cancelled
            {document.cancelledAt ? ` on ${document.cancelledAt.toLocaleDateString('en-ZA')}` : ''}
            {document.cancelReason ? ` — ${document.cancelReason}` : ''}. The number is kept so the
            sequence stays complete.
          </Callout>
        )}

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

                        {/* What the customer asked for.
                            Every answer is shown, including the ones flagged not
                            to print on a receipt: this is the office copy, and
                            somebody looking up a disputed order needs to see
                            what the kitchen was told, not what the slip said.
                            The price is already inside the line total — these
                            are the breakdown of it, not extra charges. */}
                        {(line.instructions.length > 0 || line.note) && (
                          <div className="mt-1 flex flex-col gap-0.5 text-xs text-muted">
                            {line.instructions.map((c) => (
                              <span key={c.id}>
                                · {c.optionName}
                                {c.qty > 1 && ` ×${formatQty(c.qty)}`}
                                {c.lineAdjustIncl !== 0 && (
                                  <span className="ml-1 numeric">
                                    ({c.lineAdjustIncl > 0 ? '+' : '−'}
                                    {formatMoney(Math.abs(c.lineAdjustIncl))})
                                  </span>
                                )}
                              </span>
                            ))}
                            {line.note && <span className="italic">“{line.note}”</span>}
                          </div>
                        )}
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
          <Card>
            <CardHeader title="Totals" />
            <CardBody>
              <SummaryList>
                <SummaryRow label="Subtotal (excl.)" value={formatMoney(document.subtotalExcl)} />
                {document.discountTotal > 0 && (
                  <SummaryRow label="Discount" value={`−${formatMoney(document.discountTotal)}`} />
                )}
                <SummaryRow label="VAT" value={formatMoney(document.vatTotal)} />
                {document.roundingAdj !== 0 && (
                  <SummaryRow label="Cash rounding" value={formatMoney(document.roundingAdj)} />
                )}
                <SummaryTotal label="Total" value={formatMoney(document.totalIncl)} />
              </SummaryList>
            </CardBody>
          </Card>

          {tenders.length > 0 && (
            <Card>
              <CardHeader title="Paid by" />
              <CardBody>
                <SummaryList>
                  {tenders.map((tender, index) => (
                    <SummaryRow
                      key={index}
                      label={
                        <>
                          {String(tender.tender_name)}
                          {tender.reference ? (
                            <span className="ml-1 text-xs text-faint">
                              {String(tender.reference)}
                            </span>
                          ) : null}
                        </>
                      }
                      value={formatMoney(toNum(tender.amount))}
                    />
                  ))}
                  {document.changeGiven > 0 && (
                    <SummaryRow label="Change given" value={formatMoney(document.changeGiven)} />
                  )}
                </SummaryList>
              </CardBody>
            </Card>
          )}

          {credits.length > 0 && (
            <Card>
              <CardHeader title="Credited by" />
              <CardBody>
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
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <SummaryList>
                <SummaryRow label="Customer" value={document.customerName ?? 'Walk-in'} />
                <SummaryRow label="Cashier" value={document.userName || '—'} />
                <SummaryRow label="Till" value={document.terminalCode ?? '—'} />
                {document.reference && <SummaryRow label="Reference" value={document.reference} />}
                {document.printCount > 0 && (
                  <SummaryRow
                    label="Printed"
                    value={`${document.printCount} time${document.printCount === 1 ? '' : 's'}`}
                  />
                )}
              </SummaryList>
            </CardBody>
          </Card>
        </div>
      </PageBody>
    </>
  )
}
