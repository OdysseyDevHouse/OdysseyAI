/**
 * Settlement discount, taken on a real payment run.
 *
 * THE CLAIM BEING TESTED: a discounted invoice settles in FULL. Pay R980 on a
 * R1 000 invoice with 2% terms and the remaining R20 must be closed by a credit
 * note — not left outstanding for ever on an invoice both sides consider paid.
 * That is the difference between a working creditors ledger and one that slowly
 * fills with phantom balances.
 *
 *   npm run test:settlement-discount
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { createSupplier, getSupplier, updateSupplier } from '../src/lib/site/suppliers'
import { buildRemittance } from '../src/lib/statements/remittance'
import { renderStatementPdf } from '../src/lib/statements/pdf'
import {
  postSupplierTransaction,
  listSupplierLedger,
  reconcileSupplierBalances,
} from '../src/lib/site/supplierLedger'
import {
  payableSuppliers,
  createPaymentRun,
  postPaymentRun,
  listPaymentItems,
  payableInvoicesFor,
  proposeDiscountRun,
} from '../src/lib/site/paymentRuns'
import { round, toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Discount Test' }
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
const today = daysAgo(0)

async function main() {
  const sup = await createSupplier(SITE, actor, {
    code: `SD${stamp}`,
    name: 'Discount Test Supplier',
    paymentTermsDays: 30,
  })
  ok('supplier created', sup.ok)
  if (!sup.ok) return finish(0)

  // 2/10 net 30 — the classic term.
  await siteExecute(
    SITE,
    'UPDATE suppliers SET settlement_discount_days = 10, settlement_discount_pct = 2 WHERE id = ?',
    [sup.id],
  )

  // An invoice dated three days ago: inside the 10-day discount window.
  const inWindow = await postSupplierTransaction(SITE, actor, {
    supplierId: sup.id,
    docType: 'invoice',
    amount: 1000,
    docDate: daysAgo(3),
    docNumber: `SDINV${stamp}`,
  })
  ok('invoice posted', inWindow.ok)

  // A second, dated 40 days ago: the window has long passed.
  const expired = await postSupplierTransaction(SITE, actor, {
    supplierId: sup.id,
    docType: 'invoice',
    amount: 500,
    docDate: daysAgo(40),
    docNumber: `SDOLD${stamp}`,
  })
  ok('expired-window invoice posted', expired.ok)
  if (!inWindow.ok || !expired.ok) return finish(sup.id)

  console.log('\n── The discount is offered ─────────────────────────────────\n')

  const payable = (await payableSuppliers(SITE)).find((s) => s.supplierId === sup.id)
  ok('supplier appears as payable', payable !== undefined)
  ok('*** discount offered on the in-window invoice ***',
      (payable?.discountAvailable ?? 0) === 20,
      `offered ${payable?.discountAvailable}`)
  ok('  and a deadline is given', payable?.nextDiscountDeadline !== null,
      payable?.nextDiscountDeadline ?? 'none')

  const invoices = await payableInvoicesFor(SITE, sup.id)
  const fresh = invoices.find((i) => i.txnId === inWindow.id)
  const old = invoices.find((i) => i.txnId === expired.id)

  ok('the in-window invoice carries its discount', fresh?.discountAvailable === 20,
      String(fresh?.discountAvailable))
  ok('*** the expired one carries none ***', old?.discountAvailable === 0,
      String(old?.discountAvailable))

  console.log('\n── The rule: it must settle in full ────────────────────────\n')

  // Paying 980 with NO discount recorded leaves 20 outstanding — allowed, it is
  // simply a part payment. What must be refused is claiming a discount whose
  // arithmetic does not close the invoice.
  const wrongMaths = await createPaymentRun(SITE, actor, {
    paymentDate: today,
    payments: [
      {
        supplierId: sup.id,
        allocations: [{ txnId: inWindow.id, amount: 900, discount: 20 }],
      },
    ],
  })
  ok('*** a discount that does not clear the invoice is refused ***', !wrongMaths.ok,
      wrongMaths.ok ? 'IT WAS ACCEPTED' : wrongMaths.error)

  const negative = await createPaymentRun(SITE, actor, {
    paymentDate: today,
    payments: [
      { supplierId: sup.id, allocations: [{ txnId: inWindow.id, amount: 980, discount: -5 }] },
    ],
  })
  ok('a negative discount is refused', !negative.ok)

  console.log('\n── Posting ─────────────────────────────────────────────────\n')

  const run = await createPaymentRun(SITE, actor, {
    paymentDate: today,
    reference: `RUN${stamp}`,
    payments: [
      {
        supplierId: sup.id,
        // 980 paid + 20 discount = the full 1000.
        allocations: [{ txnId: inWindow.id, amount: 980, discount: 20 }],
      },
    ],
  })
  ok('run created with a discount', run.ok, run.ok ? '' : run.error)
  if (!run.ok) return finish(sup.id)

  const items = await listPaymentItems(SITE, run.runId)
  ok('  the discount is stored on the item', items[0]?.discountAmount === 20,
      String(items[0]?.discountAmount))
  ok('  and per invoice for the remittance', items[0]?.allocations[0]?.discountAmount === 20,
      String(items[0]?.allocations[0]?.discountAmount))

  const posted = await postPaymentRun(SITE, actor, run.runId)
  ok('run posted', posted.ok, posted.ok ? `paid ${posted.total}, discount ${posted.discount}` : posted.error)
  ok('  the discount is reported', posted.ok && posted.discount === 20)

  // THE assertion this whole feature exists for.
  const ledger = await listSupplierLedger(SITE, sup.id)
  const settledInvoice = ledger.find((l) => l.id === inWindow.id)
  ok('*** THE INVOICE IS FULLY SETTLED — nothing left dangling ***',
      round(settledInvoice?.amountOutstanding ?? -1, 2) === 0,
      `outstanding ${settledInvoice?.amountOutstanding}`)

  const creditNote = ledger.find((l) => l.docType === 'credit_note')
  ok('  a credit note carries the discount', creditNote !== undefined)
  ok('  for the discount amount', Math.abs(creditNote?.amountSigned ?? 0) === 20,
      String(creditNote?.amountSigned))
  ok('  and it is fully applied', round(creditNote?.amountOutstanding ?? -1, 2) === 0,
      String(creditNote?.amountOutstanding))
  ok('  described so the saving is visible',
      (creditNote?.description ?? '').toLowerCase().includes('settlement discount'),
      creditNote?.description ?? '')

  const afterPost = await listPaymentItems(SITE, run.runId)
  ok('  the credit note is linked to the run item', afterPost[0]?.discountTxnId !== null)

  // The balance must now be exactly the untouched second invoice.
  const balance = toNum(
    (await siteQueryOne<{ balance: number }>(SITE, 'SELECT balance FROM suppliers WHERE id = ?', [
      sup.id,
    ]))?.balance,
  )
  ok('*** the balance is only the invoice we did not pay ***', balance === 500, String(balance))

  console.log('\n── Proposing a discount run ────────────────────────────────\n')

  // A third invoice, in window, to be found by the proposer.
  const third = await postSupplierTransaction(SITE, actor, {
    supplierId: sup.id,
    docType: 'invoice',
    amount: 2000,
    docDate: daysAgo(1),
    docNumber: `SD3${stamp}`,
  })

  const proposal = await proposeDiscountRun(SITE, today, 14)
  const mine = proposal.payments.find((p) => p.supplierId === sup.id)
  ok('the proposer finds the in-window invoice', mine !== undefined)
  ok('  paying net of the discount', mine?.allocations[0]?.amount === 1960,
      String(mine?.allocations[0]?.amount))
  ok('  and recording the discount', mine?.allocations[0]?.discount === 40,
      String(mine?.allocations[0]?.discount))
  ok('*** it excludes the expired-window invoice ***',
      !mine?.allocations.some((a) => a.txnId === expired.id))

  console.log('\n── Terms round-trip through the supplier record ────────────\n')

  const saved = await getSupplier(SITE, sup.id)
  ok('the discount terms read back', saved?.settlementDiscountDays === 10 && saved?.settlementDiscountPct === 2,
      `${saved?.settlementDiscountPct}/${saved?.settlementDiscountDays}`)

  // The positional-column trap: notes must not land in a numeric column.
  const updated = await updateSupplier(SITE, actor, sup.id, {
    code: `SD${stamp}`, name: 'Discount Test Supplier', paymentTermsDays: 30,
    settlementDiscountDays: 15, settlementDiscountPct: 2.5, notes: 'kept',
  })
  ok('terms can be updated', updated.ok, updated.ok ? '' : updated.error)
  const after = await getSupplier(SITE, sup.id)
  ok('  new terms read back', after?.settlementDiscountDays === 15 && after?.settlementDiscountPct === 2.5,
      `${after?.settlementDiscountPct}/${after?.settlementDiscountDays}`)
  ok('*** notes land in notes, not a discount column ***', after?.notes === 'kept',
      String(after?.notes))

  // A window longer than the terms earns a discount for paying late — almost
  // always the two numbers entered the wrong way round.
  const backwards = await updateSupplier(SITE, actor, sup.id, {
    code: `SD${stamp}`, name: 'Discount Test Supplier', paymentTermsDays: 10,
    settlementDiscountDays: 30, settlementDiscountPct: 2,
  })
  ok('*** a discount window longer than the terms is refused ***', !backwards.ok,
      backwards.ok ? 'ACCEPTED' : backwards.error)

  // Put the real terms back for the remittance check below.
  await updateSupplier(SITE, actor, sup.id, {
    code: `SD${stamp}`, name: 'Discount Test Supplier', paymentTermsDays: 30,
    settlementDiscountDays: 10, settlementDiscountPct: 2,
  })

  console.log('\n── The remittance says so ──────────────────────────────────\n')

  const advice = await buildRemittance(SITE, 'Test Store', null, run.runId, sup.id)
  ok('a remittance is produced', advice !== null)

  const discountLine = advice?.lines.find((l) => l.docNumber === `SDINV${stamp}`)
  ok('*** the invoice reads as settled, not short-paid ***',
      (discountLine?.outstanding ?? -1) === 0, `outstanding ${discountLine?.outstanding}`)
  ok('  and the discount is named on the line',
      (discountLine?.description ?? '').toLowerCase().includes('settlement discount'),
      discountLine?.description ?? '')
  ok('  the advice carries the discount total', advice?.settlementDiscount === 20,
      String(advice?.settlementDiscount))
  ok('  invoices less discount equals the amount paid',
      round((advice?.closingBalance ?? 0) + (advice?.settlementDiscount ?? 0), 2) === 1000,
      `${advice?.closingBalance} + ${advice?.settlementDiscount}`)

  // It must still render — a PDF that throws is a remittance nobody receives.
  const pdf = await renderStatementPdf(advice!, 'remittance')
  ok('  and the PDF renders', pdf.length > 1000, `${pdf.length} bytes`)

  console.log('\n── Invariants ──────────────────────────────────────────────\n')

  const drift = await reconcileSupplierBalances(SITE)
  ok('*** every supplier balance agrees with its ledger ***', drift.length === 0,
      JSON.stringify(drift.slice(0, 3)))

  await finish(sup.id, run.runId, third.ok ? third.id : 0)
}

async function finish(supplierId: number, runId = 0, _extra = 0) {
  if (runId) await siteExecute(SITE, 'DELETE FROM supplier_payment_runs WHERE id = ?', [runId])
  if (supplierId) {
    await siteExecute(
      SITE,
      'DELETE FROM supplier_allocations WHERE debit_txn_id IN (SELECT id FROM supplier_transactions WHERE supplier_id = ?) OR credit_txn_id IN (SELECT id FROM supplier_transactions WHERE supplier_id = ?)',
      [supplierId, supplierId],
    )
    await siteExecute(SITE, 'DELETE FROM supplier_transactions WHERE supplier_id = ?', [supplierId])
    await siteExecute(SITE, 'DELETE FROM suppliers WHERE id = ?', [supplierId])
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
