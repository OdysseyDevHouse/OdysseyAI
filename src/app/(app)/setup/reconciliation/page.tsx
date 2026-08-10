import { requireCapability } from '@/lib/auth'
import { reconcileStock } from '@/lib/site/stockMovements'
import { reconcileStockTakes } from '@/lib/site/stockTakes'
import { reconcileTransfers } from '@/lib/site/stockTransfers'
import { reconcileManufacturing } from '@/lib/site/manufacturing'
import { reconcileBalances } from '@/lib/site/customerLedger'
import { reconcileSupplierBalances } from '@/lib/site/supplierLedger'
import { reconcileAging } from '@/lib/site/aging'
import { listSequences, verifySequence } from '@/lib/site/sequences'
import { formatMoney } from '@/lib/decimals'
import { PageHeader, PageBody, Callout, Card, CardHeader } from '@/components/ui'
import {
  StockDriftTable,
  StockTakeDriftTable,
  TransferDriftTable,
  BuildDriftTable,
  BalanceDriftTable,
  SequenceTable,
} from './DriftTables'

export const dynamic = 'force-dynamic'

/**
 * Does the system still add up?
 *
 * Seven invariants, each of which SHOULD always return nothing:
 *
 *   stock_on_hand      = Σ stock_movements.qty_change
 *   a posted count line's variance = the adjustment it wrote
 *   a posted transfer line = the two movements it wrote, out and in
 *   a posted build's lines = the manufacture movements it wrote
 *   customers.balance  = Σ customer_transactions.amount_signed
 *   suppliers.balance  = Σ supplier_transactions.amount_signed
 *   every issued document number resolves to a document
 *
 * The three DOCUMENT checks catch what the stock check cannot. A transfer that
 * wrote only its "out" half, or a build that consumed its ingredients and never
 * received the finished goods, leaves every product individually consistent
 * with its own movements — so the stock table stays clean and says nothing,
 * while the document claims something that did not happen.
 *
 * A row here is a bug in a posting path, never rounding — both sides of every
 * comparison are DECIMAL and no float is involved anywhere. That is why this
 * screen reports rather than repairs: silently correcting a drift would hide
 * whatever caused it, and the cause is the thing worth knowing.
 *
 * A CLEAN invariant renders as one compact success line; a full empty card per
 * check would bury the one section that actually has rows.
 */
