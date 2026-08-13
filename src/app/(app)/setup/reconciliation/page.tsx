import { requireCapability } from '@/lib/auth'
import { reconcileStock } from '@/lib/site/stockMovements'
import { reconcileStockTakes } from '@/lib/site/stockTakes'
import { reconcileTransfers } from '@/lib/site/stockTransfers'
import { reconcileAdjustments } from '@/lib/site/stockAdjustments'
import { reconcileStoreTransfers } from '@/lib/site/storeTransfers'
import { reconcileManufacturing } from '@/lib/site/manufacturing'
import { reconcileBalances } from '@/lib/site/customerLedger'
import { reconcileSupplierBalances } from '@/lib/site/supplierLedger'
import { reconcileAging } from '@/lib/site/aging'
import { reconcileJobParts } from '@/lib/site/jobParts'
import { reconcileJobSla } from '@/lib/site/jobSla'
import { reconcileJobCards } from '@/lib/site/jobCards'
import { listSequences, verifySequence } from '@/lib/site/sequences'
import { formatMoney } from '@/lib/decimals'
import { PageHeader, PageBody, Callout, Card, CardHeader } from '@/components/ui'
import {
  StockDriftTable,
  StockTakeDriftTable,
  TransferDriftTable,
  AdjustmentDriftTable,
  StoreTransferDriftTable,
  BuildDriftTable,
  BalanceDriftTable,
  SequenceTable,
  JobIssuedDriftTable,
  JobInvoicedOutTable,
  JobStrandedTable,
  JobAlsoOnOrderTable,
  JobSlaStaleTable,
  JobSlaImpossibleTable,
  JobSlaUntargetedTable,
  JobLineDriftTable,
  JobStateDriftTable,
  JobStrandedStatusTable,
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
 *   a job line's issued_qty = the transfers that carry its link
 *   a recorded response happened after the job was reported
 *   every issued document number resolves to a document
 *
 * The JOB PARTS check exists because one case defeats every other check on this
 * screen: an invoice consumes from the main location, so a part invoiced while
 * still on a technician's van debits the wrong pile. All three stock invariants
 * still hold — the totals are right, they are just attributed to the wrong
 * shelf — and only the job line knows the goods were elsewhere.
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

  const [
    stock,
    stockTakes,
    transfers,
    adjustments,
    storeTransfers,
    builds,
    customers,
    suppliers,
    aging,
    jobParts,
    jobSla,
    jobCards,
    sequences,
  ] = await Promise.all([
    reconcileStock(siteId),
    reconcileStockTakes(siteId),
    reconcileTransfers(siteId),
    reconcileAdjustments(siteId),
    reconcileStoreTransfers(siteId),
    reconcileManufacturing(siteId),
    reconcileBalances(siteId),
    reconcileSupplierBalances(siteId),
    reconcileAging(siteId),
    /*
     * Tolerant, for the reason reservedQtyFor swallows heldQtyFor: a site that
     * has not yet run 104 has no job_card_lines, and one missing table must not
     * take down the screen somebody opens BECAUSE something is wrong.
     */
    reconcileJobParts(siteId).catch(() => null),
    // Tolerant for the same reason: 113 may not have run on this site yet.
    reconcileJobSla(siteId).catch(() => null),
    reconcileJobCards(siteId).catch(() => null),
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
  /*
   * A dispatch still on the road is NOT a drift — it is a lorry. Only the
   * unsettled kind counts against the books: those goods are on two stores at
   * once, which is a real figure being wrong right now.
   */
  const unsettled = storeTransfers.filter((t) => t.kind === 'unsettled')
  const stillOut = storeTransfers.filter((t) => t.kind === 'stale')

  /*
   * Of the five job-parts checks, only three are drift. Stock sitting on a van
   * for a job nobody has opened yet is untidy, not wrong — the pile and the
   * movements agree. A part promised to both a job and a sales order is a real
   * risk with no arithmetic error behind it: nothing links the two documents, so
   * it can only be reported. Colouring the whole page red for either would teach
   * people to ignore the red.
   */
  const partsDrift = jobParts
    ? jobParts.issuedMismatch.length + jobParts.overIssued.length + jobParts.invoicedWhileOut.length
    : 0

  /*
   * Of the three SLA checks, only one is a bug.
   *
   * A response recorded BEFORE the job was reported cannot happen through the
   * app — responded_at is stamped by markResponded and reported_at defaults to
   * CURRENT_TIMESTAMP — so it means somebody edited the database.
   *
   * The other two are not drift at all. A stored deadline that no longer matches
   * what the current trading hours would produce is exactly what storing the
   * deadline BUYS: a job promised under last months hours must keep its old
   * figure. And a job with no target was logged before the promises existed, so
   * nothing was promised for it. Both are reported, neither is red.
   */
  const slaDrift = jobSla ? jobSla.impossibleResponse.length : 0

  /*
   * Three of the five job checks are bugs; two are not.
   *
   * A line invoiced beyond its quantity, a line pointing at an invoice that is not
   * its job's, and a non-billable line carrying an invoice are each impossible
   * through the app. A status whose role disagrees with the stored open/closed
   * flag is the same class — setStatus is the only writer of both.
   *
   * The board check is a CONFIGURATION trap rather than a bug: a job in a status
   * no board lists is invisible on every board, which is a thing to fix in setup,
   * not a figure that is wrong.
   */
  const jobDrift = jobCards
    ? jobCards.overInvoiced.length +
      jobCards.orphanedInvoiceLinks.length +
      jobCards.billedUnbillable.length +
      jobCards.stateMismatch.length
    : 0

  const ledgersClean =
    stock.length === 0 &&
    stockTakes.length === 0 &&
    transfers.length === 0 &&
    adjustments.length === 0 &&
    unsettled.length === 0 &&
    builds.length === 0 &&
    customers.length === 0 &&
    suppliers.length === 0 &&
    aging.ok &&
    partsDrift === 0 &&
    slaDrift === 0 &&
    jobDrift === 0
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

        {adjustments.length === 0 ? (
          <Callout tone="success" title="Stock adjustments">
            Every posted adjustment moved exactly what its lines claim.
          </Callout>
        ) : (
          <Card>
            <CardHeader
              title="Stock adjustments"
              description="Each posted line against the single movement it must write. An adjustment is one-sided by design, so there is one figure to agree rather than two."
            />
            <AdjustmentDriftTable rows={adjustments} />
          </Card>
        )}

        {unsettled.length === 0 ? (
          <Callout tone="success" title="Store transfers">
            No dispatch is being counted by two stores at once.
          </Callout>
        ) : (
          <Card>
            <CardHeader
              title="Store transfers"
              description="Dispatches the receiving store has already taken while this one still holds them in transit. The goods are counted twice until each is settled — open the dispatch and press “Check with” to finish it."
            />
            <StoreTransferDriftTable rows={unsettled} />
          </Card>
        )}

        {/* Informational, and deliberately not part of "does it add up": goods
            genuinely on a truck are exactly where the books say they are. */}
        {stillOut.length > 0 && (
          <Card>
            <CardHeader
              title="Still on the road"
              description="Dispatched a while ago and not yet confirmed by the receiving store. Not a drift — these goods are correctly on this store's books — but somebody should chase them."
            />
            <StoreTransferDriftTable rows={stillOut} />
          </Card>
        )}

        {/* Job parts. Skipped entirely on a site without the job tables rather
            than reported as clean — "nothing to check" and "checked, fine" are
            different sentences and only one of them is true. */}
        {jobParts !== null &&
          (partsDrift === 0 ? (
            <Callout tone="success" title="Job parts">
              Every part issued to a vehicle matches the transfers that moved it, and nothing
              invoiced is still on board.
            </Callout>
          ) : (
            <>
              {jobParts.issuedMismatch.length > 0 && (
                <Card>
                  <CardHeader
                    title="Parts issued to a vehicle"
                    description="Each job line's issued figure against the transfers that carry its link. A gap means the line and the goods disagree about how much left the shelf."
                  />
                  <JobIssuedDriftTable rows={jobParts.issuedMismatch} />
                </Card>
              )}

              {jobParts.overIssued.length > 0 && (
                <Card>
                  <CardHeader
                    title="More issued than the job needs"
                    description="A line carrying more on a vehicle than the job ever asked for. Arithmetic that cannot be right whatever the goods are doing."
                  />
                  <JobIssuedDriftTable
                    rows={jobParts.overIssued.map((r) => ({
                      lineId: r.lineId,
                      jobId: r.jobId,
                      description: r.description,
                      issued: r.issued,
                      moved: r.qty,
                    }))}
                  />
                </Card>
              )}

              {jobParts.invoicedWhileOut.length > 0 && (
                <Card>
                  <CardHeader
                    title="Invoiced while still on a vehicle"
                    description="The invoice took these units off the main location; the goods are on a bakkie. Every stock invariant still holds, so the stock check above cannot see this — only the job link can. Return them to the shelf, or transfer them back and re-issue."
                  />
                  <JobInvoicedOutTable rows={jobParts.invoicedWhileOut} />
                </Card>
              )}
            </>
          ))}

        {/* Informational, like "still on the road": the pile and the movements
            agree, so neither is a figure being wrong right now. */}
        {jobParts !== null && jobParts.strandedOnVans.length > 0 && (
          <Card>
            <CardHeader
              title="Stock living on a vehicle"
              description="On board for no open job. Correctly counted where it is, but it has been paid for and nobody is going to fit it — either bring it back or open the job it is waiting for."
            />
            <JobStrandedTable rows={jobParts.strandedOnVans} />
          </Card>
        )}

        {jobParts !== null && jobParts.alsoOnOrder.length > 0 && (
          <Card>
            <CardHeader
              title="Promised twice"
              description="A part promised to an open job and reserved by a sales order for the same customer. Nothing links the two documents, so this can only be reported — check whether one unit is being counted on for two jobs."
            />
            <JobAlsoOnOrderTable rows={jobParts.alsoOnOrder} />
          </Card>
        )}

        {jobCards !== null &&
          (jobDrift === 0 ? (
            <Callout tone="success" title="Job cards">
              Every job line agrees with the invoice that took it, and no job is stored in a state
              its stage contradicts.
            </Callout>
          ) : (
            <>
              {jobCards.overInvoiced.length > 0 && (
                <Card>
                  <CardHeader
                    title="Invoiced beyond the quantity"
                    description="A line claiming more invoiced than it has to give. invoiceJob clamps this, so a row here means the clamp was bypassed."
                  />
                  <JobLineDriftTable
                    rows={jobCards.overInvoiced.map((r) => ({
                      lineId: r.lineId,
                      jobId: r.jobId,
                      description: r.description,
                      detail: `${r.invoiced} invoiced of ${r.qty}`,
                    }))}
                  />
                </Card>
              )}

              {jobCards.orphanedInvoiceLinks.length > 0 && (
                <Card>
                  <CardHeader
                    title="Pointing at somebody else's invoice"
                    description="The line names an invoice that is not linked to its job. The thread from job to paper is broken, so the job's revenue cannot be traced."
                  />
                  <JobLineDriftTable
                    rows={jobCards.orphanedInvoiceLinks.map((r) => ({
                      lineId: r.lineId,
                      jobId: r.jobId,
                      description: r.description,
                      detail: `invoice #${r.docId}`,
                    }))}
                  />
                </Card>
              )}

              {jobCards.billedUnbillable.length > 0 && (
                <Card>
                  <CardHeader
                    title="Billed something we said we would not charge for"
                    description="An internal, pending or written-off line carrying an invoice. The customer was charged for work somebody had decided to absorb."
                  />
                  <JobLineDriftTable
                    rows={jobCards.billedUnbillable.map((r) => ({
                      lineId: r.lineId,
                      jobId: r.jobId,
                      description: r.description,
                      detail: r.state,
                    }))}
                  />
                </Card>
              )}

              {jobCards.stateMismatch.length > 0 && (
                <Card>
                  <CardHeader
                    title="Open or closed disagrees with the stage"
                    description="setStatus derives the stored open/closed flag from the stage's role and is the only writer of both, so these cannot diverge through the app. Every open-jobs figure in the system reads the stored flag."
                  />
                  <JobStateDriftTable rows={jobCards.stateMismatch} />
                </Card>
              )}
            </>
          ))}

        {/* Configuration, not drift: nothing is miscounted, but a job in one of
            these stages cannot be found on any board. */}
        {jobCards !== null && jobCards.statusesOffEveryBoard.length > 0 && (
          <Card>
            <CardHeader
              title="Stages that appear on no board"
              description="A job in one of these is invisible on every board — board membership is derived from the stage, so a stage no board lists has nowhere to draw its jobs. Add them to a board under Job workflow."
            />
            <JobStrandedStatusTable rows={jobCards.statusesOffEveryBoard} />
          </Card>
        )}

        {/* Service targets. Skipped on a site without 113 rather than reported
            as clean — "nothing to check" and "checked, fine" differ. */}
        {jobSla !== null &&
          (slaDrift === 0 ? (
            <Callout tone="success" title="Service targets">
              Every recorded response happened after the job it belongs to was reported.
            </Callout>
          ) : (
            <Card>
              <CardHeader
                title="Responded before it was reported"
                description="A first response stamped earlier than the job itself. The app cannot produce this — responded_at is written when somebody presses the button and reported_at defaults to the moment of creation — so it means these rows were edited directly in the database."
              />
              <JobSlaImpossibleTable rows={jobSla.impossibleResponse} />
            </Card>
          ))}

        {/* Informational, like "still on the road": the stored deadline is the
            promise that was made, and keeping it is the whole point. */}
        {jobSla !== null && jobSla.staleDeadlines.length > 0 && (
          <Card>
            <CardHeader
              title="Promised under different trading hours"
              description="These jobs keep the deadline they were given, which is correct — a promise does not move because the opening times changed. Listed so somebody who has just edited the trading hours can see how many live jobs are still measured against the old week."
            />
            <JobSlaStaleTable rows={jobSla.staleDeadlines} />
          </Card>
        )}

        {jobSla !== null && jobSla.missingDeadlines.length > 0 && (
          <Card>
            <CardHeader
              title="Open jobs with no target"
              description="Logged before the service targets were set up, so nothing was promised for them. They are absent from the target lists and will clear as they close. Not a fault — back-dating a deadline would invent a promise nobody made."
            />
            <JobSlaUntargetedTable rows={jobSla.missingDeadlines} />
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
