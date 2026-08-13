import { formatMoney, formatQty } from '@/lib/decimals'
import type { ReceiptData } from '@/lib/receiptData'

/**
 * The till slip — a TAX INVOICE, on 80mm paper or a screen.
 *
 * Renders `ReceiptData`, never a raw document: the ESC/POS renderer consumes
 * the same object, so the two prints cannot disagree.
 *
 * GIFT MODE suppresses money HERE, in the renderer — the data keeps its
 * prices so one object serves both prints. A gift slip keeps the document
 * number (the exchange reference a shop needs) and drops everything with a
 * rand on it.
 */
export function ReceiptSlip({ receipt }: { receipt: ReceiptData }) {
  const gift = receipt.gift
  return (
    <article className="mx-auto w-full max-w-[72mm] bg-surface p-3 text-ink">
      <header className="border-b border-border pb-3 text-center">
        <h1 className="text-base font-semibold text-ink">{receipt.siteName}</h1>
        {receipt.vatNumber && !gift && (
          <p className="mt-0.5 text-[11px] text-muted">VAT no. {receipt.vatNumber}</p>
        )}
        <p className="mt-2 text-[12px] font-semibold tracking-wide text-ink">
          {gift ? 'GIFT RECEIPT' : 'TAX INVOICE'}
        </p>
        <p className="mt-0.5 text-[11px] text-muted">
          {receipt.documentNumber} · {receipt.documentDate}
        </p>
        <p className="text-[11px] text-muted">
          {[receipt.cashierName, receipt.terminalCode, receipt.printedAt].filter(Boolean).join(' · ')}
        </p>
        {receipt.customerName && (
          <p className="mt-1 text-[11px] text-ink-2">
            {receipt.customerName}
            {receipt.customerVatNo && !gift ? ` · VAT ${receipt.customerVatNo}` : ''}
          </p>
        )}
        {receipt.copyNumber > 0 && !gift && (
          <p className="mt-1 text-[12px] font-bold text-warning-ink">
            COPY {receipt.copyNumber > 1 ? receipt.copyNumber : ''}
          </p>
        )}
        {gift && (
          <p className="mt-1 text-[11px] text-muted">A gift receipt — prices not shown.</p>
        )}
      </header>

      <ul className="border-b border-border py-2">
        {receipt.lines.map((line, i) => (
          <li key={i} className="py-0.5 text-[12px]">
            <div className="flex justify-between gap-2">
              <span className="min-w-0 flex-1 text-ink">
                {formatQty(line.qty)} × {line.description}
              </span>
              {!gift && (
                <span className="numeric shrink-0 text-ink">{formatMoney(line.lineTotalIncl)}</span>
              )}
            </div>
            {!gift && line.qty !== 1 && (
              <div className="text-[11px] text-muted">@ {formatMoney(line.unitPriceIncl)}</div>
            )}
            {line.notes.map((note, j) => (
              <div key={j} className="pl-3 text-[11px] text-muted">
                {note}
              </div>
            ))}
          </li>
        ))}
      </ul>

      {!gift && (
        <>
          <dl className="flex flex-col gap-0.5 py-2 text-[12px]">
            {receipt.discountTotal > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted">Discount</dt>
                <dd className="numeric text-ink">−{formatMoney(receipt.discountTotal)}</dd>
              </div>
            )}
            <div className="flex justify-between text-[14px] font-bold">
              <dt className="text-ink">TOTAL</dt>
              <dd className="numeric text-ink">{formatMoney(receipt.totalIncl)}</dd>
            </div>
            {receipt.roundingAdj !== 0 && (
              <div className="flex justify-between">
                <dt className="text-muted">Cash rounding</dt>
                <dd className="numeric text-ink">{formatMoney(receipt.roundingAdj)}</dd>
              </div>
            )}
          </dl>

          <dl className="flex flex-col gap-0.5 border-t border-border py-2 text-[12px]">
            {receipt.tenders.map((t, i) => (
              <div key={i} className="flex justify-between">
                <dt className="text-muted">
                  {t.name}
                  {t.reference ? ` (${t.reference})` : ''}
                </dt>
                <dd className="numeric text-ink">{formatMoney(t.amount)}</dd>
              </div>
            ))}
            {receipt.changeGiven > 0 && (
              <div className="flex justify-between font-semibold">
                <dt className="text-ink">Change</dt>
                <dd className="numeric text-ink">{formatMoney(receipt.changeGiven)}</dd>
              </div>
            )}
          </dl>

          <dl className="flex flex-col gap-0.5 border-t border-border py-2 text-[11px]">
            {receipt.vatByRate.map((rate) => (
              <div key={rate.ratePct} className="flex justify-between">
                <dt className="text-muted">
                  VAT @ {rate.ratePct}% on {formatMoney(rate.excl)}
                </dt>
                <dd className="numeric text-ink">{formatMoney(rate.vat)}</dd>
              </div>
            ))}
          </dl>

          {receipt.loyalty && (
            <p className="border-t border-border py-2 text-center text-[11px] text-muted">
              Earned {receipt.loyalty.pointsEarned} point
              {receipt.loyalty.pointsEarned === 1 ? '' : 's'} · balance {receipt.loyalty.balance}
            </p>
          )}
        </>
      )}

      {receipt.footerText && (
        <p className="border-t border-border py-2 text-center text-[11px] text-muted">
          {receipt.footerText}
        </p>
      )}
    </article>
  )
}
