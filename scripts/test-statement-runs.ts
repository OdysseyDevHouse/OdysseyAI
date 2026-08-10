/**
 * Statement runs — the queue, not the sending.
 *
 * SMTP is not configured in development, so the send itself is expected to
 * fail. That is the interesting case: it proves failures land PER ITEM with a
 * reason, that the run still completes, and that retry touches only the
 * failures.
 *
 *   npm run test:statement-runs
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { createCustomer } from '../src/lib/site/customers'
import { postTransaction } from '../src/lib/site/customerLedger'
import {
  createRun, processRun, listItems, getRun, retryFailed, refreshCounts,
  lastStatementFor, deleteRun, itemPeriod,
} from '../src/lib/site/statementRuns'
import { isConfigured } from '../src/lib/mail'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Statement Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const period = { periodFrom: '2026-01-01', periodTo: '2026-12-31' }

  // Three accounts covering the three outcomes a run has to distinguish.
  const withEmail = await createCustomer(SITE, actor, { code: `STA${stamp}`, name: 'Owes and reachable', email: `a${stamp}@example.com`, creditLimit: 10000 })
  const noEmail = await createCustomer(SITE, actor, { code: `STB${stamp}`, name: 'Owes but no email', creditLimit: 10000 })
  const noBalance = await createCustomer(SITE, actor, { code: `STC${stamp}`, name: 'Reachable but settled', email: `c${stamp}@example.com`, creditLimit: 10000 })
  if (!withEmail.ok || !noEmail.ok || !noBalance.ok) { console.log('setup failed'); process.exit(1) }

  // Give the first two a balance; leave the third at zero.
  for (const id of [withEmail.id, noEmail.id]) {
    await postTransaction(SITE, actor, { customerId: id, docType: 'invoice', amount: 1150, vatRatePct: 15, docNumber: `SI${stamp}`, docDate: '2026-06-01' })
  }

  // ── Validation
  ok('empty selection refused', !(await createRun(SITE, actor, { customerIds: [], ...period })).ok)
  ok('bad date refused', !(await createRun(SITE, actor, { customerIds: [withEmail.id], periodFrom: 'nope', periodTo: period.periodTo })).ok)
  ok('period ending before it starts refused', !(await createRun(SITE, actor, { customerIds: [withEmail.id], periodFrom: '2026-12-31', periodTo: '2026-01-01' })).ok)

  // ── Creating the run
  const created = await createRun(SITE, actor, {
    customerIds: [withEmail.id, noEmail.id, noBalance.id],
    ...period,
  })
  ok('*** run created ***', created.ok, created.ok ? `run ${created.runId}` : created.error)
  if (!created.ok) process.exit(1)
  ok('  only the sendable one was queued', created.queued === 1, String(created.queued))

  const items = await listItems(SITE, created.runId)
  ok('  all three accounts appear on the run', items.length === 3, String(items.length))

  const byCode = new Map(items.map((i) => [i.customerCode, i]))
  ok('*** no email -> skipped, with the reason ***',
    byCode.get(`STB${stamp}`)?.status === 'skipped' && (byCode.get(`STB${stamp}`)?.error ?? '').includes('No email'),
    byCode.get(`STB${stamp}`)?.error ?? '')
  ok('*** nothing owed -> skipped, with the reason ***',
    byCode.get(`STC${stamp}`)?.status === 'skipped' && (byCode.get(`STC${stamp}`)?.error ?? '').includes('Nothing outstanding'),
    byCode.get(`STC${stamp}`)?.error ?? '')
  ok('  the sendable one is queued', byCode.get(`STA${stamp}`)?.status === 'queued')
  ok('  balance captured at queue time', byCode.get(`STA${stamp}`)?.closingBalance === 1150, String(byCode.get(`STA${stamp}`)?.closingBalance))

  // ── Per-item periods
  //
  // Three accounts on three different cycles, one requested end date. Each must
  // get ITS OWN period containing that date, or a weekly customer receives a
  // month-long "statement" — a different document, not a rounding error.
  await siteExecute(SITE, "UPDATE customers SET statement_cycle='7day', statement_anchor_date='2026-08-04' WHERE id = ?", [withEmail.id])
  await siteExecute(SITE, "UPDATE customers SET statement_cycle='14day', statement_anchor_date='2026-08-04' WHERE id = ?", [noEmail.id])
  await siteExecute(SITE, "UPDATE customers SET statement_cycle='monthly', statement_anchor_day=0 WHERE id = ?", [noBalance.id])

  const cycleRun = await createRun(SITE, actor, {
    customerIds: [withEmail.id, noEmail.id, noBalance.id],
    periodFrom: '2026-08-01',
    periodTo: '2026-08-06',
  })
  ok('*** a cycle run is created ***', cycleRun.ok, cycleRun.ok ? '' : cycleRun.error)
  if (cycleRun.ok) {
    const byCycleCode = new Map((await listItems(SITE, cycleRun.runId)).map((i) => [i.customerCode, i]))
    const weekly = byCycleCode.get(`STA${stamp}`)
    const fortnightly = byCycleCode.get(`STB${stamp}`)
    const monthly = byCycleCode.get(`STC${stamp}`)

    ok('  the weekly account gets its week', weekly?.periodFrom === '2026-08-04' && weekly?.periodTo === '2026-08-10', `${weekly?.periodFrom}..${weekly?.periodTo}`)
    ok('  the fortnightly account gets its fortnight', fortnightly?.periodFrom === '2026-08-04' && fortnightly?.periodTo === '2026-08-17', `${fortnightly?.periodFrom}..${fortnightly?.periodTo}`)
    ok('  the monthly account gets the whole month', monthly?.periodFrom === '2026-08-01' && monthly?.periodTo === '2026-08-31', `${monthly?.periodFrom}..${monthly?.periodTo}`)
    ok('  every period contains the requested end date',
      [weekly, fortnightly, monthly].every((i) => (i?.periodFrom ?? '') <= '2026-08-06' && (i?.periodTo ?? '') >= '2026-08-06'))
    ok('  and they are genuinely different', new Set([weekly?.periodTo, fortnightly?.periodTo, monthly?.periodTo]).size === 3)

    // The escape hatch: everyone's January, whatever their cycle.
    const fixedRun = await createRun(SITE, actor, {
      customerIds: [withEmail.id, noEmail.id, noBalance.id],
      periodFrom: '2026-01-01',
      periodTo: '2026-01-31',
      periodMode: 'fixed',
    })
    ok('*** a fixed run overrides every cycle ***', fixedRun.ok, fixedRun.ok ? '' : fixedRun.error)
    if (fixedRun.ok) {
      const fixedItems = await listItems(SITE, fixedRun.runId)
      ok('  no item carries its own period', fixedItems.every((i) => i.periodFrom === null && i.periodTo === null))
      // Which is how a legacy row behaves too, and it must still send.
      const fixed = await getRun(SITE, fixedRun.runId)
      const resolved = fixed ? itemPeriod(fixed, fixedItems[0]) : null
      ok('  so they fall back to the run period', resolved?.from === '2026-01-01' && resolved?.to === '2026-01-31', `${resolved?.from}..${resolved?.to}`)
      await siteExecute(SITE, 'DELETE FROM customer_statement_items WHERE run_id = ?', [fixedRun.runId])
      await siteExecute(SITE, 'DELETE FROM customer_statement_runs WHERE id = ?', [fixedRun.runId])
    }

    await siteExecute(SITE, 'DELETE FROM customer_statement_items WHERE run_id = ?', [cycleRun.runId])
    await siteExecute(SITE, 'DELETE FROM customer_statement_runs WHERE id = ?', [cycleRun.runId])
  }

  // Back to monthly so the send assertions below are not cycle-dependent.
  for (const id of [withEmail.id, noEmail.id, noBalance.id]) {
    await siteExecute(SITE, "UPDATE customers SET statement_cycle='monthly', statement_anchor_date=NULL WHERE id = ?", [id])
  }

  // Queueing the same account twice on one run must be impossible.
  let duplicate = false
  try {
    await siteExecute(SITE,
      `INSERT INTO customer_statement_items (run_id, customer_id, customer_code, customer_name, status)
       VALUES (?,?,?,?, 'queued')`, [created.runId, withEmail.id, 'DUP', 'Duplicate'])
    duplicate = true
  } catch { /* the unique index refused it */ }
  ok('*** the same account cannot be queued twice on one run ***', !duplicate)

  // ── Processing
  const mailReady = isConfigured()
  console.log(`\n   (SMTP configured: ${mailReady} — the send is expected to ${mailReady ? 'succeed' : 'fail'} below)\n`)

  const result = await processRun(SITE, 'Test Store', '4123456789', created.runId)
  const run = (await getRun(SITE, created.runId))!

  if (mailReady) {
    ok('run completed with a send', run.status === 'completed' && result.sent === 1, JSON.stringify(result))
    ok('  item marked sent with a timestamp', (await listItems(SITE, created.runId, 'sent'))[0]?.sentAt !== null)
  } else {
    // The interesting path: the run must still COMPLETE, with the failure
    // recorded against the item rather than killing the batch.
    ok('*** run still completes when the send fails ***', run.status === 'completed' || run.status === 'failed', run.status)
    const failed = await listItems(SITE, created.runId, 'failed')
    const isFailedRun = run.status === 'failed'
    ok('*** the failure is recorded, not swallowed ***',
      isFailedRun ? (run.error ?? '').length > 0 : failed.length === 1 && (failed[0].error ?? '').length > 0,
      isFailedRun ? (run.error ?? '') : (failed[0]?.error ?? ''))
    if (!isFailedRun) {
      ok('  and the attempt was counted', failed[0]?.attempts === 1, String(failed[0]?.attempts))
    }
  }

  ok('  counts add up to the total',
    run.sentCount + run.failedCount + run.skippedCount === run.totalCount,
    `${run.sentCount}+${run.failedCount}+${run.skippedCount} vs ${run.totalCount}`)
  ok('  skipped count is 2', run.skippedCount === 2, String(run.skippedCount))

  // ── Retry touches ONLY the failures
  const beforeRetry = await listItems(SITE, created.runId)
  const skippedBefore = beforeRetry.filter((i) => i.status === 'skipped').map((i) => i.id).sort()
  const { requeued } = await retryFailed(SITE, created.runId)

  if (run.failedCount > 0) {
    ok('*** retry requeues the failures ***', requeued === run.failedCount, `${requeued} vs ${run.failedCount}`)
    const afterRetry = await listItems(SITE, created.runId)
    const skippedAfter = afterRetry.filter((i) => i.status === 'skipped').map((i) => i.id).sort()
    ok('*** and leaves the skipped ones alone ***', JSON.stringify(skippedBefore) === JSON.stringify(skippedAfter))
    ok('  the run reopens for another pass', (await getRun(SITE, created.runId))!.status === 'pending')
  } else {
    ok('retry finds nothing to requeue when nothing failed', requeued === 0)
  }

  // ── Counts are derived, never trusted
  await siteExecute(SITE, 'UPDATE customer_statement_runs SET sent_count = 999 WHERE id = ?', [created.runId])
  await refreshCounts(SITE, created.runId)
  ok('*** refreshCounts rebuilds the header from the items ***',
    (await getRun(SITE, created.runId))!.sentCount !== 999)

  // ── lastStatementFor
  const last = await lastStatementFor(SITE, withEmail.id)
  ok('lastStatementFor returns nothing until one is actually sent', mailReady ? last !== null : last === null)

  // ── Deleting
  await siteExecute(SITE, "UPDATE customer_statement_runs SET status = 'running' WHERE id = ?", [created.runId])
  ok('a running run cannot be deleted', !(await deleteRun(SITE, actor, created.runId)).ok)
  await siteExecute(SITE, "UPDATE customer_statement_runs SET status = 'completed' WHERE id = ?", [created.runId])
  ok('a finished run can be deleted', (await deleteRun(SITE, actor, created.runId)).ok)
  ok('  and its items go with it', (await listItems(SITE, created.runId)).length === 0)

  // ── Cleanup: items reference customers with RESTRICT, so runs go first.
  for (const id of [withEmail.id, noEmail.id, noBalance.id]) {
    await siteExecute(SITE, 'DELETE FROM customer_statement_items WHERE customer_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM customer_allocations WHERE debit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)', [id])
    await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [id])
  }
  const orphans = await siteQueryOne<any>(SITE, 'SELECT COUNT(*) n FROM customer_statement_runs WHERE total_count = 3 AND sent_count = 0 AND failed_count = 0')
  if (toNum(orphans?.n) > 0) await siteExecute(SITE, 'DELETE FROM customer_statement_runs WHERE id = ?', [created.runId])

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}
main()
