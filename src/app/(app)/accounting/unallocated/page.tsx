import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import {
  listUnallocatedCredits,
  unallocatedSummary,
  listUnappliedSupplierCredits,
  unidentifiedBankReceipts,
} from '@/lib/site/unallocatedReceipts'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  StatTile,
  EmptyState,
  Badge,
} from '@/components/ui'
import { AllocateButton } from './AllocateButton'

export const dynamic = 'force-dynamic'

/**
 * Money we are holding that is not matched to anything.
 *
 * Three different problems on one screen, deliberately ordered by how wrong
 * each is:
 *
 *   Unidentified bank receipts — the money arrived and NO account was credited.
 *   Somebody is being chased for an invoice they have already paid.
 *
 *   Unapplied customer credits — the account was credited but the invoices are
 *   still open, still ageing, still on the age analysis.
 *
 *   Unapplied supplier credits — we are paying invoices in full while holding a
 *   credit that should have reduced the payment.
 */
export default async function UnallocatedPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('cashbook.view')

  const [summary, credits, supplierCredits, unidentified] = await Promise.all([
    unallocatedSummary(siteId),
    listUnallocatedCredits(siteId, { limit: 200 }),
    listUnappliedSupplierCredits(siteId, { limit: 100 }),
    unidentifiedBankReceipts(siteId, { limit: 100 }),
  ])

  return (
    <>
      <PageHeader
        title="Unallocated money"
        subtitle="Payments and credits that have not been matched to anything"
      />

      <PageBody>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Unidentified receipts"
            value={String(unidentified.length)}
            tone={unidentified.length > 0 ? 'danger' : 'positive'}
            hint={
              unidentified.length > 0
                ? 'Money in, no account credited'
                : 'Every receipt is identified'
            }
          />
          <StatTile
            label="Awaiting allocation"
            value={formatMoney(summary.allocatable)}
            tone={summary.allocatableCount > 0 ? 'warning' : 'default'}
            hint={`${summary.allocatableCount} credit${summary.allocatableCount === 1 ? '' : 's'} with invoices open`}
          />
          <StatTile
            label="Held on account"
            value={formatMoney(summary.heldOnAccount)}
            hint={`${summary.heldOnAccountCount} with nothing to settle`}
          />
          <StatTile
            label="Held over 90 days"
            value={formatMoney(summary.agedTotal)}
            tone={summary.agedCount > 0 ? 'warning' : 'default'}
            hint={`${summary.agedCount} credit${summary.agedCount === 1 ? '' : 's'}`}
          />
        </div>

        {unidentified.length > 0 && (
          <Card>
            <CardHeader
              title="Money in, customer unknown"
              description="These reached the bank but no customer account was credited — somebody's invoice still shows as unpaid. Match them on the account's reconciliation screen."
            />
            <CardBody>
              <ul className="divide-y divide-border">
                {unidentified.map((r) => (
                  <li key={r.bankTxnId} className="flex items-center justify-between gap-4 py-2">
                    <div className="min-w-0">
                      <span className="block truncate text-sm text-ink">
                        {r.description ?? r.reference ?? 'No description'}
                      </span>
                      <span className="text-xs text-muted">
                        {r.txnDate} · {r.bankAccountName} · held {r.daysHeld} day
                        {r.daysHeld === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {r.daysHeld > 30 && <Badge tone="danger">{r.daysHeld} days</Badge>}
                      <span className="numeric text-sm text-ink">{formatMoney(r.amount)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Customer credits not applied"
            description="Payments and credit notes sitting on accounts without settling an invoice."
          />
          {credits.length === 0 ? (
            <CardBody>
              <EmptyState
                title="Everything is allocated"
                hint="Every customer payment has been matched against the invoices it settles."
              />
            </CardBody>
          ) : (
            <CardBody>
              <ul className="divide-y divide-border">
                {credits.map((c) => (
                  <li key={c.txnId} className="flex items-center justify-between gap-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/customers/${c.customerId}`}
                        className="text-sm text-ink hover:text-brand"
                      >
                        {c.customerName}
                      </Link>
                      <span className="mt-0.5 block text-xs text-muted">
                        {c.customerCode} · {c.docType.replace('_', ' ')}
                        {c.docNumber ? ` ${c.docNumber}` : ''} · {c.docDate}
                        {c.reference ? ` · ${c.reference}` : ''}
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-3">
                      {c.daysHeld > 90 && <Badge tone="warning">{c.daysHeld} days</Badge>}
                      {c.canAllocate ? (
                        <Badge tone="brand">{formatMoney(c.openDebt)} open</Badge>
                      ) : (
                        <Badge tone="default">Nothing to settle</Badge>
                      )}
                      <span className="numeric w-28 text-right text-sm text-ink">
                        {formatMoney(c.unapplied)}
                      </span>
                      <AllocateButton txnId={c.txnId} disabled={!c.canAllocate} />
                    </div>
                  </li>
                ))}
              </ul>
            </CardBody>
          )}
        </Card>

        {supplierCredits.length > 0 && (
          <Card>
            <CardHeader
              title="Supplier credits not taken"
              description="Credits we hold that should be reducing what we pay."
            />
            <CardBody>
              <ul className="divide-y divide-border">
                {supplierCredits.map((c) => (
                  <li key={c.txnId} className="flex items-center justify-between gap-4 py-2.5">
                    <div className="min-w-0">
                      <Link
                        href={`/suppliers/${c.supplierId}`}
                        className="text-sm text-ink hover:text-brand"
                      >
                        {c.supplierName}
                      </Link>
                      <span className="mt-0.5 block text-xs text-muted">
                        {c.supplierCode}
                        {c.docNumber ? ` · ${c.docNumber}` : ''} · {c.docDate} · held{' '}
                        {c.daysHeld} day{c.daysHeld === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {c.canAllocate && <Badge tone="brand">{formatMoney(c.openDebt)} open</Badge>}
                      <span className="numeric text-sm text-ink">{formatMoney(c.unapplied)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}
      </PageBody>
    </>
  )
}
