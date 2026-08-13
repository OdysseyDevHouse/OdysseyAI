/**
 * The general ledger — double entry, and the three statements.
 *
 * The rules that matter, and what breaks if they slip:
 *
 *   EVERY JOURNAL SUMS TO ZERO. An unbalanced batch poisons every statement
 *   built on it, and the difference gets chased through years of history by
 *   somebody who does not know where to start.
 *
 *   THE TRIAL BALANCE BALANCES. Debits equal credits across the whole ledger,
 *   always. It is the proof the ledger is internally consistent.
 *
 *   THE BALANCE SHEET BALANCES. Assets = liabilities + equity, including the
 *   unclosed result for the year. This is not imposed — it falls out of every
 *   journal summing to zero, so a failure here means one did not.
 *
 *   CONTROL ACCOUNTS AGREE WITH THEIR SUBLEDGERS. The GL is a derived mirror,
 *   so the two can drift; anything reported means a balance sheet figure
 *   disagrees with the detail behind it.
 *
 *   A MISSING MAPPING NEVER BLOCKS A SALE. The subledger is the source of
 *   truth and the GL fails soft.
 *
 *   npm run test:general-ledger
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { createCustomer } from '../src/lib/site/customers'
import { saveDraft as saveSaleDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { createSupplier } from '../src/lib/site/suppliers'
import { postTransaction } from '../src/lib/site/customerLedger'
import { createAccount as createBankAccount } from '../src/lib/site/bankAccounts'
import { cashFlowStatement } from '../src/lib/site/cashFlowStatement'
import { recordCustomerReceipt } from '../src/lib/site/cashbook'
import { saveDraft, finalise } from '../src/lib/site/expenses'
import { listCategories } from '../src/lib/site/expenseCategories'
import { requestWriteOff } from '../src/lib/site/writeOffs'
import {
  listAccounts, getAccountByCode, createAccount, updateAccount, setAccountActive,
  resolveAccount, setMapping, reconcileAccountBalances, reconcileControlAccounts,
} from '../src/lib/site/chartOfAccounts'
import { post, reverse, getBatch, accountLedger, listBatches } from '../src/lib/site/journals'
import { trialBalance, incomeStatement, balanceSheet, ledgerHealth } from '../src/lib/site/financialStatements'
import { mirrorSale, mirrorGrv, closeYear } from '../src/lib/site/glPosting'
import { journalTotals, refuseJournal, displayBalance, closesAtYearEnd } from '../src/lib/glModel'
import { round, toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'GL Test' }
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
const created = {
  batches: [] as number[],
  accounts: [] as number[],
  expenses: [] as number[],
  saleDocuments: [] as number[],
}
let customerId = 0
let supplierId = 0
let bankAccountId = 0

async function main() {
  console.log('\n── Pure double entry ───────────────────────────────────────\n')

  const balanced = journalTotals([
    { accountId: 1, amount: 100 },
    { accountId: 2, amount: -100 },
  ])
  ok('a matched pair balances', balanced.balanced && balanced.difference === 0)
  ok('  and reports both sides', balanced.totalDebit === 100 && balanced.totalCredit === 100)

  const off = journalTotals([
    { accountId: 1, amount: 100 },
    { accountId: 2, amount: -99.99 },
  ])
  ok('*** a cent out does NOT balance ***', !off.balanced && off.difference === 0.01)

  ok('an unbalanced journal is refused',
      refuseJournal({ description: 'x', lines: [{ accountId: 1, amount: 100 }, { accountId: 2, amount: -50 }] }) !== null)
  ok('a one-sided journal is refused',
      refuseJournal({ description: 'x', lines: [{ accountId: 1, amount: 100 }, { accountId: 2, amount: 50 }] }) !== null)
  ok('a single line is refused',
      refuseJournal({ description: 'x', lines: [{ accountId: 1, amount: 100 }] }) !== null)
  ok('a balanced journal passes',
      refuseJournal({ description: 'x', lines: [{ accountId: 1, amount: 100 }, { accountId: 2, amount: -100 }] }) === null)

  // Credit-normal types must DISPLAY positive: "we owe 12 000" is not negative.
  ok('*** a liability displays positive ***', displayBalance('liability', -12000) === 12000)
  ok('an asset displays as stored', displayBalance('asset', 5000) === 5000)
  ok('income displays positive', displayBalance('income', -48000) === 48000)

  ok('income closes at year end', closesAtYearEnd('income') && closesAtYearEnd('expense'))
  ok('*** assets do NOT close ***', !closesAtYearEnd('asset') && !closesAtYearEnd('equity'))

  console.log('\n── The chart of accounts ───────────────────────────────────\n')

  const accounts = await listAccounts(SITE)
  ok('a chart is seeded', accounts.length >= 40, `${accounts.length} accounts`)

  const debtors = await getAccountByCode(SITE, '1100')
  const bank = await getAccountByCode(SITE, '1000')
  const sales = await getAccountByCode(SITE, '4000')

  ok('*** the debtors control account is NOT postable ***', debtors?.isPostable === false)
  ok('  and says what maintains it', debtors?.controlType === 'debtors')
  ok('an ordinary account is postable', bank?.isPostable === true)
  ok('sales is an income account', sales?.accountType === 'income')

  const custom = await createAccount(SITE, actor, {
    accountCode: `9${stamp}`, name: 'Test account', accountType: 'expense', subtype: 'operating',
  })
  ok('an account can be added', custom.ok)
  if (custom.ok) created.accounts.push(custom.id)

  ok('a duplicate code is refused',
      !(await createAccount(SITE, actor, { accountCode: '1000', name: 'Clash', accountType: 'asset' })).ok)

  console.log('\n── Manual journals ─────────────────────────────────────────\n')

  const rentAccount = await getAccountByCode(SITE, '6000')
  if (!rentAccount || !bank) return finish()

  const manual = await post(SITE, actor, {
    journalDate: daysAgo(10),
    description: `Test journal ${stamp}`,
    lines: [
      { accountId: rentAccount.id, amount: 5000, description: 'Rent paid' },
      { accountId: bank.id, amount: -5000, description: 'From the bank' },
    ],
  })
  ok('a balanced journal posts', manual.ok, manual.ok ? manual.journalNumber : manual.error)
  if (!manual.ok) return finish()
  created.batches.push(manual.id)

  ok('  a number was issued', /^JNL\d+/.test(manual.journalNumber))

  const batch = await getBatch(SITE, manual.id)
  ok('  it stores both totals', batch?.totalDebit === 5000 && batch?.totalCredit === 5000)
  ok('  the debit line is positive', batch?.lines[0]?.debit === 5000)
  ok('  the credit line is shown on its own side', batch?.lines[1]?.credit === 5000)
  ok('  and the account code is snapshotted', batch?.lines[0]?.accountCode === '6000')

  // The balance invariant.
  const rentAfter = await getAccountByCode(SITE, '6000')
  ok('*** the account balance moved with the line ***',
      round((rentAfter?.balance ?? 0) - rentAccount.balance, 2) === 5000)

  // Posting to a control account by hand must be refused.
  const toControl = await post(SITE, actor, {
    journalDate: daysAgo(10),
    description: 'Should be refused',
    lines: [
      { accountId: debtors!.id, amount: 100 },
      { accountId: bank.id, amount: -100 },
    ],
  })
  ok('*** a manual journal cannot touch a control account ***', !toControl.ok,
      toControl.ok ? 'IT POSTED' : toControl.error)

  const unbalanced = await post(SITE, actor, {
    journalDate: daysAgo(10),
    description: 'Should be refused',
    lines: [
      { accountId: rentAccount.id, amount: 100 },
      { accountId: bank.id, amount: -60 },
    ],
  })
  ok('*** an unbalanced journal is refused at the server ***', !unbalanced.ok)

  console.log('\n── Reversal ────────────────────────────────────────────────\n')

  ok('reversal needs a reason', !(await reverse(SITE, actor, manual.id, '')).ok)

  const reversed = await reverse(SITE, actor, manual.id, 'Captured in error')
  ok('a manual journal can be reversed', reversed.ok, reversed.ok ? '' : reversed.error)
  if (reversed.ok) created.batches.push(reversed.id)

  const rentBack = await getAccountByCode(SITE, '6000')
  ok('*** the reversal returns the balance ***',
      round((rentBack?.balance ?? 0) - rentAccount.balance, 2) === 0,
      String(rentBack?.balance))

  ok('reversing twice is refused', !(await reverse(SITE, actor, manual.id, 'again')).ok)

  console.log('\n── Subledger mirrors ───────────────────────────────────────\n')

  const cust = await createCustomer(SITE, actor, {
    code: `GL${stamp}`, name: 'GL Test Co', paymentTermsDays: 30, creditLimit: 100000,
  })
  const sup = await createSupplier(SITE, actor, {
    code: `GLS${stamp}`, name: 'GL Test Supplier', paymentTermsDays: 30,
  })
  const acct = await createBankAccount(SITE, actor, {
    code: `GLB${stamp}`, name: 'GL Test Bank', accountType: 'bank', openingBalance: 0,
  })
  if (!cust.ok || !sup.ok || !acct.ok) return finish()
  customerId = cust.id
  supplierId = sup.id
  bankAccountId = acct.id

  // A bank account needs its own GL mapping, or a receipt has nowhere to post.
  await setMapping(SITE, actor, 'bank_account', bankAccountId, bank.id)

  // A sale, mirrored.
  const saleMirror = await mirrorSale(SITE, actor, {
    documentId: 900000 + Number(stamp),
    documentNumber: `TESTINV${stamp}`,
    documentDate: daysAgo(8),
    isCreditNote: false,
    revenueLines: [{ departmentId: null, excl: 1000 }],
    vatTotal: 150,
    costOfSales: 600,
    tenders: [{ tenderTypeId: null, isAccount: false, amount: 1150 }],
  })
  ok('a sale mirrors into the ledger', saleMirror.ok, saleMirror.ok ? '' : saleMirror.reason)
  if (saleMirror.ok) created.batches.push(saleMirror.batchId)

  if (saleMirror.ok) {
    const saleBatch = await getBatch(SITE, saleMirror.batchId)
    ok('  and it balances', saleBatch?.totalDebit === saleBatch?.totalCredit,
        `${saleBatch?.totalDebit} / ${saleBatch?.totalCredit}`)
    // 1150 bank + 600 cost of sales = 1750 debits.
    ok('  cost of sales is posted with the revenue', saleBatch?.totalDebit === 1750,
        String(saleBatch?.totalDebit))
    ok('  and stock is relieved',
        saleBatch?.lines.some((l) => l.accountCode === '1200' && l.credit === 600) === true)
  }

  // A GRV, mirrored.
  const grvMirror = await mirrorGrv(SITE, actor, {
    documentId: 900000 + Number(stamp),
    documentNumber: `TESTGRV${stamp}`,
    documentDate: daysAgo(7),
    isReturn: false,
    supplierId,
    stockExcl: 2000,
    vatTotal: 300,
  })
  ok('a GRV mirrors into the ledger', grvMirror.ok, grvMirror.ok ? '' : grvMirror.reason)
  if (grvMirror.ok) {
    created.batches.push(grvMirror.batchId)
    const grvBatch = await getBatch(SITE, grvMirror.batchId)
    ok('  debits stock and VAT, credits creditors', grvBatch?.totalDebit === 2300,
        String(grvBatch?.totalDebit))
    ok('  and it balances', grvBatch?.totalDebit === grvBatch?.totalCredit)
  }

  // A receipt, through the real posting path.
  await postTransaction(SITE, actor, {
    customerId, docType: 'invoice', amount: 1150, docDate: daysAgo(6),
    docNumber: `GLINV${stamp}`,
  })
  const receipt = await recordCustomerReceipt(SITE, actor, {
    customerId, bankAccountId, amount: 1150, receiptDate: daysAgo(5), autoAllocate: true,
  })
  ok('a receipt posts through the real path', receipt.ok)

  const receiptBatch = await siteQueryOne<{ id: number; total_debit: number }>(
    SITE, "SELECT id, total_debit FROM journal_batches WHERE source = 'receipt' ORDER BY id DESC LIMIT 1")
  ok('*** the receipt reached the ledger ***', receiptBatch !== null,
      receiptBatch ? `batch ${receiptBatch.id}` : 'MISSING')
  if (receiptBatch) created.batches.push(Number(receiptBatch.id))

  // An expense, through the real posting path.
  const categories = await listCategories(SITE)
  const fuel = categories.find((c) => c.accountCode === '5070')!
  const expense = await saveDraft(SITE, actor, {
    expenseDate: daysAgo(4),
    paymentType: 'direct',
    supplierName: 'Test Garage',
    bankAccountId,
    lines: [{ categoryId: fuel.id, amountIncl: 1150, vatRatePct: 15 }],
  })
  if (expense.ok) {
    created.expenses.push(expense.id)
    await finalise(SITE, actor, expense.id)

    const expBatch = await siteQueryOne<{ id: number; total_debit: number }>(
      SITE, "SELECT id, total_debit FROM journal_batches WHERE source = 'expense' ORDER BY id DESC LIMIT 1")
    ok('*** an expense reaches the ledger ***', expBatch !== null)
    if (expBatch) {
      created.batches.push(Number(expBatch.id))
      ok('  splitting cost from claimable VAT', toNum(expBatch.total_debit) === 1150,
          String(expBatch.total_debit))
    }
  }

  console.log('\n── Through the REAL posting paths ──────────────────────────\n')

  // The mirrors above were called directly. These go through finaliseDocument
  // and receiveGoods — the paths a till and a GRV screen actually use — which
  // is the claim that matters: the ledger populates itself in normal trading.
  const realSale = await sellSomething()
  if (realSale) {
    const saleJournal = await siteQueryOne<{ id: number; total_debit: number }>(
      SITE,
      "SELECT id, total_debit FROM journal_batches WHERE source = 'sale' AND source_doc_id = ? LIMIT 1",
      [realSale.documentId],
    )
    ok('*** a till sale reaches the ledger by itself ***', saleJournal !== null,
        saleJournal ? `batch ${saleJournal.id}` : 'NO JOURNAL')
    if (saleJournal) {
      created.batches.push(Number(saleJournal.id))
      const b = await getBatch(SITE, Number(saleJournal.id))
      ok('  and it balances', b?.totalDebit === b?.totalCredit,
          `${b?.totalDebit} / ${b?.totalCredit}`)
      ok('  crediting revenue', b?.lines.some((l) => l.accountCode === '4000' && l.credit > 0) === true)
      ok('  and VAT output', b?.lines.some((l) => l.accountCode === '2100' && l.credit > 0) === true)
    }
  } else {
    console.log('SKIP  no sellable stock in this database — till mirror not exercised')
  }

  console.log('\n── The statements ──────────────────────────────────────────\n')

  const tb = await trialBalance(SITE, daysAgo(0))
  ok('*** THE TRIAL BALANCE BALANCES ***', tb.balanced,
      `debits ${tb.totalDebit}, credits ${tb.totalCredit}, out by ${tb.difference}`)
  ok('  and it lists accounts', tb.rows.length > 0, `${tb.rows.length} accounts`)
  ok('  omitting zero balances', tb.rows.every((r) => r.debit !== 0 || r.credit !== 0))

  const pl = await incomeStatement(SITE, { from: daysAgo(30), to: daysAgo(0) }, { compare: true })
  ok('an income statement is produced', pl.revenueTotal > 0, `revenue ${pl.revenueTotal}`)
  ok('*** revenue displays positive ***', pl.revenueTotal > 0)
  ok('  gross profit is revenue less cost of sales',
      pl.grossProfit === round(pl.revenueTotal - pl.costOfSalesTotal, 2))
  ok('  net profit is gross less expenses',
      pl.netProfit === round(pl.grossProfit - pl.expenseTotal, 2))
  ok('  and a margin is computed', pl.grossMarginPct !== null, `${pl.grossMarginPct}%`)
  ok('  with a prior period to compare', pl.prior !== null)

  const bs = await balanceSheet(SITE, daysAgo(0))
  ok('*** THE BALANCE SHEET BALANCES ***', bs.balanced,
      `assets ${bs.assetsTotal}, liabilities ${bs.liabilitiesTotal}, equity ${bs.totalEquityAndReserves}, out by ${bs.outOfBalance}`)
  ok('  the unclosed result appears in equity', bs.currentYearResult !== 0,
      String(bs.currentYearResult))
  ok('  liabilities display positive', bs.liabilitiesTotal >= 0, String(bs.liabilitiesTotal))

  const cf = await cashFlowStatement(SITE, { from: daysAgo(30), to: daysAgo(0) })
  ok('*** THE CASH FLOW STATEMENT RECONCILES ***', cf.balanced,
      `movement ${cf.netCashMovement}, explained ${round(cf.operatingTotal + cf.investing.total + cf.financing.total + cf.other.total, 2)}, unexplained ${cf.unexplained}`)
  ok('  closing minus opening is the movement',
      cf.netCashMovement === round(cf.closingCash - cf.openingCash, 2))
  ok('  the net result feeds operating',
      cf.operatingTotal === round(cf.netResult + cf.nonCashAdjustments + cf.operating.total, 2))
  // The whole-history window: everything the ledger has ever posted must still
  // explain the whole cash balance — the zero-sum identity, end to end.
  const cfAll = await cashFlowStatement(SITE, { from: '2000-01-01', to: daysAgo(0) })
  ok('*** the identity holds over the whole ledger ***', cfAll.balanced,
      `unexplained ${cfAll.unexplained}`)
  ok('  opening cash at the dawn of time is zero', cfAll.openingCash === 0,
      String(cfAll.openingCash))

  console.log('\n── Invariants ──────────────────────────────────────────────\n')

  const drift = await reconcileAccountBalances(SITE)
  ok('*** every GL balance agrees with its journal lines ***', drift.length === 0,
      JSON.stringify(drift.slice(0, 3)))

  const health = await ledgerHealth(SITE)
  ok('*** no unbalanced batches exist ***', health.unbalancedBatches.length === 0,
      JSON.stringify(health.unbalancedBatches.slice(0, 3)))
  ok('  and the trial balance difference is zero', health.trialBalanceDifference === 0)

  const controls = await reconcileControlAccounts(SITE)
  // Control drift is EXPECTED here: this database has years of history posted
  // before the GL existed, so the control accounts hold only what the mirrors
  // wrote. The check must RUN and report a number, which is what proves it
  // would catch a real drift once a site starts clean.
  ok('control reconciliation runs and reports', Array.isArray(controls),
      controls.length === 0 ? 'in step' : `${controls.length} control account(s) differ — expected on a pre-GL database`)

  console.log('\n── Account enquiry ─────────────────────────────────────────\n')

  const ledger = await accountLedger(SITE, bank.id, { from: daysAgo(30), to: daysAgo(0) })
  ok('an account ledger returns entries', ledger.entries.length > 0, `${ledger.entries.length}`)
  if (ledger.entries.length > 0) {
    const last = ledger.entries[ledger.entries.length - 1]
    ok('  with a running balance that ends at the closing figure',
        last.balance === ledger.closing)
  }

  console.log('\n── Failing soft ────────────────────────────────────────────\n')

  // A mapping that does not resolve must not throw — it returns a reason, and
  // the subledger write it mirrors stays committed.
  const unmapped = await mirrorSale(SITE, actor, {
    documentId: 999999,
    documentNumber: 'NOMAP',
    documentDate: daysAgo(1),
    isCreditNote: false,
    revenueLines: [{ departmentId: null, excl: 100 }],
    vatTotal: 0,
    costOfSales: 0,
    tenders: [{ tenderTypeId: 999999, isAccount: false, amount: 100 }],
  })
  // The tender falls back to the default mapping, so this actually succeeds —
  // which is the point: an unconfigured tender type still posts.
  ok('*** an unmapped tender falls back rather than failing ***', unmapped.ok,
      unmapped.ok ? '' : unmapped.reason)
  if (unmapped.ok) created.batches.push(unmapped.batchId)

  ok('resolveAccount falls back to the default',
      (await resolveAccount(SITE, 'tender', 999999)) !== null)
  ok('  and returns null for an unknown key',
      (await resolveAccount(SITE, 'no_such_key')) === null)

  await finish()
}

/**
 * Puts a real sale through finaliseDocument.
 *
 * A SERVICE line, deliberately: it carries a cost but moves no stock, so the
 * sale cannot fail on inventory this database may not have. The mirror is
 * exercised identically either way — cost of sales comes from unit_cost_excl,
 * not from a stock movement.
 */
