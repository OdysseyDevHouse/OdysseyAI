import { formatMoney } from '@/lib/decimals'
import { BUCKET_LABELS, AGING_BUCKETS } from '@/lib/site/ledger'
import type { StatementData } from '@/lib/statements/render'
import { TABLE, TABLE_HEAD_ROW, TABLE_TH, TABLE_TD, TABLE_ROW, TABLE_NUMERIC } from '@/components/ui'

/**
 * The statement, on screen.
 *
 * Deliberately renders at a fixed document width rather than filling the
 * viewport: it is a document, and it must look like the PDF a customer will
 * receive. Browser print produces an acceptable copy of it, which is the free
 * fallback before the PDF route is reached for.
 *
 * `variant` covers the creditors side too — a remittance advice shares the
 * letterhead, the address blocks, the table skin and the footer, and differs in
 * the title, whether an ageing strip appears, and whether the summary says
 * "amount due" or "amount paid". That is a handful of conditionals, not a
 * second document.
 */
export function StatementDocument({
  data,
  variant = 'statement',
}: {
  data: StatementData
  variant?: 'statement' | 'remittance' | 'supplier-statement'
}) {
  const isRemittance = variant === 'remittance'
  // Our own view of a supplier account: same document, but we are the one who
  // owes, so it must not ask them to quote a code or open a query window.
  const isSupplier = variant === 'supplier-statement'

  return (
    <article className="mx-auto w-full max-w-[52rem] bg-surface p-8 text-ink">
      <header className="flex items-start justify-between gap-8 border-b border-border pb-5">
        <div>
          <h1 className="text-lg font-semibold text-ink">{data.site.name}</h1>
          {data.site.vatNumber && (
            <p className="mt-0.5 text-xs text-muted">VAT no. {data.site.vatNumber}</p>
          )}
        </div>
        <div className="text-right">
          <h2 className="text-xl font-semibold tracking-wide text-ink">
            {isRemittance
              ? 'REMITTANCE ADVICE'
              : isSupplier
                ? 'SUPPLIER ACCOUNT'
                : 'STATEMENT'}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {data.period.from} to {data.period.to}
          </p>
        </div>
      </header>

      <section className="flex flex-wrap justify-between gap-8 py-5">
        <div className="min-w-[16rem]">
          <p className="text-xs font-medium text-muted">Account</p>
          <p className="mt-1 font-medium text-ink">{data.account.name}</p>
          {data.account.contactName && (
            <p className="text-sm text-ink-2">{data.account.contactName}</p>
          )}
          {data.account.addressLines.map((line) => (
            <p key={line} className="text-sm text-ink-2">
              {line}
            </p>
          ))}
          {data.account.vatNumber && (
            <p className="mt-1 text-xs text-muted">VAT no. {data.account.vatNumber}</p>
          )}
        </div>

        <dl className="min-w-[14rem] text-sm">
          <Row label="Account code" value={data.account.code} />
          <Row
            label="Terms"
            value={
              data.account.paymentTermsDays === 0
                ? 'Cash on delivery'
                : `${data.account.paymentTermsDays} days`
            }
          />
          <Row label="Statement date" value={data.period.to} />
          {!isRemittance && data.account.creditLimit > 0 && (
            <Row label="Credit limit" value={formatMoney(data.account.creditLimit)} />
          )}
        </dl>
      </section>

      <table className={TABLE}>
        <thead>
          <tr className={TABLE_HEAD_ROW}>
            <th className={TABLE_TH}>Date</th>
            <th className={TABLE_TH}>Document</th>
            <th className={TABLE_TH}>Description</th>
            <th className={`${TABLE_TH} text-right`}>Debit</th>
            <th className={`${TABLE_TH} text-right`}>Credit</th>
            <th className={`${TABLE_TH} text-right`}>
              {data.format === 'open-item' ? 'Outstanding' : 'Balance'}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.format === 'activity' && (
            <tr className={TABLE_ROW}>
              <td className={TABLE_TD} colSpan={5}>
                <span className="text-muted">Balance brought forward</span>
              </td>
              <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                {formatMoney(data.openingBalance)}
              </td>
            </tr>
          )}

          {data.lines.length === 0 ? (
            <tr className={TABLE_ROW}>
              <td className={`${TABLE_TD} text-center text-muted`} colSpan={6}>
                Nothing outstanding — thank you.
              </td>
            </tr>
          ) : (
            data.lines.map((line, index) => (
              <tr key={`${line.docNumber ?? line.date}-${index}`} className={TABLE_ROW}>
                <td className={TABLE_TD}>{line.date}</td>
                <td className={TABLE_TD}>
                  <div className="text-ink">{line.docType}</div>
                  {line.docNumber && <div className="text-xs text-muted">{line.docNumber}</div>}
                </td>
                <td className={TABLE_TD}>
                  <div>{line.description}</div>
                  {line.reference && (
                    <div className="text-xs text-muted">Ref: {line.reference}</div>
                  )}
                  {line.daysOverdue > 0 && (
                    <div className="text-xs text-danger">
                      {line.daysOverdue} day{line.daysOverdue === 1 ? '' : 's'} overdue
                    </div>
                  )}
                </td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                  {line.debit ? formatMoney(line.debit) : ''}
                </td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                  {line.credit ? formatMoney(line.credit) : ''}
                </td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                  {formatMoney(
                    data.format === 'open-item' ? Math.abs(line.outstanding) : line.balance,
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {!isRemittance && (
        <section className="mt-6">
          <p className="mb-2 text-xs font-medium text-muted">Age analysis</p>
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                {AGING_BUCKETS.map((bucket) => (
                  <th key={bucket} className={`${TABLE_TH} text-right`}>
                    {BUCKET_LABELS[bucket]}
                  </th>
                ))}
                <th className={`${TABLE_TH} text-right`}>Total</th>
              </tr>
            </thead>
            <tbody>
              <tr className={TABLE_ROW}>
                {AGING_BUCKETS.map((bucket) => (
                  <td key={bucket} className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    {formatMoney(data.aging[bucket])}
                  </td>
                ))}
                <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>
                  {formatMoney(data.aging.total)}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      <section className="mt-6 flex justify-end">
        <div className="w-full max-w-xs rounded-card border border-border">
          {!isRemittance && data.dueNow > 0 && (
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5 text-sm">
              <span className="text-muted">Overdue</span>
              <span className="numeric font-medium text-danger">{formatMoney(data.dueNow)}</span>
            </div>
          )}
          <div className="flex items-center justify-between bg-surface-2 px-4 py-3">
            <span className="font-medium text-ink">
              {isRemittance ? 'Amount paid' : isSupplier ? 'Balance owed' : 'Amount due'}
            </span>
            <span className="numeric text-lg font-semibold text-ink">
              {formatMoney(Math.abs(data.closingBalance))}
            </span>
          </div>
        </div>
      </section>

      <footer className="mt-8 border-t border-border pt-4 text-xs text-muted">
        {isRemittance ? (
          <p>Payment has been made to the banking details we hold for you.</p>
        ) : isSupplier ? (
          <p>
            Our account <span className="text-ink-2">{data.account.code}</span>. Our records as at{' '}
            {data.period.to} — please advise of any difference against your own statement.
          </p>
        ) : (
          <p>
            Please quote your account code <span className="text-ink-2">{data.account.code}</span>{' '}
            with any payment. Queries within 7 days of the statement date.
          </p>
        )}
        <p className="mt-1">
          Generated {data.generatedAt.toLocaleString('en-ZA')} · E &amp; O E
        </p>
      </footer>
    </article>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-6 py-0.5">
      <dt className="text-muted">{label}</dt>
      <dd className="text-ink-2">{value}</dd>
    </div>
  )
}
