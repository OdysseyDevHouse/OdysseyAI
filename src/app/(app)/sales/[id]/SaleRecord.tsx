import Link from 'next/link'
import { formatMoney, formatQty } from '@/lib/decimals'
import {
  Card,
  CardHeader,
  CardBody,
  Callout,
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

/**
 * What a finished sale looks like, as data.
 *
 * Deliberately a PLAIN shape rather than the SalesDocument row: this renders in
 * two places — the /sales/[id] record page on the server, and the dialog the
 * invoicing screen shows the moment an invoice posts — and the second one is a
 * client component that receives it back from a server action. Anything that
 * cannot survive that trip (a Date, a driver row) has no business in here.
 */
export type SaleRecordData = {
  status: string
  /** Already formatted for reading: the client side has no Date to format. */
  cancelledAt: string | null
  cancelReason: string | null
  subtotalExcl: number
  vatTotal: number
  discountTotal: number
  roundingAdj: number
  totalIncl: number
  changeGiven: number
  customerName: string | null
  userName: string
  terminalCode: string | null
  reference: string | null
  printCount: number
  lines: {
    id: number
    description: string
    productCode: string | null
    discountPct: number
    vatRatePct: number
    qty: number
    unitPriceIncl: number
    lineTotalIncl: number
    note: string
    instructions: { id: number; optionName: string; qty: number; lineAdjustIncl: number }[]
  }[]
  tenders: { name: string; reference: string | null; amount: number }[]
  credits: { id: number; documentNumber: string | null; total: number; reason: string | null }[]
}

/**
 * The sale itself — lines on the left, money and provenance on the right.
 *
 * The two callers frame it differently, which is what `className` is for: the
 * page hands it the page grid, the dialog its own. This component owns the
 * CONTENT and nothing about where it sits.
 */
export function SaleRecord({
  sale,
  className = '',
  linkCredits = true,
}: {
  sale: SaleRecordData
  className?: string
  /**
   * Off inside the finalise dialog: a link that navigates away from a modal the
   * operator has not finished with is a trap rather than a convenience.
   */
  linkCredits?: boolean
}) {
  return (
    <div className={`grid gap-4 lg:grid-cols-3 ${className}`}>
      {sale.status === 'cancelled' && (
        <Callout tone="danger" title="This sale is cancelled" className="lg:col-span-3">
          Cancelled
          {sale.cancelledAt ? ` on ${sale.cancelledAt}` : ''}
          {sale.cancelReason ? ` — ${sale.cancelReason}` : ''}. The number is kept so the sequence
          stays complete.
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
                {sale.lines.map((line) => (
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
                          {line.note && <span className="italic">&ldquo;{line.note}&rdquo;</span>}
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
              <SummaryRow label="Subtotal (excl.)" value={formatMoney(sale.subtotalExcl)} />
              {sale.discountTotal > 0 && (
                <SummaryRow label="Discount" value={`−${formatMoney(sale.discountTotal)}`} />
              )}
              <SummaryRow label="VAT" value={formatMoney(sale.vatTotal)} />
              {sale.roundingAdj !== 0 && (
                <SummaryRow label="Cash rounding" value={formatMoney(sale.roundingAdj)} />
              )}
              <SummaryTotal label="Total" value={formatMoney(sale.totalIncl)} />
            </SummaryList>
          </CardBody>
        </Card>

        {sale.tenders.length > 0 && (
          <Card>
            <CardHeader title="Paid by" />
            <CardBody>
              <SummaryList>
                {sale.tenders.map((tender, index) => (
                  <SummaryRow
                    key={index}
                    label={
                      <>
                        {tender.name}
                        {tender.reference ? (
                          <span className="ml-1 text-xs text-faint">{tender.reference}</span>
                        ) : null}
                      </>
                    }
                    value={formatMoney(tender.amount)}
                  />
                ))}
                {sale.changeGiven > 0 && (
                  <SummaryRow label="Change given" value={formatMoney(sale.changeGiven)} />
                )}
              </SummaryList>
            </CardBody>
          </Card>
        )}

        {sale.credits.length > 0 && (
          <Card>
            <CardHeader title="Credited by" />
            <CardBody>
              <ul className="flex flex-col gap-1.5 text-sm">
                {sale.credits.map((credit) => (
                  <li key={credit.id} className="flex items-baseline justify-between gap-3">
                    {linkCredits ? (
                      <Link href={`/sales/${credit.id}`} className="text-brand hover:underline">
                        {credit.documentNumber}
                      </Link>
                    ) : (
                      <span className="text-ink-2">{credit.documentNumber}</span>
                    )}
                    <span className="numeric text-ink-2">{formatMoney(Math.abs(credit.total))}</span>
                  </li>
                ))}
              </ul>
              {sale.credits.some((c) => c.reason) && (
                <p className="mt-2 border-t border-border pt-2 text-xs text-muted">
                  {sale.credits.find((c) => c.reason)?.reason}
                </p>
              )}
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <SummaryList>
              <SummaryRow label="Customer" value={sale.customerName ?? 'Walk-in'} />
              <SummaryRow label="Cashier" value={sale.userName || '—'} />
              <SummaryRow label="Till" value={sale.terminalCode ?? '—'} />
              {sale.reference && <SummaryRow label="Reference" value={sale.reference} />}
              {sale.printCount > 0 && (
                <SummaryRow
                  label="Printed"
                  value={`${sale.printCount} time${sale.printCount === 1 ? '' : 's'}`}
                />
              )}
            </SummaryList>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
