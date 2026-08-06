/**
 * The back-office invoice screen, finalised with real tenders.
 *
 * The screen used to post every invoice to the account and nothing else. Now it
 * takes payment the way the till does, so what matters is that the SAME engine
 * runs: tenders land in sales_tenders as handed over, stock moves once, the
 * debtor ledger only moves for the part that went on account, and a mixed
 * payment settles exactly.
 *
 *   npm run test:invoicing
 */
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'
import { saveDraft, getDocument, createBlankInvoice } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { reconcileStock, seedOpeningStock } from '../src/lib/site/stockMovements'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { reconcileBalances } from '../src/lib/site/customerLedger'
import { createCustomer, getCustomer } from '../src/lib/site/customers'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Invoicing Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function stockOf(productId: number): Promise<number> {
  const row = await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id = ?', [productId])
  return toNum(row?.stock_on_hand)
}

/** What actually landed in sales_tenders for a document. */
async function tendersOf(documentId: number) {
  return siteQuery<any>(
    SITE,
    'SELECT tender_code, amount, change_given, reference FROM sales_tenders WHERE document_id = ? ORDER BY id',
    [documentId],
  )
}

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const vatRate = toNum(vat?.rate, 15)

  const res = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id)
     VALUES (?,?,?,?,?,?,?)`,
    [`INV${stamp}`, `Invoicing test ${stamp}`, 'normal', '200.000', '10.0000', '10.0000', vat?.id ?? null],
  )
  const productId = res.insertId

  await seedOpeningStock(SITE, actor)
  ok('opening stock seeded (reconcile clean to start)', (await reconcileStock(SITE)).length === 0)

  const cash = await getTenderByCode(SITE, 'CASH')
  const card = await getTenderByCode(SITE, 'CARD')
  const account = await getTenderByCode(SITE, 'ACCOUNT')
  if (!cash || !card || !account) { console.log('missing seeded tenders'); process.exit(1) }

  const line = (qty: number, price: number) => ({
    productId,
    productCode: `INV${stamp}`,
    description: 'Invoicing test line',
    productType: 'normal' as const,
    qty,
    unitPriceIncl: price,
    vatRatePct: vatRate,
    unitCostExcl: 10,
  })

  /* ── A blank invoice is what the New button creates. ───────────────────── */

  const blank = await createBlankInvoice(SITE, actor)
  ok('blank invoice created', blank.ok, blank.ok ? '' : blank.error)
  if (!blank.ok) process.exit(1)

  const blankDoc = (await getDocument(SITE, blank.id))!
  ok('  it is editable, unnumbered and empty', blankDoc.documentNumber === null && blankDoc.lines.length === 0)

  /* ── CASH on an invoice: the case the screen could not do before. ───────── */

  const cashBefore = await stockOf(productId)
  const cashDraft = await saveDraft(SITE, actor, {
    docType: 'invoice', customerName: 'Counter payer', lines: [line(2, 57.5)],
  }, blank.id)
  ok('draft saved onto the blank invoice', cashDraft.ok, cashDraft.ok ? '' : cashDraft.error)
  if (!cashDraft.ok) process.exit(1)

  const cashDoc = (await getDocument(SITE, cashDraft.id))!
  const cashFin = await finaliseDocument(SITE, actor, {
    documentId: cashDraft.id,
    tenders: [{ tenderTypeId: cash.id, amount: 200 }],
  })
  ok('*** invoice finalised with CASH, no account needed ***', cashFin.ok, cashFin.ok ? cashFin.documentNumber : cashFin.error)
  if (!cashFin.ok) process.exit(1)

  const cashPosted = (await getDocument(SITE, cashDraft.id))!
  ok('  status finalised and numbered', cashPosted.status === 'finalised' && !!cashPosted.documentNumber, cashPosted.documentNumber ?? '')
  ok('  no customer attached — a cash invoice needs none', cashPosted.customerId === null)
  ok('  tendered records the GROSS 200', cashPosted.tenderedTotal === 200, String(cashPosted.tenderedTotal))
  ok('  change is 200 - payable', Math.abs(cashFin.change - (200 - (cashPosted.totalIncl + cashPosted.roundingAdj))) < 0.005,
    `change=${cashFin.change} total=${cashPosted.totalIncl} adj=${cashPosted.roundingAdj}`)
  ok('  stock moved by 2', (await stockOf(productId)) === cashBefore - 2, `${cashBefore} -> ${await stockOf(productId)}`)

  const cashRows = await tendersOf(cashDraft.id)
  ok('  one CASH tender row written', cashRows.length === 1 && cashRows[0].tender_code === 'CASH', JSON.stringify(cashRows))
  ok('  the row carries the change given', toNum(cashRows[0]?.change_given) === cashFin.change, String(cashRows[0]?.change_given))

  /* ── CARD, which takes a reference and gives no change. ─────────────────── */

  const cardDraft = await saveDraft(SITE, actor, {
    docType: 'invoice', customerName: 'Card payer', lines: [line(1, 100)],
  })
  if (cardDraft.ok) {
    const doc = (await getDocument(SITE, cardDraft.id))!
    const fin = await finaliseDocument(SITE, actor, {
      documentId: cardDraft.id,
      tenders: [{ tenderTypeId: card.id, amount: doc.totalIncl, reference: 'AUTH-7781' }],
    })
    ok('*** invoice finalised with CARD ***', fin.ok, fin.ok ? fin.documentNumber : fin.error)
    if (fin.ok) {
      ok('  no change on a card tender', fin.change === 0, String(fin.change))
      const rows = await tendersOf(cardDraft.id)
      ok('  the card reference is stored', rows[0]?.reference === 'AUTH-7781', String(rows[0]?.reference))
    }
  }

  /* ── ACCOUNT, which is the only tender that touches the ledger. ─────────── */

  const cust = await createCustomer(SITE, actor, {
    code: `INVC${stamp}`, name: 'Invoicing Test Co', creditLimit: 5000, paymentTermsDays: 30,
  })
  if (!cust.ok) { console.log('could not create customer'); process.exit(1) }

  const balBefore = toNum((await getCustomer(SITE, cust.id))?.balance)
  const acctDraft = await saveDraft(SITE, actor, {
    docType: 'invoice', customerId: cust.id, customerName: 'Invoicing Test Co', lines: [line(3, 115)],
  })
  if (!acctDraft.ok) { console.log('draft failed'); process.exit(1) }

  const acctDoc = (await getDocument(SITE, acctDraft.id))!
  const acctFin = await finaliseDocument(SITE, actor, {
    documentId: acctDraft.id,
    customerId: cust.id,
    tenders: [{ tenderTypeId: account.id, amount: acctDoc.totalIncl }],
  })
  ok('*** invoice finalised on ACCOUNT ***', acctFin.ok, acctFin.ok ? acctFin.documentNumber : acctFin.error)
  if (acctFin.ok) {
    const balAfter = toNum((await getCustomer(SITE, cust.id))?.balance)
    ok('  the full total went onto the balance',
      Math.abs(balAfter - (balBefore + acctDoc.totalIncl)) < 0.005,
      `${balBefore} -> ${balAfter}, total ${acctDoc.totalIncl}`)
  }

  /* ── THE SPLIT. Half cash, half on account — one invoice, two rows, and the
        ledger must move by the ACCOUNT portion only. ───────────────────────── */

  const splitBefore = toNum((await getCustomer(SITE, cust.id))?.balance)
  const stockBefore = await stockOf(productId)
  const splitDraft = await saveDraft(SITE, actor, {
    docType: 'invoice', customerId: cust.id, customerName: 'Invoicing Test Co', lines: [line(4, 100)],
  })
  if (!splitDraft.ok) { console.log('split draft failed'); process.exit(1) }

  const splitDoc = (await getDocument(SITE, splitDraft.id))!
  const onAccount = 150
  const inCash = splitDoc.totalIncl - onAccount

  const splitFin = await finaliseDocument(SITE, actor, {
    documentId: splitDraft.id,
    customerId: cust.id,
    tenders: [
      { tenderTypeId: cash.id, amount: inCash },
      { tenderTypeId: account.id, amount: onAccount },
    ],
  })
  ok('*** invoice finalised on a SPLIT tender ***', splitFin.ok, splitFin.ok ? splitFin.documentNumber : splitFin.error)

  if (splitFin.ok) {
    const rows = await tendersOf(splitDraft.id)
    ok('  two tender rows written', rows.length === 2, JSON.stringify(rows.map((r) => r.tender_code)))
    ok('  they sum to the invoice total',
      Math.abs(rows.reduce((s, r) => s + toNum(r.amount), 0) - splitDoc.totalIncl) < 0.005,
      `${rows.reduce((s, r) => s + toNum(r.amount), 0)} vs ${splitDoc.totalIncl}`)

    const balAfter = toNum((await getCustomer(SITE, cust.id))?.balance)
    ok('  *** only the ACCOUNT portion hit the ledger ***',
      Math.abs(balAfter - (splitBefore + onAccount)) < 0.005,
      `${splitBefore} -> ${balAfter}, expected +${onAccount} not +${splitDoc.totalIncl}`)

    ok('  stock moved once, by the full 4', (await stockOf(productId)) === stockBefore - 4,
      `${stockBefore} -> ${await stockOf(productId)}`)
  }

  /* ── Refusals. Each must leave nothing behind. ──────────────────────────── */

  const shortDraft = await saveDraft(SITE, actor, {
    docType: 'invoice', customerName: 'Short payer', lines: [line(1, 100)],
  })
  if (shortDraft.ok) {
    const beforeShort = await stockOf(productId)
    const short = await finaliseDocument(SITE, actor, {
      documentId: shortDraft.id, tenders: [{ tenderTypeId: cash.id, amount: 10 }],
    })
    ok('under-tendered invoice refused', !short.ok, !short.ok ? short.error : '')
    ok('  and no stock moved on the refusal', (await stockOf(productId)) === beforeShort)

    const none = await finaliseDocument(SITE, actor, { documentId: shortDraft.id, tenders: [] })
    ok('finalising with no tender at all refused', !none.ok, !none.ok ? none.error : '')

    // An account tender with nobody to bill it to.
    const orphan = await finaliseDocument(SITE, actor, {
      documentId: shortDraft.id, tenders: [{ tenderTypeId: account.id, amount: 115 }],
    })
    ok('account tender with no customer refused', !orphan.ok, !orphan.ok ? orphan.error : '')

    const stillDraft = (await getDocument(SITE, shortDraft.id))!
    ok('  the draft survives every refusal, unnumbered',
      stillDraft.status !== 'finalised' && stillDraft.documentNumber === null, stillDraft.status)
  }

  /* ── Everything still reconciles. ───────────────────────────────────────── */

  const drift = await reconcileStock(SITE)
  ok('*** stock reconciles after all of it ***', drift.length === 0, JSON.stringify(drift.slice(0, 3)))

  const ledgerDrift = await reconcileBalances(SITE)
  ok('*** debtor balances reconcile ***', ledgerDrift.length === 0, JSON.stringify(ledgerDrift.slice(0, 3)))

  console.log(fails === 0 ? '\nAll invoicing checks passed.' : `\n${fails} check(s) FAILED.`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
