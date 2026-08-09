/**
 * Statements — the numbers on a statement of a PAST period.
 *
 * The bug this exists to fence: buildStatement used to compute the aging strip
 * and the closing balance as at TODAY regardless of the period end, so a June
 * statement showed June's transaction lines beside August's buckets and
 * August's balance due. Nobody noticed because the period picker was hidden on
 * the default format, which is exactly the kind of wrongness a period dropdown
 * would mass-produce.
 *
 * The period generator itself is covered by test-statement-periods.ts, which
 * needs no database.
 *
 * Ends on reconcileBalances, so the runner schedules it on its own — see
 * AGENTS.md on why a site-wide assertion cannot share the site.
 *
 *   npm run test:statements
 */
import { siteExecute } from '../src/lib/siteDb'
import { createCustomer, updateCustomer, getCustomer } from '../src/lib/site/customers'
import { postTransaction, allocate, reconcileBalances } from '../src/lib/site/customerLedger'
import { buildStatement } from '../src/lib/statements/render'
import { today } from '../src/lib/site/ledger'

const SITE = 1
const actor = { userId: 1, userName: 'Statement Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const SITE_NAME = 'Test Site'

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const created: number[] = []

  // Three invoices in three consecutive months, all comfortably in the past so
  // "historic" is unambiguous whenever this runs.
  const cust = await createCustomer(SITE, actor, {
    code: `STM${stamp}`,
    name: 'Statement as-at',
    creditLimit: 100000,
    paymentTermsDays: 30,
  })
  if (!cust.ok) {
    console.log('setup failed:', cust.error)
    process.exit(1)
  }
  created.push(cust.id)

  const inv1 = await postTransaction(SITE, actor, { customerId: cust.id, docType: 'invoice', amount: 1000, docNumber: `SA${stamp}1`, docDate: '2026-01-10' })
  const inv2 = await postTransaction(SITE, actor, { customerId: cust.id, docType: 'invoice', amount: 500, docNumber: `SA${stamp}2`, docDate: '2026-02-10' })
  const inv3 = await postTransaction(SITE, actor, { customerId: cust.id, docType: 'invoice', amount: 250, docNumber: `SA${stamp}3`, docDate: '2026-03-10' })
  if (!inv1.ok || !inv2.ok || !inv3.ok) {
    console.log('posting failed')
    process.exit(1)
  }

  console.log('\n── A statement of a past period reports that period ──')
  const feb = await buildStatement(SITE, SITE_NAME, null, cust.id, {
    format: 'activity',
    from: '2026-02-01',
    to: '2026-02-28',
  })
  if (!feb) {
    console.log('build failed')
    process.exit(1)
  }

  ok('opening balance is everything before the period', feb.openingBalance === 1000, String(feb.openingBalance))
  ok('closing balance is the period end, not today', feb.closingBalance === 1500, String(feb.closingBalance))
  ok('  so March is excluded', feb.closingBalance !== 1750, String(feb.closingBalance))
  ok('the aging buckets add up to the closing balance', feb.aging.total === feb.closingBalance, `${feb.aging.total} vs ${feb.closingBalance}`)
  ok('only the period\'s lines are listed', feb.lines.length === 1, String(feb.lines.length))
  ok('  and the running balance ends at the closing balance', feb.lines[feb.lines.length - 1]?.balance === 1500, String(feb.lines[feb.lines.length - 1]?.balance))

  // Invoice 1 is dated 10 Jan on 30-day terms, so it falls due 9 Feb — eight
  // days before the 28th, and not the many months it would be counted as if
  // this were still measured to today.
  const janAging = await buildStatement(SITE, SITE_NAME, null, cust.id, { format: 'activity', from: '2026-02-01', to: '2026-02-28' })
  ok('overdue is measured to the period end', (janAging?.aging.d30 ?? 0) === 1000, JSON.stringify(janAging?.aging))
  ok('  and what is not yet due sits in Current', (janAging?.aging.current ?? 0) === 500, JSON.stringify(janAging?.aging))

  console.log('\n── A payment AFTER the period does not rewrite it ──')
  const pay = await postTransaction(SITE, actor, { customerId: cust.id, docType: 'payment', amount: 1000, docNumber: `SP${stamp}`, docDate: '2026-04-05' })
  if (!pay.ok) {
    console.log('payment failed')
    process.exit(1)
  }
  const alloc = await allocate(SITE, actor, inv1.id, pay.id, 1000)
  ok('the January invoice is settled in April', alloc.ok, alloc.ok ? '' : alloc.error)

  const febAgain = await buildStatement(SITE, SITE_NAME, null, cust.id, { format: 'activity', from: '2026-02-01', to: '2026-02-28' })
  // This is the assertion that proves the reconstruction path is genuinely
  // reached: the fast path reads amount_outstanding, which is now zero on
  // invoice 1, and would quietly report 500 here.
  ok('February\'s aging is unchanged by an April allocation', febAgain?.aging.d30 === 1000, JSON.stringify(febAgain?.aging))
  ok('  and February\'s closing balance is unchanged', febAgain?.closingBalance === 1500, String(febAgain?.closingBalance))

  console.log('\n── A current statement still agrees with the live balance ──')
  const current = await buildStatement(SITE, SITE_NAME, null, cust.id, { format: 'activity', from: '2026-01-01', to: today() })
  const row = await getCustomer(SITE, cust.id)
  ok('closing balance equals customers.balance when the period ends today', current?.closingBalance === row?.balance, `${current?.closingBalance} vs ${row?.balance}`)

  console.log('\n── The cycle drives the bucket labels ──')
  ok('a monthly account reads the familiar ladder', feb.bucketLabels.d30 === '30 days', feb.bucketLabels.d30)
  ok('  and its cycle is reported', feb.cycle === 'monthly', feb.cycle)

  await updateCustomer(SITE, actor, cust.id, {
    code: `STM${stamp}`,
    name: 'Statement as-at',
    creditLimit: 100000,
    paymentTermsDays: 30,
    statementCycle: '7day',
    statementAnchorDate: '2026-02-03',
  })
  const weekly = await buildStatement(SITE, SITE_NAME, null, cust.id, { format: 'activity', from: '2026-02-01', to: '2026-02-28' })
  ok('a weekly account reads a 7-day ladder', weekly?.bucketLabels.d30 === '7 days', weekly?.bucketLabels.d30)
  ok('  open-ended at 28+', weekly?.bucketLabels.d120 === '28+ days', weekly?.bucketLabels.d120)
  // Due 9 Feb, statement to 28 Feb: 19 days late. On the 30-day ladder that is
  // the first overdue bucket; on a 7-day ladder it is the third (15-21 days).
  // Same debt, same lateness — the cycle only changes where the line is drawn.
  ok('  the same 19-day-late invoice moves out along a 7-day ladder', weekly?.aging.d90 === 1000, JSON.stringify(weekly?.aging))
  ok('  where on the monthly ladder it sat in the first bucket', feb.aging.d30 === 1000, JSON.stringify(feb.aging))
  ok('  while the total is the same money either way', weekly?.aging.total === feb.aging.total, `${weekly?.aging.total} vs ${feb.aging.total}`)

  console.log('\n── With no period given, the account\'s current cycle period is used ──')
  const defaulted = await buildStatement(SITE, SITE_NAME, null, cust.id, { format: 'activity' })
  ok('the period is 7 days long', defaulted !== null && daysApart(defaulted.period.from, defaulted.period.to) === 6, `${defaulted?.period.from}..${defaulted?.period.to}`)
  ok('  it contains today', defaulted !== null && defaulted.period.from <= today() && defaulted.period.to >= today())
  ok('  and it is labelled, not printed as raw dates', Boolean(defaulted?.periodLabel && !defaulted.periodLabel.includes(' to ')), defaulted?.periodLabel)

  console.log('\n── Open item on a historic period ──')
  const openHistoric = await buildStatement(SITE, SITE_NAME, null, cust.id, { format: 'open-item', from: '2026-02-01', to: '2026-02-28' })
  const future = openHistoric?.lines.filter((l) => l.date > '2026-02-28') ?? []
  ok('no document raised after the period is listed', future.length === 0, `${future.length} leaked`)

  // ── Cleanup, innermost reference first.
  for (const id of created) {
    await siteExecute(SITE, 'DELETE FROM customer_allocations WHERE debit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)', [id])
    await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [id])
  }

  console.log('\n── Site-wide invariant ──')
  const drift = await reconcileBalances(SITE)
  ok('every customer balance still agrees with its ledger', drift.length === 0, `${drift.length} drifting`)

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

function daysApart(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000,
  )
}

main()
