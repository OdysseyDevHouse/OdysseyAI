import Link from 'next/link'
import { PrintDocumentButton } from '@/components/PrintDocumentButton'
import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { approvalGate, getPurchaseDocument, purchaseAudit } from '@/lib/site/purchaseDocuments'
import { can } from '@/lib/site/permissions'
import { invoiceMatchState } from '@/lib/site/purchaseInvoiceMatch'
import { returnableLines, returnsFor } from '@/lib/site/purchaseReversal'
import { lastOrderEmail } from '@/lib/site/purchaseOrderEmail'
import { getSupplier } from '@/lib/site/suppliers'
import { isConfigured as isMailConfigured } from '@/lib/mail'
import { listLocations } from '@/lib/site/stockLocations'
import { today as localToday } from '@/lib/site/ledger'
import { formatCost, formatMoney, formatQty, round } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Callout,
  Card,
  CardHeader,
  CardBody,
  Badge,
  Icons,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import PurchaseActions from './PurchaseActions'
import { purchaseStatusLabel, purchaseStatusTone } from '../status'
import { listAttachments } from '@/lib/site/attachments'
import { AttachmentsPanel } from '@/components/attachments/AttachmentsPanel'

export const dynamic = 'force-dynamic'

export default async function PurchaseDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities } = await requireCapability('purchasing.edit')
  const { id } = await params

  const documentId = Number(id)
  if (!Number.isFinite(documentId) || documentId <= 0) notFound()

  const doc = await getPurchaseDocument(siteId, documentId)
  if (!doc) notFound()

  // The entity follows the document type: a purchase order's attachment is the
  // supplier's quote, a GRV's is the invoice it was keyed from. Filing both
  // under one entity would mix them on a screen that shows one document.
  const attachTo = doc.docType === 'purchase_order' ? 'purchase_order' : 'grv'
  const [attachments, auditTrail] = await Promise.all([
    listAttachments(siteId, attachTo, documentId),
    purchaseAudit(siteId, documentId),
  ])

  /*
   * Where each line went, or is meant to go.
   *
   * Closed locations included: a receipt posted into a room that has since been
   * shut still went there, and showing a blank would make the document disagree
   * with the movement behind it. The column appears only when the site has more
   * than one place for goods to go — on a single-location site it would be the
   * same word forty times.
   */
  const locations = await listLocations(siteId)
  const locationName = new Map(locations.map((l) => [l.id, l.code]))
  // Transit is excluded from the COUNT but not from the names above: it is a
  // real pile a line could name, and it is not somewhere a site chooses to
  // send goods, so a site of "main plus transit" is a one-location site here.
  const showLocation =
    locations.filter((l) => !l.isTransit).length > 1 &&
    doc.lines.some((l) => l.locationId !== null)

  // The shelf prices this delivery decided (193). Shown only when it decided
  // any — most GRVs re-price nothing, and a column of dashes on every one of
  // them would push the figures that matter off a narrow screen.
  const showNewPrice = doc.lines.some((l) => l.sellingPriceIncl !== null)

  // Local date, matching how the GRV was stamped — toISOString() is UTC and
  // hid the Void button in the hours after local midnight.
  const today = localToday()
  const voidable = doc.docType === 'grv' && doc.status === 'finalised' && doc.documentDate === today

  // A GRV can be returned against until every line has gone back. Both reads
  // are skipped entirely for an order or a return, which have neither.
  const isGrv = doc.docType === 'grv' && doc.status === 'finalised'
  const [returnLines, priorReturns] = isGrv
    ? await Promise.all([returnableLines(siteId, documentId), returnsFor(siteId, documentId)])
    : [null, []]
  const returnable = (returnLines ?? []).some((l) => l.returnable > 0)

  // What an order is still waiting for, and what has already turned up. Both
  // read off the lines rather than the fulfilment status: the status says
  // "part received" without saying how much, and the confirmation quotes a
  // figure the buyer can check against their delivery note.
  const outstanding = doc.lines.reduce(
    (sum, line) => sum + Math.max(line.qtyOrdered - line.qtyReceived, 0),
    0,
  )
  const receivedSoFar = doc.lines.reduce((sum, line) => sum + line.qtyReceived, 0)

  // Emailing, for an order only. Both reads are skipped for a GRV or a return,
  // which are our own records rather than something a supplier is sent.
  const isOrder = doc.docType === 'purchase_order'
  const mailConfigured = isOrder && isMailConfigured()
  const [orderSupplier, lastSent] = mailConfigured
    ? await Promise.all([getSupplier(siteId, doc.supplierId), lastOrderEmail(siteId, documentId)])
    : [null, null]
  // Whether this draft is over the site's approval limit, and whether the
  // person looking at it may issue it anyway. Only asked of a draft: once
  // issued the question is settled, and asking it of a GRV is meaningless.
  const gate =
    isOrder && doc.status === 'draft'
      ? await approvalGate(siteId, doc.totalIncl)
      : { needed: false, threshold: 0 }
  const canApprove = can(capabilities, 'purchasing.approve')
  const blockedByApproval = gate.needed && !canApprove

  // Whether this receipt is still standing on our own GRV number rather than
  // the supplier's. Only asked of a posted GRV — an order has no creditor
  // entry, and a draft has not raised one yet.
  const matchState = isGrv ? await invoiceMatchState(siteId, documentId) : null
  const awaitingInvoice = !!matchState?.awaitingInvoice &&
    round(matchState.outstanding, 2) === round(matchState.amountGross, 2)

  const supplierEmail = orderSupplier?.email ?? ''
  const lastSentNote = lastSent
    ? `${lastSent.detail ?? ''} · ${lastSent.userName} · ${stamp(lastSent.at)}`.replace(/^ · /, '')
    : null

  return (
    <>
      <PageHeader
        title={doc.documentNumber ?? `Draft #${doc.id}`}
        subtitle={`${doc.docLabel} · ${doc.supplierName} · ${doc.documentDate}`}
        backHref="/purchasing"
        backLabel="Purchasing"
        action={
          <>
            {/* The supplier's copy. Offered on a cancelled order too: working
                out what a supplier was sent is exactly when the cancelled one
                needs looking at, and the paper says CANCELLED across it. */}
            {doc.docType === 'purchase_order' && (
              <PrintDocumentButton
                href={`/purchasing/${doc.id}/order`}
                label="Print order"
              />
            )}

            {/* Labels for what just arrived — the moment shelf edges go stale. */}
            {doc.docType === 'grv' && doc.status === 'finalised' && (
              <PrintDocumentButton
                href={`/labels/a4?source=grv&id=${doc.id}`}
                label="Shelf labels"
              />
            )}
            <PurchaseActions
              documentId={doc.id}
              documentNumber={doc.documentNumber}
              status={doc.status}
              docType={doc.docType}
              voidable={voidable}
              returnable={returnable}
              outstanding={outstanding}
              received={receivedSoFar}
              mailConfigured={mailConfigured}
              supplierEmail={supplierEmail}
              lastSentNote={lastSentNote}
              blockedByApproval={blockedByApproval}
              awaitingInvoice={awaitingInvoice}
              creditorNumber={matchState?.docNumber ?? null}
              creditorDate={matchState?.docDate ?? null}
            />
          </>
        }
      />

      <PageBody>
        {/* Said on the page, not only in a tooltip on a disabled button. The
            buyer's next move is to fetch somebody, and they need the figure
            and the reason to explain why. Worded differently for the person
            who CAN sign it off: to them this is not an obstacle, it is the
            thing they were called over for. */}
        {gate.needed && (
          <Callout
            tone={canApprove ? 'brand' : 'warning'}
            icon={<Icons.StatusWarning size={18} />}
            title={
              canApprove
                ? `Over the ${formatMoney(gate.threshold)} approval limit — yours to issue`
                : `Needs approval — over the ${formatMoney(gate.threshold)} limit`
            }
          >
            {canApprove
              ? `This order comes to ${formatMoney(doc.totalIncl)}. Issuing it is the approval.`
              : `This order comes to ${formatMoney(doc.totalIncl)}. It stays a draft until someone who can approve large orders issues it. Nothing is lost — it can still be edited in the meantime.`}
          </Callout>
        )}

        {doc.status === 'cancelled' && (
          <Callout
            tone="danger"
            icon={<Icons.Ban size={18} />}
            title={`Cancelled${doc.cancelReason ? ` — ${doc.cancelReason}` : ''}`}
          >
            Stock was taken back out; the average cost was deliberately left alone, since anything
            sold since has already moved on.
          </Callout>
        )}

        {/* Returns raised against this receipt. Shown on the GRV rather than
            only on the return itself, because "has any of this gone back?" is
            asked of the receipt, not of a document you would have to find first. */}
        {priorReturns.length > 0 && (
          <Callout tone="warning" icon={<Icons.Reverse size={18} />} title="Returned against">
            <span className="flex flex-wrap items-center gap-2">
              {priorReturns.map((r) => (
                <Link
                  key={r.id}
                  href={`/purchasing/${r.id}`}
                  className="font-medium underline underline-offset-2"
                >
                  {r.documentNumber ?? `#${r.id}`} ({formatMoney(Math.abs(r.total))})
                </Link>
              ))}
            </span>
          </Callout>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Item</th>
                    <th className={`${TABLE_TH} text-right`}>
                      {doc.docType === 'purchase_order' ? 'Ordered' : 'Received'}
                    </th>
                    {showLocation && <th className={TABLE_TH}>Location</th>}
                    <th className={`${TABLE_TH} text-right`}>Unit cost</th>
                    {doc.chargesExcl > 0 && <th className={`${TABLE_TH} text-right`}>Landed</th>}
                    {showNewPrice && <th className={`${TABLE_TH} text-right`}>New price</th>}
                    <th className={`${TABLE_TH} text-right`}>Total (excl.)</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.lines.map((line) => (
                    <tr key={line.id} className={TABLE_ROW}>
                      <td className={TABLE_TD}>
                        <div className="text-ink">{line.description}</div>
                        <div className="text-xs text-muted">
                          {line.productCode}
                          {line.supplierCode && <span className="ml-2">their {line.supplierCode}</span>}
                        </div>
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        {doc.docType === 'purchase_order' ? (
                          <div>
                            <div>{formatQty(line.qtyOrdered)}</div>
                            {line.qtyReceived > 0 && (
                              <div className="text-xs text-muted">
                                {formatQty(line.qtyReceived)} received
                              </div>
                            )}
                          </div>
                        ) : (
                          formatQty(line.qtyReceived)
                        )}
                      </td>
                      {showLocation && (
                        <td className={TABLE_TD}>
                          {/* An order says where goods are HEADED; a receipt
                              says where they went. Blank on an order is a real
                              answer — main, whichever that is when it lands. */}
                          {line.locationId === null ? (
                            <span className="text-muted">
                              {doc.docType === 'purchase_order' ? 'At receipt' : '—'}
                            </span>
                          ) : (
                            (locationName.get(line.locationId) ?? '—')
                          )}
                        </td>
                      )}
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        {formatCost(line.unitCostExcl)}
                      </td>
                      {doc.chargesExcl > 0 && (
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-ink`}>
                          {formatMoney(line.landedCostExcl)}
                        </td>
                      )}
                      {showNewPrice && (
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          {/* A dash, not a price: this line left the shelf
                              where it was, which is different from pricing it
                              at what it already cost. */}
                          {line.sellingPriceIncl === null ? (
                            <span className="text-muted">—</span>
                          ) : (
                            <span className="text-ink">{formatMoney(line.sellingPriceIncl)}</span>
                          )}
                        </td>
                      )}
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-ink`}>
                        {formatMoney(line.lineTotalExcl)}
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
              <Row label="Goods (excl.)" value={formatMoney(doc.subtotalExcl)} />
              {doc.chargesExcl > 0 && <Row label="Delivery" value={formatMoney(doc.chargesExcl)} />}
              <Row label="VAT" value={formatMoney(doc.vatTotal)} />
            </dl>
            <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
              <span className="font-medium text-ink">Total</span>
              <span className="numeric text-xl font-semibold text-ink">
                {formatMoney(doc.totalIncl)}
              </span>
            </div>
          </Card>

          <Card className="p-4">
            <dl className="flex flex-col gap-1.5 text-sm">
              <Row
                label="Supplier"
                value={doc.supplierName ?? '—'}
                href={`/suppliers/${doc.supplierId}`}
              />
              {doc.supplierInvoiceNo ? (
                <Row label="Their invoice" value={doc.supplierInvoiceNo} />
              ) : (
                // Said out loud rather than left blank. Without this the card
                // shows nothing where the invoice number goes, and the fact
                // that the CREDITOR ENTRY is still standing on our own GRV
                // number — the thing "Record invoice" exists to fix — is
                // invisible on the one screen where it should be obvious.
                awaitingInvoice && (
                  <Row label="Their invoice" value="Not received yet" muted />
                )
              )}
              {doc.dueDate && <Row label="Due" value={doc.dueDate} />}
              {doc.expectedDate && <Row label="Expected" value={doc.expectedDate} />}
              <Row label="Captured by" value={doc.userName || '—'} />
              {doc.reference && <Row label="Reference" value={doc.reference} />}
            </dl>
            <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
              <Badge tone={purchaseStatusTone(doc.status)}>
                {purchaseStatusLabel(doc.status)}
              </Badge>
              {doc.fulfilmentStatus && doc.fulfilmentStatus !== 'open' && (
                <Badge tone="neutral">{doc.fulfilmentStatus.replace('_', ' ')}</Badge>
              )}
            </div>
          </Card>

          {doc.docType === 'grv' && doc.status === 'finalised' && (
            <Card className="p-3">
              <p className="text-xs text-muted">
                This receipt moved stock in and blended its landed cost into each product&apos;s
                average. The supplier&apos;s account was credited by the VAT-inclusive total.
                {/* Only said when it is true: a receipt that re-priced nothing
                    must not claim it did, and most of them re-price nothing. */}
                {showNewPrice && ' It also set the selling prices shown above.'}
              </p>
            </Card>
          )}

          {/* The document this was keyed from. When a supplier queries what
              was received, the answer is here rather than in someone's inbox. */}
          <Card>
            <CardHeader
              title={attachTo === 'purchase_order' ? 'Attachments' : 'Supplier invoice'}
              description={
                attachTo === 'purchase_order'
                  ? 'The quote or order confirmation behind this order.'
                  : 'The invoice or delivery note this receipt was captured from.'
              }
            />
            <CardBody>
              <AttachmentsPanel
                entity={attachTo}
                entityId={documentId}
                hint={
                  attachTo === 'purchase_order'
                    ? 'Attach the supplier’s quote, so what was agreed sits with what was ordered.'
                    : 'Attach the supplier’s invoice, so the paperwork sits with the receipt rather than in an inbox.'
                }
                attachments={attachments.map((a) => ({
                  id: a.id,
                  filename: a.filename,
                  description: a.description,
                  sizeBytes: a.sizeBytes,
                  uploadedName: a.uploadedName,
                  createdAt: a.createdAt.toISOString(),
                }))}
              />
            </CardBody>
          </Card>

          {auditTrail.length > 0 && (
            <Card>
              <CardHeader
                title="History"
                description="What has happened to this document, and who did it."
              />
              <CardBody>
                <ul className="space-y-2 text-sm">
                  {auditTrail.map((entry, i) => (
                    <li key={i} className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-2">
                        <Badge tone={AUDIT_TONE[entry.action] ?? 'neutral'}>
                          {AUDIT_LABEL[entry.action] ?? entry.action}
                        </Badge>
                        <span className="text-ink-2">{entry.detail}</span>
                      </div>
                      <span className="shrink-0 text-muted">
                        {entry.userName} · {stamp(entry.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}
        </div>
        </div>
      </PageBody>
    </>
  )
}

const AUDIT_LABEL: Record<string, string> = {
  finalised: 'Received',
  void: 'Voided',
  issued: 'Issued',
  cancelled: 'Cancelled',
  edited: 'Edited',
  printed: 'Printed',
  reprinted: 'Reprinted',
  closed_short: 'Closed short',
  emailed: 'Emailed',
  re_emailed: 'Emailed again',
  invoice_matched: 'Invoice recorded',
}

const AUDIT_TONE: Record<string, 'success' | 'danger' | 'brand' | 'neutral' | 'warning'> = {
  finalised: 'success',
  void: 'danger',
  issued: 'brand',
  cancelled: 'neutral',
  printed: 'neutral',
  // A reprint is the entry someone is looking FOR when they are working out
  // how a supplier came to deliver the same order twice, so it does not read
  // as routine.
  reprinted: 'warning',
  // Somebody decided goods that were ordered are never coming. That is a fact
  // about the supplier worth seeing when the next order to them is raised.
  closed_short: 'warning',
  invoice_matched: 'brand',
}

/** The pool parses DATETIME as UTC, so wall-clock comes back out with getUTC*. */
function stamp(value: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())} ${p(value.getUTCHours())}:${p(value.getUTCMinutes())}`
}

function Row({
  label,
  value,
  href,
  muted = false,
}: {
  label: string
  value: string
  href?: string
  /** For a value that is an ABSENCE — "not received yet" is a state, not data. */
  muted?: boolean
}) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className={muted ? 'text-muted' : 'text-ink-2'}>
        {href ? (
          <Link href={href} className="text-brand hover:underline">
            {value}
          </Link>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}
