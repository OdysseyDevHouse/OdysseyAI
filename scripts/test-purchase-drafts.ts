/**
 * Draft goods receipts — a delivery put down half-keyed.
 *
 * THE PROPERTY THAT MATTERS: a draft moves NOTHING. No stock, no cost, no
 * ledger, no number. It is a remembered set of keystrokes and nothing more.
 * That is checked after every operation below, because a draft that quietly
 * moved stock would surface weeks later as a stock-take discrepancy with
 * nothing pointing back here.
 *
 * The second hazard is double-posting: a draft finalised twice would move the
 * stock twice and credit the supplier twice, with two documents claiming to be
 * the same delivery. Guarded outside the transaction AND inside it, and both
 * are tested.
 *
 *   npm run test:purchase-drafts
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  saveDraftReceipt,
  deleteDraftReceipt,
  receiveGoods,
} from '../src/lib/site/purchasePosting'
import { getPurchaseDocument, documentCharges } from '../src/lib/site/purchaseDocuments'
import { createSupplier, getSupplier } from '../src/lib/site/suppliers'
import { reconcileStock, listMovements } from '../src/lib/site/stockMovements'
import { reconcileSupplierBalances } from '../src/lib/site/supplierLedger'
import { verifySequence } from '../src/lib/site/sequences'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Draft Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}
const product = async (id: number) =>
  (await siteQueryOne<any>(
    SITE,
    'SELECT stock_on_hand, average_cost, last_cost FROM products WHERE id=?',
    [id],
  ))!

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const vat =
    (await siteQueryOne<any>(
      SITE,
      "SELECT rate FROM vat_rates WHERE vat_type='purchase' AND is_default=1 LIMIT 1",
    )) ??
    (await siteQueryOne<any>(
      SITE,
      "SELECT rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
    ))
  const rate = toNum(vat?.rate, 15)

  const sup = await createSupplier(SITE, actor, {
    code: `DFT${stamp}`,
    name: 'Draft Test Wholesalers',
    paymentTermsDays: 30,
  })
  if (!sup.ok) {
    console.log('setup failed:', sup.error)
    process.exit(1)
  }

  const seqBefore = await verifySequence(SITE, 'grv')

  const p1 = (
    await siteExecute(
      SITE,
      `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
       VALUES (?,?,'normal',0,0,0,1)`,
      [`DP${stamp}`, `Draft test item ${stamp}`],
    )
  ).insertId

  console.log('\n── Saving a draft ──')

  const draft = await saveDraftReceipt(SITE, actor, {
    supplierId: sup.id,
    supplierInvoiceNo: `INV-${stamp}`,
    reference: 'Half a pallet checked',
    lines: [
      {
        productId: p1,
        productCode: `DP${stamp}`,
        description: 'Draft test item',
        qtyReceived: 40,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('*** a draft saves ***', draft.ok, draft.ok ? String(draft.id) : draft.error)
  if (!draft.ok) process.exit(1)

  let doc = await getPurchaseDocument(SITE, draft.id)
  ok('  it is a GRV', doc?.docType === 'grv')
  ok('  in draft status', doc?.status === 'draft', doc?.status)
  ok(
    '*** a DRAFT TAKES NO NUMBER — an abandoned one must not leave a hole ***',
    doc?.documentNumber === null,
    String(doc?.documentNumber),
  )
  ok('  no due date either, that belongs to a posted invoice', doc?.dueDate === null)
  ok('  the line is kept', doc?.lines.length === 1 && toNum(doc?.lines[0]?.qtyReceived) === 40)
  ok('  their invoice number is kept', doc?.supplierInvoiceNo === `INV-${stamp}`)

  // THE property.
  let state = await product(p1)
  ok('*** NO STOCK MOVED ***', toNum(state.stock_on_hand) === 0, String(state.stock_on_hand))
  ok('*** average cost UNTOUCHED ***', toNum(state.average_cost) === 0, String(state.average_cost))
  ok('  no movement was written', (await listMovements(SITE, p1, 5)).length === 0)

  let owed = await getSupplier(SITE, sup.id)
  ok('*** THE SUPPLIER IS OWED NOTHING ***', Math.abs(owed!.balance) < 0.001, String(owed!.balance))

  console.log('\n── Editing it ──')

  const edited = await saveDraftReceipt(
    SITE,
    actor,
    {
      supplierId: sup.id,
      supplierInvoiceNo: `INV-${stamp}`,
      chargesExcl: 0,
      lines: [
        {
          productId: p1,
          description: 'Draft test item',
          qtyReceived: 100,
          unitCostExcl: 10,
          vatRatePct: rate,
        },
        {
          productId: null,
          description: 'A second line added later',
          qtyReceived: 5,
          unitCostExcl: 20,
          vatRatePct: rate,
        },
      ],
    },
    draft.id,
  )
  ok('a draft can be edited', edited.ok, edited.ok ? '' : edited.error)
  ok('  and keeps its id', edited.ok && edited.id === draft.id)

  doc = await getPurchaseDocument(SITE, draft.id)
  ok('  lines are rewritten wholesale', doc?.lines.length === 2, String(doc?.lines.length))
  ok('  the new quantity took', toNum(doc?.lines[0]?.qtyReceived) === 100)
  ok('  still a draft, still no number', doc?.status === 'draft' && doc?.documentNumber === null)

  state = await product(p1)
  ok('*** STILL no stock ***', toNum(state.stock_on_hand) === 0, String(state.stock_on_hand))

  console.log('\n── A draft is deliberately lenient ──')

  const incomplete = await saveDraftReceipt(SITE, actor, {
    supplierId: sup.id,
    lines: [
      {
        productId: p1,
        description: 'Not counted yet',
        // Zero, which receiveGoods refuses outright. A draft must accept it:
        // the receiver saved BECAUSE they had not counted it.
        qtyReceived: 0,
        unitCostExcl: 0,
        vatRatePct: rate,
      },
    ],
  })
  ok('*** a zero quantity is ACCEPTED on a draft ***', incomplete.ok, incomplete.ok ? '' : incomplete.error)

  const emptyDraft = await saveDraftReceipt(SITE, actor, { supplierId: sup.id, lines: [] })
  ok('*** so is a draft with no lines at all ***', emptyDraft.ok, emptyDraft.ok ? '' : emptyDraft.error)

  const noSupplier = await saveDraftReceipt(SITE, actor, { supplierId: 0, lines: [] })
  ok('but a supplier IS required — the row cannot exist without one', !noSupplier.ok)

  console.log('\n── Charges and bonus survive the round trip ──')

  const rich = await saveDraftReceipt(SITE, actor, {
    supplierId: sup.id,
    charges: [{ description: 'Courier', amountExcl: 75, vatRatePct: rate }],
    lines: [
      {
        productId: p1,
        description: 'With extras',
        qtyReceived: 10,
        qtyBonus: 2,
        unitCostExcl: 50,
        discountPct: 5,
        vatRatePct: rate,
      },
    ],
  })
  ok('a draft with charges and bonus saves', rich.ok, rich.ok ? '' : rich.error)
  if (rich.ok) {
    doc = await getPurchaseDocument(SITE, rich.id)
    ok('  the bonus is remembered', toNum(doc?.lines[0]?.qtyBonus) === 2, String(doc?.lines[0]?.qtyBonus))
    ok('  the line discount too', toNum(doc?.lines[0]?.discountPct) === 5)
    const ch = await documentCharges(SITE, rich.id)
    ok('  and the charge', ch.length === 1 && ch[0].amountExcl === 75, JSON.stringify(ch))
    ok('  totals reflect the charge', toNum(doc?.chargesExcl) === 75, String(doc?.chargesExcl))
  }

  console.log('\n── Finalising it ──')

  const posted = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    draftId: draft.id,
    supplierInvoiceNo: `INV-${stamp}`,
    lines: [
      {
        productId: p1,
        description: 'Draft test item',
        qtyReceived: 100,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('*** a draft finalises ***', posted.ok, posted.ok ? posted.documentNumber : posted.error)
  if (!posted.ok) process.exit(1)

  ok(
    '*** IT KEEPS ITS ID, so anything pointing at the draft still resolves ***',
    posted.documentId === draft.id,
    `${posted.documentId} vs ${draft.id}`,
  )

  doc = await getPurchaseDocument(SITE, draft.id)
  ok('  status is finalised', doc?.status === 'finalised', doc?.status)
  ok('  NOW it has a number', (doc?.documentNumber ?? '').startsWith('GRV'), String(doc?.documentNumber))
  ok('  and a due date from their terms', doc?.dueDate !== null, String(doc?.dueDate))
  ok(
    '  the stale second line is gone, replaced by what was posted',
    doc?.lines.length === 1,
    String(doc?.lines.length),
  )

  state = await product(p1)
  ok('*** NOW the stock moved ***', toNum(state.stock_on_hand) === 100, String(state.stock_on_hand))
  ok('*** and the cost ***', toNum(state.average_cost) === 10, String(state.average_cost))

  owed = await getSupplier(SITE, sup.id)
  ok('*** and the supplier is owed ***', owed!.balance > 0, String(owed!.balance))

  console.log('\n── Double-posting is refused ──')

  const twice = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    draftId: draft.id,
    lines: [
      {
        productId: p1,
        description: 'Draft test item',
        qtyReceived: 100,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok(
    '*** FINALISING THE SAME DRAFT TWICE IS REFUSED ***',
    !twice.ok,
    twice.ok ? 'POSTED TWICE — stock and ledger both doubled' : twice.error,
  )

  state = await product(p1)
  ok(
    '  and the stock did not double',
    toNum(state.stock_on_hand) === 100,
    String(state.stock_on_hand),
  )

  ok(
    '*** a finalised receipt cannot be edited as a draft ***',
    !(await saveDraftReceipt(SITE, actor, { supplierId: sup.id, lines: [] }, draft.id)).ok,
  )
  ok(
    '*** nor discarded ***',
    !(await deleteDraftReceipt(SITE, draft.id)).ok,
  )

  console.log('\n── Discarding ──')

  const throwaway = await saveDraftReceipt(SITE, actor, {
    supplierId: sup.id,
    charges: [{ description: 'Courier', amountExcl: 50, vatRatePct: rate }],
    lines: [
      { productId: p1, description: 'Never posted', qtyReceived: 5, unitCostExcl: 1, vatRatePct: rate },
    ],
  })
  ok('a throwaway draft saves', throwaway.ok)
  if (!throwaway.ok) process.exit(1)

  const discarded = await deleteDraftReceipt(SITE, throwaway.id)
  ok('*** a draft can be discarded ***', discarded.ok, discarded.ok ? '' : (discarded as any).error)
  ok('  and is GONE, not left as a cancelled shell', (await getPurchaseDocument(SITE, throwaway.id)) === null)

  const orphanLines = await siteQuery<any>(
    SITE,
    'SELECT id FROM purchase_document_lines WHERE document_id = ?',
    [throwaway.id],
  )
  ok('  its lines cascaded away', orphanLines.length === 0, String(orphanLines.length))
  ok('  and its charges', (await documentCharges(SITE, throwaway.id)).length === 0)

  ok('discarding twice is refused', !(await deleteDraftReceipt(SITE, throwaway.id)).ok)

  console.log('\n── Invariants ──')

  const drift = (await reconcileStock(SITE)).filter((d) => d.productId === p1)
  ok('*** zero stock drift ***', drift.length === 0, JSON.stringify(drift))

  const balances = (await reconcileSupplierBalances(SITE)).filter(
    (b: any) => b.supplierId === sup.id,
  )
  ok('*** zero supplier-balance drift ***', balances.length === 0, JSON.stringify(balances))

  // The reason a draft takes no number: every GRV number issued must have a
  // document carrying it. Drafts and discards must not disturb that.
  const seqAfter = await verifySequence(SITE, 'grv')
  ok(
    '*** every GRV number this run issued has a document ***',
    seqAfter.missing === seqBefore.missing,
    `before ${seqBefore.missing}, after ${seqAfter.missing}`,
  )

  console.log(`\n${fails === 0 ? 'All good.' : `${fails} FAILED`}\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
