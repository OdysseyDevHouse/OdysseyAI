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
  ButtonLink,
  Card,
  CardHeader,
  StatStrip,
  StatTile,
} from '@/components/ui'
import {
  UnidentifiedTable,
  CustomerCreditsTable,
  SupplierCreditsTable,
  type UnidentifiedRow,
  type CustomerCreditRow,
  type SupplierCreditRow,
} from './UnallocatedTables'

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

  // Plain serializable rows — DataTable's columns and actions are functions,
  // so they live in the client components and only data crosses the boundary.
  const unidentifiedRows: UnidentifiedRow[] = unidentified.map((r) => ({
    bankTxnId: r.bankTxnId,
    description: r.description,
    reference: r.reference,
    txnDate: r.txnDate,
    bankAccountName: r.bankAccountName,
    daysHeld: r.daysHeld,
    amount: r.amount,
  }))

  const creditRows: CustomerCreditRow[] = credits.map((c) => ({
    txnId: c.txnId,
    customerId: c.customerId,
    customerName: c.customerName,
    customerCode: c.customerCode,
    docType: c.docType,
    docNumber: c.docNumber,
    docDate: c.docDate,
    reference: c.reference,
    daysHeld: c.daysHeld,
    canAllocate: c.canAllocate,
    openDebt: c.openDebt,
    unapplied: c.unapplied,
  }))

  const supplierRows: SupplierCreditRow[] = supplierCredits.map((c) => ({
    txnId: c.txnId,
    supplierId: c.supplierId,
    supplierName: c.supplierName,
    supplierCode: c.supplierCode,
    docNumber: c.docNumber,
    docDate: c.docDate,
    daysHeld: c.daysHeld,
    canAllocate: c.canAllocate,
    openDebt: c.openDebt,
    unapplied: c.unapplied,
  }))

  return (
    <>
      <PageHeader
        title="Unallocated money"
        subtitle="Payments and credits that have not been matched to anything"
      />

      <PageBody>
        {/* One tile carries a tone — the act-now one. Coloured counts on every
            tile would leave nothing to notice. */}
        <StatStrip>
          <StatTile
            label="Unidentified receipts"
            value={String(unidentified.length)}
            tone={unidentified.length > 0 ? 'danger' : 'default'}
            hint={
              unidentified.length > 0
                ? 'Money in, no account credited'
                : 'Every receipt is identified'
            }
          />
          <StatTile
            label="Awaiting allocation"
            value={formatMoney(summary.allocatable)}
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
            hint={`${summary.agedCount} credit${summary.agedCount === 1 ? '' : 's'}`}
          />
        </StatStrip>

        {unidentified.length > 0 && (
          <Card>
            <CardHeader
              title="Money in, customer unknown"
              description="These reached the bank but no customer account was credited — somebody's invoice still shows as unpaid. Match them on the account's reconciliation screen."
              action={
                <ButtonLink href="/cashbook" variant="secondary" size="sm">
                  Match in the cashbook
                </ButtonLink>
              }
            />
            <UnidentifiedTable rows={unidentifiedRows} />
          </Card>
        )}

        <Card>
          <CardHeader
            title="Customer credits not applied"
            description="Payments and credit notes sitting on accounts without settling an invoice."
          />
          <CustomerCreditsTable rows={creditRows} />
        </Card>

        {supplierCredits.length > 0 && (
          <Card>
            <CardHeader
              title="Supplier credits not taken"
              description="Credits we hold that should be reducing what we pay."
            />
            <SupplierCreditsTable rows={supplierRows} />
          </Card>
        )}
      </PageBody>
    </>
  )
}
