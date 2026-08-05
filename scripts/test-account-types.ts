/**
 * Customer account types — who gets credit, and who allocates payments.
 *
 * The distinction that matters, and the reason this is a type rather than a
 * boolean:
 *
 *   open_item    a payment is CHOSEN against specific invoices, and can be
 *                split across several — R300 here, R200 there
 *   balance_fwd  a payment lands on the OLDEST invoice and works forward, with
 *                nobody allocating anything by hand
 *   cash         no credit, ever
 *   lay_by       no credit either: the shop still holds the goods
 *
 * Both credit types keep a full open-item ledger underneath. balance_fwd is
 * not a different ledger — it is the same ledger with the allocation run
 * automatically. This suite proves that, because if it ever stops being true
 * the age analysis and the statements quietly diverge.
 *
 *   npm run test:account-types
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { createCustomer, getCustomer, updateCustomer } from '../src/lib/site/customers'
import {
  postTransaction, listLedger, allocate, autoAllocate, reconcileBalances,
} from '../src/lib/site/customerLedger'
import { creditBlockedReason, headroomRefusal } from '../src/lib/creditRules'
import {
  ACCOUNT_TYPES, allowsCredit, autoAllocates, accountTypeLabel, toAccountType,
} from '../src/lib/accountTypes'

const SITE = 1
const actor = { userId: 1, userName: 'Type Test' }
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

/** Three invoices, oldest first, so allocation order is observable. */
async function threeInvoices(customerId: number, stamp: string) {
  const ids: number[] = []
  for (const [amount, age, suffix] of [[300, 90, 'A'], [400, 60, 'B'], [500, 30, 'C']] as const) {
    const r = await postTransaction(SITE, actor, {
      customerId, docType: 'invoice', amount, docDate: daysAgo(age),
      docNumber: `${stamp}-${suffix}`,
    })
    if (r.ok) ids.push(r.id)
  }
  return ids
}

