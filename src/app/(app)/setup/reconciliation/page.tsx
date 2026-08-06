import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import { reconcileStock } from '@/lib/site/stockMovements'
import { reconcileBalances } from '@/lib/site/customerLedger'
import { reconcileSupplierBalances } from '@/lib/site/supplierLedger'
import { reconcileAging } from '@/lib/site/aging'
import { listSequences, verifySequence } from '@/lib/site/sequences'
import { formatMoney, formatQty } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  Badge,
  Icons,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

/**
 * Does the system still add up?
 *
 * Four invariants, each of which SHOULD always return nothing:
 *
 *   stock_on_hand      = Σ stock_movements.qty_change
 *   customers.balance  = Σ customer_transactions.amount_signed
 *   suppliers.balance  = Σ supplier_transactions.amount_signed
 *   every issued document number resolves to a document
 *
 * A row here is a bug in a posting path, never rounding — both sides of every
 * comparison are DECIMAL and no float is involved anywhere. That is why this
 * screen reports rather than repairs: silently correcting a drift would hide
 * whatever caused it, and the cause is the thing worth knowing.
 */
export default async function ReconciliationPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  const [stock, customers, suppliers, aging, sequences] = await Promise.all([
    reconcileStock(siteId),
    reconcileBalances(siteId),
    reconcileSupplierBalances(siteId),
    reconcileAging(siteId),
    listSequences(siteId),
  ])

  const checks = await Promise.all(sequences.map((s) => verifySequence(siteId, s.docType)))
  const missingNumbers = checks.filter((c) => c.missing > 0)

  // The MONEY invariants are the serious ones: a stock or balance drift means a
  // posting path is wrong and figures on screen are lying. An unaccounted
  // document number is a different kind of problem — it means rows were removed
  // outside the app — so it is reported separately rather than colouring the
  // whole page red.
  const ledgersClean =
    stock.length === 0 && customers.length === 0 && suppliers.length === 0 && aging.ok
  const clean = ledgersClean && missingNumbers.length === 0

  return (
    <>
      <PageHeader
        title="Reconciliation"
        subtitle="Whether the books still agree with themselves."
      />
      <PageBody>
        <Card>
          <div className="flex items-center gap-3 px-6 py-5">
            <span
              className={`flex size-10 shrink-0 items-center justify-center rounded-control ${
                clean
                  ? 'bg-success-soft text-success'
                  : ledgersClean
                    ? 'bg-warning-soft text-warning'
                    : 'bg-danger-soft text-danger'
              }`}
            >
              {clean ? (
                <Icons.StatusSuccess size={20} />
              ) : ledgersClean ? (
                <Icons.StatusWarning size={20} />
              ) : (
                <Icons.StatusError size={20} />
              )}
            </span>
            <div>
              <p className="font-medium text-ink">
                {clean
                  ? 'Everything reconciles.'
                  : ledgersClean
                    ? 'The books balance, but some document numbers are unaccounted for.'
                    : 'Something does not add up.'}
              </p>
              <p className="text-sm text-muted">
                {clean
                  ? 'Stock, both ledgers, the age analysis and every document number all agree.'
                  : ledgersClean
                    ? 'Stock and both ledgers are correct. The numbering gap below usually means documents were removed directly in the database.'
                    : 'The differences below are bugs in a posting path, not rounding — every figure compared here is a DECIMAL.'}
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Stock on hand"
            description="products.stock_on_hand against the sum of every movement ever recorded."
          />
          {stock.length === 0 ? (
            <Clean message="Every product's stock matches its movement history." />
          ) : (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Product</th>
                    <th className={`${TABLE_TH} text-right`}>Stored</th>
                    <th className={`${TABLE_TH} text-right`}>From movements</th>
                    <th className={`${TABLE_TH} text-right`}>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {stock.map((row) => (
                    <tr key={row.productId} className={TABLE_ROW}>
                      <td className={TABLE_TD}>
                        <Link
                          href={`/products/${row.productId}`}
                          className="text-brand hover:underline"
                        >
                          {row.code}
                        </Link>
                        <div className="text-ink">{row.description}</div>
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatQty(row.stored)}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatQty(row.computed)}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-danger`}>
                        {formatQty(row.drift)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Customer balances"
            description="customers.balance against the sum of their ledger."
          />
          {customers.length === 0 ? (
            <Clean message="Every customer's balance matches their transactions." />
          ) : (
            <DriftTable rows={customers} hrefBase="/customers" />
          )}
        </Card>

        <Card>
          <CardHeader
            title="Supplier balances"
            description="suppliers.balance against the sum of their ledger."
          />
          {suppliers.length === 0 ? (
            <Clean message="Every supplier's balance matches their transactions." />
          ) : (
            <DriftTable rows={suppliers} hrefBase="/suppliers" />
          )}
        </Card>

        <Card>
          <CardHeader
            title="Age analysis"
            description="The fast path against the as-at reconstruction. They must produce the same total."
          />
          {aging.ok ? (
            <Clean message={`Both agree at ${formatMoney(aging.fast.total)}.`} />
          ) : (
            <div className="px-6 py-4 text-sm">
              <p className="text-danger">
                Fast path says {formatMoney(aging.fast.total)}, reconstruction says{' '}
                {formatMoney(aging.rebuilt.total)}.
              </p>
              <p className="mt-1 text-muted">
                A historical age analysis would disagree with the one on screen.
              </p>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Document numbers"
            description="Every number a sequence issued should resolve to a document — live or voided."
          />
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Sequence</th>
                  <th className={`${TABLE_TH} text-right`}>Issued</th>
                  <th className={`${TABLE_TH} text-right`}>Live</th>
                  <th className={`${TABLE_TH} text-right`}>Voided</th>
                  <th className={`${TABLE_TH} text-right`}>Unaccounted</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((check) => (
                  <tr key={check.docType} className={TABLE_ROW}>
                    <td className={TABLE_TD}>
                      {check.docType}
                      {check.firstNumber && (
                        <div className="text-xs text-muted">
                          {check.firstNumber} – {check.lastNumber}
                        </div>
                      )}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{check.issued}</td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{check.live}</td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {/* A voided document is an EXPLAINABLE gap — it keeps its
                          number and its reason, which is what the law asks for. */}
                      {check.voided > 0 ? <Badge tone="neutral">{check.voided}</Badge> : '—'}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {check.missing > 0 ? (
                        <Badge tone="danger">{check.missing}</Badge>
                      ) : (
                        <span className="text-faint">0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {missingNumbers.length > 0 && (
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

function Clean({ message }: { message: string }) {
  return (
    <p className="flex items-center gap-2 px-6 py-4 text-sm text-muted">
      <Icons.Check size={15} className="text-success" />
      {message}
    </p>
  )
}

function DriftTable({
  rows,
  hrefBase,
}: {
  rows: { id: number; code: string; name: string; stored: number; computed: number; drift: number }[]
  hrefBase: string
}) {
  return (
    <div className="overflow-x-auto">
      <table className={TABLE}>
        <thead>
          <tr className={TABLE_HEAD_ROW}>
            <th className={TABLE_TH}>Account</th>
            <th className={`${TABLE_TH} text-right`}>Stored</th>
            <th className={`${TABLE_TH} text-right`}>From ledger</th>
            <th className={`${TABLE_TH} text-right`}>Difference</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={TABLE_ROW}>
              <td className={TABLE_TD}>
                <Link href={`${hrefBase}/${row.id}`} className="text-brand hover:underline">
                  {row.code}
                </Link>
                <div className="text-ink">{row.name}</div>
              </td>
              <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(row.stored)}</td>
              <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(row.computed)}</td>
              <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-danger`}>
                {formatMoney(row.drift)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
