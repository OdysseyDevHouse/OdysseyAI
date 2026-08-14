/**
 * Correcting a finalised invoice — reverse and repost.
 *
 * The rule that matters: "edit" NEVER means UPDATE. A finalised invoice has
 * moved stock, posted a ledger entry, declared VAT and been printed. Correcting
 * it produces three sound documents — the original, a credit note reversing it,
 * and a replacement — and the ledger, the stock and the VAT all stay true.
 *
 * The guards are the point. Each one prevents a mistake that cannot be undone.
 *
 *   npm run test:sales-edit
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { createCustomer, getCustomer } from '../src/lib/site/customers'
import { saveDraft, getDocument } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { createCreditNote } from '../src/lib/site/salesReversal'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { listLedger, reconcileBalances, postTransaction, allocate } from '../src/lib/site/customerLedger'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { setSetting } from '../src/lib/site/settings'
import {
  canEditFinalised, editFinalisedDocument, editDocumentDetails, correctionChain,
} from '../src/lib/site/salesEdit'
import { NO_CAPABILITIES, type CapabilitySet } from '../src/lib/site/permissions'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Edit Test' }

/**
 * These checks used to name a ROLE; permissions now take the capability set
 * that role resolves to. The three below stand in for what the old role names
 * meant here — an owner may do anything, and neither staff nor manager holds
 * sales.edit_finalised by default.
 */
const OWNER: CapabilitySet = { isOwner: true, granted: new Set<string>() }
const MANAGER: CapabilitySet = { isOwner: false, granted: new Set<string>() }
const STAFF: CapabilitySet = NO_CAPABILITIES
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}
const stockOf = async (id: number) =>
  toNum((await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [id]))?.stock_on_hand)

