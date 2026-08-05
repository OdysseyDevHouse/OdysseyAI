/**
 * Opening balances — carrying in what is already owed.
 *
 * The rule that matters: an opening balance is imported per INVOICE, dated as
 * it really was. That is what makes the first age analysis truthful and the
 * first payment allocatable. A single lump dated go-live day would age every
 * account as current and settle against nothing.
 *
 *   npm run test:opening-balances
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { createCustomer, getCustomer } from '../src/lib/site/customers'
import { createSupplier, getSupplier } from '../src/lib/site/suppliers'
import { listLedger, reconcileBalances, postTransaction, allocate } from '../src/lib/site/customerLedger'
import { reconcileSupplierBalances } from '../src/lib/site/supplierLedger'
import { customerAging } from '../src/lib/site/aging'
import {
  planOpeningBalances, applyOpeningBalances, parseOpeningCsv,
} from '../src/lib/site/openingBalances'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Opening Test' }
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

async function main() {
  const stamp = Date.now().toString().slice(-8)

  const cust = await createCustomer(SITE, actor, {
    code: `OPN${stamp}`, name: 'Opening Test Co', creditLimit: 100000, paymentTermsDays: 30,
  })
  const other = await createCustomer(SITE, actor, {
    code: `OPB${stamp}`, name: 'Opening Test Two', creditLimit: 100000, paymentTermsDays: 30,
  })
  const closed = await createCustomer(SITE, actor, {
    code: `OPC${stamp}`, name: 'Opening Closed Co', creditLimit: 0, status: 'closed', statusReason: 'Left the area',
  })
  const sup = await createSupplier(SITE, actor, {
    code: `OPS${stamp}`, name: 'Opening Test Supplies', paymentTermsDays: 30,
  })
  if (!cust.ok || !other.ok || !closed.ok || !sup.ok) { console.log('setup failed:', JSON.stringify({cust,other,closed,sup})); process.exit(1) }

  // ── The CSV parser
  const parsed = parseOpeningCsv(
    `Account Code,Invoice No,Date,Amount,Reference
OPN${stamp},INV-9001,${daysAgo(100)},"R1 150.00",Old system
OPN${stamp},INV-9002,${daysAgo(50)},2300,
OPN${stamp},INV-9003,${daysAgo(5)},575,`,
  )
  ok('*** CSV with a header parses ***', parsed.rows.length === 3, `${parsed.rows.length} rows`)
  ok('  currency symbols and spaces stripped', parsed.rows[0].amount === 1150, String(parsed.rows[0].amount))
  ok('  columns found by name, not position', parsed.rows[0].docNumber === 'INV-9001', parsed.rows[0].docNumber)
  ok('  reference carried', parsed.rows[0].reference === 'Old system')

  const headerless = parseOpeningCsv(`OPN${stamp},INV-8000,${daysAgo(10)},400`)
  ok('a file with no header still parses', headerless.rows.length === 1 && headerless.rows[0].amount === 400)

  const dmy = parseOpeningCsv(`code,invoice,date,amount\nOPN${stamp},INV-7000,05/08/2026,100`)
  ok('*** 05/08/2026 reads as 5 August (day first) ***', dmy.rows[0].docDate === '2026-08-05', dmy.rows[0].docDate)

  // ── Planning refuses what it should, and says why
  const badPlan = await planOpeningBalances(SITE, 'customer', [
    { code: 'NOSUCHCODE', docNumber: 'X1', docDate: daysAgo(10), amount: 100 },
    { code: `OPN${stamp}`, docNumber: '', docDate: daysAgo(10), amount: 100 },
    { code: `OPN${stamp}`, docNumber: 'X2', docDate: 'not-a-date', amount: 100 },
    { code: `OPN${stamp}`, docNumber: 'X3', docDate: daysAgo(-30), amount: 100 },
    { code: `OPN${stamp}`, docNumber: 'X4', docDate: daysAgo(10), amount: 0 },
    { code: `OPN${stamp}`, docNumber: 'X5', docDate: daysAgo(10), amount: -50 },
    { code: `OPN${stamp}`, docNumber: 'X6', docDate: daysAgo(10), amount: 100 },
    { code: `OPN${stamp}`, docNumber: 'X6', docDate: daysAgo(10), amount: 100 },
    { code: `OPC${stamp}`, docNumber: 'X7', docDate: daysAgo(10), amount: 100 },
  ])
  ok('*** every bad row is named, not dropped ***', badPlan.problems.length === 8, `${badPlan.problems.length} problems`)
  ok('  only the good one is ready', badPlan.ready.length === 1, String(badPlan.ready.length))
  ok('  unknown code explained', badPlan.problems[0].reason.includes('No customer with code'))
  ok('  a future date refused', badPlan.problems.some((p) => p.reason.includes('future')))
  ok('  a negative amount refused', badPlan.problems.some((p) => p.reason.includes('Negative')))
  ok('  a duplicate within the file refused', badPlan.problems.some((p) => p.reason.includes('twice')))
  ok('  a closed account refused', badPlan.problems.some((p) => p.reason.includes('closed')))
  ok('  nothing was written by planning', (await getCustomer(SITE, cust.id))?.balance === 0)

  // ── The real import
  const plan = await planOpeningBalances(SITE, 'customer', parsed.rows)
  ok('*** plan is clean ***', plan.problems.length === 0 && plan.ready.length === 3)
  ok('  totalling 4025', plan.total === 4025, String(plan.total))
  ok('  across one account', plan.accountCount === 1)
  ok('  nothing imported before', plan.alreadyImported.length === 0)

  const result = await applyOpeningBalances(SITE, actor, plan)
  ok('*** imported ***', result.posted === 3 && result.failed.length === 0, `${result.posted} posted`)
  ok('  balance is now 4025', (await getCustomer(SITE, cust.id))?.balance === 4025,
    String((await getCustomer(SITE, cust.id))?.balance))

  const ledger = await listLedger(SITE, cust.id)
  const opens = ledger.filter((l) => l.docType === 'opening')
  ok('*** three transactions, not one lump ***', opens.length === 3, String(opens.length))
  ok('  each keeps its old document number',
    opens.some((l) => l.docNumber === 'INV-9001') && opens.some((l) => l.docNumber === 'INV-9002'))
  ok('  each dated as it really was',
    opens.some((l) => l.docDate === daysAgo(100)), opens.map((l) => l.docDate).join(','))
  ok('*** VAT is zero — it was declared in the old system ***',
    opens.every((l) => toNum(l.amountVat) === 0), JSON.stringify(opens.map((l) => l.amountVat)))
  ok('  and each is fully outstanding', opens.every((l) => l.amountOutstanding === l.amountSigned))

  // ── THE POINT: ageing is truthful
  const aged = await customerAging(SITE)
  const mine = aged.rows.find((r) => r.id === cust.id)?.aging
  ok('*** the 100-day invoice ages as OVERDUE, not current ***',
    (mine?.current ?? 0) < 4025, `current ${mine?.current} of ${mine?.total}`)
  ok('  the 5-day one IS current', (mine?.current ?? 0) === 575, String(mine?.current))
  ok('  and the buckets total the balance', mine?.total === 4025, String(mine?.total))

  // ── And a payment can be allocated to a specific carried-in invoice
  const pay = await postTransaction(SITE, actor, {
    customerId: cust.id, docType: 'payment', amount: 1150, docDate: daysAgo(0),
    docNumber: `PAY${stamp}`,
  })
  ok('a payment posts against the carried-in book', pay.ok)
  if (pay.ok) {
    const target = opens.find((l) => l.docNumber === 'INV-9001')!
    const alloc = await allocate(SITE, actor, target.id, pay.id, 1150)
    ok('*** the oldest carried-in invoice can be settled BY NAME ***', alloc.ok, alloc.ok ? '' : alloc.error)

    const after = (await listLedger(SITE, cust.id)).find((l) => l.docNumber === 'INV-9001')
    ok('  and it reads settled', after?.amountOutstanding === 0, String(after?.amountOutstanding))
    ok('  while the others are untouched',
      (await listLedger(SITE, cust.id)).find((l) => l.docNumber === 'INV-9002')?.amountOutstanding === 2300)
  }

  // ── Re-import warns rather than silently doubling
  const rerun = await planOpeningBalances(SITE, 'customer', parsed.rows)
  ok('*** a second run WARNS that this account already has openings ***',
    rerun.alreadyImported.length === 1, JSON.stringify(rerun.alreadyImported))
  ok('  naming how many', rerun.alreadyImported[0]?.count === 3, String(rerun.alreadyImported[0]?.count))

  // ── Partial failure is reported per row, not rolled back wholesale
  const mixed = await planOpeningBalances(SITE, 'customer', [
    { code: `OPB${stamp}`, docNumber: 'GOOD-1', docDate: daysAgo(20), amount: 500 },
    { code: `OPB${stamp}`, docNumber: 'GOOD-2', docDate: daysAgo(10), amount: 250 },
  ])
  const mixedResult = await applyOpeningBalances(SITE, actor, mixed)
  ok('a second account imports independently', mixedResult.posted === 2)
  ok('  its balance is 750', (await getCustomer(SITE, other.id))?.balance === 750,
    String((await getCustomer(SITE, other.id))?.balance))
  ok('  and the first account is unaffected', (await getCustomer(SITE, cust.id))?.balance === 2875,
    String((await getCustomer(SITE, cust.id))?.balance))

  // ── Suppliers use the same machinery
  const supPlan = await planOpeningBalances(SITE, 'supplier', [
    { code: `OPS${stamp}`, docNumber: 'SUP-100', docDate: daysAgo(60), amount: 3400 },
    { code: `OPN${stamp}`, docNumber: 'WRONG', docDate: daysAgo(10), amount: 100 },
  ])
  ok('*** supplier side works the same ***', supPlan.ready.length === 1 && supPlan.problems.length === 1)
  ok('  and a customer code is not a supplier code', supPlan.problems[0].reason.includes('No supplier with code'))

  const supResult = await applyOpeningBalances(SITE, actor, supPlan)
  ok('  supplier opening posted', supResult.posted === 1)
  ok('  supplier owes 3400', (await getSupplier(SITE, sup.id))?.balance === 3400,
    String((await getSupplier(SITE, sup.id))?.balance))

  // ── Invariants
  ok('*** reconcileBalances zero drift ***', (await reconcileBalances(SITE)).length === 0)
  ok('*** reconcileSupplierBalances zero drift ***', (await reconcileSupplierBalances(SITE)).length === 0)

  // ── Cleanup
  for (const id of [cust.id, other.id, closed.id]) {
    await siteExecute(SITE, 'DELETE FROM customer_allocations WHERE debit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?) OR credit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)', [id, id])
    await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [id])
  }
  await siteExecute(SITE, 'DELETE FROM supplier_transactions WHERE supplier_id = ?', [sup.id])
  await siteExecute(SITE, 'DELETE FROM suppliers WHERE id = ?', [sup.id])

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}
main()
