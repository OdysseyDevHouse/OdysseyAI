/**
 * Interest, settlement discount, period locks, write-offs and unallocated money.
 *
 * The rules that matter, and what breaks if they slip:
 *
 *   Interest is never charged by default. An account nobody signed up must
 *   accrue nothing, whatever rate is lying in the column.
 *
 *   In duplum. Unpaid interest may never exceed the capital — section 103(5)
 *   of the NCA. A balance that breaches it cannot lawfully be collected.
 *
 *   Interest does not compound. Charging interest on interest needs an
 *   agreement this system cannot verify.
 *
 *   A hard-locked period refuses postings. That is the whole point of closing
 *   one; a lock that can be posted through is decoration.
 *
 *   A write-off over the threshold posts NOTHING until approved.
 *
 *   npm run test:accounting
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { createCustomer } from '../src/lib/site/customers'
import { postTransaction, reconcileBalances, listLedger } from '../src/lib/site/customerLedger'
import {
  interestOn, capInDuplum, calculateInterest, effectiveTerms,
  discountFor, discountOpportunities, annualisedDiscountRate, addDays,
} from '../src/lib/site/interestRules'
import { proposeRun, postRun, listItems, getRun, cancelRun, excludeItem, previewForCustomer } from '../src/lib/site/interestRuns'
import { lockPeriod, unlockPeriod, isLocked, guardPosting, lockMonth, listLocks } from '../src/lib/site/periodLocks'
import {
  requestWriteOff, approveWriteOff, rejectWriteOff, recoverWriteOff,
  listWriteOffs, writeOffSummary, writeOffCandidates,
} from '../src/lib/site/writeOffs'
import { listUnallocatedCredits, unallocatedSummary } from '../src/lib/site/unallocatedReceipts'
import { buildVatReturn, vatPeriods } from '../src/lib/site/vatReturn'
import { round, toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Accounting Test' }
const approver = { userId: 2, userName: 'Second Person' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const stamp = Date.now().toString().slice(-6)
const created: number[] = []

async function main() {
  console.log('\n── Interest: the arithmetic ────────────────────────────────\n')

  const terms = { ratePct: 15, enabled: true, graceDays: 0 }

  // R10 000 at 15% for 365 days = R1 500. Simple, not compound.
  ok('a year at 15% on 10 000 is 1500',
      interestOn({ id: 1, outstanding: 10000, daysOverdue: 365 }, terms) === 1500,
      String(interestOn({ id: 1, outstanding: 10000, daysOverdue: 365 }, terms)))

  ok('*** disabled accounts accrue nothing ***',
      interestOn({ id: 1, outstanding: 10000, daysOverdue: 365 }, { ...terms, enabled: false }) === 0)
  ok('a zero rate accrues nothing',
      interestOn({ id: 1, outstanding: 10000, daysOverdue: 365 }, { ...terms, ratePct: 0 }) === 0)

  // Grace is subtracted from the days, not used as a cliff.
  const graced = { ratePct: 15, enabled: true, graceDays: 7 }
  ok('grace reduces the days rather than gating them',
      interestOn({ id: 1, outstanding: 10000, daysOverdue: 10 }, graced) ===
      interestOn({ id: 1, outstanding: 10000, daysOverdue: 3 }, terms))
  ok('inside the grace period, nothing accrues',
      interestOn({ id: 1, outstanding: 10000, daysOverdue: 5 }, graced) === 0)

  // In duplum: unpaid interest may never exceed the capital.
  ok('in duplum allows interest below the capital',
      capInDuplum(500, 10000, 2000).amount === 500)
  ok('*** in duplum caps at the capital ***',
      capInDuplum(500, 10000, 9800).amount === 200 && capInDuplum(500, 10000, 9800).capped)
  ok('*** in duplum charges nothing once reached ***',
      capInDuplum(500, 10000, 10000).amount === 0 && capInDuplum(500, 10000, 10000).capped)

  // Per-item, not on the balance: a fresh invoice must not be charged 90 days.
  const mixed = calculateInterest(
    [
      { id: 1, outstanding: 1000, daysOverdue: 90 },
      { id: 2, outstanding: 1000, daysOverdue: 0 },
    ],
    terms,
  )
  ok('only overdue items are charged', mixed.base === 1000, `base ${mixed.base}`)
  ok('  and for their own days', mixed.days === 90, `days ${mixed.days}`)

  const belowMin = calculateInterest([{ id: 1, outstanding: 10, daysOverdue: 5 }], terms, { minimumCharge: 25 })
  ok('a charge below the minimum is skipped', belowMin.amount === 0 && belowMin.skipReason !== null,
      belowMin.skipReason ?? '')

  // Terms resolution: the account's own rate wins over the group's.
  ok('account rate beats group rate',
      effectiveTerms({ ratePct: 10, enabled: true }, { ratePct: 20, enabled: true, graceDays: 0 }).ratePct === 10)
  ok('group rate is inherited when the account has none',
      effectiveTerms({ ratePct: 0, enabled: true }, { ratePct: 20, enabled: true, graceDays: 0 }).ratePct === 20)
  ok('an account can opt out of a group charge',
      !effectiveTerms({ enabled: false }, { ratePct: 20, enabled: true, graceDays: 0 }).enabled)

  console.log('\n── Settlement discount ─────────────────────────────────────\n')

  const disc = { days: 10, pct: 2 }
  const inWindow = discountFor('2026-03-01', 1000, disc, '2026-03-05')
  ok('2% within 10 days earns 20 on 1000', inWindow.discount === 20)
  ok('  deadline is the invoice date plus the days', inWindow.deadline === '2026-03-11')
  ok('  days remaining counts down', inWindow.daysRemaining === 6, String(inWindow.daysRemaining))

  const missed = discountFor('2026-03-01', 1000, disc, '2026-03-20')
  ok('*** past the window earns nothing ***', missed.discount === 0 && missed.expired)

  // The cliff is deliberate: day 11 earns nothing at all.
  ok('the day after the deadline is a hard zero',
      discountFor('2026-03-01', 1000, disc, '2026-03-12').discount === 0)
  ok('the deadline day itself still earns',
      discountFor('2026-03-01', 1000, disc, '2026-03-11').discount === 20)

  const opportunities = discountOpportunities(
    [
      { txnId: 1, docNumber: 'A', docDate: '2026-03-01', outstanding: 1000 },
      { txnId: 2, docNumber: 'B', docDate: '2026-03-04', outstanding: 5000 },
      { txnId: 3, docNumber: 'C', docDate: '2026-01-01', outstanding: 9000 },
    ],
    disc,
    '2026-03-05',
  )
  ok('expired invoices are dropped', opportunities.length === 2)
  ok('*** most urgent first, not most valuable ***', opportunities[0].txnId === 1,
      opportunities.map((o) => `${o.docNumber}:${o.daysRemaining}d`).join(' '))

  // 2/10 net 30 annualises to roughly 37% — worth taking against any overdraft.
  const annualised = annualisedDiscountRate({ days: 10, pct: 2 }, 30)
  ok('2/10 net 30 annualises above 35%', annualised > 35 && annualised < 40, `${annualised}%`)
  // A poor term is one where little is saved for waiting a long time: 0.5% for
  // paying 55 days early annualises to ~3%, well under any overdraft rate, so
  // the money is better kept in the account.
  ok('a poor discount annualises below borrowing cost',
      annualisedDiscountRate({ days: 5, pct: 0.5 }, 60) < 10,
      `${annualisedDiscountRate({ days: 5, pct: 0.5 }, 60)}%`)

  console.log('\n── Period locks ────────────────────────────────────────────\n')

  const lockFrom = daysAgo(400)
  const lockTo = daysAgo(380)

  const lock = await lockPeriod(SITE, actor, {
    periodFrom: lockFrom, periodTo: lockTo, lockType: 'hard',
    scope: 'all', reason: 'VAT return filed',
  })
  ok('period locked', lock.ok, lock.ok ? '' : lock.error)

  if (lock.ok) {
    const inside = await isLocked(SITE, daysAgo(390))
    ok('*** a date inside a hard lock is refused ***', inside.refused && inside.locked)
    ok('  with a message naming the period', (inside.message ?? '').includes(lockFrom))

    const outside = await isLocked(SITE, daysAgo(370))
    ok('a date outside it is fine', !outside.locked)

    ok('guardPosting returns an error string inside the lock',
        (await guardPosting(SITE, daysAgo(390))) !== null)
    ok('  and null outside it', (await guardPosting(SITE, daysAgo(370))) === null)

    ok('overlapping locks are refused',
        !(await lockPeriod(SITE, actor, { periodFrom: daysAgo(395), periodTo: daysAgo(385) })).ok)

    // A soft lock warns without refusing.
    const soft = await lockPeriod(SITE, actor, {
      periodFrom: daysAgo(370), periodTo: daysAgo(365),
      lockType: 'soft', scope: 'sales', reason: 'Being finalised',
    })
    if (soft.ok) {
      const softCheck = await isLocked(SITE, daysAgo(368), 'sales')
      ok('*** a soft lock warns but allows ***', softCheck.locked && !softCheck.refused)
      ok('  and a different scope is untouched', !(await isLocked(SITE, daysAgo(368), 'stock')).locked)
      await siteExecute(SITE, 'DELETE FROM period_locks WHERE id = ?', [soft.id])
    }

    ok('reopening needs a reason', !(await unlockPeriod(SITE, actor, lock.id, '')).ok)
    ok('reopened', (await unlockPeriod(SITE, actor, lock.id, 'Correction needed')).ok)
    ok('  and posting is allowed again', !(await isLocked(SITE, daysAgo(390))).refused)

    const history = await listLocks(SITE, { includeUnlocked: true })
    const reopened = history.find((l) => l.id === lock.id)
    ok('  the unlocked row is kept for the trail', reopened !== undefined && !reopened.active)
    ok('  recording who reopened it', reopened?.unlockedBy === actor.userName)

    await siteExecute(SITE, 'DELETE FROM period_locks WHERE id = ?', [lock.id])
  }

  console.log('\n── Interest: a real run ────────────────────────────────────\n')

  const cust = await createCustomer(SITE, actor, {
    code: `INT${stamp}`, name: 'Interest Test Co', paymentTermsDays: 30, creditLimit: 100000,
  })
  ok('customer created', cust.ok)
  if (!cust.ok) return finish()
  created.push(cust.id)

  // An invoice 90 days overdue.
  const inv = await postTransaction(SITE, actor, {
    customerId: cust.id, docType: 'invoice', amount: 10000,
    docDate: daysAgo(120), docNumber: `INV${stamp}`,
  })
  ok('overdue invoice posted', inv.ok)

  // Interest is off by default, so a run must find nothing to charge.
  const noneEnabled = await previewForCustomer(SITE, cust.id)
  ok('*** interest is off until switched on ***', noneEnabled?.amount === 0,
      noneEnabled?.skipReason ?? '')

  await siteExecute(SITE,
    'UPDATE customers SET interest_enabled = TRUE, interest_rate_pct = 15, interest_grace_days = 0 WHERE id = ?',
    [cust.id])

  const preview = await previewForCustomer(SITE, cust.id)
  ok('once enabled, interest is calculated', (preview?.amount ?? 0) > 0,
      `${preview?.amount} on ${preview?.base} for ${preview?.days}d`)

  const run = await proposeRun(SITE, actor, {
    periodFrom: daysAgo(30), periodTo: daysAgo(0), minimumCharge: 1,
    customerIds: [cust.id],
  })
  ok('run proposed', run.ok, run.ok ? `${run.charged} charged, ${run.total}` : run.error)

  if (run.ok) {
    const items = await listItems(SITE, run.runId)
    ok('  the account is on the run', items.length === 1)
    ok('  with its workings stored',
        (items[0]?.baseAmount ?? 0) === 10000 && (items[0]?.ratePct ?? 0) === 15,
        `base ${items[0]?.baseAmount} rate ${items[0]?.ratePct} days ${items[0]?.days}`)

    // Nothing is charged until posted.
    const balanceBefore = toNum((await siteQueryOne<{ balance: number }>(
      SITE, 'SELECT balance FROM customers WHERE id = ?', [cust.id]))?.balance)
    ok('*** a draft run charges nothing ***', balanceBefore === 10000, String(balanceBefore))

    const posted = await postRun(SITE, actor, run.runId)
    ok('run posted', posted.ok, posted.ok ? `${posted.posted} accounts, ${posted.total}` : posted.error)

    const balanceAfter = toNum((await siteQueryOne<{ balance: number }>(
      SITE, 'SELECT balance FROM customers WHERE id = ?', [cust.id]))?.balance)
    ok('  the balance now includes the interest', balanceAfter > 10000, String(balanceAfter))

    const ledger = await listLedger(SITE, cust.id)
    const interestLine = ledger.find((l) => l.docType === 'interest')
    ok('  posted as an interest document', interestLine !== undefined)
    ok('  whose description explains itself',
        (interestLine?.description ?? '').includes('15.00%'), interestLine?.description ?? '')

    ok('posting twice is refused', !(await postRun(SITE, actor, run.runId)).ok)

    // The second run must not charge interest on the interest.
    const second = await proposeRun(SITE, actor, {
      periodFrom: daysAgo(30), periodTo: daysAgo(0), minimumCharge: 1, customerIds: [cust.id],
    })
    if (second.ok) {
      const secondItems = await listItems(SITE, second.runId)
      ok('*** interest does not compound ***',
          (secondItems[0]?.baseAmount ?? 0) === 10000,
          `base was ${secondItems[0]?.baseAmount}, should exclude the interest charged`)
      await cancelRun(SITE, actor, second.runId)
      await siteExecute(SITE, 'DELETE FROM interest_runs WHERE id = ?', [second.runId])
    }

    // Excluding an account from a draft.
    const third = await proposeRun(SITE, actor, {
      periodFrom: daysAgo(30), periodTo: daysAgo(0), minimumCharge: 1, customerIds: [cust.id],
    })
    if (third.ok) {
      const thirdItems = await listItems(SITE, third.runId)
      if (thirdItems[0]) {
        ok('an account can be excluded during review',
            (await excludeItem(SITE, actor, thirdItems[0].id, 'In dispute')).ok)
        const after = await getRun(SITE, third.runId)
        ok('  and the run total drops', after?.totalAmount === 0, String(after?.totalAmount))
      }
      await siteExecute(SITE, 'DELETE FROM interest_runs WHERE id = ?', [third.runId])
    }

    await siteExecute(SITE, 'DELETE FROM interest_runs WHERE id = ?', [run.runId])
  }

  console.log('\n── Write-offs ──────────────────────────────────────────────\n')

  const debtor = await createCustomer(SITE, actor, {
    code: `WO${stamp}`, name: 'Write Off Test Co', paymentTermsDays: 30, creditLimit: 100000,
  })
  if (!debtor.ok) return finish()
  created.push(debtor.id)

  await postTransaction(SITE, actor, {
    customerId: debtor.id, docType: 'invoice', amount: 5000,
    docDate: daysAgo(200), docNumber: `WOINV${stamp}`,
  })

  ok('a blank reason is refused',
      !(await requestWriteOff(SITE, actor, { customerId: debtor.id, amount: 100, reason: '' })).ok)
  ok('writing off more than is owed is refused',
      !(await requestWriteOff(SITE, actor, { customerId: debtor.id, amount: 9999, reason: 'Too much' })).ok)

  // Below the threshold: posts at once.
  const small = await requestWriteOff(SITE, actor, {
    customerId: debtor.id, amount: 3.4, reason: 'Rounding difference on settlement',
    category: 'small_bal', approvalThreshold: 1000,
  })
  ok('a small write-off posts immediately', small.ok && small.status === 'posted',
      small.ok ? small.status : small.error)

  const afterSmall = toNum((await siteQueryOne<{ balance: number }>(
    SITE, 'SELECT balance FROM customers WHERE id = ?', [debtor.id]))?.balance)
  ok('  and the balance drops', afterSmall === round(5000 - 3.4, 2), String(afterSmall))

  // At or above the threshold: nothing posts until approved.
  const big = await requestWriteOff(SITE, actor, {
    customerId: debtor.id, amount: 2000, reason: 'Customer liquidated, no prospect of recovery',
    category: 'bad_debt', approvalThreshold: 1000,
  })
  ok('a large write-off waits for approval', big.ok && big.status === 'pending',
      big.ok ? big.status : big.error)

  const afterPending = toNum((await siteQueryOne<{ balance: number }>(
    SITE, 'SELECT balance FROM customers WHERE id = ?', [debtor.id]))?.balance)
  ok('*** a pending write-off moves nothing ***', afterPending === afterSmall, String(afterPending))

  if (big.ok) {
    const approved = await approveWriteOff(SITE, approver, big.id)
    ok('approved and posted', approved.ok)

    const afterApproval = toNum((await siteQueryOne<{ balance: number }>(
      SITE, 'SELECT balance FROM customers WHERE id = ?', [debtor.id]))?.balance)
    ok('  the balance drops on approval', afterApproval === round(afterSmall - 2000, 2),
        String(afterApproval))

    const record = (await listWriteOffs(SITE, { customerId: debtor.id })).find((w) => w.id === big.id)
    ok('  the approver is recorded separately', record?.approvedBy === approver.userName,
        record?.approvedBy ?? '')
    ok('  and differs from the requester', record?.userName === actor.userName)

    // The write-off should have settled the invoice, not left it open.
    const open = await listLedger(SITE, debtor.id, { openOnly: true })
    const stillOpenInvoice = open.find((l) => l.docType === 'invoice' && l.amountOutstanding > 0)
    ok('  and it was applied against the invoice',
        (stillOpenInvoice?.amountOutstanding ?? 0) < 5000,
        `still open: ${stillOpenInvoice?.amountOutstanding ?? 0}`)

    // Recovery puts the debt back.
    const recovered = await recoverWriteOff(SITE, actor, big.id, 500)
    ok('a recovery restores part of the debt', recovered.ok)
    const afterRecovery = toNum((await siteQueryOne<{ balance: number }>(
      SITE, 'SELECT balance FROM customers WHERE id = ?', [debtor.id]))?.balance)
    ok('  the balance goes back up', afterRecovery === round(afterApproval + 500, 2),
        String(afterRecovery))
    ok('recovering twice is refused', !(await recoverWriteOff(SITE, actor, big.id)).ok)
  }

  // Rejection.
  const toReject = await requestWriteOff(SITE, actor, {
    customerId: debtor.id, amount: 1500, reason: 'Speculative write-off request',
    approvalThreshold: 1000,
  })
  if (toReject.ok) {
    ok('rejection needs a reason', !(await rejectWriteOff(SITE, approver, toReject.id, '')).ok)
    ok('rejected', (await rejectWriteOff(SITE, approver, toReject.id, 'Still collectable')).ok)
    const rejected = (await listWriteOffs(SITE, { status: 'rejected' })).find((w) => w.id === toReject.id)
    ok('  and kept on record', rejected !== undefined)
  }

  const summary = await writeOffSummary(SITE, { from: daysAgo(30), to: daysAgo(-1) })
  ok('summary totals by category', summary.total > 0, `${summary.total} across ${summary.rows.length} categories`)
  ok('  and reports recoveries', summary.recovered > 0, String(summary.recovered))

  ok('candidates can be listed', Array.isArray(await writeOffCandidates(SITE, { minDaysSinceActivity: 1 })))

  console.log('\n── Unallocated money ───────────────────────────────────────\n')

  const payer = await createCustomer(SITE, actor, {
    code: `UN${stamp}`, name: 'Unallocated Test Co', paymentTermsDays: 30, creditLimit: 50000,
  })
  if (!payer.ok) return finish()
  created.push(payer.id)

  // A payment with no invoice to settle — money genuinely held.
  await postTransaction(SITE, actor, {
    customerId: payer.id, docType: 'payment', amount: 750,
    docDate: daysAgo(100), reference: 'DEPOSIT', autoAllocate: false,
  })

  const unallocated = await listUnallocatedCredits(SITE, { customerId: payer.id })
  ok('the unapplied payment is found', unallocated.length === 1, `${unallocated.length} found`)
  ok('  reported as held, not allocatable', unallocated[0]?.canAllocate === false)
  ok('  with how long it has been held', (unallocated[0]?.daysHeld ?? 0) >= 99,
      String(unallocated[0]?.daysHeld))

  // Now give them an invoice: the same credit becomes allocatable.
  await postTransaction(SITE, actor, {
    customerId: payer.id, docType: 'invoice', amount: 400,
    docDate: daysAgo(10), docNumber: `UNINV${stamp}`,
  })
  const nowAllocatable = await listUnallocatedCredits(SITE, { customerId: payer.id })
  ok('*** once an invoice exists it becomes allocatable ***',
      nowAllocatable[0]?.canAllocate === true, `openDebt ${nowAllocatable[0]?.openDebt}`)

  const unSummary = await unallocatedSummary(SITE)
  ok('summary splits held from allocatable',
      unSummary.total > 0 && unSummary.count > 0,
      `${unSummary.count} totalling ${unSummary.total}, ${unSummary.allocatableCount} allocatable`)

  console.log('\n── VAT return ──────────────────────────────────────────────\n')

  const vat = await buildVatReturn(SITE, { from: daysAgo(60), to: daysAgo(0) })
  ok('a return is produced', vat !== null)
  ok('  with output and input sides', Array.isArray(vat?.outputByRate) && Array.isArray(vat?.inputByRate))
  ok('  net payable is output minus input',
      vat !== null && vat.netPayable === round(vat.outputTotal.vat - vat.inputTotal.vat, 2),
      `${vat?.outputTotal.vat} - ${vat?.inputTotal.vat} = ${vat?.netPayable}`)
  ok('an invalid range returns nothing',
      (await buildVatReturn(SITE, { from: '2026-12-01', to: '2026-01-01' })) === null)

  const periods = vatPeriods(2026, 'A')
  ok('category A gives six two-month periods', periods.length === 6)
  ok('  ending on odd months', periods[0].to.startsWith('2026-01'), periods[0].to)
  ok('  each spanning two months', periods[1].from === '2026-02-01' && periods[1].to === '2026-03-31',
      `${periods[1].from} to ${periods[1].to}`)

  console.log('\n── Invariants ──────────────────────────────────────────────\n')

  const drift = await reconcileBalances(SITE)
  ok('*** every customer balance agrees with its ledger ***', drift.length === 0,
      JSON.stringify(drift.slice(0, 3)))

  await cleanup()
  finish()
}

async function cleanup() {
  for (const id of created) {
    await siteExecute(SITE, 'DELETE FROM debt_write_offs WHERE customer_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM interest_run_items WHERE customer_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM customer_allocations WHERE debit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?) OR credit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)', [id, id])
    await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [id])
  }
}

function finish() {
  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
