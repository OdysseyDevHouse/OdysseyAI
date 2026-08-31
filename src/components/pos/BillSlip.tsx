import { formatMoney, formatQty } from '@/lib/decimals'
import type { BillData } from '@/lib/billData'
import { TABLE, TABLE_HEAD_ROW, TABLE_TH, TABLE_TD, TABLE_ROW, TABLE_NUMERIC } from '@/components/ui'

/**
 * A pro-forma bill — the slip a waiter puts on the table BEFORE payment.
 *
 * Not a receipt and not a tax invoice, and it says so out loud: nothing has
 * been paid, no document number exists (numbers are minted at finalise), and
 * the banner is the reason SARS never sees this piece of paper. The VAT split
 * is still shown — a table of foreigners asks — but under the pro-forma flag.
 *
 * Renders `BillData`, never a raw document: the ESC/POS renderer (Phase 6)
 * consumes the same object, so the two slips cannot disagree.
 */
export function BillSlip({ bill }: { bill: BillData }) {
  return (
    <article className="mx-auto w-full max-w-[26rem] bg-surface p-6 text-ink">
      <header className="border-b border-border pb-4 text-center">
        <h1 className="text-lg font-semibold text-ink">{bill.siteName}</h1>
        {bill.vatNumber && <p className="mt-0.5 text-xs text-muted">{bill.taxLabel ?? 'VAT'} no. {bill.vatNumber}</p>}
        <p className="mt-3 text-sm font-semibold tracking-wide text-ink">{bill.label}</p>
        <p className="mt-0.5 text-xs text-muted">
          {[
            bill.covers ? `${bill.covers} pax` : '',
            bill.userName,
            bill.printedAt,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </header>

      {/* The banner. Bold, boxed, unmissable — the whole legal difference
          between this slip and a tax invoice is this sentence. */}
      <p className="my-4 rounded-control border border-warning/60 bg-warning-soft px-3 py-2 text-center text-xs font-semibold text-warning-ink">
        PRO-FORMA BILL — NOT A TAX INVOICE. NO PAYMENT HAS BEEN TAKEN.
      </p>

      <div className="overflow-x-auto">
        <table className={TABLE}>
          <thead>
            <tr className={TABLE_HEAD_ROW}>
              <th className={TABLE_TH}>Item</th>
              <th className={`${TABLE_TH} text-right`}>Qty</th>
              <th className={`${TABLE_TH} text-right`}>Total</th>
            </tr>
          </thead>
          <tbody>
            {bill.lines.map((line, i) => (
              <tr key={i} className={TABLE_ROW}>
                <td className={TABLE_TD}>
                  <div className="text-ink">{line.description}</div>
                  {line.notes.map((note, j) => (
                    <div key={j} className="text-xs text-muted">
                      {note}
                    </div>
                  ))}
                </td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatQty(line.qty, { exact: true })}</td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-ink`}>
                  {formatMoney(line.lineTotalIncl)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="mt-4 flex flex-col gap-1 border-t border-border pt-4 text-sm">
        {bill.discountTotal > 0 && (
          <div className="flex justify-between">
            <dt className="text-muted">Discount</dt>
            <dd className="numeric text-ink">−{formatMoney(bill.discountTotal)}</dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-muted">Excl. {bill.taxLabel ?? 'VAT'}</dt>
          <dd className="numeric text-ink">{formatMoney(bill.subtotalExcl)}</dd>
        </div>
        {bill.vatByRate.map((rate) => (
          <div key={rate.ratePct} className="flex justify-between">
            <dt className="text-muted">{bill.taxLabel ?? 'VAT'} @ {rate.ratePct}%</dt>
            <dd className="numeric text-ink">{formatMoney(rate.vat)}</dd>
          </div>
        ))}
        <div className="mt-1 flex justify-between border-t border-border pt-2 text-base font-semibold">
          <dt className="text-ink">Total</dt>
          <dd className="numeric text-ink">{formatMoney(bill.totalIncl)}</dd>
        </div>
      </dl>

      <p className="mt-5 text-center text-xs text-muted">
        Please settle at the table or the counter. A tax invoice is issued on payment.
      </p>
    </article>
  )
}