async function main() {
  const stamp = Date.now().toString().slice(-8)

  // ── The pure rules
  ok('*** every type is covered by the options table ***',
    ACCOUNT_TYPES.every((t) => accountTypeLabel(t).length > 0))
  ok('open_item allows credit', allowsCredit('open_item'))
  ok('balance_fwd allows credit', allowsCredit('balance_fwd'))
  ok('*** cash does NOT allow credit ***', !allowsCredit('cash'))
  ok('*** lay_by does NOT allow credit — the shop still holds the goods ***', !allowsCredit('lay_by'))
  ok('*** only balance_fwd auto-allocates ***',
    autoAllocates('balance_fwd') && !autoAllocates('open_item') &&
    !autoAllocates('cash') && !autoAllocates('lay_by'))
  ok('an unknown value falls back to open_item, never to "no credit"',
    toAccountType('nonsense') === 'open_item')

  // ── Credit is refused by TYPE, with the type named
  const position = { name: 'Test Co', status: 'active', creditLimit: 5000, balance: 0 }
  ok('*** a cash account is refused credit ***',
    creditBlockedReason({ ...position, accountType: 'cash' }) !== null)
  ok('  and the message names the type',
    (creditBlockedReason({ ...position, accountType: 'cash' }) ?? '').includes('cash'),
    creditBlockedReason({ ...position, accountType: 'cash' }) ?? '')
  ok('*** a lay-by account is refused credit ***',
    creditBlockedReason({ ...position, accountType: 'lay_by' }) !== null)
  ok('an open-item account with a limit is allowed',
    creditBlockedReason({ ...position, accountType: 'open_item' }) === null)
  ok('a balance-forward account with a limit is allowed',
    creditBlockedReason({ ...position, accountType: 'balance_fwd' }) === null)
  ok('  and a cash account is refused at the till too',
    headroomRefusal({ ...position, accountType: 'cash' }, 100) !== null)

  // ── BALANCE BROUGHT FORWARD: pays oldest first, automatically
  const bf = await createCustomer(SITE, actor, {
    code: `BF${stamp}`, name: 'Balance Forward Co', creditLimit: 100000,
    paymentTermsDays: 30, accountType: 'balance_fwd',
  })
  if (!bf.ok) { console.log('setup failed:', bf.error); process.exit(1) }
  ok('*** a balance_fwd customer is created as such ***',
    (await getCustomer(SITE, bf.id))?.accountType === 'balance_fwd')

  await threeInvoices(bf.id, `BF${stamp}`)
  ok('  owes 1200 across three invoices', (await getCustomer(SITE, bf.id))?.balance === 1200,
    String((await getCustomer(SITE, bf.id))?.balance))

  // R500 with autoAllocate — the balance_fwd behaviour.
  const bfPay = await postTransaction(SITE, actor, {
    customerId: bf.id, docType: 'payment', amount: 500, docNumber: `BFP${stamp}`,
    autoAllocate: true,
  })
  ok('*** payment posted with auto-allocation ***', bfPay.ok, bfPay.ok ? '' : bfPay.error)

  const bfLedger = await listLedger(SITE, bf.id)
  const bfA = bfLedger.find((l) => l.docNumber === `BF${stamp}-A`)
  const bfB = bfLedger.find((l) => l.docNumber === `BF${stamp}-B`)
  const bfC = bfLedger.find((l) => l.docNumber === `BF${stamp}-C`)
  ok('*** the OLDEST invoice is settled in full ***', bfA?.amountOutstanding === 0,
    String(bfA?.amountOutstanding))
  ok('*** the next one takes the remaining 200 ***', bfB?.amountOutstanding === 200,
    String(bfB?.amountOutstanding))
  ok('*** the newest is untouched ***', bfC?.amountOutstanding === 500,
    String(bfC?.amountOutstanding))
  ok('  balance is 700', (await getCustomer(SITE, bf.id))?.balance === 700,
    String((await getCustomer(SITE, bf.id))?.balance))

  // ── OPEN ITEM: the user chooses, and can SPLIT one payment
  const oi = await createCustomer(SITE, actor, {
    code: `OI${stamp}`, name: 'Open Item Co', creditLimit: 100000,
    paymentTermsDays: 30, accountType: 'open_item',
  })
  if (!oi.ok) { console.log('setup failed'); process.exit(1) }
  const oiIds = await threeInvoices(oi.id, `OI${stamp}`)

  const oiPay = await postTransaction(SITE, actor, {
    customerId: oi.id, docType: 'payment', amount: 500, docNumber: `OIP${stamp}`,
    // NOT auto-allocated: this is the open-item promise.
  })
  ok('*** an open-item payment posts UNALLOCATED ***', oiPay.ok)
  if (!oiPay.ok) { console.log('payment failed'); process.exit(1) }

  const beforeAlloc = await listLedger(SITE, oi.id)
  ok('  every invoice is still fully outstanding',
    beforeAlloc.filter((l) => l.docType === 'invoice').every((l) => l.amountOutstanding === l.amountSigned))
  ok('  and the payment is sitting unapplied', beforeAlloc.find((l) => l.docType === 'payment')?.amountOutstanding === -500,
    String(beforeAlloc.find((l) => l.docType === 'payment')?.amountOutstanding))

  // THE OPEN-ITEM CASE: split 500 across two invoices, 300 and 200 — and
  // deliberately NOT the oldest-first order an auto-allocation would pick.
  const splitOne = await allocate(SITE, actor, oiIds[2], oiPay.id, 300)
  const splitTwo = await allocate(SITE, actor, oiIds[1], oiPay.id, 200)
  ok('*** one payment SPLIT across two chosen invoices ***', splitOne.ok && splitTwo.ok,
    splitOne.ok ? '' : splitOne.error)

  const oiLedger = await listLedger(SITE, oi.id)
  const oiA = oiLedger.find((l) => l.docNumber === `OI${stamp}-A`)
  const oiB = oiLedger.find((l) => l.docNumber === `OI${stamp}-B`)
  const oiC = oiLedger.find((l) => l.docNumber === `OI${stamp}-C`)
  ok('*** the OLDEST is untouched — the user chose otherwise ***', oiA?.amountOutstanding === 300,
    String(oiA?.amountOutstanding))
  ok('  the middle one took 200 of 400', oiB?.amountOutstanding === 200, String(oiB?.amountOutstanding))
  ok('  the newest took 300 of 500', oiC?.amountOutstanding === 200, String(oiC?.amountOutstanding))
  ok('  balance is 700 either way', (await getCustomer(SITE, oi.id))?.balance === 700,
    String((await getCustomer(SITE, oi.id))?.balance))

  // ── The SAME ledger underneath: an open-item account can still auto-allocate
  const oiPay2 = await postTransaction(SITE, actor, {
    customerId: oi.id, docType: 'payment', amount: 300, docNumber: `OIP2${stamp}`,
  })
  if (oiPay2.ok) {
    ok('*** an open-item account CAN still auto-allocate on request ***',
      (await autoAllocate(SITE, actor, oiPay2.id)).ok)
    ok('  and it takes the oldest first',
      (await listLedger(SITE, oi.id)).find((l) => l.docNumber === `OI${stamp}-A`)?.amountOutstanding === 0)
  }

  // ── Switching type does not disturb the ledger
  const existing = (await getCustomer(SITE, oi.id))!
  const switched = await updateCustomer(SITE, actor, oi.id, {
    code: existing.code, name: existing.name, accountType: 'balance_fwd',
    creditLimit: existing.creditLimit, paymentTermsDays: existing.paymentTermsDays,
  })
  ok('*** a customer can switch type ***', switched.ok, switched.ok ? '' : switched.error)
  ok('  and the balance is unchanged', (await getCustomer(SITE, oi.id))?.balance === 400,
    String((await getCustomer(SITE, oi.id))?.balance))
  ok('  every allocation survived',
    (await listLedger(SITE, oi.id)).find((l) => l.docNumber === `OI${stamp}-B`)?.amountOutstanding === 200)

  // ── Cash and lay-by
  const cash = await createCustomer(SITE, actor, {
    code: `CA${stamp}`, name: 'Cash Only Co', accountType: 'cash', creditLimit: 5000,
  })
  ok('*** a cash customer can be created WITH a limit and still gets no credit ***',
    cash.ok && !(await getCustomer(SITE, cash.id))?.canBuyOnAccount)

  const layby = await createCustomer(SITE, actor, {
    code: `LB${stamp}`, name: 'Lay-by Co', accountType: 'lay_by', creditLimit: 5000,
  })
  ok('*** a lay-by customer gets no credit either ***',
    layby.ok && !(await getCustomer(SITE, layby.id))?.canBuyOnAccount)

  ok('  the default for a new customer is open_item',
    (await createCustomer(SITE, actor, { code: `DF${stamp}`, name: 'Default Co' })).ok)
  const def = await siteQueryOne<any>(SITE, 'SELECT account_type FROM customers WHERE code = ?', [`DF${stamp}`])
  ok('  confirmed', def?.account_type === 'open_item', String(def?.account_type))

  // ── Invariant
  ok('*** reconcileBalances zero drift ***', (await reconcileBalances(SITE)).length === 0)

  // ── Cleanup
  for (const code of [`BF${stamp}`, `OI${stamp}`, `CA${stamp}`, `LB${stamp}`, `DF${stamp}`]) {
    const row = await siteQueryOne<any>(SITE, 'SELECT id FROM customers WHERE code = ?', [code])
    if (!row) continue
    await siteExecute(SITE, 'DELETE FROM customer_allocations WHERE debit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?) OR credit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)', [row.id, row.id])
    await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [row.id])
    await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [row.id])
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}
main()
