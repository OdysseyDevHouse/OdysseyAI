/**
 * A discount on the whole sale — spread onto the lines, guarded, and posted.
 *
 * The rules that matter:
 *
 *   THE SHARES SUM EXACTLY. documentMath rule 3: pro-rata by value, remainder
 *   to the largest line, so a R100 discount is R100 — not R99.99 depending on
 *   line order.
 *
 *   THE CAP CANNOT BE DODGED IN RANDS. checkPricing judges an absolute
 *   discount as the percentage it amounts to. Before this, a payload carrying
 *   discountIncl bypassed max_discount_pct entirely.
 *
 *   VAT STAYS EXACT. Each line re-splits its own reduced inclusive total, so
 *   excl + VAT = incl holds identically and the GL mirror balances.
 */

import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { docDiscountShares, totalsFor, salePayloadLines, specialsFor } from '../src/app/(pos)/pos/saleSelectors'
import { checkPricing } from '../src/lib/site/priceGuard'
import { saveDraft, getDocument } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { round, toNum } from '../src/lib/decimals'
import type { BasketLine } from '../src/lib/basket'
import type { CapabilitySet } from '../src/lib/site/permissions'

const SITE = 1
const actor = { userId: 1, userName: 'DocDiscount Test' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** A minimal basket line for the pure half. */
function bl(partial: Partial<BasketLine> & { key: string; qty: number; unitPriceIncl: number }): BasketLine {
  return {
    productId: null,
    productCode: null,
    description: partial.key,
    productType: 'normal',
    departmentId: null,
    discountPct: 0,
    vatRatePct: 15,
    unitCostExcl: 0,
    maxDiscountPct: 100,
    shelfPriceIncl: null,
    allowFractions: true,
    note: '',
    ...partial,
  } as BasketLine
}

async function main() {
  console.log('\n── The shares sum exactly ──────────────────────────────────\n')

  const lines = [
    bl({ key: 'a', qty: 1, unitPriceIncl: 33.33 }),
    bl({ key: 'b', qty: 1, unitPriceIncl: 33.33 }),
    bl({ key: 'c', qty: 1, unitPriceIncl: 33.34 }),
  ]
  const noSpecials = specialsFor(lines, [], new Date())

  const shares = docDiscountShares(lines, noSpecials, { kind: 'amount', value: 10 })
  const sum = round(shares.reduce((s, v) => s + v, 0), 2)
  ok('*** R10 spreads to exactly R10 ***', sum === 10, JSON.stringify(shares))
  ok('the remainder lands on the largest line', shares[2] >= shares[0])

  const pct = docDiscountShares(lines, noSpecials, { kind: 'percent', value: 10 })
  ok('10% of R100 is R10', round(pct.reduce((s, v) => s + v, 0), 2) === 10, JSON.stringify(pct))

  const clamped = docDiscountShares(lines, noSpecials, { kind: 'amount', value: 500 })
  ok('*** a discount larger than the basket clamps to the basket ***',
      round(clamped.reduce((s, v) => s + v, 0), 2) === 100, JSON.stringify(clamped))

  const masked = docDiscountShares(lines, noSpecials, { kind: 'amount', value: 9 },
      new Set(['a', 'b']))
  ok('*** an eligibility mask keeps ineligible lines at zero ***', masked[2] === 0)
  ok('…and still spreads the full amount over the rest',
      round(masked[0] + masked[1], 2) === 9, JSON.stringify(masked))

  ok('no discount is all zeros', docDiscountShares(lines, noSpecials, null).every((s) => s === 0))
  ok('an empty basket is an empty array', docDiscountShares([], [], { kind: 'percent', value: 10 }).length === 0)

  console.log('\n── VAT stays exact through the spread ──────────────────────\n')

  const totals = totalsFor(lines, noSpecials, shares)
  ok('*** excl + VAT = incl, to the cent ***',
      round(totals.doc.subtotalExcl + totals.doc.vatTotal, 2) === totals.doc.totalIncl,
      `${totals.doc.subtotalExcl} + ${totals.doc.vatTotal} vs ${totals.doc.totalIncl}`)
  ok('the discount total is the shares', totals.doc.discountTotal === 10, String(totals.doc.discountTotal))
  ok('the total dropped by exactly the discount',
      totals.doc.totalIncl === round(totalsFor(lines, noSpecials).doc.totalIncl - 10, 2))

  const payload = salePayloadLines(lines, noSpecials, shares)
  ok('*** payload lines carry the absolute discount ***',
      payload.every((l, i) => (shares[i] > 0 ? l.discountIncl === shares[i] : l.discountIncl === undefined)),
      JSON.stringify(payload.map((l) => l.discountIncl)))

  /* A line discount PLUS a share fold into one figure. */
  const mixed = [bl({ key: 'm', qty: 2, unitPriceIncl: 50, discountPct: 10 })]
  const mixedSpecials = specialsFor(mixed, [], new Date())
  const mixedShares = docDiscountShares(mixed, mixedSpecials, { kind: 'amount', value: 5 })
  const mixedPayload = salePayloadLines(mixed, mixedSpecials, mixedShares)
  // gross 100, own discount 10, share 5 → discountIncl 15
  ok('*** a line discount and a doc share fold into one figure ***',
      mixedPayload[0].discountIncl === 15, String(mixedPayload[0].discountIncl))

  console.log('\n── The cap cannot be dodged in rands ───────────────────────\n')

  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const rate = toNum(vat?.rate, 15)

  const p = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, max_discount_pct, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'service',0,4,4,10,?,1)`,
    [`DDG${stamp}`, `Doc discount item ${stamp}`, vat?.id ?? null])
  const productId = p.insertId

  const cashier: CapabilitySet = { isOwner: false, granted: new Set(['sales.till']) }
  const supervisor: CapabilitySet = {
    isOwner: false,
    granted: new Set(['sales.till', 'sales.discount_override', 'sales.price_override']),
  }

  // 25% expressed in rands on a 10%-cap product.
  const dodge = await checkPricing(SITE, cashier, null, [
    { productId, description: 'x', qty: 2, unitPriceIncl: 100, discountIncl: 50 },
  ])
  ok('*** a rand discount over the cap is refused ***', dodge !== null, dodge ?? '')

  const withinCap = await checkPricing(SITE, cashier, null, [
    { productId, description: 'x', qty: 2, unitPriceIncl: 100, discountIncl: 20 },
  ])
  ok('a rand discount inside the cap passes', withinCap === null, withinCap ?? '')

  const supervised = await checkPricing(SITE, supervisor, null, [
    { productId, description: 'x', qty: 2, unitPriceIncl: 100, discountIncl: 50 },
  ])
  ok('the supervisor right lifts it', supervised === null, supervised ?? '')

  console.log('\n── It posts, and the books balance ─────────────────────────\n')

  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) { console.log('no CASH tender'); process.exit(1) }

  // Its own terminal + sequence, so the site-wide run is never consumed.
  const term = await siteExecute(SITE,
    'INSERT INTO terminals (code, name, till_number) VALUES (?,?,?)',
    [`DD${stamp}`.slice(0, 24), 'Doc discount till', 97])
  const terminalId = term.insertId
  await siteExecute(SITE,
    `INSERT INTO document_sequences (terminal_id, doc_type, prefix, next_number, padding)
     VALUES (?, 'invoice', 'INV', 1, 6) ON DUPLICATE KEY UPDATE doc_type = doc_type`,
    [terminalId])

  // Two lines, R100 doc discount spread 60/40 by value (600/400 gross).
  const draft = await saveDraft(SITE, actor, {
    docType: 'invoice',
    customerName: 'Walk-in',
    terminalId,
    terminalCode: `DD${stamp}`.slice(0, 24),
    lines: [
      { productId, description: 'Doc A', productType: 'service', qty: 6, unitPriceIncl: 100, discountIncl: 60, vatRatePct: rate, unitCostExcl: 4 },
      { productId, description: 'Doc B', productType: 'service', qty: 4, unitPriceIncl: 100, discountIncl: 40, vatRatePct: rate, unitCostExcl: 4 },
    ],
  })
  if (!draft.ok) { console.log(`draft failed: ${draft.error}`); process.exit(1) }

  const sale = await finaliseDocument(SITE, actor, {
    documentId: draft.id,
    tenders: [{ tenderTypeId: cash.id, amount: 900 }],
  })
  ok('*** the discounted sale posts ***', sale.ok, sale.ok ? sale.documentNumber : sale.error)
  if (!sale.ok) process.exit(1)

  const doc = await getDocument(SITE, draft.id)
  ok('the header carries the whole discount', doc?.discountTotal === 100, String(doc?.discountTotal))
  ok('the total is net of it', doc?.totalIncl === 900, String(doc?.totalIncl))
  ok('*** the document balances (excl + VAT = incl) ***',
      round((doc?.subtotalExcl ?? 0) + (doc?.vatTotal ?? 0), 2) === doc?.totalIncl)

  const batch = await siteQueryOne<any>(SITE,
    `SELECT b.id, COALESCE(SUM(l.amount),0) AS diff FROM journal_batches b
       JOIN journal_lines l ON l.batch_id = b.id
      WHERE b.source = 'sale' AND b.source_doc_id = ? GROUP BY b.id`, [draft.id])
  ok('*** the GL mirror posted and balances to zero ***',
      batch !== null && Math.abs(toNum(batch.diff)) < 0.005, JSON.stringify(batch))

  ok('reconcileStock zero drift', (await reconcileStock(SITE)).length === 0)

  console.log('\n── Cleanup ────────────────────────────────────────────────\n')

  const docs = await siteQuery<any>(SITE, 'SELECT id FROM sales_documents WHERE terminal_id = ?', [terminalId])
  for (const d of docs) {
    const batches = await siteQuery<any>(SITE,
      `SELECT id FROM journal_batches WHERE source = 'sale' AND source_doc_id = ?`, [d.id])
    for (const b of batches) {
      await siteExecute(SITE, 'DELETE FROM journal_lines WHERE batch_id = ?', [b.id])
      await siteExecute(SITE, 'DELETE FROM journal_batches WHERE id = ?', [b.id])
    }
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE source_doc_id = ?', [d.id])
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [d.id])
  }
  // Recompute touched balances from surviving posted lines — the cashup pattern.
  await siteExecute(SITE,
    `UPDATE gl_accounts a SET a.balance = COALESCE((
        SELECT SUM(l.amount) FROM journal_lines l
          JOIN journal_batches b ON b.id = l.batch_id
         WHERE l.account_id = a.id AND b.status = 'posted'), 0)`)
  await siteExecute(SITE, 'DELETE FROM document_sequences WHERE terminal_id = ?', [terminalId])
  await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [terminalId])
  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])

  const left = await siteQuery(SITE, 'SELECT id FROM products WHERE code LIKE ?', [`DDG${stamp}%`])
  ok('test data cleaned up', left.length === 0)

  console.log(fails === 0 ? '\nAll doc-discount rules hold.\n' : `\n${fails} FAILURE(S)\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
