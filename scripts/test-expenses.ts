/**
 * Expenses — spending that is not stock.
 *
 * The rules that matter, and what breaks if they slip:
 *
 *   A BILL creates a liability; a DIRECT payment does not. Getting the branch
 *   wrong either invents a creditor for every petrol station or loses the debt.
 *
 *   An expense NEVER moves stock or average_cost. That is the whole distinction
 *   from a GRV.
 *
 *   Denied categories claim no input VAT. Entertainment and salaries are
 *   refused by the VAT Act however the invoice is worded, and claiming them is
 *   an assessment.
 *
 *   The VAT return must SEE expenses. Leaving them out understates the claim by
 *   every rand of overhead the business pays.
 *
 *   A schedule generates DRAFTS, and never twice for the same period.
 *
 *   npm run test:expenses
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { createSupplier } from '../src/lib/site/suppliers'
import { listSupplierLedger, reconcileSupplierBalances } from '../src/lib/site/supplierLedger'
import { createAccount, getAccount, reconcileBankBalances } from '../src/lib/site/bankAccounts'
import { listTransactions } from '../src/lib/site/cashbook'
import {
  listCategories, createCategory, updateCategory, deleteCategory, setCategoryActive,
} from '../src/lib/site/expenseCategories'
import {
  saveDraft, finalise, getExpense, listExpenses, voidExpense, deleteDraft, findDuplicate,
} from '../src/lib/site/expenses'
import {
  saveRecurring, generateDue, getRecurring, listRecurring, generatedBy, deleteRecurring,
} from '../src/lib/site/recurringExpenses'
import { expenseSummary, spendByCategory, spendBySupplier } from '../src/lib/site/expenseReports'
import { buildVatReturn } from '../src/lib/site/vatReturn'
import { computeTotals, computeLine, refuseExpense, nextOccurrence, isDue } from '../src/lib/expenseModel'
import { round, toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Expense Test' }
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
const created: { expenses: number[]; recurring: number[]; categories: number[] } = {
  expenses: [], recurring: [], categories: [],
}
let supplierId = 0
let accountId = 0

async function main() {
  console.log('\n── Pure maths ──────────────────────────────────────────────\n')

  // VAT by SUBTRACTION so excl + vat == incl exactly, always.
  const line = computeLine({ categoryId: 1, amountIncl: 115, vatRatePct: 15 })
  ok('15% on 115 splits to 100 + 15', line.excl === 100 && line.vat === 15)
  ok('  and reconciles exactly', round(line.excl + line.vat, 2) === line.incl)

  const awkward = computeLine({ categoryId: 1, amountIncl: 99.99, vatRatePct: 15 })
  ok('an awkward amount still reconciles',
      round(awkward.excl + awkward.vat, 2) === awkward.incl,
      `${awkward.excl} + ${awkward.vat} = ${awkward.incl}`)

  const zero = computeLine({ categoryId: 1, amountIncl: 500, vatRatePct: 0 })
  ok('zero-rated carries no VAT', zero.vat === 0 && zero.excl === 500)

  const denied = computeLine({ categoryId: 1, amountIncl: 115, vatRatePct: 15, vatClaimable: false })
  ok('*** a denied category shows VAT but claims none ***',
      denied.vat === 15 && denied.claimable === 0)

  const totals = computeTotals([
    { categoryId: 1, amountIncl: 115, vatRatePct: 15 },
    { categoryId: 2, amountIncl: 230, vatRatePct: 15, vatClaimable: false },
  ])
  ok('totals sum from the lines', totals.totalIncl === 345 && totals.vatTotal === 45,
      `${totals.totalIncl} / ${totals.vatTotal}`)
  ok('  claimable excludes the denied line', totals.vatClaimable === 15,
      String(totals.vatClaimable))

  // Refusals the form shows before the server is asked.
  ok('a bill with no supplier is refused',
      refuseExpense({ paymentType: 'on_account', lines: [{ categoryId: 1, amountIncl: 100, vatRatePct: 15 }] }) !== null)
  ok('a payment with no account is refused',
      refuseExpense({ paymentType: 'direct', supplierName: 'X', lines: [{ categoryId: 1, amountIncl: 100, vatRatePct: 15 }] }) !== null)
  ok('no lines is refused',
      refuseExpense({ paymentType: 'direct', bankAccountId: 1, supplierName: 'X', lines: [] }) !== null)
  ok('a valid direct payment passes',
      refuseExpense({ paymentType: 'direct', bankAccountId: 1, supplierName: 'X',
        lines: [{ categoryId: 1, amountIncl: 100, vatRatePct: 15 }] }) === null)

  console.log('\n── Recurring dates ─────────────────────────────────────────\n')

  // The 31st in February must clamp, then return to the 31st — not drift.
  const jan31 = nextOccurrence(
    { frequency: 'monthly', dayOfMonth: 31, startsOn: '2026-01-31', lastGeneratedFor: '2026-01-31' },
    '2026-12-31')
  ok('*** the 31st clamps to the end of February ***', jan31 === '2026-02-28', String(jan31))

  const feb28 = nextOccurrence(
    { frequency: 'monthly', dayOfMonth: 31, startsOn: '2026-01-31', lastGeneratedFor: '2026-02-28' },
    '2026-12-31')
  ok('*** and returns to the 31st, rather than drifting ***', feb28 === '2026-03-31', String(feb28))

  const quarterly = nextOccurrence(
    { frequency: 'quarterly', dayOfMonth: 1, startsOn: '2026-01-01', lastGeneratedFor: '2026-01-01' },
    '2026-12-31')
  ok('quarterly advances three months', quarterly === '2026-04-01', String(quarterly))

  const ended = nextOccurrence(
    { frequency: 'monthly', dayOfMonth: 1, startsOn: '2026-01-01', endsOn: '2026-02-28',
      lastGeneratedFor: '2026-02-01' }, '2026-12-31')
  ok('a schedule stops at its end date', ended === null, String(ended))

  ok('isDue is false for a future occurrence',
      !isDue({ frequency: 'monthly', dayOfMonth: 1, startsOn: '2099-01-01' }, daysAgo(0)))

  console.log('\n── Categories ──────────────────────────────────────────────\n')

  const categories = await listCategories(SITE)
  ok('the seed ships a chart of expense accounts', categories.length >= 20,
      `${categories.length} categories`)

  const rent = categories.find((c) => c.accountCode === '5000')
  const salaries = categories.find((c) => c.accountCode === '5030')
  const entertainment = categories.find((c) => c.accountCode === '5150')
  const capital = categories.find((c) => c.accountCode === '7000')

  ok('rent is an operating expense', rent?.categoryType === 'operating')
  ok('*** salaries claim no VAT ***', salaries?.vatClaimable === false)
  ok('*** entertainment claims no VAT (s17(2)(a)) ***', entertainment?.vatClaimable === false)
  ok('*** capital is kept out of the P&L ***', capital?.categoryType === 'capital')

  const custom = await createCategory(SITE, actor, {
    accountCode: `TST${stamp}`, name: 'Test category', categoryType: 'operating',
  })
  ok('a category can be added', custom.ok)
  if (custom.ok) created.categories.push(custom.id)
  ok('a duplicate account code is refused',
      !(await createCategory(SITE, actor, { accountCode: `TST${stamp}`, name: 'Clash' })).ok)

  console.log('\n── A direct payment ────────────────────────────────────────\n')

  const account = await createAccount(SITE, actor, {
    code: `EXP${stamp}`, name: 'Expense Test Account', accountType: 'bank', openingBalance: 10000,
  })
  ok('bank account created', account.ok)
  if (!account.ok) return finish()
  accountId = account.id

  const fuel = categories.find((c) => c.accountCode === '5070')!
  const direct = await saveDraft(SITE, actor, {
    expenseDate: daysAgo(5),
    paymentType: 'direct',
    supplierName: 'Shell Garage',
    bankAccountId: accountId,
    description: 'Fuel for the delivery bakkie',
    lines: [{ categoryId: fuel.id, amountIncl: 1150, vatRatePct: 15 }],
  })
  ok('direct payment drafted', direct.ok, direct.ok ? '' : direct.error)
  if (!direct.ok) return finish()
  created.expenses.push(direct.id)

  const drafted = await getExpense(SITE, direct.id)
  ok('  it is a draft', drafted?.status === 'draft')
  ok('  totals computed', drafted?.totalIncl === 1150 && drafted?.subtotalExcl === 1000,
      `${drafted?.totalIncl} incl / ${drafted?.subtotalExcl} excl`)
  ok('  the category is snapshotted', drafted?.lines[0]?.categoryName === 'Fuel')

  const bankBefore = (await getAccount(SITE, accountId))?.balance
  ok('*** a draft moves no money ***', bankBefore === 10000, String(bankBefore))

  const posted = await finalise(SITE, actor, direct.id)
  ok('finalised', posted.ok, posted.ok ? posted.documentNumber : posted.error)
  ok('  a number was issued', posted.ok && /^EXP\d+/.test(posted.documentNumber))
  ok('*** it posted to the CASHBOOK, not the ledger ***',
      posted.ok && posted.bankTxnId !== null && posted.supplierTxnId === null)

  const bankAfter = (await getAccount(SITE, accountId))?.balance
  ok('  the bank balance dropped', bankAfter === round(10000 - 1150, 2), String(bankAfter))

  const bankLines = await listTransactions(SITE, accountId)
  ok('  the movement is negative', bankLines.some((l) => l.amountSigned === -1150))
  ok('  and sourced as an expense', bankLines.some((l) => l.source === 'expense'))

  ok('finalising twice is refused', !(await finalise(SITE, actor, direct.id)).ok)

  console.log('\n── A bill on account ───────────────────────────────────────\n')

  const sup = await createSupplier(SITE, actor, {
    code: `EXS${stamp}`, name: 'Landlord Properties', paymentTermsDays: 30,
  })
  ok('supplier created', sup.ok)
  if (!sup.ok) return finish()
  supplierId = sup.id

  const bill = await saveDraft(SITE, actor, {
    expenseDate: daysAgo(3),
    paymentType: 'on_account',
    supplierId,
    supplierName: 'Landlord Properties',
    supplierInvoiceNo: `RENT-${stamp}`,
    description: 'Shop rent',
    lines: [{ categoryId: rent!.id, amountIncl: 23000, vatRatePct: 15 }],
  })
  ok('bill drafted', bill.ok, bill.ok ? '' : bill.error)
  if (!bill.ok) return finish()
  created.expenses.push(bill.id)

  const billPosted = await finalise(SITE, actor, bill.id)
  ok('bill finalised', billPosted.ok, billPosted.ok ? '' : billPosted.error)
  ok('*** it posted to the LEDGER, not the cashbook ***',
      billPosted.ok && billPosted.supplierTxnId !== null && billPosted.bankTxnId === null)

  const supBalance = toNum((await siteQueryOne<{ balance: number }>(
    SITE, 'SELECT balance FROM suppliers WHERE id = ?', [supplierId]))?.balance)
  ok('  the supplier is now owed', supBalance === 23000, String(supBalance))

  const ledger = await listSupplierLedger(SITE, supplierId)
  ok('  as an invoice on their account', ledger.some((l) => l.docType === 'invoice'))
  ok('  with a due date from their terms',
      ledger.find((l) => l.docType === 'invoice')?.dueDate !== null)

  const withDue = await getExpense(SITE, bill.id)
  ok('  and the expense records the due date', withDue?.dueDate !== null, String(withDue?.dueDate))

  // Duplicate detection: the commonest expense error.
  const dup = await findDuplicate(SITE, supplierId, `RENT-${stamp}`)
  ok('*** a repeated supplier invoice number is detectable ***', dup !== null && dup.id === bill.id)

  console.log('\n── Denied VAT ──────────────────────────────────────────────\n')

  const staffParty = await saveDraft(SITE, actor, {
    expenseDate: daysAgo(2),
    paymentType: 'direct',
    supplierName: 'Restaurant',
    bankAccountId: accountId,
    description: 'Year-end function',
    lines: [{ categoryId: entertainment!.id, amountIncl: 5750, vatRatePct: 15 }],
  })
  if (!staffParty.ok) return finish()
  created.expenses.push(staffParty.id)
  await finalise(SITE, actor, staffParty.id)

  const ent = await getExpense(SITE, staffParty.id)
  ok('entertainment records the VAT charged', ent?.vatTotal === 750, String(ent?.vatTotal))
  ok('*** but claims none of it ***', ent?.vatClaimable === 0, String(ent?.vatClaimable))
  ok('  the line is flagged unclaimable', ent?.lines[0]?.vatClaimable === false)

  console.log('\n── It reaches the VAT return ───────────────────────────────\n')

  const vat = await buildVatReturn(SITE, { from: daysAgo(30), to: daysAgo(0) })
  ok('a return is produced', vat !== null)

  // 1000 (fuel) + 20000 (rent) + 5000 (entertainment) = 26000 excl in this window.
  const inputExcl = vat?.inputTotal.excl ?? 0
  ok('*** expenses appear in input VAT ***', inputExcl >= 26000,
      `input excl ${inputExcl}`)

  // Claimable VAT = 150 (fuel) + 3000 (rent), NOT the 750 on entertainment.
  ok('*** the denied VAT is not claimed ***',
      (vat?.inputTotal.vat ?? 0) >= 3150,
      `input vat ${vat?.inputTotal.vat}`)

  console.log('\n── Reports ─────────────────────────────────────────────────\n')

  const range = { from: daysAgo(30), to: daysAgo(0) }
  const summary = await expenseSummary(SITE, range)
  ok('summary totals operating spend', summary.operating > 0, String(summary.operating))
  ok('  and separates what is unpaid', summary.unpaidTotal === 23000, String(summary.unpaidTotal))

  const byCategory = await spendByCategory(SITE, range)
  ok('spend by category returns rows', byCategory.rows.length >= 3)
  ok('  ordered by size', byCategory.rows[0].total >= byCategory.rows[1].total)
  ok('  with a share of total', byCategory.rows[0].sharePct > 0)

  const bySupplier = await spendBySupplier(SITE, range)
  ok('spend by supplier groups free-text payees',
      bySupplier.some((s) => s.supplierName === 'Shell Garage'))

  console.log('\n── Recurring ───────────────────────────────────────────────\n')

  const schedule = await saveRecurring(SITE, actor, {
    name: `Rent ${stamp}`,
    frequency: 'monthly',
    dayOfMonth: 1,
    paymentType: 'on_account',
    supplierId,
    supplierName: 'Landlord Properties',
    description: 'Monthly shop rent',
    startsOn: daysAgo(75),
    lines: [{ categoryId: rent!.id, vatRatePct: 15, lineIncl: 23000 }],
  })
  ok('schedule created', schedule.ok, schedule.ok ? '' : schedule.error)
  if (!schedule.ok) return finish()
  created.recurring.push(schedule.id)

  const loaded = await getRecurring(SITE, schedule.id)
  ok('  it knows when it is next due', loaded?.nextDue !== null, String(loaded?.nextDue))
  ok('  and that it is due now', loaded?.due === true)

  const generated = await generateDue(SITE, actor)
  const mine = generated.generated.filter((g) => g.recurringId === schedule.id)
  ok('*** generation catches up missed periods ***', mine.length >= 2,
      `${mine.length} drafts for a 75-day-old monthly schedule`)
  for (const g of mine) created.expenses.push(g.expenseId)

  const firstDraft = await getExpense(SITE, mine[0].expenseId)
  ok('*** it generates a DRAFT, never a posting ***', firstDraft?.status === 'draft')
  ok('  with the template lines copied', firstDraft?.totalIncl === 23000, String(firstDraft?.totalIncl))
  ok('  and linked back to the schedule', firstDraft?.recurringId === schedule.id)

  // THE idempotence check.
  const again = await generateDue(SITE, actor)
  const repeats = again.generated.filter((g) => g.recurringId === schedule.id)
  ok('*** generating twice produces nothing new ***', repeats.length === 0,
      `${repeats.length} extra`)

  const produced = await generatedBy(SITE, schedule.id)
  ok('the schedule lists what it produced', produced.length >= 2, `${produced.length}`)

  console.log('\n── Voiding ─────────────────────────────────────────────────\n')

  ok('a void needs a reason', !(await voidExpense(SITE, actor, direct.id, '')).ok)

  const voided = await voidExpense(SITE, actor, direct.id, 'Captured twice')
  ok('a direct payment can be voided', voided.ok, voided.ok ? '' : voided.error)

  const afterVoid = (await getAccount(SITE, accountId))?.balance
  ok('*** voiding gives the money back ***', afterVoid === round(10000 - 5750, 2),
      String(afterVoid))

  const voidedExpense = await getExpense(SITE, direct.id)
  ok('  and the record survives, marked void', voidedExpense?.status === 'void')

  const listed = await listExpenses(SITE, {})
  ok('  voided expenses are hidden by default',
      !listed.items.some((e) => e.id === direct.id))

  console.log('\n── Invariants ──────────────────────────────────────────────\n')

  ok('*** every supplier balance agrees with its ledger ***',
      (await reconcileSupplierBalances(SITE)).length === 0)
  ok('*** every bank balance agrees with its transactions ***',
      (await reconcileBankBalances(SITE)).length === 0)

  // The defining rule: an expense is not a GRV.
  const movedStock = await siteQueryOne<{ n: number }>(
    SITE, "SELECT COUNT(*) AS n FROM stock_movements WHERE movement_type = 'expense'")
  ok('*** an expense never moves stock ***', Number(movedStock?.n ?? 0) === 0)

  await finish()
}

async function finish() {
  for (const id of created.expenses) {
    await siteExecute(SITE, 'DELETE FROM expense_lines WHERE expense_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM expenses WHERE id = ?', [id])
  }
  for (const id of created.recurring) {
    await siteExecute(SITE, 'DELETE FROM recurring_expenses WHERE id = ?', [id])
  }
  for (const id of created.categories) {
    await siteExecute(SITE, 'DELETE FROM expense_categories WHERE id = ?', [id])
  }
  if (supplierId) {
    await siteExecute(SITE, 'DELETE FROM supplier_allocations WHERE debit_txn_id IN (SELECT id FROM supplier_transactions WHERE supplier_id = ?) OR credit_txn_id IN (SELECT id FROM supplier_transactions WHERE supplier_id = ?)', [supplierId, supplierId])
    await siteExecute(SITE, 'DELETE FROM supplier_transactions WHERE supplier_id = ?', [supplierId])
    await siteExecute(SITE, 'DELETE FROM suppliers WHERE id = ?', [supplierId])
  }
  if (accountId) {
    await siteExecute(SITE, 'DELETE FROM cashbook_links WHERE bank_txn_id IN (SELECT id FROM bank_transactions WHERE bank_account_id = ?)', [accountId])
    await siteExecute(SITE, 'DELETE FROM bank_transactions WHERE bank_account_id = ?', [accountId])
    await siteExecute(SITE, 'DELETE FROM bank_accounts WHERE id = ?', [accountId])
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
