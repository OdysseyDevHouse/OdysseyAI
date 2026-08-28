import { formatMoney, formatQty } from '@/lib/decimals'
import type { PurchaseDocument } from '@/lib/site/purchaseDocuments'
import { TABLE, TABLE_HEAD_ROW, TABLE_TH, TABLE_TD, TABLE_ROW, TABLE_NUMERIC } from '@/components/ui'

/**
 * The supplier's copy of a purchase order.
 *
 * This is the document that leaves the building, so it is written for someone
 * who does not have the system in front of them: who is ordering, from whom,
 * what is wanted, where to deliver it and who to invoice. Everything the back
 * office shows about the order's own life — received quantities, landed cost,
 * the audit trail — is deliberately absent. A supplier reading "3 of 10
 * received" would be reading our records, not their instruction.
 *
 * Quantities are what was ORDERED, always. On a part-received order a reprint
 * still says ten, because the order was for ten; the outstanding position is a
 * receiving question and belongs on the receiving screen.
 *
 * Fixed document width rather than filling the viewport, like the lay-by
 * agreement and the statement: it is meant to be printed and sent.
 */
export function PurchaseOrderDocument({
  doc,
  site,
  supplier,
  deliverTo,
  printedAt,
  isReprint,
}: {
  doc: PurchaseDocument
  site: {
    name: string
    vatNumber: string | null
    /** What this business calls its tax. Absent falls back to VAT. */
    taxLabel?: string
    registrationNumber: string | null
    address1: string | null
    address2: string | null
    address3: string | null
    postalCode: string | null
    phone: string | null
    email: string | null
  }
  supplier: {
    name: string
    contactName: string | null
    email: string | null
    phone: string | null
    addressLine1: string | null
    addressLine2: string | null
    city: string | null
    postalCode: string | null
    vatNumber: string | null
    accountNumber: string | null
    paymentTermsDays: number
  } | null
  /** Where the goods must physically go. The ordering store's own address. */
  deliverTo: string[]
  printedAt: string
  /**
   * Marked on paper when this is not the first print. Two copies of an order
   * in a supplier's inbox is how an order gets filled twice; saying which one
   * is the reprint is cheaper than a duplicate delivery.
   */
  isReprint: boolean
}) {
  const supplierAddress = [
    supplier?.addressLine1,
    supplier?.addressLine2,
    [supplier?.city, supplier?.postalCode].filter(Boolean).join(' ').trim() || null,
  ].filter((l): l is string => !!l && l.trim() !== '')

  const ourAddress = [
    site.address1,
    site.address2,
    site.address3,
    site.postalCode,
  ].filter((l): l is string => !!l && l.trim() !== '')

  // Shown only when someone gave the line a real discount. A column of "0%"
  // down a document going to the person who set the prices is noise.
  const anyDiscount = doc.lines.some((l) => l.discountPct > 0 || l.discountAmount > 0)

  return (
    <article className="mx-auto w-full max-w-[52rem] bg-surface p-8 text-ink">
      <header className="flex items-start justify-between gap-8 border-b border-border pb-5">
        <div>
          <h1 className="text-lg font-semibold text-ink">{site.name}</h1>
          {ourAddress.length > 0 && (
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {ourAddress.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </p>
          )}
          <p className="mt-1 text-xs text-muted">
            {site.vatNumber && <span className="block">{site.taxLabel ?? 'VAT'} no. {site.vatNumber}</span>}
            {site.registrationNumber && (
              <span className="block">Reg. no. {site.registrationNumber}</span>
            )}
            {site.phone && <span className="block">{site.phone}</span>}
            {site.email && <span className="block">{site.email}</span>}
          </p>
        </div>
        <div className="text-right">
          <h2 className="text-xl font-semibold tracking-wide text-ink">PURCHASE ORDER</h2>
          <p className="mt-0.5 text-sm font-medium text-ink-2">
            {doc.documentNumber ?? `Draft #${doc.id}`}
          </p>
          <p className="mt-0.5 text-sm text-muted">{doc.documentDate}</p>
          {/* A draft has no number the supplier could quote back, so the paper
              has to say so rather than look like a live order. */}
          {doc.status === 'draft' && (
            <p className="mt-1 text-xs font-medium tracking-wide text-warning-ink">
              DRAFT — NOT YET ISSUED
            </p>
          )}
          {doc.status === 'cancelled' && (
            <p className="mt-1 text-xs font-medium tracking-wide text-danger-ink">CANCELLED</p>
          )}
          {isReprint && doc.status !== 'draft' && (
            <p className="mt-1 text-xs font-medium tracking-wide text-muted">REPRINT</p>
          )}
        </div>
      </header>

      <section className="grid gap-6 border-b border-border py-5 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted">TO</p>
          <p className="mt-1 font-medium text-ink">{supplier?.name ?? doc.supplierName ?? '—'}</p>
          {supplier?.contactName && (
            <p className="text-sm text-ink-2">{supplier.contactName}</p>
          )}
          {supplierAddress.map((line) => (
            <p key={line} className="text-sm text-muted">
              {line}
            </p>
          ))}
          {supplier?.email && <p className="text-sm text-muted">{supplier.email}</p>}
          {supplier?.phone && <p className="text-sm text-muted">{supplier.phone}</p>}
          {supplier?.accountNumber && (
            <p className="mt-1 text-xs text-muted">Our account: {supplier.accountNumber}</p>
          )}
        </div>
        <div>
          <p className="text-xs font-medium tracking-wide text-muted">DELIVER TO</p>
          {deliverTo.map((line) => (
            <p key={line} className="text-sm text-ink-2">
              {line}
            </p>
          ))}
          <dl className="mt-3 flex flex-col gap-1 text-sm">
            {doc.expectedDate && (
              <div className="flex justify-between gap-6">
                <dt className="text-muted">Required by</dt>
                <dd className="font-medium text-ink">{doc.expectedDate}</dd>
              </div>
            )}
            {doc.reference && (
              <div className="flex justify-between gap-6">
                <dt className="text-muted">Reference</dt>
                <dd className="text-ink">{doc.reference}</dd>
              </div>
            )}
            {supplier && supplier.paymentTermsDays > 0 && (
              <div className="flex justify-between gap-6">
                <dt className="text-muted">Terms</dt>
                <dd className="text-ink">{supplier.paymentTermsDays} days</dd>
              </div>
            )}
            <div className="flex justify-between gap-6">
              <dt className="text-muted">Ordered by</dt>
              <dd className="text-ink">{doc.userName || '—'}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="py-5">
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH}>Item</th>
                <th className={`${TABLE_TH} text-right`}>Qty</th>
                <th className={`${TABLE_TH} text-right`}>Unit cost</th>
                {anyDiscount && <th className={`${TABLE_TH} text-right`}>Disc.</th>}
                <th className={`${TABLE_TH} text-right`}>Total (excl.)</th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((line) => (
                <tr key={line.id} className={TABLE_ROW}>
                  <td className={TABLE_TD}>
                    <div className="text-ink">{line.description}</div>
                    {/* Their code first when we know it: the supplier picks
                        from their own catalogue, not ours. */}
                    <div className="text-xs text-muted">
                      {line.supplierCode ?? line.productCode}
                    </div>
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatQty(line.qtyOrdered)}</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    {formatMoney(line.unitCostExcl)}
                  </td>
                  {anyDiscount && (
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {line.discountAmount > 0
                        ? formatMoney(line.discountAmount)
                        : line.discountPct > 0
                          ? `${line.discountPct}%`
                          : '—'}
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
      </section>

      <section className="flex justify-end border-t border-border py-5">
        <div className="w-full max-w-xs">
          <dl className="flex flex-col gap-1.5 text-sm">
            <div className="flex justify-between gap-6">
              <dt className="text-muted">Goods (excl.)</dt>
              <dd className="numeric text-ink">{formatMoney(doc.subtotalExcl)}</dd>
            </div>
            {doc.chargesExcl > 0 && (
              <div className="flex justify-between gap-6">
                <dt className="text-muted">Delivery</dt>
                <dd className="numeric text-ink">{formatMoney(doc.chargesExcl)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-6">
              <dt className="text-muted">{site.taxLabel ?? 'VAT'}</dt>
              <dd className="numeric text-ink">{formatMoney(doc.vatTotal)}</dd>
            </div>
          </dl>
          <div className="mt-3 flex items-baseline justify-between gap-6 border-t border-border pt-3">
            <span className="font-medium text-ink">Total</span>
            <span className="numeric text-xl font-semibold text-ink">
              {formatMoney(doc.totalIncl)}
            </span>
          </div>
        </div>
      </section>

      {doc.notes && doc.notes.trim() !== '' && (
        <section className="border-t border-border py-5">
          <p className="mb-2 text-xs font-medium tracking-wide text-muted">NOTES</p>
          <p className="whitespace-pre-line text-sm text-ink-2">{doc.notes.trim()}</p>
        </section>
      )}

      <footer className="border-t border-border pt-5">
        <p className="text-xs text-muted">
          Please quote {doc.documentNumber ?? 'this order'} on your delivery note and invoice.
          Deliveries not matching this order may be refused.
        </p>
        <p className="mt-2 text-xs text-faint">Printed {printedAt}</p>
      </footer>
    </article>
  )
}