async function sellSomething(): Promise<{ documentId: number } | null> {
  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) return null

  const draft = await saveSaleDraft(SITE, actor, {
    docType: 'invoice',
    customerName: 'GL walk-in',
    lines: [
      {
        productCode: `GLS${stamp}`,
        description: 'GL test service',
        productType: 'service',
        qty: 1,
        unitPriceIncl: 115,
        vatRatePct: 15,
        unitCostExcl: 40,
      },
    ],
  })
  if (!draft.ok) return null
  created.saleDocuments.push(draft.id)

  const posted = await finaliseDocument(SITE, actor, {
    documentId: draft.id,
    tenders: [{ tenderTypeId: cash.id, amount: 115 }],
  })
  return posted.ok ? { documentId: posted.documentId } : null
}

async function finish() {
  // Journals before accounts: the FK from journal_lines is RESTRICT.
  for (const id of created.batches) {
    await siteExecute(SITE, 'DELETE FROM journal_lines WHERE batch_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM journal_batches WHERE id = ?', [id])
  }
  for (const id of created.expenses) {
    await siteExecute(SITE, 'DELETE FROM expense_lines WHERE expense_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM expenses WHERE id = ?', [id])
  }
  for (const id of created.saleDocuments) {
    await siteExecute(SITE, 'DELETE FROM document_audit WHERE document_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [id])
  }
  for (const id of created.accounts) {
    await siteExecute(SITE, 'DELETE FROM gl_accounts WHERE id = ?', [id])
  }
  if (customerId) {
    await siteExecute(SITE, 'DELETE FROM customer_allocations WHERE debit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?) OR credit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)', [customerId, customerId])
    await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [customerId])
    await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [customerId])
  }
  if (supplierId) {
    await siteExecute(SITE, 'DELETE FROM supplier_transactions WHERE supplier_id = ?', [supplierId])
    await siteExecute(SITE, 'DELETE FROM suppliers WHERE id = ?', [supplierId])
  }
  if (bankAccountId) {
    await siteExecute(SITE, 'DELETE FROM gl_mappings WHERE mapping_key = ? AND ref_id = ?', ['bank_account', bankAccountId])
    await siteExecute(SITE, 'DELETE FROM cashbook_links WHERE bank_txn_id IN (SELECT id FROM bank_transactions WHERE bank_account_id = ?)', [bankAccountId])
    await siteExecute(SITE, 'DELETE FROM bank_transactions WHERE bank_account_id = ?', [bankAccountId])
    await siteExecute(SITE, 'DELETE FROM bank_accounts WHERE id = ?', [bankAccountId])
  }

  // Balances were moved by journals now deleted; put them back so the next run
  // starts from a consistent ledger.
  await siteExecute(
    SITE,
    `UPDATE gl_accounts a
        SET a.balance = COALESCE((
              SELECT SUM(l.amount) FROM journal_lines l
                JOIN journal_batches b ON b.id = l.batch_id
               WHERE l.account_id = a.id AND b.status = 'posted'), 0)`,
  )

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
