import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { getPurchaseDocument } from '@/lib/site/purchaseDocuments'
import { returnableLines, returnsFor } from '@/lib/site/purchaseReversal'
import { formatMoney, formatQty } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Callout,
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
import PurchaseActions from './PurchaseActions'
import { purchaseStatusLabel, purchaseStatusTone } from '../status'

export const dynamic = 'force-dynamic'

export default async function PurchaseDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('purchasing.edit')
  const { id } = await params

  const documentId = Number(id)
  if (!Number.isFinite(documentId) || documentId <= 0) notFound()

  const doc = await getPurchaseDocument(siteId, documentId)
  if (!doc) notFound()

  const today = new Date().toISOString().slice(0, 10)
  const voidable = doc.docType === 'grv' && doc.status === 'finalised' && doc.documentDate === today

  // A GRV can be returned against until every line has gone back. Both reads
  // are skipped entirely for an order or a return, which have neither.
  const isGrv = doc.docType === 'grv' && doc.status === 'finalised'
  const [returnLines, priorReturns] = isGrv
    ? await Promise.all([returnableLines(siteId, documentId), returnsFor(siteId, documentId)])
    : [null, []]
  const returnable = (returnLines ?? []).some((l) => l.returnable > 0)

  return (
    <>
      <PageHeader
        title={doc.documentNumber ?? `Draft #${doc.id}`}
        subtitle={`${doc.docLabel} · ${doc.supplierName} · ${doc.documentDate}`}
        backHref="/purchasing"
        backLabel="Purchasing"
        action={
          <PurchaseActions
            documentId={doc.id}
            documentNumber={doc.documentNumber}
            status={doc.status}
            docType={doc.docType}
            voidable={voidable}
            returnable={returnable}
          />
        }
      />

      <PageBody>
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
                    <th className={`${TABLE_TH} text-right`}>Unit cost</th>
                    {doc.chargesExcl > 0 && <th className={`${TABLE_TH} text-right`}>Landed</th>}
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
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        {formatMoney(line.unitCostExcl)}
                      </td>
                      {doc.chargesExcl > 0 && (
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-ink`}>
                          {formatMoney(line.landedCostExcl)}
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
              {doc.supplierInvoiceNo && (
                <Row label="Their invoice" value={doc.supplierInvoiceNo} />
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
              </p>
            </Card>
          )}
        </div>
        </div>
      </PageBody>
    </>
  )
}

function Row({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-ink-2">
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