const CODE_PATTERN = '^EDT[0-9]{8}$'
async function sweepStrays() {
  const where = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  await siteExecute(SITE, `DELETE FROM sales_document_lines WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
}

/** Rings up a finalised account invoice for `qty` at `price`. */
async function sellOnAccount(
  productId: number, code: string, customerId: number, qty: number, price: number,
  rate: number, accountTenderId: number,
): Promise<number> {
  const draft = await saveDraft(SITE, actor, {
    docType: 'invoice', customerId, customerName: 'Edit Test Co',
    lines: [{ productId, productCode: code, description: 'Edit test widget', productType: 'normal', qty, unitPriceIncl: price, vatRatePct: rate, unitCostExcl: 40 }],
  })
  if (!draft.ok) throw new Error(draft.error)
  const posted = await finaliseDocument(SITE, actor, {
    documentId: draft.id, customerId,
    tenders: [{ tenderTypeId: accountTenderId, amount: qty * price }],
  })
  if (!posted.ok) throw new Error(posted.error)
  return draft.id
}

async function main() {
  await sweepStrays()

  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const rate = toNum(vat?.rate, 15)

  const p = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'normal',200,40,40,?,1)`,
    [`EDT${stamp}`, 'Edit test widget', vat?.id ?? null])
  const product = p.insertId
  await siteExecute(SITE,
    "INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_id, user_name) VALUES (?,(SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1),'opening',200,200,40,'opening',1,'Edit Test')",
    [product])
  await siteExecute(SITE,
    'INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) SELECT id, (SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1), stock_on_hand FROM products WHERE id=? ON DUPLICATE KEY UPDATE stock_on_hand=VALUES(stock_on_hand)',
    [product])

  const account = await getTenderByCode(SITE, 'ACCOUNT')
  const cash = await getTenderByCode(SITE, 'CASH')
  const cust = await createCustomer(SITE, actor, { code: `EDC${stamp}`, name: 'Edit Test Co', creditLimit: 500000, paymentTermsDays: 30 })
  if (!account || !cash || !cust.ok) { console.log('setup failed'); process.exit(1) }

  const driftBefore = (await reconcileStock(SITE)).length

  // ── GUARD 1: the role must have the capability
  const wrongQty = await sellOnAccount(product, `EDT${stamp}`, cust.id, 10, 115, rate, account.id)
  ok('*** staff CANNOT correct a finalised invoice ***',
    !(await canEditFinalised(SITE, STAFF, wrongQty)).ok)
  ok('*** manager cannot either — it is owner-only by default ***',
    !(await canEditFinalised(SITE, MANAGER, wrongQty)).ok)
  ok('*** an owner can ***', (await canEditFinalised(SITE, OWNER, wrongQty)).ok)

  const staffTry = await editFinalisedDocument(SITE, actor, STAFF, {
    documentId: wrongQty, reason: 'wrong qty', lines: [], tenders: [],
  })
  ok('  and the attempt itself is refused', !staffTry.ok)

  // ── GUARD 2: only a finalised invoice
  const draftDoc = await saveDraft(SITE, actor, {
    docType: 'invoice', customerId: cust.id, customerName: 'Edit Test Co',
    lines: [{ productId: product, productCode: `EDT${stamp}`, description: 'Edit test widget', productType: 'normal', qty: 1, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 40 }],
  })
  ok('a DRAFT cannot be "corrected" — just edit it',
    draftDoc.ok && !(await canEditFinalised(SITE, OWNER, draftDoc.id)).ok)

  // ── A reason is mandatory
  ok('*** a correction without a reason is refused ***',
    !(await editFinalisedDocument(SITE, actor, OWNER, {
      documentId: wrongQty, reason: '   ',
      lines: [{ productId: product, productCode: `EDT${stamp}`, description: 'Edit test widget', productType: 'normal', qty: 8, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 40 }],
      tenders: [{ tenderTypeId: account.id, amount: 920 }],
    })).ok)

  // ── THE CORRECTION: 10 sold, should have been 8
  const balanceBefore = (await getCustomer(SITE, cust.id))!.balance
  const stockBefore = await stockOf(product)
  ok('before: 10 sold, balance 1150', balanceBefore === 1150 && stockBefore === 190,
    `${balanceBefore} / ${stockBefore}`)

  const corrected = await editFinalisedDocument(SITE, actor, OWNER, {
    documentId: wrongQty,
    reason: 'Cashier keyed 10, customer took 8',
    lines: [{ productId: product, productCode: `EDT${stamp}`, description: 'Edit test widget', productType: 'normal', qty: 8, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 40 }],
    tenders: [{ tenderTypeId: account.id, amount: 920 }],
  })
  ok('*** corrected ***', corrected.ok,
    corrected.ok ? `${corrected.replacedNumber} → ${corrected.documentNumber} via ${corrected.creditNoteNumber}` : corrected.error)
  if (!corrected.ok) { await sweepStrays(); process.exit(1) }

  // ── THE ORIGINAL IS UNTOUCHED — this is the whole point
  const original = await getDocument(SITE, wrongQty)
  ok('*** the ORIGINAL still says 10 ***', original?.lines[0].qty === 10, String(original?.lines[0].qty))
  ok('*** and still totals 1150 ***', original?.totalIncl === 1150, String(original?.totalIncl))
  ok('*** and keeps its own number ***', original?.documentNumber === corrected.replacedNumber)
  ok('*** and is still FINALISED, not void ***', original?.status === 'finalised', String(original?.status))

  // ── Three documents now exist, and they net correctly
  const replacement = await getDocument(SITE, corrected.documentId)
  ok('*** the replacement says 8 ***', replacement?.lines[0].qty === 8, String(replacement?.lines[0].qty))
  ok('  totalling 920', replacement?.totalIncl === 920, String(replacement?.totalIncl))
  ok('  with its OWN new number', replacement?.documentNumber !== original?.documentNumber)
  ok('  and a note naming what it replaces',
    (replacement?.notes ?? '').includes(corrected.replacedNumber), replacement?.notes ?? '')

  const creditNote = await getDocument(SITE, corrected.creditNoteId)
  ok('  the credit note reverses the original in full', creditNote?.totalIncl === -1150, String(creditNote?.totalIncl))
  ok('  and links to it', creditNote?.reversesId === wrongQty, String(creditNote?.reversesId))

  // ── The figures all land where they should
  ok('*** balance is now 920, not 1150+920 ***',
    (await getCustomer(SITE, cust.id))?.balance === 920,
    String((await getCustomer(SITE, cust.id))?.balance))
  ok('*** stock reflects 8 sold, not 18 ***', (await stockOf(product)) === 192, String(await stockOf(product)))
  ok('*** Σ movements still equals stock_on_hand ***', (await reconcileStock(SITE)).length === driftBefore)
  ok('*** reconcileBalances zero drift ***', (await reconcileBalances(SITE)).length === 0)

  const ledger = await listLedger(SITE, cust.id)
  ok('  the ledger holds all three: invoice, credit, invoice',
    ledger.filter((l) => l.docType === 'invoice').length === 2 &&
    ledger.filter((l) => l.docType === 'credit_note').length === 1,
    ledger.map((l) => l.docType).join(','))

  const chain = await correctionChain(SITE, wrongQty)
  ok('*** the original knows it was corrected ***', chain.correctedAt !== null)
  ok('  by whom', chain.correctedBy === 'Edit Test', String(chain.correctedBy))
  ok('  why', (chain.reason ?? '').includes('Cashier keyed 10'), chain.reason ?? '')
  ok('  and which credit note reversed it', chain.reversedBy?.id === corrected.creditNoteId)

  // ── GUARD 3: cannot correct twice
  ok('*** an already-corrected invoice cannot be corrected again ***',
    !(await canEditFinalised(SITE, OWNER, wrongQty)).ok)
  const twice = await canEditFinalised(SITE, OWNER, wrongQty)
  ok('  and says why', !twice.ok && twice.refusal.reason.includes('already been credited'),
    !twice.ok ? twice.refusal.reason : '')

  // ── GUARD 4: an allocated payment blocks it
  const payTarget = await sellOnAccount(product, `EDT${stamp}`, cust.id, 2, 115, rate, account.id)
  const payTxn = (await listLedger(SITE, cust.id)).find((l) => l.sourceDocId === payTarget)!
  const payment = await postTransaction(SITE, actor, {
    customerId: cust.id, docType: 'payment', amount: 100, docNumber: `PAY${stamp}`,
  })
  ok('a payment posts', payment.ok)
  if (payment.ok) {
    const alloc = await allocate(SITE, actor, payTxn.id, payment.id, 100)
    ok('  and allocates against the invoice', alloc.ok, alloc.ok ? '' : alloc.error)

    const blocked = await canEditFinalised(SITE, OWNER, payTarget)
    ok('*** an invoice with an allocated payment CANNOT be corrected ***', !blocked.ok)
    ok('  naming the amount', !blocked.ok && blocked.refusal.reason.includes('100.00'),
      !blocked.ok ? blocked.refusal.reason : '')
    ok('  and suggesting what to do instead',
      !blocked.ok && blocked.refusal.suggestion.length > 0,
      !blocked.ok ? blocked.refusal.suggestion : '')
  }

  // ── GUARD 5: a locked VAT period blocks it
  const lockTarget = await sellOnAccount(product, `EDT${stamp}`, cust.id, 1, 115, rate, account.id)
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  await setSetting(SITE, 'vat_period_locked_to', today)
  const locked = await canEditFinalised(SITE, OWNER, lockTarget)
  ok('*** a LOCKED VAT period refuses the correction ***', !locked.ok)
  // guardPosting's unified wording says "that period is closed"; the older
  // helper said "locked". Either way the reason must name the closure.
  ok('  naming the lock',
    !locked.ok && /locked|closed/.test(locked.refusal.reason),
    !locked.ok ? locked.refusal.reason : '')
  await setSetting(SITE, 'vat_period_locked_to', '')
  ok('  and unlocking allows it again', (await canEditFinalised(SITE, OWNER, lockTarget)).ok)

  // ── "Edit details" — the safe subset
  const details = await editDocumentDetails(SITE, actor, lockTarget, {
    reference: 'Their PO 8891', notes: 'Delivered to reception', customerPhone: '021 555 0000',
  })
  ok('*** details can be edited in place — no reversal ***', details.ok, details.ok ? '' : details.error)

  const afterDetails = await getDocument(SITE, lockTarget)
  ok('  the reference changed', afterDetails?.reference === 'Their PO 8891')
  ok('*** but the TOTAL did not ***', afterDetails?.totalIncl === 115, String(afterDetails?.totalIncl))
  ok('*** and the number did not ***', afterDetails?.documentNumber !== null)
  ok('*** and nothing was reversed ***',
    (await getDocument(SITE, lockTarget))?.status === 'finalised')
  ok('  balance unchanged by a details edit', (await reconcileBalances(SITE)).length === 0)

  // ── Final invariants
  ok('*** reconcileStock clean at the end ***', (await reconcileStock(SITE)).length === driftBefore,
    `${(await reconcileStock(SITE)).length} drift rows`)
  ok('*** reconcileBalances clean at the end ***', (await reconcileBalances(SITE)).length === 0)

  // ── Cleanup
  await siteExecute(SITE, 'DELETE FROM customer_allocations WHERE debit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?) OR credit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)', [cust.id, cust.id])
  await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id IN (SELECT id FROM sales_documents WHERE customer_id = ?)', [cust.id])
  await siteExecute(SITE, 'DELETE FROM document_audit WHERE document_id IN (SELECT id FROM sales_documents WHERE customer_id = ?)', [cust.id])
  await siteExecute(SITE, 'UPDATE sales_documents SET reverses_id = NULL WHERE customer_id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE customer_id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [cust.id])
  await sweepStrays()

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await setSetting(SITE, 'vat_period_locked_to', '').catch(() => {})
  await sweepStrays()
  console.log('\nCRASHED — strays swept')
  process.exit(1)
})
