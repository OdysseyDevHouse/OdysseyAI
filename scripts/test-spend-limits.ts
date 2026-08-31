/**
 * Daily and monthly spend limits, and auto-emailed invoices.
 *
 * The distinction this suite exists to pin down: a CREDIT limit caps exposure
 * and is freed by paying; a SPEND limit caps velocity and is not. The test that
 * matters most is the one where a customer settles their account in full and is
 * STILL refused, because their daily limit is spent — get that wrong and the
 * feature is just a second credit limit wearing a different label.
 *
 * Also proves the two ways this could silently do nothing: that the spend is
 * measured from ACCOUNT TENDERS (so a mostly-cash sale barely touches it), and
 * that a voided sale gives the room back with no reset job anywhere.
 *
 *   npm run test:spend-limits
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { createCustomer, getCustomer, updateCustomer } from '../src/lib/site/customers'
import { getTillCustomer } from '../src/lib/site/tillCustomers'
import { headroomRefusal, remainingDaily, remainingMonthly, NO_SPEND } from '../src/lib/creditRules'
import { accountSpend, monthStart } from '../src/lib/site/customerSpend'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { autoEmailInvoice, type MailDeps } from '../src/lib/site/invoiceEmail'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { postTransaction, reconcileBalances } from '../src/lib/site/customerLedger'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Spend Limit Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const sent: { to: string; subject: string; attachments: number }[] = []
const workingMail: MailDeps = {
  configured: () => true,
  send: async (_siteId, msg) => {
    sent.push({ to: msg.to, subject: msg.subject, attachments: msg.attachments?.length ?? 0 })
    return { ok: true, messageId: 'fake-1' }
  },
}

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )
  const vatRate = toNum(vat?.rate, 15)

  const prod = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'service',0,0,0,?,1)`,
    [`SPL${stamp}`, `Spend limit service ${stamp}`, vat?.id ?? null],
  )
  const productId = prod.insertId

  const account = await getTenderByCode(SITE, 'ACCOUNT')
  const cash = await getTenderByCode(SITE, 'CASH')
  if (!account || !cash) {
    console.log('missing seeded tenders')
    process.exit(1)
  }

  /** One sale, tendered across however many methods are given. */
  const sell = async (
    customerId: number,
    amount: number,
    tenders: { tenderTypeId: number; amount: number }[],
  ) => {
    const draft = await saveDraft(SITE, actor, {
      docType: 'invoice',
      customerId,
      customerName: 'Spend limit customer',
      lines: [
        {
          productId,
          productCode: `SPL${stamp}`,
          description: 'Spend limit service',
          productType: 'service',
          qty: 1,
          unitPriceIncl: amount,
          vatRatePct: vatRate,
        },
      ],
    })
    if (!draft.ok) return { ok: false as const, error: draft.error }
    return finaliseDocument(SITE, actor, { documentId: draft.id, customerId, tenders })
  }

  /* ── The pure rules ───────────────────────────────────────────────────── */

  const base = {
    name: 'Velocity Co',
    status: 'active',
    accountType: 'open_item' as const,
    creditLimit: 10_000,
    balance: 0,
    dailyLimit: 1_000,
    monthlyLimit: 5_000,
  }

  ok('no spend yet: within the daily cap is allowed', headroomRefusal(base, 900, NO_SPEND) === null)
  ok(
    'over the daily cap is refused',
    headroomRefusal(base, 1_100, NO_SPEND) !== null,
    String(headroomRefusal(base, 1_100, NO_SPEND)),
  )
  ok(
    'a sale that fits the remaining daily room is allowed',
    headroomRefusal(base, 400, { today: 600, month: 600 }) === null,
  )
  ok(
    'the same sale is refused once the day is spent',
    headroomRefusal(base, 400, { today: 700, month: 700 }) !== null,
  )
  ok(
    'the monthly cap bites even when the day is clear',
    headroomRefusal(base, 500, { today: 0, month: 4_800 }) !== null,
  )

  // The whole point of the feature: a spend cap is NOT freed by paying.
  ok(
    '*** a zero balance does NOT reset the daily cap ***',
    headroomRefusal({ ...base, balance: 0 }, 500, { today: 900, month: 900 }) !== null,
    'settling the account must not hand back the day',
  )

  // Zero means unlimited here — the opposite of creditLimit. Both caps are
  // cleared for this one: leaving the monthly at 5,000 would have it refuse the
  // sale and the assertion would pass for the wrong reason.
  ok(
    'a zero daily limit means NO daily cap',
    headroomRefusal({ ...base, dailyLimit: 0, monthlyLimit: 0 }, 9_000, {
      today: 50_000,
      month: 50_000,
    }) === null,
  )
  ok(
    '  but the credit limit still applies',
    headroomRefusal({ ...base, dailyLimit: 0, monthlyLimit: 0 }, 11_000, NO_SPEND) !== null,
  )
  ok(
    'an absent limit behaves as no cap',
    headroomRefusal(
      { name: 'X', status: 'active', accountType: 'open_item' as const, creditLimit: 100, balance: 0 },
      50,
    ) === null,
  )

  // The binding constraint is the one reported, not whichever is checked first.
  const both = headroomRefusal(base, 2_000, { today: 0, month: 4_900 }) ?? ''
  ok('the WORST breach is the one reported', both.includes('monthly'), both)

  ok('remaining daily is limit minus spend', remainingDaily(base, { today: 250, month: 250 }) === 750)
  ok('remaining never goes negative', remainingDaily(base, { today: 5_000, month: 5_000 }) === 0)
  ok('remaining is null where no cap is set', remainingDaily({ ...base, dailyLimit: 0 }, NO_SPEND) === null)
  ok('remaining monthly reads its own cap', remainingMonthly(base, { today: 0, month: 1_000 }) === 4_000)

  ok('month start is the first of that month', monthStart('2026-08-16') === '2026-08-01')

  /* ── A real account ───────────────────────────────────────────────────── */

  const cust = await createCustomer(SITE, actor, {
    code: `SPL${stamp}`,
    name: 'Velocity Trading',
    creditLimit: 10_000,
    dailyLimit: 1_000,
    monthlyLimit: 5_000,
    paymentTermsDays: 30,
  })
  if (!cust.ok) {
    console.log('setup failed:', cust.error)
    process.exit(1)
  }

  const stored = await getCustomer(SITE, cust.id)
  ok('limits persisted', stored?.dailyLimit === 1_000 && stored?.monthlyLimit === 5_000,
    `${stored?.dailyLimit}/${stored?.monthlyLimit}`)

  const fresh = await accountSpend(SITE, cust.id)
  ok('a new account has spent nothing', fresh.today === 0 && fresh.month === 0)

  const till = await getTillCustomer(SITE, cust.id)
  ok('the till carries the caps', till?.dailyLimit === 1_000, String(till?.dailyLimit))
  ok('  and the room left in them', till?.remainingDaily === 1_000, String(till?.remainingDaily))

  // ── A sale inside the cap
  const first = await sell(cust.id, 600, [{ tenderTypeId: account.id, amount: 600 }])
  ok('*** an account sale inside the daily cap posts ***', first.ok, first.ok ? first.documentNumber : first.error)

  const afterFirst = await accountSpend(SITE, cust.id)
  ok('  the day now shows the spend', afterFirst.today === 600, String(afterFirst.today))
  ok('  and so does the month', afterFirst.month === 600, String(afterFirst.month))
  ok('  the till sees the room shrink', (await getTillCustomer(SITE, cust.id))?.remainingDaily === 400)

  // ── A sale that breaches it
  const over = await sell(cust.id, 500, [{ tenderTypeId: account.id, amount: 500 }])
  ok('*** the sale that breaks the daily cap is refused ***', !over.ok, !over.ok ? over.error : '')
  ok(
    '  and the refusal names the daily limit',
    !over.ok && over.error.includes('daily'),
    !over.ok ? over.error : '',
  )

  // ── Paying does NOT give the day back. The heart of the feature.
  //
  // A real receipt through the ledger, not an UPDATE on the balance: falsifying
  // it directly would leave reconcileBalances reporting drift at the end of this
  // suite and blame the ledger for the test's own shortcut.
  const receipt = await postTransaction(SITE, actor, {
    customerId: cust.id,
    docType: 'payment',
    amount: 600,
    description: 'Settling the account in full',
    autoAllocate: true,
  })
  ok('the account is paid off', receipt.ok, receipt.ok ? '' : receipt.error)
  ok(
    '  balance is back to zero',
    (await getCustomer(SITE, cust.id))?.balance === 0,
    String((await getCustomer(SITE, cust.id))?.balance),
  )

  const afterPaying = await sell(cust.id, 500, [{ tenderTypeId: account.id, amount: 500 }])
  ok(
    '*** settling the account does NOT reopen the daily cap ***',
    !afterPaying.ok,
    !afterPaying.ok ? afterPaying.error : 'IT WAS ALLOWED — the cap is behaving as a credit limit',
  )

  // ── The spend follows the ACCOUNT tender, not the document total
  const split = await sell(cust.id, 1_000, [
    { tenderTypeId: cash.id, amount: 900 },
    { tenderTypeId: account.id, amount: 100 },
  ])
  ok('*** a mostly-cash sale posts against the same cap ***', split.ok, split.ok ? '' : (split as any).error)

  const afterSplit = await accountSpend(SITE, cust.id)
  ok(
    '  only the ACCOUNT slice counted, not the R1000 total',
    afterSplit.today === 700,
    `expected 700, got ${afterSplit.today}`,
  )

  // ── Voiding gives the room back, with no reset job.
  //
  // 'cancelled' is the status a void lands in — see the enum comment in
  // 015_sales_core.sql. The spend query filters on status = 'finalised', so
  // anything else drops out of the sum with nothing to reset.
  //
  // The status is set directly rather than through voidDocument() because this
  // is asserting one thing: that the SUM follows the status. Its ledger entry
  // is left in place and reversed below, so the balance stays explainable.
  if (split.ok) {
    await siteExecute(SITE, "UPDATE sales_documents SET status = 'cancelled' WHERE id = ?", [
      split.documentId,
    ])
    const afterVoid = await accountSpend(SITE, cust.id)
    ok(
      '*** voiding a sale returns its room to the cap ***',
      afterVoid.today === 600,
      `expected 600, got ${afterVoid.today}`,
    )
  }

  // ── A back-dated invoice is measured in ITS window, not today's
  const lastMonth = await accountSpend(SITE, cust.id, '2020-03-15')
  ok('an old window shows nothing spent', lastMonth.today === 0 && lastMonth.month === 0)

  /* ── Auto-email ───────────────────────────────────────────────────────── */

  const noEmail = await autoEmailInvoice(SITE, actor, cust.id, first.ok ? first.documentId : 0, workingMail)
  ok(
    'an account that never opted in is not emailed',
    !noEmail.sent && noEmail.reason === 'not-enabled',
    JSON.stringify(noEmail),
  )

  // Switching it on with no address is refused at the form, not silently kept.
  const noAddress = await updateCustomer(SITE, actor, cust.id, {
    code: `SPL${stamp}`,
    name: 'Velocity Trading',
    autoEmailInvoices: true,
  })
  ok(
    '*** auto-email without an address is refused ***',
    !noAddress.ok,
    noAddress.ok ? 'IT WAS ACCEPTED — every invoice would fail silently' : noAddress.error,
  )

  const enabled = await updateCustomer(SITE, actor, cust.id, {
    code: `SPL${stamp}`,
    name: 'Velocity Trading',
    email: 'accounts@velocity.test',
    autoEmailInvoices: true,
    creditLimit: 10_000,
    dailyLimit: 1_000,
    monthlyLimit: 5_000,
  })
  ok('auto-email switches on with an address', enabled.ok, enabled.ok ? '' : enabled.error)

  sent.length = 0
  const emailed = await autoEmailInvoice(
    SITE,
    actor,
    cust.id,
    first.ok ? first.documentId : 0,
    workingMail,
  )
  ok('*** an opted-in account is emailed its invoice ***', emailed.sent, JSON.stringify(emailed))
  ok('  to the account address', sent[0]?.to === 'accounts@velocity.test', sent[0]?.to)
  ok('  with the PDF attached', (sent[0]?.attachments ?? 0) === 1, String(sent[0]?.attachments))

  const audit = await siteQueryOne<any>(
    SITE,
    "SELECT COUNT(*) n FROM document_audit WHERE document_id = ? AND action = 'emailed'",
    [first.ok ? first.documentId : 0],
  )
  ok('  and the send is on the audit trail', Number(audit?.n ?? 0) >= 1, String(audit?.n))

  // A validation guard, not a silent skip: it must not be possible to leave the
  // switch on while clearing the address.
  const cleared = await updateCustomer(SITE, actor, cust.id, {
    code: `SPL${stamp}`,
    name: 'Velocity Trading',
    email: null,
    autoEmailInvoices: true,
  })
  ok('clearing the address with auto-email on is refused', !cleared.ok, cleared.ok ? '' : cleared.error)

  /* ── Validation ───────────────────────────────────────────────────────── */

  const negative = await updateCustomer(SITE, actor, cust.id, {
    code: `SPL${stamp}`, name: 'Velocity Trading', email: 'accounts@velocity.test', dailyLimit: -1,
  })
  ok('a negative daily limit is refused', !negative.ok, negative.ok ? '' : negative.error)

  const inverted = await updateCustomer(SITE, actor, cust.id, {
    code: `SPL${stamp}`, name: 'Velocity Trading', email: 'accounts@velocity.test',
    dailyLimit: 9_000, monthlyLimit: 5_000,
  })
  ok(
    'a daily limit above the monthly one is refused',
    !inverted.ok,
    inverted.ok ? 'IT WAS ACCEPTED — the daily cap could never bind' : inverted.error,
  )

  /* ── Invariants ───────────────────────────────────────────────────────── */

  // Scoped to THIS customer. A global reconcile picks up litter other suites
  // left behind and reports it as this one's failure — see the note in
  // test-general-ledger.ts about running invariant checks solo.
  // `id` is the customer id on a BalanceDrift — filtering on a field that does
  // not exist would match nothing and pass without proving anything.
  const allDrift = await reconcileBalances(SITE)
  const drift = allDrift.filter((d) => d.id === cust.id)
  ok(
    '*** this account has zero balance drift ***',
    drift.length === 0,
    `${JSON.stringify(drift)} (${allDrift.length} account(s) drifting site-wide)`,
  )

  /* ── Cleanup. Documents before the customer: the FK is RESTRICT. ───────── */

  const docs = await siteQueryOne<any>(
    SITE,
    'SELECT GROUP_CONCAT(id) ids FROM sales_documents WHERE customer_id = ?',
    [cust.id],
  )
  for (const id of String(docs?.ids ?? '').split(',').filter(Boolean)) {
    await siteExecute(SITE, 'DELETE FROM document_audit WHERE document_id = ?', [Number(id)])
    await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id = ?', [Number(id)])
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE source_doc_id = ?', [Number(id)])
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [Number(id)])
  }
  await siteExecute(
    SITE,
    'DELETE FROM customer_allocations WHERE debit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)',
    [cust.id],
  )
  await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM activity_log WHERE entity = ? AND entity_id = ?', ['customer', cust.id])
  await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId])
  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
