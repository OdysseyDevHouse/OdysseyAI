/**
 * Payment runs — paying suppliers against specific invoices.
 *
 * The rule that matters: a payment settles EXACTLY the invoices chosen, never a
 * guess. That is what the remittance advice communicates, and a run that
 * allocated oldest-first at posting time would make the advice a lie.
 *
 *   npm run test:payment-runs
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { createSupplier, getSupplier } from '../src/lib/site/suppliers'
import { postSupplierTransaction, listSupplierLedger, reconcileSupplierBalances } from '../src/lib/site/supplierLedger'
import {
  payableSuppliers, createPaymentRun, postPaymentRun, listPaymentItems,
  getPaymentRun, cancelPaymentRun, payableInvoicesFor, proposeOverdueRun,
} from '../src/lib/site/paymentRuns'
import { buildRemittance } from '../src/lib/statements/remittance'
import { renderStatementPdf } from '../src/lib/statements/pdf'
import { toNum, round } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Payment Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** yyyy-mm-dd, n days ago. */
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const today = daysAgo(0)

  const sup = await createSupplier(SITE, actor, {
    code: `PAY${stamp}`, name: 'Payment Test Supplies', email: `pay${stamp}@example.com`,
    paymentTermsDays: 30,
  })
  if (!sup.ok) { console.log('setup failed:', sup.error); process.exit(1) }

  // Three invoices: two overdue, one still within terms.
  const posted: number[] = []
  for (const [amount, age, num] of [[1150, 90, 'A'], [2300, 45, 'B'], [575, 5, 'C']] as const) {
    const r = await postSupplierTransaction(SITE, actor, {
      supplierId: sup.id, docType: 'invoice', amount, vatRatePct: 15,
      docNumber: `SUP${stamp}${num}`, docDate: daysAgo(age),
    })
    if (r.ok) posted.push(r.id)
  }
  ok('three supplier invoices posted', posted.length === 3)
  ok('  supplier owes 4025', (await getSupplier(SITE, sup.id))?.balance === 4025, String((await getSupplier(SITE, sup.id))?.balance))

  // ── What can be paid
  const payables = await payableSuppliers(SITE)
  const mine = payables.find((p) => p.supplierId === sup.id)
  ok('*** supplier appears as payable ***', !!mine, mine ? `${mine.invoices.length} invoices` : 'not found')
  ok('  with all three invoices', mine?.invoices.length === 3)
  ok('  and an overdue total that excludes the recent one', mine?.overdueTotal === 3450, String(mine?.overdueTotal))

  const overdueOnly = await payableSuppliers(SITE, { overdueOnly: true })
  ok('overdueOnly drops the in-terms invoice',
    overdueOnly.find((p) => p.supplierId === sup.id)?.invoices.length === 2,
    String(overdueOnly.find((p) => p.supplierId === sup.id)?.invoices.length))

  const invoices = await payableInvoicesFor(SITE, sup.id)
  ok('payableInvoicesFor returns them oldest first', invoices[0].docNumber === `SUP${stamp}A`, String(invoices[0].docNumber))

  // ── Validation
  ok('run with no payments refused', !(await createPaymentRun(SITE, actor, { paymentDate: today, payments: [] })).ok)
  ok('bad date refused', !(await createPaymentRun(SITE, actor, { paymentDate: 'nope', payments: [{ supplierId: sup.id, allocations: [{ txnId: posted[0], amount: 10 }] }] })).ok)
  ok('supplier with no chosen invoices refused',
    !(await createPaymentRun(SITE, actor, { paymentDate: today, payments: [{ supplierId: sup.id, allocations: [] }] })).ok)

  const overpay = await createPaymentRun(SITE, actor, {
    paymentDate: today,
    payments: [{ supplierId: sup.id, allocations: [{ txnId: posted[0], amount: 9999 }] }],
  })
  ok('*** paying more than an invoice is worth REFUSED ***', !overpay.ok, !overpay.ok ? overpay.error : '')

  const wrongSupplier = await createPaymentRun(SITE, actor, {
    paymentDate: today,
    payments: [{ supplierId: 999999, allocations: [{ txnId: posted[0], amount: 10 }] }],
  })
  ok('unknown supplier refused', !wrongSupplier.ok)

  // ── A run: settle the oldest in full, part-pay the second
  const run = await createPaymentRun(SITE, actor, {
    paymentDate: today,
    reference: `EFT-${stamp}`,
    payments: [{
      supplierId: sup.id,
      allocations: [
        { txnId: posted[0], amount: 1150 },  // in full
        { txnId: posted[1], amount: 1000 },  // part of 2300
      ],
    }],
  })
  ok('*** payment run created ***', run.ok, run.ok ? `run ${run.runId}` : run.error)
  if (!run.ok) process.exit(1)

  const header = (await getPaymentRun(SITE, run.runId))!
  ok('  total is 2150', header.totalAmount === 2150, String(header.totalAmount))
  ok('  status is draft — nothing paid yet', header.status === 'draft')
  ok('  balance untouched while draft', (await getSupplier(SITE, sup.id))?.balance === 4025)

  const items = await listPaymentItems(SITE, run.runId)
  ok('  one item, two allocations', items.length === 1 && items[0].allocations.length === 2)

  // ── Posting
  const result = await postPaymentRun(SITE, actor, run.runId)
  ok('*** run posted ***', result.ok, result.ok ? `${result.paid} paid, ${result.total}` : result.error)
  ok('  supplier balance reduced to 1875', (await getSupplier(SITE, sup.id))?.balance === 1875, String((await getSupplier(SITE, sup.id))?.balance))

  const ledger = await listSupplierLedger(SITE, sup.id)
  const invA = ledger.find((l) => l.docNumber === `SUP${stamp}A`)
  const invB = ledger.find((l) => l.docNumber === `SUP${stamp}B`)
  const invC = ledger.find((l) => l.docNumber === `SUP${stamp}C`)
  ok('*** the chosen invoice is fully settled ***', invA?.amountOutstanding === 0, String(invA?.amountOutstanding))
  ok('*** the part-paid one has 1300 left ***', invB?.amountOutstanding === 1300, String(invB?.amountOutstanding))
  ok('*** the UNCHOSEN invoice is untouched ***', invC?.amountOutstanding === 575, String(invC?.amountOutstanding))

  const payment = ledger.find((l) => l.docType === 'payment')
  ok('  a payment was posted', payment?.amountSigned === -2150, String(payment?.amountSigned))
  ok('  and is fully applied', payment?.amountOutstanding === 0, String(payment?.amountOutstanding))

  const afterItems = await listPaymentItems(SITE, run.runId)
  ok('  the item links to its ledger row', (afterItems[0].transactionId ?? 0) > 0)
  ok('  run is marked posted', (await getPaymentRun(SITE, run.runId))!.status === 'posted')
  ok('  posting twice refused', !(await postPaymentRun(SITE, actor, run.runId)).ok)
  ok('  a posted run cannot be cancelled', !(await cancelPaymentRun(SITE, run.runId)).ok)

  // ── The remittance advice
  const remittance = await buildRemittance(SITE, 'Test Store', '4123456789', run.runId, sup.id)
  ok('*** remittance built ***', remittance !== null)
  ok('  addressed to the supplier', remittance?.account.name === 'Payment Test Supplies')
  ok('  shows the amount paid', remittance?.closingBalance === 2150, String(remittance?.closingBalance))
  ok('  one line per invoice settled', remittance?.lines.length === 2, String(remittance?.lines.length))
  ok('*** it names the part payment as such ***',
    remittance?.lines.some((l) => l.description.includes('Part payment')) ?? false,
    JSON.stringify(remittance?.lines.map((l) => l.description)))
  ok('  and the settled one as settled in full',
    remittance?.lines.some((l) => l.description === 'Settled in full') ?? false)
  ok('  no ageing on a remittance — it is not a demand', remittance?.aging.total === 0)

  // It renders through the SHARED pdf renderer, unchanged.
  const pdf = await renderStatementPdf(remittance!, 'remittance')
  ok('*** renders as a PDF through the shared renderer ***', pdf.length > 800, `${pdf.length} bytes`)
  ok('  valid PDF', pdf.toString('latin1').startsWith('%PDF-'))

  // ── Propose
  const proposal = await proposeOverdueRun(SITE, today)
  ok('proposeOverdueRun suggests what is overdue', proposal.payments.length > 0)

  // ── Cancelling a draft
  const draft = await createPaymentRun(SITE, actor, {
    paymentDate: today,
    payments: [{ supplierId: sup.id, allocations: [{ txnId: posted[2], amount: 100 }] }],
  })
  if (draft.ok) {
    ok('a draft run can be cancelled', (await cancelPaymentRun(SITE, draft.runId)).ok)
    ok('  and posting a cancelled run is refused', !(await postPaymentRun(SITE, actor, draft.runId)).ok)
  }

  // ── Invariants
  ok('*** reconcileSupplierBalances zero drift ***', (await reconcileSupplierBalances(SITE)).length === 0)

  // ── Cleanup: runs before transactions before the supplier (FKs are RESTRICT).
  await siteExecute(SITE, 'DELETE FROM supplier_payment_runs WHERE id IN (?, ?)', [run.runId, draft.ok ? draft.runId : 0])
  await siteExecute(SITE, 'DELETE FROM supplier_allocations WHERE debit_txn_id IN (SELECT id FROM supplier_transactions WHERE supplier_id = ?) OR credit_txn_id IN (SELECT id FROM supplier_transactions WHERE supplier_id = ?)', [sup.id, sup.id])
  await siteExecute(SITE, 'DELETE FROM supplier_transactions WHERE supplier_id = ?', [sup.id])
  await siteExecute(SITE, 'DELETE FROM suppliers WHERE id = ?', [sup.id])

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}
main()
