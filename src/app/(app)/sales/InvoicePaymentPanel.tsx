import { Badge, Card, CardBody, CardHeader, Icons, MeterBar } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { InvoicePayment } from '@/lib/site/paidInvoices'

/**
 * Has this invoice been paid?
 *
 * ── THE QUESTION THE INVOICE SCREEN COULD NOT ANSWER ──────────────────────
 *
 * It showed deposits and nothing else. A receipt lands on the CUSTOMER's
 * account, so learning whether an invoice had actually been paid meant leaving
 * the invoice, opening the account and reading the ledger — and an online
 * payment could arrive overnight leaving this screen looking exactly as before.
 *
 * ── IT READS ALLOCATIONS, SO IT COUNTS EVERY KIND OF SETTLEMENT ───────────
 *
 * A card payment at the counter, an EFT keyed by hand, a credit note, a
 * statement payment auto-allocated across several invoices, a pay link — all of
 * them settle an invoice by creating an allocation, and all of them show here.
 * The figure beside each is what went to THIS invoice, not the credit's total,
 * which is the distinction that matters when one payment covered four bills.
 *
 * ── NOTHING TO SHOW IS ITS OWN ANSWER ─────────────────────────────────────
 *
 * A cash sale is settled at the till and has no ledger entry, so it has no
 * allocations either — and the panel does not render at all rather than saying
 * "unpaid" about a sale that was paid for in cash. The caller decides that by
 * passing `outstanding`, which for a cash sale is already zero.
 */

export function InvoicePaymentPanel({
  totalIncl,
  outstanding,
  payments,
}: {
  totalIncl: number
  /** What is still owed TODAY, from outstandingForDocument. */
  outstanding: number
  payments: InvoicePayment[]
}) {
  // Nothing owed and nothing recorded — a cash sale. It was paid at the till and
  // saying so here would be a panel that appears on every counter sale to
  // announce the obvious.
  if (payments.length === 0 && outstanding <= 0.005) return null

  const paid = Math.max(0, totalIncl - outstanding)
  const settled = outstanding <= 0.005
  const percent = totalIncl > 0 ? Math.min(100, (paid / totalIncl) * 100) : 0

  return (
    <Card>
      <CardHeader
        icon={<Icons.Coins size={18} />}
        title="Payment"
        description="What has been received against this invoice."
        action={
          settled ? (
            <Badge tone="success">Paid in full</Badge>
          ) : paid > 0.005 ? (
            <Badge tone="warning">Part paid</Badge>
          ) : (
            <Badge tone="neutral">Unpaid</Badge>
          )
        }
      />
      <CardBody>
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <p className="text-xs text-muted">Received</p>
            <p className="numeric text-lg font-semibold text-ink">{formatMoney(paid)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted">{settled ? 'Outstanding' : 'Still to pay'}</p>
            <p
              className={`numeric text-lg font-semibold ${settled ? 'text-success' : 'text-ink'}`}
            >
              {formatMoney(outstanding)}
            </p>
          </div>
        </div>

        {/* Against the INVOICE TOTAL, so a part payment reads as the fraction it
            is. A bar scaled to what has been received would draw every invoice
            as paid in full. */}
        <div className="mt-3">
          <MeterBar
            total={100}
            segments={[{ value: percent, tone: settled ? 'success' : 'brand', label: 'Received' }]}
          />
          <p className="mt-1.5 text-xs text-muted">
            {percent.toFixed(0)}% of {formatMoney(totalIncl)} received
          </p>
        </div>

        {payments.length > 0 && (
          <ul className="mt-4 flex flex-col gap-1.5 border-t border-border pt-3">
            {payments.map((p) => (
              <li key={p.id} className="flex items-baseline justify-between gap-4 text-sm">
                <span className="text-ink-2">
                  {p.docDate}
                  {' · '}
                  {p.docType === 'credit_note' ? 'Credit note' : 'Payment'}
                  {/* PayFast's own id, so a shop querying a payment with the
                      gateway has the number it will be asked for. */}
                  {p.reference ? ` · ${p.reference}` : ''}
                </span>
                <span className="flex items-center gap-2">
                  {p.source === 'payfast' && <Badge tone="brand">Online</Badge>}
                  <span className="numeric text-ink">{formatMoney(p.applied)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}
