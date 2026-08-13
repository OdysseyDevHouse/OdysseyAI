/**
 * The cashbook — bank accounts, statement import, matching and reconciliation.
 *
 * The rules that matter, and what breaks if they slip:
 *
 *   The balance invariant. opening + SUM(non-void movements) = balance, always.
 *   A capture that moves one without the other makes every cash figure a lie.
 *
 *   Matching never guesses between equals. Two customers paying R1 200 on the
 *   same day must BOTH be left for a person — auto-linking either is a coin
 *   toss that writes to the ledger.
 *
 *   Import is idempotent. Overlapping statements are normal; the second import
 *   of a line must do nothing rather than double the balance.
 *
 *   npm run test:cashbook
 */
import { siteExecute, siteQueryOne, siteQuery } from '../src/lib/siteDb'
import { createCustomer } from '../src/lib/site/customers'
import { postTransaction } from '../src/lib/site/customerLedger'
import {
  createAccount, getAccount, listAccounts, closeAccount,
  reconcileBankBalances, defaultAccount, totalCash,
} from '../src/lib/site/bankAccounts'
import {
  captureTransaction, categoriseTransaction, recordTransfer, voidTransfer,
  listTransactions, voidTransaction, linkTransaction,
  unlinkTransaction, linksFor, suggestMatches, autoMatch, recordCustomerReceipt,
  previewReconciliation, completeReconciliation, reopenReconciliation, getTransaction,
} from '../src/lib/site/cashbook'
import { batchForSource } from '../src/lib/site/journals'
import { setMapping, getAccountByCode } from '../src/lib/site/chartOfAccounts'
import {
  parseBankCsv, parseBankOfx, parseStatement, parseAmount, parseDate,
  detectDateFormat, splitCsvLine, importStatement, undoImport, importKeyFor,
} from '../src/lib/site/bankImport'
import {
  scoreMatch, rankMatches, isConfidentMatch, reconcile, referencesMatch,
  signsOppose, refuseLink,
} from '../src/lib/site/cashbookRules'
import { round, toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Cashbook Test' }
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

async function main() {
  console.log('\n── Pure rules: parsing ─────────────────────────────────────\n')

  // Amounts, as banks actually write them.
  ok('plain amount', parseAmount('1234.56') === 1234.56)
  ok('thousands separator', parseAmount('1,234.56') === 1234.56)
  ok('leading minus', parseAmount('-1234.56') === -1234.56)
  ok('trailing minus (legacy exports)', parseAmount('1234.56-') === -1234.56)
  ok('parenthesised negative', parseAmount('(1234.56)') === -1234.56)
  ok('currency symbol', parseAmount('R 1 234.56') === 1234.56)
  ok('comma decimal, no dot', parseAmount('1234,56') === 1234.56)
  ok('comma thousands with dot decimal', parseAmount('1.234.567,89') === 1234567.89)
  ok('rejects text', parseAmount('N/A') === null)
  ok('rejects empty', parseAmount('') === null)

  // Dates. The ambiguity between dd/mm and mm/dd is the dangerous one.
  ok('iso date', parseDate('2026-03-15', 'yyyy-mm-dd') === '2026-03-15')
  ok('day-first', parseDate('15/03/2026', 'dd/mm/yyyy') === '2026-03-15')
  ok('month-first when told', parseDate('03/15/2026', 'mm/dd/yyyy') === '2026-03-15')
  ok('named month', parseDate('15 Mar 2026', 'dd/mm/yyyy') === '2026-03-15')
  ok('two-digit year', parseDate('15/03/26', 'dd/mm/yyyy') === '2026-03-15')
  ok('rejects impossible month', parseDate('15/13/2026', 'dd/mm/yyyy') === null)

  ok('detects day-first from a day > 12', detectDateFormat(['05/03/2026', '25/03/2026']) === 'dd/mm/yyyy')
  ok('detects month-first from proof', detectDateFormat(['03/25/2026', '03/05/2026']) === 'mm/dd/yyyy')
  ok('defaults day-first when ambiguous', detectDateFormat(['03/05/2026']) === 'dd/mm/yyyy')
  ok('detects iso', detectDateFormat(['2026-03-15']) === 'yyyy-mm-dd')

  // Quoted commas inside descriptions shift every later column if mishandled.
  const cells = splitCsvLine('2026-03-15,"PAYMENT TO SMITH, T",-450.00')
  ok('quoted comma keeps columns aligned', cells.length === 3 && cells[2] === '-450.00', cells.join(' | '))
  ok('doubled quote is one literal', splitCsvLine('a,"say ""hi""",b')[1] === 'say "hi"')

  console.log('\n── Pure rules: matching ────────────────────────────────────\n')

  ok('opposite signs required', signsOppose(500, -500) && !signsOppose(500, 500))
  ok('references match through bank noise', referencesMatch('ABSA EFT INV000041 CRD', 'INV000041'))
  ok('short references are refused', !referencesMatch('A1', 'A1'))

  const bankLine = { id: 1, date: '2026-03-15', amount: 1200, reference: 'INV000041', description: 'EFT INV000041' }
  const exact = { id: 10, date: '2026-03-15', amount: -1200, reference: 'INV000041', description: null, partyName: 'Harbour Cafe' }
  const wrongAmount = { id: 11, date: '2026-03-15', amount: -1199, reference: 'INV000041', description: null }
  const sameSide = { id: 12, date: '2026-03-15', amount: 1200, reference: 'INV000041', description: null }

  ok('exact match scores high', (scoreMatch(bankLine, exact)?.confidence ?? 0) >= 85)
  ok('a cent out is not a match at all', scoreMatch(bankLine, wrongAmount) === null)
  ok('same-sided row is not a match', scoreMatch(bankLine, sameSide) === null)

  // THE ambiguity guard: two identical candidates must never auto-link.
  const twin1 = { id: 20, date: '2026-03-15', amount: -1200, reference: null, description: null, partyName: 'Alpha Traders' }
  const twin2 = { id: 21, date: '2026-03-15', amount: -1200, reference: null, description: null, partyName: 'Beta Supplies' }
  const ambiguous = rankMatches({ ...bankLine, reference: null, description: null }, [twin1, twin2])
  ok('two identical candidates both score', ambiguous.length === 2)
  ok('*** a tie is never auto-matched ***', !isConfidentMatch(ambiguous),
      ambiguous.map((a) => a.confidence).join(' vs '))

  const clear = rankMatches(bankLine, [exact, twin2])
  ok('a clear winner is auto-matched', isConfidentMatch(clear), `${clear[0]?.confidence} vs ${clear[1]?.confidence}`)

  // Reconciliation arithmetic.
  const balanced = reconcile({ statementBalance: 5000, bookBalance: 5300, unreconciledTotal: 300 })
  ok('balances when uncleared items explain the gap', balanced.balanced && balanced.difference === 0)
  const off = reconcile({ statementBalance: 5000, bookBalance: 5300, unreconciledTotal: 250 })
  ok('reports the exact unexplained difference', off.difference === 50 && !off.balanced)

  ok('link refuses same-side', refuseLink(500, 500, 0, 500) !== null)
  ok('link refuses over-matching', refuseLink(500, -500, 400, 200) !== null)
  ok('link allows the remainder', refuseLink(500, -500, 400, 100) === null)

  console.log('\n── Accounts ────────────────────────────────────────────────\n')

  const created = await createAccount(SITE, actor, {
    code: `TST${stamp}`,
    name: 'Test Cheque Account',
    accountType: 'bank',
    openingBalance: 1000,
    openingDate: daysAgo(60),
  })
  ok('account created', created.ok)
  if (!created.ok) return finish()
  const accountId = created.id

  const account = await getAccount(SITE, accountId)
  ok('opening balance seeds the balance', account?.balance === 1000, String(account?.balance))
  ok('code is upper-cased', account?.code === `TST${stamp}`)

  ok('duplicate code refused', !(await createAccount(SITE, actor, { code: `TST${stamp}`, name: 'Clash' })).ok)
  ok('blank name refused', !(await createAccount(SITE, actor, { code: `X${stamp}`, name: '' })).ok)

  console.log('\n── Capture and the balance invariant ───────────────────────\n')

  const deposit = await captureTransaction(SITE, actor, {
    bankAccountId: accountId, amount: 2500, txnDate: daysAgo(10),
    description: 'Cash deposit', reference: 'DEP001',
  })
  ok('deposit captured', deposit.ok)

  const charge = await captureTransaction(SITE, actor, {
    bankAccountId: accountId, amount: -85.5, txnDate: daysAgo(8),
    description: 'Bank charges',
  })
  ok('charge captured', charge.ok)

  const afterCapture = await getAccount(SITE, accountId)
  ok('balance moves with both directions', afterCapture?.balance === round(1000 + 2500 - 85.5, 2),
      String(afterCapture?.balance))

  ok('zero amount refused', !(await captureTransaction(SITE, actor, { bankAccountId: accountId, amount: 0 })).ok)

  const lines = await listTransactions(SITE, accountId)
  ok('running balance starts from opening', lines[0]?.runningBalance === 3500, String(lines[0]?.runningBalance))
  ok('running balance ends at the account balance',
      lines[lines.length - 1]?.runningBalance === afterCapture?.balance)

  // Void backs the money out but keeps the row.
  if (charge.ok) {
    ok('void needs a reason', !(await voidTransaction(SITE, actor, charge.id, '')).ok)
    ok('voided', (await voidTransaction(SITE, actor, charge.id, 'Captured twice')).ok)
    const afterVoid = await getAccount(SITE, accountId)
    ok('void backs the amount out', afterVoid?.balance === 3500, String(afterVoid?.balance))
    const voided = await getTransaction(SITE, charge.id)
    ok('  but the row survives, marked void', voided?.status === 'void')
  }

  ok('*** balance invariant holds after captures ***',
      (await reconcileBankBalances(SITE)).every((d) => d.id !== accountId))

  console.log('\n── Receipts: ledger + bank + link, together ────────────────\n')

  const cust = await createCustomer(SITE, actor, {
    code: `CB${stamp}`, name: 'Cashbook Test Co', paymentTermsDays: 30, creditLimit: 50000,
  })
  ok('customer created', cust.ok)
  if (!cust.ok) return finish()

  const inv = await postTransaction(SITE, actor, {
    customerId: cust.id, docType: 'invoice', amount: 1200,
    docDate: daysAgo(20), docNumber: `INV${stamp}`,
  })
  ok('invoice posted', inv.ok)

  const receipt = await recordCustomerReceipt(SITE, actor, {
    customerId: cust.id, bankAccountId: accountId, amount: 1200,
    receiptDate: daysAgo(2), reference: `INV${stamp}`, autoAllocate: true,
  })
  ok('receipt recorded on both sides', receipt.ok)

  if (receipt.ok) {
    const links = await linksFor(SITE, receipt.bankTxnId)
    ok('  receipt is linked to its ledger payment', links.length === 1 && links[0].side === 'customer')
    ok('  and the link is at full confidence', links[0]?.confidence === 100)

    const custRow = await siteQueryOne<{ balance: number }>(
      SITE, 'SELECT balance FROM customers WHERE id = ?', [cust.id])
    ok('  the invoice is settled', toNum(custRow?.balance) === 0, String(custRow?.balance))

    const bankAfter = await getAccount(SITE, accountId)
    ok('  and the bank holds the money', bankAfter?.balance === 4700, String(bankAfter?.balance))
  }

  console.log('\n── Suggesting and matching ─────────────────────────────────\n')

  // An unmatched payment, and a bank line that should find it.
  const orphan = await postTransaction(SITE, actor, {
    customerId: cust.id, docType: 'payment', amount: 640.25,
    docDate: daysAgo(4), reference: 'REMIT77', description: 'EFT',
  })
  const bankIn = await captureTransaction(SITE, actor, {
    bankAccountId: accountId, amount: 640.25, txnDate: daysAgo(3),
    description: 'CREDIT TRANSFER CASHBOOK TEST CO', reference: 'REMIT77',
  })
  ok('orphan payment and bank line both exist', orphan.ok && bankIn.ok)

  if (bankIn.ok && orphan.ok) {
    const suggestions = await suggestMatches(SITE, bankIn.id)
    ok('suggests the matching payment', suggestions.some((s) => s.ledgerTxnId === orphan.id),
        suggestions.map((s) => `${s.ledgerTxnId}@${s.confidence}`).join(', '))
    ok('  with high confidence', (suggestions[0]?.confidence ?? 0) >= 85)

    const matched = await autoMatch(SITE, actor, accountId)
    ok('auto-match links it', matched.matched >= 1, `${matched.matched}/${matched.considered}`)

    const links = await linksFor(SITE, bankIn.id)
    ok('  recorded as an auto match', links[0]?.matchType === 'auto')

    // Unlink and confirm it returns to the worklist.
    if (links[0]) {
      ok('unlinked', (await unlinkTransaction(SITE, actor, links[0].id)).ok)
      const stillLinked = await linksFor(SITE, bankIn.id)
      ok('  the link is gone', stillLinked.length === 0)
      const unmatched = await listTransactions(SITE, accountId, { unmatchedOnly: true })
      ok('  and it is outstanding again', unmatched.some((l) => l.id === bankIn.id))
      // Put it back for the reconciliation below.
      await linkTransaction(SITE, actor, bankIn.id, 'customer', orphan.id, 640.25)
    }
  }

  console.log('\n── Statement import ────────────────────────────────────────\n')

  const csv = [
    'Statement for account 62xxxxxx',
    '',
    'Date,Description,Reference,Debit,Credit',
    `${daysAgo(6).split('-').reverse().join('/')},"SETTLEMENT, CARD",CARDSTL,,1500.00`,
    `${daysAgo(5).split('-').reverse().join('/')},SERVICE FEE,FEES,120.50,`,
    'Closing balance,,,,9999.00',
  ].join('\n')

  const parsed = parseBankCsv(csv)
  ok('finds the header past the preamble', parsed.rows.length === 2,
      `${parsed.rows.length} rows, ${parsed.problems.length} problems`)
  ok('credit is positive', parsed.rows[0]?.amount === 1500)
  ok('debit is forced negative', parsed.rows[1]?.amount === -120.5)
  ok('quoted comma survives', parsed.rows[0]?.description === 'SETTLEMENT, CARD')
  ok('total line is skipped silently', parsed.problems.length === 0)

  const imported = await importStatement(SITE, actor, {
    bankAccountId: accountId, parsed, filename: 'test.csv', autoMatch: false,
  })
  ok('import succeeded', imported.ok)

  if (imported.ok) {
    ok('  both lines imported', imported.imported === 2, String(imported.imported))

    const afterImport = await getAccount(SITE, accountId)
    const expected = round(4700 + 640.25 + 1500 - 120.5, 2)
    ok('  balance moved by the net of the file', afterImport?.balance === expected,
        `${afterImport?.balance} vs ${expected}`)

    // THE idempotence check: importing the same file again must do nothing.
    const again = await importStatement(SITE, actor, {
      bankAccountId: accountId, parsed, filename: 'test.csv', autoMatch: false,
    })
    ok('*** re-import is a no-op ***', again.ok && again.imported === 0 && again.duplicates === 2,
        again.ok ? `${again.imported} imported, ${again.duplicates} dup` : 'failed')

    const afterRepeat = await getAccount(SITE, accountId)
    ok('  and the balance did not move', afterRepeat?.balance === expected, String(afterRepeat?.balance))

    if (again.ok) await undoImport(SITE, actor, again.batchId)

    ok('undo removes the imported lines', (await undoImport(SITE, actor, imported.batchId)).ok)
    const afterUndo = await getAccount(SITE, accountId)
    ok('  and backs the balance out', afterUndo?.balance === round(4700 + 640.25, 2),
        String(afterUndo?.balance))
  }

  // OFX, where the bank gives a real unique id.
  const ofx = `<OFX><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260315120000<TRNAMT>250.00<FITID>ABC123<NAME>DEPOSIT</STMTTRN></OFX>`
  const ofxParsed = parseStatement(ofx)
  ok('ofx detected by content', ofxParsed.detected.format === 'ofx')
  ok('  one transaction read', ofxParsed.rows.length === 1 && ofxParsed.rows[0].amount === 250)
  ok('  fitid becomes the import key',
      importKeyFor(1, ofxParsed.rows[0]).startsWith('fit:1:ABC123'))

  console.log('\n── Reconciliation ──────────────────────────────────────────\n')

  const current = await getAccount(SITE, accountId)
  const bookBalance = current?.balance ?? 0

  // Everything is matched, so a statement equal to the book balance balances.
  const preview = await previewReconciliation(SITE, accountId, daysAgo(0), bookBalance)
  ok('preview computes a difference', typeof preview.difference === 'number',
      `book ${preview.bookBalance}, unrec ${preview.unreconciledTotal}, diff ${preview.difference}`)

  // An out-of-balance sign-off must be refused without a reason.
  const refused = await completeReconciliation(SITE, actor, {
    bankAccountId: accountId, statementDate: daysAgo(0), statementBalance: bookBalance + 999,
  })
  ok('*** out-of-balance sign-off refused ***', !refused.ok)

  const forcedNoReason = await completeReconciliation(SITE, actor, {
    bankAccountId: accountId, statementDate: daysAgo(0),
    statementBalance: bookBalance + 999, force: true,
  })
  ok('  forcing still needs an explanation', !forcedNoReason.ok)

  const target = round(bookBalance - preview.unreconciledTotal, 2)
  const signed = await completeReconciliation(SITE, actor, {
    bankAccountId: accountId, statementDate: daysAgo(0), statementBalance: target,
  })
  ok('balanced sign-off accepted', signed.ok, signed.ok ? '' : signed.error)

  if (signed.ok) {
    ok('  difference is zero', signed.difference === 0, String(signed.difference))
    const acc = await getAccount(SITE, accountId)
    ok('  account records when it was last reconciled', acc?.lastReconciledDate === daysAgo(0))

    const frozen = await listTransactions(SITE, accountId, { status: 'reconciled' })
    ok('  matched lines are frozen', frozen.length > 0, `${frozen.length} frozen`)

    // A frozen line must resist being voided or unmatched.
    if (frozen[0]) {
      ok('  a reconciled line cannot be voided',
          !(await voidTransaction(SITE, actor, frozen[0].id, 'nope')).ok)
      const frozenLinks = await linksFor(SITE, frozen[0].id)
      if (frozenLinks[0]) {
        ok('  a reconciled link cannot be unmatched',
            !(await unlinkTransaction(SITE, actor, frozenLinks[0].id)).ok)
      }
    }

    ok('reopen needs a reason', !(await reopenReconciliation(SITE, actor, signed.id, '')).ok)
    ok('reopened', (await reopenReconciliation(SITE, actor, signed.id, 'Statement was wrong')).ok)
    const thawed = await listTransactions(SITE, accountId, { status: 'reconciled' })
    ok('  its lines return to unreconciled', thawed.length === 0, `${thawed.length} still frozen`)
  }

  console.log('\n── Accounts: defaults, totals, closing ─────────────────────\n')

  const def = await defaultAccount(SITE, 'receipts')
  ok('there is always a default receipts account', def !== null)
  ok('total cash is a number', typeof (await totalCash(SITE)) === 'number')

  ok('cannot close an account holding money', !(await closeAccount(SITE, actor, accountId)).ok)

  ok('*** balance invariant holds across every account ***',
      (await reconcileBankBalances(SITE)).length === 0,
      JSON.stringify(await reconcileBankBalances(SITE)))

  console.log('\n── The ledger hears about it (130) ─────────────────────────\n')

  // A categorised capture posts DR/CR bank vs its category; an uncategorised
  // one posts nothing until it is filed; a void posts the opposite journal.
  const filed = await captureTransaction(SITE, actor, {
    bankAccountId: accountId, amount: 150, txnDate: daysAgo(4),
    description: 'Interest earned', categoryKey: 'interest_received',
  })
  ok('categorised capture accepted', filed.ok)
  if (filed.ok) {
    const batch = await batchForSource(SITE, 'bank_txn', filed.id)
    ok('*** a categorised capture reaches the ledger ***', !!batch)
    if (batch) {
      const jl = await siteQuery<any>(SITE,
        'SELECT amount FROM journal_lines WHERE batch_id = ?', [batch.id])
      const sum = jl.reduce((s: number, l: any) => round(s + toNum(l.amount), 2), 0)
      ok('  and its journal balances', Math.abs(sum) < 0.005, String(sum))
    }
    ok('  voiding it', (await voidTransaction(SITE, actor, filed.id, 'Test void')).ok)
    ok('*** the void posts the opposite journal ***',
      !!(await batchForSource(SITE, 'bank_txn_void', filed.id)))
  }

  const unfiled = await captureTransaction(SITE, actor, {
    bankAccountId: accountId, amount: -20, txnDate: daysAgo(4), description: 'Mystery fee',
  })
  ok('uncategorised capture accepted', unfiled.ok)
  if (unfiled.ok) {
    ok('*** an uncategorised capture posts NO journal ***',
      (await batchForSource(SITE, 'bank_txn', unfiled.id)) === null)
    ok('  filing it later works',
      (await categoriseTransaction(SITE, actor, unfiled.id, 'owner_drawings')).ok)
    ok('*** filing posts the journal it was missing ***',
      !!(await batchForSource(SITE, 'bank_txn', unfiled.id)))
    ok('  refiling a posted line is refused',
      !(await categoriseTransaction(SITE, actor, unfiled.id, 'other_income')).ok)
  }

  // A transfer: two legs, ONE journal — provable only when the two accounts
  // map to different ledger accounts, so the second one is pointed at 1400.
  const second = await createAccount(SITE, actor, { code: `TS2${stamp}`, name: 'Transfer target' })
  ok('second account created', second.ok)
  if (second.ok) {
    const depositsAccount = await getAccountByCode(SITE, '1400')
    if (depositsAccount) {
      await setMapping(SITE, actor, 'bank_account', second.id, depositsAccount.id)
    }
    const moved = await recordTransfer(SITE, actor, {
      fromAccountId: accountId, toAccountId: second.id, amount: 300,
    })
    ok('*** a transfer records both legs ***', moved.ok, moved.ok ? '' : moved.error)
    if (moved.ok) {
      const [a, b] = await Promise.all([getAccount(SITE, accountId), getAccount(SITE, second.id)])
      ok('  both balances moved', (b?.balance ?? 0) === 300 && a !== null)
      const tb = await batchForSource(SITE, 'bank_transfer', moved.fromTxnId)
      ok('*** one journal for the pair ***', !!tb)
      ok('  voiding one leg alone is refused',
        !(await voidTransaction(SITE, actor, moved.fromTxnId, 'nope')).ok)
      ok('  voiding the transfer takes both legs',
        (await voidTransfer(SITE, actor, moved.fromTxnId, 'Test void')).ok)
      ok('*** and reverses the journal ***',
        !!(await batchForSource(SITE, 'bank_transfer_void', moved.fromTxnId)))
      const after = await getAccount(SITE, second.id)
      ok('  target balance back to zero', (after?.balance ?? -1) === 0, String(after?.balance))
    }
    // The second account's rows, mapping and the account itself go back too.
    await siteExecute(SITE, 'DELETE FROM bank_transactions WHERE bank_account_id = ?', [second.id])
    await siteExecute(SITE, "DELETE FROM gl_mappings WHERE mapping_key = 'bank_account' AND ref_id = ?", [second.id])
    await siteExecute(SITE, 'DELETE FROM bank_accounts WHERE id = ?', [second.id])
  }

  await cleanup(accountId, cust.id)
  finish()
}

/** Links before transactions before accounts — the FKs are RESTRICT. */
async function cleanup(accountId: number, customerId: number) {
  // The journals this suite's captures posted go first — they point at the
  // bank rows via source_doc_id — then balances are recomputed from what
  // survives (the test-general-ledger cleanup pattern).
  const glBatches = await siteQuery<any>(SITE,
    `SELECT id FROM journal_batches
      WHERE source IN ('bank_txn','bank_txn_void','bank_transfer','bank_transfer_void')
        AND source_doc_id IN (SELECT id FROM bank_transactions WHERE bank_account_id = ?)`,
    [accountId])
  for (const b of glBatches) {
    await siteExecute(SITE, 'DELETE FROM journal_lines WHERE batch_id = ?', [b.id])
    await siteExecute(SITE, 'DELETE FROM journal_batches WHERE id = ?', [b.id])
  }
  if (glBatches.length > 0) {
    await siteExecute(SITE,
      `UPDATE gl_accounts a
          SET a.balance = COALESCE((
                SELECT SUM(l.amount) FROM journal_lines l
                  JOIN journal_batches b ON b.id = l.batch_id
                 WHERE l.account_id = a.id AND b.status = 'posted'
              ), 0)`)
  }
  await siteExecute(SITE, 'DELETE FROM cashbook_links WHERE bank_txn_id IN (SELECT id FROM bank_transactions WHERE bank_account_id = ?)', [accountId])
  await siteExecute(SITE, 'DELETE FROM bank_reconciliations WHERE bank_account_id = ?', [accountId])
  await siteExecute(SITE, 'DELETE FROM bank_transactions WHERE bank_account_id = ?', [accountId])
  await siteExecute(SITE, 'DELETE FROM bank_import_batches WHERE bank_account_id = ?', [accountId])
  await siteExecute(SITE, 'DELETE FROM bank_accounts WHERE id = ?', [accountId])
  await siteExecute(SITE, 'DELETE FROM customer_allocations WHERE debit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?) OR credit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)', [customerId, customerId])
  await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [customerId])
  await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [customerId])
}

function finish() {
  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
