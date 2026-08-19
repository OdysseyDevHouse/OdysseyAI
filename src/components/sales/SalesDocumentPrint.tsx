import { formatMoney, formatQty } from '@/lib/decimals'
import type { SalesDocument } from '@/lib/site/salesDocuments'
import {
  HEADING as KIND_HEADING,
  CLOSING as KIND_CLOSING,
  type PrintKind,
} from '@/lib/site/salesDocumentKind'
import { TABLE, TABLE_HEAD_ROW, TABLE_TH, TABLE_TD, TABLE_ROW, TABLE_NUMERIC } from '@/components/ui'

/**
 * The customer's copy of a quote, a sales order or an invoice.
 *
 * ── ONE RENDERER, FOUR HEADINGS ──────────────────────────────────────────
 *
 * These are the same document at four moments in its life — same customer,
 * same lines, same prices, same VAT — and what differs is only what the paper
 * is ENTITLED to claim:
 *
 *   quote        →  QUOTATION            an offer, valid until a date
 *   sales order  →  SALES ORDER          a promise, with a delivery date
 *   invoice, unfinalised
 *                →  PRO FORMA INVOICE    a request to pay; NOT a tax invoice
 *   invoice, finalised
 *                →  TAX INVOICE          the real thing, with its number
 *
 * That last split is the one that matters legally. A pro forma is not a tax
 * invoice and must not look like one: it has no tax-invoice number, and it
 * says on its face that no VAT may be claimed against it. Printing an
 * unfinalised invoice under a "TAX INVOICE" heading would hand a customer a
 * document their accountant can act on for a sale that has not happened —
 * which is why the heading is derived here, from status, rather than passed in
 * by whichever screen opened the page.
 *
 * Everything the back office knows about the document's own life — cost, GP,
 * who captured it, which till — is deliberately absent. This is written for
 * someone who does not have the system in front of them.
 *
 * Fixed document width rather than filling the viewport, like the purchase
 * order and the lay-by agreement: it is meant to be printed and sent.
 */

/*
 * The wording moved to lib/site/salesDocumentKind.ts, because the emailed PDF
 * and the customer portal need the same answers and this file imports the UI
 * kit — which has no business being pulled into a background job to read two
 * string maps. Re-exported so existing callers keep working and there is still
 * only one definition.
 */
export { printKindFor, HEADING, CLOSING, type PrintKind } from '@/lib/site/salesDocumentKind'

