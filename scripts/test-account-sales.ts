/**
 * Account sales — the seam where sales meets debtors.
 *
 * Checks that the till's credit rules and the posting engine's agree, that an
 * account sale lands on the ledger linked to its document, and that the three
 * ways an account can be blocked are all refused.
 *
 *   npm run test:account-sales
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { createCustomer, getCustomer, updateCustomer } from '../src/lib/site/customers'
import { searchCustomersForTill, getTillCustomer } from '../src/lib/site/tillCustomers'
import { headroomRefusal, creditBlockedReason, availableCredit } from '../src/lib/creditRules'
import { saveDraft, getDocument } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { listLedger, reconcileBalances } from '../src/lib/site/customerLedger'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Account Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const vatRate = toNum(vat?.rate, 15)

  const prod = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'service',0,0,0,?,1)`,
    [`ACC${stamp}`, `Account test service ${stamp}`, vat?.id ?? null],
  )
  const productId = prod.insertId

  const account = await getTenderByCode(SITE, 'ACCOUNT')
  const cash = await getTenderByCode(SITE, 'CASH')
  if (!account || !cash) { console.log('missing seeded tenders'); process.exit(1) }

  const sell = async (customerId: number | null, amount: number, tenderId: number) => {
    const draft = await saveDraft(SITE, actor, {
      docType: 'invoice',
      customerId,
      customerName: customerId ? 'Account customer' : 'Walk-in',
      lines: [{
        productId, productCode: `ACC${stamp}`, description: 'Account test service',
        productType: 'service', qty: 1, unitPriceIncl: amount, vatRatePct: vatRate,
      }],
    })
    if (!draft.ok) return { ok: false as const, error: draft.error }
    return finaliseDocument(SITE, actor, {
      documentId: draft.id, customerId, tenders: [{ tenderTypeId: tenderId, amount }],
    })
  }

  // ── The pure rules
  const base = { name: 'Test Co', status: 'active', accountType: 'open_item' as const, creditLimit: 1000, balance: 200 }
  ok('available credit = limit - balance', availableCredit(base) === 800)
  ok('within headroom is allowed', headroomRefusal(base, 500) === null)
  ok('beyond headroom is refused', headroomRefusal(base, 900) !== null, String(headroomRefusal(base, 900)))
  ok('on hold blocked', creditBlockedReason({ ...base, status: 'on_hold' }) !== null)
  ok('cash-only blocked', creditBlockedReason({ ...base, accountType: 'cash' as const }) !== null)
  ok('zero limit means NO credit, not unlimited', creditBlockedReason({ ...base, creditLimit: 0 }) !== null)
  ok('already over limit blocked', creditBlockedReason({ ...base, balance: 1200 }) !== null)
  ok('negative available credit clamps to 0', availableCredit({ ...base, balance: 1200 }) === 0)

  // ── A real account
  const cust = await createCustomer(SITE, actor, {
    code: `ACT${stamp}`, name: 'Account Test Co', creditLimit: 1000, paymentTermsDays: 30,
  })
  if (!cust.ok) { console.log('setup failed:', cust.error); process.exit(1) }

  const till = await getTillCustomer(SITE, cust.id)
  ok('till sees the new account as sellable', till?.creditBlockedReason === null)
  ok('  with full credit available', till?.availableCredit === 1000, String(till?.availableCredit))

  const found = await searchCustomersForTill(SITE, `ACT${stamp}`)
  ok('till search finds it by code', found.length === 1 && found[0].id === cust.id)

  // ── The sale
  const sale = await sell(cust.id, 575, account.id)
  ok('*** account sale posted ***', sale.ok, sale.ok ? sale.documentNumber : sale.error)

  const after = await getCustomer(SITE, cust.id)
  ok('  balance moved to the ledger', after?.balance === 575, String(after?.balance))
  ok('  available credit fell', (await getTillCustomer(SITE, cust.id))?.availableCredit === 425)

  const ledger = await listLedger(SITE, cust.id)
  const entry = ledger[ledger.length - 1]
  ok('  ledger entry created', ledger.length === 1)
  ok('  entry is linked to the sale document', (entry?.sourceDocId ?? 0) > 0, `sourceDocId=${entry?.sourceDocId}`)
  ok('  entry source says it came from a sale', entry?.source === 'sale', String(entry?.source))
  ok('  entry carries the invoice number', (entry?.docNumber ?? '').startsWith('INV'), String(entry?.docNumber))
  ok('  entry has a due date from the terms', entry?.dueDate !== null, String(entry?.dueDate))

  // ── The three refusals
  const over = await sell(cust.id, 900, account.id)
  ok('*** over-limit sale REFUSED ***', !over.ok, !over.ok ? over.error : '')

  await updateCustomer(SITE, actor, cust.id, {
    code: `ACT${stamp}`, name: 'Account Test Co', creditLimit: 1000,
    status: 'on_hold', statusReason: 'Testing',
  })
  const held = await sell(cust.id, 10, account.id)
  ok('*** on-hold sale REFUSED ***', !held.ok, !held.ok ? held.error : '')
  ok('  and the till agrees it is blocked', (await getTillCustomer(SITE, cust.id))?.creditBlockedReason !== null)

  await updateCustomer(SITE, actor, cust.id, {
    code: `ACT${stamp}`, name: 'Account Test Co', creditLimit: 1000, status: 'active', accountType: 'cash' as const,
  })
  const cashOnly = await sell(cust.id, 10, account.id)
  ok('*** cash-only sale REFUSED ***', !cashOnly.ok, !cashOnly.ok ? cashOnly.error : '')

  // A cash-only customer can still buy — just not on account.
  await updateCustomer(SITE, actor, cust.id, {
    code: `ACT${stamp}`, name: 'Account Test Co', creditLimit: 1000, status: 'active', accountType: 'cash' as const,
  })
  const stillCash = await sell(cust.id, 25, cash.id)
  ok('cash-only customer CAN still pay cash', stillCash.ok, stillCash.ok ? '' : stillCash.error)
  ok('  and that did not touch their balance', (await getCustomer(SITE, cust.id))?.balance === 575, String((await getCustomer(SITE, cust.id))?.balance))

  // ── Walk-in with an account tender
  const walkIn = await sell(null, 50, account.id)
  ok('account tender without a customer refused', !walkIn.ok, !walkIn.ok ? walkIn.error : '')

  // ── Invariants
  ok('*** reconcileBalances zero drift ***', (await reconcileBalances(SITE)).length === 0)
  ok('*** reconcileStock zero drift ***', (await reconcileStock(SITE)).length === 0)

  // ── Cleanup. Documents before the customer: the FK is RESTRICT.
  const docs = await siteQueryOne<any>(SITE, 'SELECT GROUP_CONCAT(id) ids FROM sales_documents WHERE customer_id = ? OR customer_name = ?', [cust.id, 'Walk-in'])
  for (const id of String(docs?.ids ?? '').split(',').filter(Boolean)) {
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE source_doc_id = ?', [Number(id)])
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [Number(id)])
  }
  await siteExecute(SITE, 'DELETE FROM customer_allocations WHERE debit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)', [cust.id])
  await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId])
  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}
main()
