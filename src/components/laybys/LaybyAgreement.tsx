import { formatMoney, formatQty } from '@/lib/decimals'
import { percentPaid } from '@/lib/laybyRules'
import { qrDataUri } from '@/lib/stationery/qr'
import type { Layby } from '@/lib/site/laybys'
import { TABLE, TABLE_HEAD_ROW, TABLE_TH, TABLE_TD, TABLE_ROW, TABLE_NUMERIC } from '@/components/ui'

/**
 * The customer's copy of a lay-by.
 *
 * This is not a receipt — it is the AGREEMENT, and printing it is what makes
 * the store's terms binding. Under section 62 of the Consumer Protection Act a
 * cancellation fee is only chargeable if the customer was told about it before
 * they signed, so the terms block below is the whole reason this document
 * exists. Without it the fee is unenforceable, which is exactly what
 * `cancelLayby` already refuses to do.
 *
 * Fixed document width rather than filling the viewport, like the statement:
 * it is meant to be printed and handed over.
 */
export function LaybyAgreement({
  layby,
  site,
  payUrl = null,
  terms,
}: {
  layby: Layby
  site: { name: string; vatNumber: string | null; taxLabel?: string }
  /**
   * Where "pay an instalment" points, or null for no block at all.
   *
   * Resolved by the ROUTE rather than here, because minting a link is a
   * database write and this component is also rendered for a preview. Null is
   * the ordinary case — the shop has not switched lay-by links on, or has no
   * gateway — and prints nothing rather than a square that leads to an apology.
   */
  payUrl?: string | null
  terms: string
}) {
  return (
    <article className="mx-auto w-full max-w-[52rem] bg-surface p-8 text-ink">
      <header className="flex items-start justify-between gap-8 border-b border-border pb-5">
        <div>
          <h1 className="text-lg font-semibold text-ink">{site.name}</h1>
          {site.vatNumber && <p className="mt-0.5 text-xs text-muted">{site.taxLabel ?? 'VAT'} no. {site.vatNumber}</p>}
        </div>
        <div className="text-right">
          <h2 className="text-xl font-semibold tracking-wide text-ink">LAY-BY AGREEMENT</h2>
          <p className="mt-0.5 text-sm text-muted">{layby.laybyNumber}</p>
        </div>
      </header>

      <section className="grid gap-6 border-b border-border py-5 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted">HELD FOR</p>
          <p className="mt-1 font-medium text-ink">{layby.customerName}</p>
          {layby.customerCode && <p className="text-sm text-muted">{layby.customerCode}</p>}
        </div>
        <div className="sm:text-right">
          <dl className="flex flex-col gap-1 text-sm">
            <div className="flex justify-between gap-6 sm:justify-end">
              <dt className="text-muted">Opened</dt>
              <dd className="text-ink">{layby.createdAt.toLocaleDateString('en-ZA')}</dd>
            </div>
            <div className="flex justify-between gap-6 sm:justify-end">
              <dt className="text-muted">To be paid by</dt>
              <dd className="font-medium text-ink">{layby.dueDate ?? '—'}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="py-5">
        <p className="mb-2 text-xs font-medium tracking-wide text-muted">GOODS PUT ASIDE</p>
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
              {layby.lines.map((line) => (
                <tr key={line.id} className={TABLE_ROW}>
                  <td className={TABLE_TD}>
                    <div className="text-ink">{line.description}</div>
                    {line.productCode && (
                      <div className="text-xs text-muted">{line.productCode}</div>
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
      </section>

      <section className="grid gap-6 border-t border-border py-5 sm:grid-cols-2">
        <div>
          {layby.payments.filter((p) => p.amount > 0).length > 0 && (
            <>
              <p className="mb-2 text-xs font-medium tracking-wide text-muted">PAID SO FAR</p>
              <dl className="flex flex-col gap-1 text-sm">
                {layby.payments
                  .filter((p) => p.amount > 0)
                  .map((payment) => (
                    <div key={payment.id} className="flex justify-between gap-6">
                      <dt className="text-muted">
                        {payment.paidOn}
                        {payment.tenderName ? ` · ${payment.tenderName}` : ''}
                      </dt>
                      <dd className="numeric text-ink">{formatMoney(payment.amount)}</dd>
                    </div>
                  ))}
              </dl>
            </>
          )}
        </div>

        <div>
          <dl className="flex flex-col gap-1.5 text-sm">
            <div className="flex justify-between gap-6">
              <dt className="text-muted">Lay-by total</dt>
              <dd className="numeric text-ink">{formatMoney(layby.totalIncl)}</dd>
            </div>
            <div className="flex justify-between gap-6">
              <dt className="text-muted">Paid ({percentPaid(layby)}%)</dt>
              <dd className="numeric text-ink">{formatMoney(layby.paidTotal)}</dd>
            </div>
          </dl>
          <div className="mt-3 flex items-baseline justify-between gap-6 border-t border-border pt-3">
            <span className="font-medium text-ink">Still to pay</span>
            <span className="numeric text-xl font-semibold text-ink">
              {formatMoney(layby.outstanding)}
            </span>
          </div>
        </div>
      </section>

      {/*
        Paying an instalment without coming in.
        ── THE CASE THE WHOLE PAY-LINK FEATURE EXISTS FOR ────────────────────
        A lay-by customer is frequently a `cash` account — somebody on file who
        was never granted credit — and until this the only way to pay one off
        was to stand at the counter with a card. This card lives in a wallet for
        months, which is exactly why the link behind the square is a revocable
        slug rather than a token that expires.
        Absent unless the shop switched it on AND has a working gateway, so a
        square that scans to an apology is never printed. The code is spelled
        out beside it because a scanner that will not read is the moment
        somebody types it instead — which is what the slug alphabet is chosen
        for.
      */}
      {payUrl ? (
        <section className="mt-5 flex items-center gap-4 border-t border-border pt-5">
          <img
            src={qrDataUri(payUrl, { scale: 4 })}
            alt=""
            width={96}
            height={96}
            className="shrink-0"
          />
          <div className="text-sm">
            <p className="font-medium text-ink">Pay an instalment online</p>
            <p className="mt-1 text-muted">
              Scan this code, or go to{' '}
              <span className="whitespace-nowrap text-ink">{payUrl.replace(/^https?:\/\//, '')}</span>
            </p>
            <p className="mt-1 text-xs text-muted">
              It always asks for what is still owed on the day you open it.
            </p>
          </div>
        </section>
      ) : null}

      {/*
        The disclosure. Everything above is a record of the transaction; THIS
        is what makes the store's cancellation terms enforceable, and its
        absence is what makes them unenforceable.
      */}
      <section className="border-t border-border pt-5">
        <p className="mb-2 text-xs font-medium tracking-wide text-muted">TERMS</p>
        {terms.trim() ? (
          <p className="whitespace-pre-line text-sm text-ink-2">{terms.trim()}</p>
        ) : (
          <p className="text-sm text-muted">
            No cancellation fee applies. If this lay-by is cancelled, everything paid is refunded
            in full.
          </p>
        )}

        {/* The statutory rights, printed whatever the store has written. These
            are not the store's to vary, and a customer holding this page should
            be able to read them. */}
        <p className="mt-3 text-xs text-muted">
          The goods remain the property of {site.name} until this lay-by is paid in full, and the
          money you pay remains yours until you take them. If we cannot supply the goods once you
          have paid, you are entitled to equivalent goods or a refund of double what you paid. No
          cancellation charge applies where a customer has died or been hospitalised. These rights
          are given by section 62 of the Consumer Protection Act 68 of 2008.
        </p>
      </section>

      <section className="mt-8 grid gap-8 border-t border-border pt-8 sm:grid-cols-2">
        <div>
          <div className="h-10 border-b border-border-strong" />
          <p className="mt-1 text-xs text-muted">Customer signature</p>
        </div>
        <div>
          <div className="h-10 border-b border-border-strong" />
          <p className="mt-1 text-xs text-muted">For {site.name} · {layby.userName}</p>
        </div>
      </section>
    </article>
  )
}