export function SalesDocumentPrint({
  doc,
  kind,
  site,
  validUntil = null,
  deliveryDate = null,
  customerOrderNo = null,
  printedAt,
  isReprint = false,
}: {
  doc: SalesDocument
  kind: PrintKind
  site: {
    name: string
    vatNumber: string | null
    registrationNumber: string | null
    address1: string | null
    address2: string | null
    address3: string | null
    postalCode: string | null
    phone: string | null
    email: string | null
  }
  /** A quote's expiry. Null on every other kind, and on a quote with none. */
  validUntil?: string | null
  /** A sales order's promised delivery date. Null on every other kind. */
  deliveryDate?: string | null
  /** The customer's own order number, where the order screen captured one. */
  customerOrderNo?: string | null
  printedAt: string
  /**
   * Marked on paper when this is not the first print of a FINALISED invoice.
   *
   * Two copies of a tax invoice in a customer's payables is how an invoice
   * gets paid twice; saying which one is the reprint is cheaper than chasing
   * the duplicate. Meaningless on a quote or a pro forma, which are expected
   * to be printed repeatedly as they are revised, so the routes for those do
   * not set it.
   */
  isReprint?: boolean
}) {
  const ourAddress = [site.address1, site.address2, site.address3, site.postalCode].filter(
    (l): l is string => !!l && l.trim() !== '',
  )

  /* The customer's address as captured on the document, which is where it was
     copied to when the sale was made — NOT the account's address today. A
     reprint of last year's invoice must show where it was actually sent. */
  const customerAddress = (doc.customerAddress ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')

  // Shown only when somebody actually gave a discount. A column of "0.00%"
  // down a document going to the customer is noise, and on a document with no
  // discounts at all it costs a column the descriptions could have used.
  const anyDiscount = doc.lines.some((l) => l.discountPct > 0 || l.discountIncl > 0)

  /* A pro forma has no tax-invoice number and must not borrow one. Drafts have
     no number at all; a saved invoice may carry one internally, but until it is
     finalised the paper says what it IS rather than quoting a number the
     customer could file as a tax invoice. */
  const showsNumber = kind !== 'proforma' && doc.documentNumber !== null
  const closing = KIND_CLOSING[kind]

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
            {/* Our VAT number is what makes a tax invoice one. Shown on the
                others too — it is public, and a customer checking a quote
                against the invoice that follows should see the same trader. */}
            {site.vatNumber && <span className="block">VAT no. {site.vatNumber}</span>}
            {site.registrationNumber && (
              <span className="block">Reg. no. {site.registrationNumber}</span>
            )}
            {site.phone && <span className="block">{site.phone}</span>}
            {site.email && <span className="block">{site.email}</span>}
          </p>
        </div>
        <div className="text-right">
          <h2 className="text-xl font-semibold tracking-wide text-ink">{KIND_HEADING[kind]}</h2>
          {showsNumber ? (
            <p className="mt-0.5 text-sm font-medium text-ink-2">{doc.documentNumber}</p>
          ) : (
            /* No number to quote back, so the paper says so rather than
               printing a bare id that looks like one. */
            <p className="mt-0.5 text-sm text-muted">Reference #{doc.id}</p>
          )}
          <p className="mt-0.5 text-sm text-muted">{doc.documentDate}</p>

          {/* A pro forma states what it is NOT, in the corner where an
              accountant looks for the invoice number. */}
          {kind === 'proforma' && (
            <p className="mt-1 text-xs font-medium tracking-wide text-warning-ink">
              NOT A TAX INVOICE
            </p>
          )}
          {doc.status === 'cancelled' && (
            <p className="mt-1 text-xs font-medium tracking-wide text-danger-ink">CANCELLED</p>
          )}
          {isReprint && kind === 'tax_invoice' && (
            <p className="mt-1 text-xs font-medium tracking-wide text-muted">REPRINT</p>
          )}
        </div>
      </header>

      <section className="grid gap-6 border-b border-border py-5 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted">TO</p>
          <p className="mt-1 font-medium text-ink">{doc.customerName ?? 'Cash sale'}</p>
          {customerAddress.map((line) => (
            <p key={line} className="text-sm text-muted">
              {line}
            </p>
          ))}
          {doc.customerPhone && <p className="text-sm text-muted">{doc.customerPhone}</p>}
          {/* THEIR VAT number, not ours. A tax invoice to a registered
              business has to carry it for them to claim the input tax. */}
          {doc.customerVatNo && (
            <p className="mt-1 text-xs text-muted">VAT no. {doc.customerVatNo}</p>
          )}
          {doc.customerCode && (
            <p className="text-xs text-muted">Account: {doc.customerCode}</p>
          )}
        </div>
        <div>
          <dl className="flex flex-col gap-1 text-sm">
            {/* Each kind's own defining date. A quote expires, an order is
                promised for a day, an invoice on account falls due. */}
            {kind === 'quote' && (
              <div className="flex justify-between gap-6">
                <dt className="text-muted">Valid until</dt>
                <dd className="font-medium text-ink">
                  {validUntil ?? 'No expiry'}
                </dd>
              </div>
            )}
            {kind === 'sales_order' && deliveryDate && (
              <div className="flex justify-between gap-6">
                <dt className="text-muted">Delivery date</dt>
                <dd className="font-medium text-ink">{deliveryDate}</dd>
              </div>
            )}
            {kind === 'tax_invoice' && doc.dueDate && (
              <div className="flex justify-between gap-6">
                <dt className="text-muted">Due</dt>
                <dd className="font-medium text-ink">{doc.dueDate}</dd>
              </div>
            )}

            {/* THEIR reference — the purchase-order number they will quote
                back at us. The single most useful thing on the page for the
                person matching this to their own paperwork. */}
            {(doc.reference || customerOrderNo) && (
              <div className="flex justify-between gap-6">
                <dt className="text-muted">Your reference</dt>
                <dd className="text-ink">{customerOrderNo ?? doc.reference}</dd>
              </div>
            )}
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
                <th className={`${TABLE_TH} text-right`}>Unit price</th>
                {anyDiscount && <th className={`${TABLE_TH} text-right`}>Disc.</th>}
                <th className={`${TABLE_TH} text-right`}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((line) => (
                <tr key={line.id} className={TABLE_ROW}>
                  <td className={TABLE_TD}>
                    <div className="text-ink">{line.description}</div>
                    {line.productCode && (
                      <div className="text-xs text-muted">{line.productCode}</div>
                    )}
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatQty(line.qty)}</td>
                  {/* Prices INCLUSIVE, because that is what a South African
                      customer is quoted and what they pay. The VAT is broken
                      out once, in the totals, which is what a tax invoice
                      requires — not per line. */}
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    {formatMoney(line.unitPriceIncl)}
                  </td>
                  {anyDiscount && (
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {line.discountPct > 0
                        ? `${line.discountPct}%`
                        : line.discountIncl > 0
                          ? formatMoney(line.discountIncl)
                          : '—'}
                    </td>
                  )}
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-ink`}>
                    {formatMoney(line.lineTotalIncl)}
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
              <dt className="text-muted">Subtotal (excl.)</dt>
              <dd className="numeric text-ink">{formatMoney(doc.subtotalExcl)}</dd>
            </div>
            {doc.discountTotal > 0 && (
              <div className="flex justify-between gap-6">
                <dt className="text-muted">Discount</dt>
                <dd className="numeric text-ink">{formatMoney(doc.discountTotal)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-6">
              <dt className="text-muted">VAT</dt>
              <dd className="numeric text-ink">{formatMoney(doc.vatTotal)}</dd>
            </div>
            {/* Cash rounding, where the till applied it. Shown rather than
                folded into the total: a customer adding up the lines and
                landing five cents out should be able to see why. */}
            {doc.roundingAdj !== 0 && (
              <div className="flex justify-between gap-6">
                <dt className="text-muted">Rounding</dt>
                <dd className="numeric text-ink">{formatMoney(doc.roundingAdj)}</dd>
              </div>
            )}
          </dl>
          <div className="mt-3 flex items-baseline justify-between gap-6 border-t border-border pt-3">
            <span className="font-medium text-ink">Total</span>
            <span className="numeric text-xl font-semibold text-ink">
              {formatMoney(doc.totalIncl)}
            </span>
          </div>
        </div>
      </section>

      {/* The comment captured on the document, printed because the editor's
          own field says "Printed on the invoice." */}
      {doc.notes && doc.notes.trim() !== '' && (
        <section className="border-t border-border py-5">
          <p className="whitespace-pre-line text-sm text-ink-2">{doc.notes.trim()}</p>
        </section>
      )}

      <footer className="border-t border-border pt-5">
        {closing !== '' && <p className="text-sm text-ink-2">{closing}</p>}
        <p className={`text-xs text-faint ${closing !== '' ? 'mt-2' : ''}`}>
          Printed {printedAt}
        </p>
      </footer>
    </article>
  )
}