export default async function ReconciliationPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  const [stock, stockTakes, transfers, builds, customers, suppliers, aging, sequences] =
    await Promise.all([
      reconcileStock(siteId),
      reconcileStockTakes(siteId),
      reconcileTransfers(siteId),
      reconcileManufacturing(siteId),
      reconcileBalances(siteId),
      reconcileSupplierBalances(siteId),
      reconcileAging(siteId),
      listSequences(siteId),
    ])

  const checks = await Promise.all(sequences.map((s) => verifySequence(siteId, s.docType)))
  const missingNumbers = checks.filter((c) => c.missing > 0)

  // Worst drift first — the row someone opened this screen for is at the top.
  const byDrift = <T extends { drift: number }>(rows: T[]) =>
    [...rows].sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))

  // The MONEY invariants are the serious ones: a stock or balance drift means a
  // posting path is wrong and figures on screen are lying. An unaccounted
  // document number is a different kind of problem — it means rows were removed
  // outside the app — so it is reported separately rather than colouring the
  // whole page red.
  const ledgersClean =
    stock.length === 0 &&
    stockTakes.length === 0 &&
    transfers.length === 0 &&
    builds.length === 0 &&
    customers.length === 0 &&
    suppliers.length === 0 &&
    aging.ok
  const clean = ledgersClean && missingNumbers.length === 0

  return (
    <>
      <PageHeader
        title="Reconciliation"
        subtitle="Whether the books still agree with themselves."
      />
      <PageBody>
        <Callout
          tone={clean ? 'success' : ledgersClean ? 'warning' : 'danger'}
          title={
            clean
              ? 'Everything reconciles.'
              : ledgersClean
                ? 'The books balance, but some document numbers are unaccounted for.'
                : 'Something does not add up.'
          }
        >
          {clean
            ? 'Stock, counts, transfers, builds, both ledgers, the age analysis and every document number all agree.'
            : ledgersClean
              ? 'Stock, the documents that move it and both ledgers are correct. The numbering gap below usually means documents were removed directly in the database.'
              : 'The differences below are bugs in a posting path, not rounding — every figure compared here is a DECIMAL.'}
        </Callout>

        {stock.length === 0 ? (
          <Callout tone="success" title="Stock on hand">
            Every product&apos;s stock matches its movement history.
          </Callout>
        ) : (
          <Card>
            <CardHeader
              title="Stock on hand"
              description="products.stock_on_hand against the sum of every movement ever recorded."
            />
            <StockDriftTable rows={byDrift(stock)} />
          </Card>
        )}

        {stockTakes.length === 0 ? (
          <Callout tone="success" title="Stock takes">
            Every posted count wrote exactly the movements its lines claim.
          </Callout>
        ) : (
          <Card>
            <CardHeader
              title="Stock takes"
              description="Each posted line's variance against the adjustment it produced. A gap means a count posted only part of itself."
            />
            <StockTakeDriftTable rows={stockTakes} />
          </Card>
        )}

        {transfers.length === 0 ? (
          <Callout tone="success" title="Transfers">
            Every posted transfer moved the same quantity out as it moved in.
          </Callout>
        ) : (
          <Card>
            <CardHeader
              title="Transfers"
              description="Each posted line against the two movements it must write. One half without the other leaves the piles disagreeing with the site total."
            />
            <TransferDriftTable rows={transfers} />
          </Card>
        )}

        {builds.length === 0 ? (
          <Callout tone="success" title="Manufacturing">
            Every posted build consumed and produced exactly what it says it did.
          </Callout>
        ) : (
          <Card>
            <CardHeader
              title="Manufacturing"
              description="Each posted build against the movements it wrote — the ingredients it consumed, and the finished goods it received."
            />
            <BuildDriftTable rows={builds} />
          </Card>
        )}

        {customers.length === 0 ? (
          <Callout tone="success" title="Customer balances">
            Every customer&apos;s balance matches their transactions.
          </Callout>
        ) : (
          <Card>
            <CardHeader
              title="Customer balances"
              description="customers.balance against the sum of their ledger."
            />
            <BalanceDriftTable rows={byDrift(customers)} hrefBase="/customers" />
          </Card>
        )}

        {suppliers.length === 0 ? (
          <Callout tone="success" title="Supplier balances">
            Every supplier&apos;s balance matches their transactions.
          </Callout>
        ) : (
          <Card>
            <CardHeader
              title="Supplier balances"
              description="suppliers.balance against the sum of their ledger."
            />
            <BalanceDriftTable rows={byDrift(suppliers)} hrefBase="/suppliers" />
          </Card>
        )}

        {aging.ok ? (
          <Callout tone="success" title="Age analysis">
            Both paths agree at {formatMoney(aging.fast.total)}.
          </Callout>
        ) : (
          <Card>
            <CardHeader
              title="Age analysis"
              description="The fast path against the as-at reconstruction. They must produce the same total."
            />
            {/* Plain ink — the hero and the card already carry the alarm. */}
            <div className="px-6 py-4 text-sm">
              <p className="text-ink">
                Fast path says {formatMoney(aging.fast.total)}, reconstruction says{' '}
                {formatMoney(aging.rebuilt.total)}.
              </p>
              <p className="mt-1 text-muted">
                A historical age analysis would disagree with the one on screen.
              </p>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Document numbers"
            description="Every number a sequence issued should resolve to a document — live or voided."
          />
          <SequenceTable checks={checks} />
          {missingNumbers.length > 0 && (
            // Outside the table's own scroll container, so it never scrolls
            // sideways with the columns.
            <p className="border-t border-border px-6 py-3 text-xs text-muted">
              An unaccounted number means the sequence issued it but no document carries it. By
              construction that should be impossible — the number and the document are written in
              the same transaction — so it usually means documents were deleted directly in the
              database.
            </p>
          )}
        </Card>
      </PageBody>
    </>
  )
}
