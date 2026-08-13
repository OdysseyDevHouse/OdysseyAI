/**
 * Discount codes spent at the till.
 *
 * The rules that matter:
 *
 *   ONE AUTHORITY. validateCode prices the reduction, at the till exactly as
 *   at the storefront — the till adds rulings (no delivery fee to waive,
 *   identity-bound codes need a customer) but never re-prices.
 *
 *   THE SPEND IS TRANSACTIONAL. The code is redeemed inside the sale's own
 *   transaction, against a FOR UPDATE lock — the last use of a single-use
 *   code cannot be given to two tills, and a refused spend rolls the WHOLE
 *   sale back: no document, no number consumed, no stock moved.
 *
 *   THE LEDGER POINTS AT THE SALE. discount_code_uses.document_id is the
 *   till's kind of evidence, and deleting the sale takes the use with it.
 */

import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { validateCode } from '../src/lib/site/discountCodes'
import { saveDraft, getDocument } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { round, toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'TillCode Test' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const rate = toNum(vat?.rate, 15)
  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) { console.log('no CASH tender'); process.exit(1) }

  const codeIds: number[] = []
  async function seedCode(fields: Record<string, unknown>): Promise<number> {
    const cols = Object.keys(fields)
    const res = await siteExecute(SITE,
      `INSERT INTO discount_codes (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      Object.values(fields) as never[])
    codeIds.push(res.insertId)
    return res.insertId
  }

  const tenOff = await seedCode({ code: `TC10${stamp}`, kind: 'percent', value: 10, is_active: 1 })
  await seedCode({ code: `TCBIG${stamp}`, kind: 'amount', value: 50, min_order_incl: 500, is_active: 1 })
  const oneUse = await seedCode({ code: `TCONE${stamp}`, kind: 'amount', value: 20, max_uses: 1, is_active: 1 })
  void tenOff

  const prod = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'service',0,4,4,?,1)`,
    [`TCP${stamp}`, `Till code item ${stamp}`, vat?.id ?? null])
  const productId = prod.insertId

  console.log('\n── validateCode is the one authority ───────────────────────\n')

  const basket = {
    lines: [{ productId, qty: 2, unitPriceIncl: 100, onSpecial: false, departmentId: null }],
  }
  const priced = await validateCode(SITE, `TC10${stamp}`, basket)
  ok('*** 10% of R200 prices at R20 ***', priced.ok && priced.application.discountIncl === 20,
      priced.ok ? String(priced.application.discountIncl) : priced.error)

  const short = await validateCode(SITE, `TCBIG${stamp}`, basket)
  ok('*** a min-basket code refuses a small basket ***', !short.ok, short.ok ? '' : short.error)

  const nonsense = await validateCode(SITE, `NOPE${stamp}`, basket)
  ok('an unknown code is not recognised', !nonsense.ok)

  console.log('\n── The spend is transactional, and points at the sale ──────\n')

  const term = await siteExecute(SITE,
    'INSERT INTO terminals (code, name, till_number) VALUES (?,?,?)',
    [`TC${stamp}`.slice(0, 24), 'Till code till', 95])
  const terminalId = term.insertId
  await siteExecute(SITE,
    `INSERT INTO document_sequences (terminal_id, doc_type, prefix, next_number, padding)
     VALUES (?, 'invoice', 'INV', 1, 6) ON DUPLICATE KEY UPDATE doc_type = doc_type`,
    [terminalId])

  // The lines already carry the money (R20 spread onto the R200 line).
  async function codeSale() {
    const draft = await saveDraft(SITE, actor, {
      docType: 'invoice', customerName: 'Walk-in',
      terminalId, terminalCode: `TC${stamp}`.slice(0, 24),
      lines: [{ productId, description: 'Coded item', productType: 'service', qty: 2, unitPriceIncl: 100, discountIncl: 20, vatRatePct: rate, unitCostExcl: 4 }],
    })
    if (!draft.ok) throw new Error(draft.error)
    return draft.id
  }

  const saleA = await codeSale()
  const postedA = await finaliseDocument(SITE, actor, {
    documentId: saleA,
    tenders: [{ tenderTypeId: cash.id, amount: 180 }],
    discountCode: { codeId: oneUse, code: `TCONE${stamp}`, amountIncl: 20 },
  })
  ok('*** the coded sale posts ***', postedA.ok, postedA.ok ? postedA.documentNumber : postedA.error)
  if (!postedA.ok) process.exit(1)

  const use = await siteQueryOne<any>(SITE,
    'SELECT document_id, order_id, amount_incl FROM discount_code_uses WHERE code_id = ?', [oneUse])
  ok('*** the use row points at the SALES DOCUMENT ***', Number(use?.document_id) === saleA,
      JSON.stringify(use))
  ok('…with no online order', use?.order_id === null)
  ok('…recording the money given away', toNum(use?.amount_incl) === 20)

  const codeRow = await siteQueryOne<any>(SITE,
    'SELECT uses_count FROM discount_codes WHERE id = ?', [oneUse])
  ok('the counter moved', Number(codeRow?.uses_count) === 1)

  const docA = await getDocument(SITE, saleA)
  ok('*** the document remembers the code by name ***',
      (docA as any)?.id === saleA &&
      String((await siteQueryOne<any>(SITE, 'SELECT discount_code FROM sales_documents WHERE id = ?', [saleA]))?.discount_code) === `TCONE${stamp}`)
  ok('the header carries the R20 discount', docA?.discountTotal === 20, String(docA?.discountTotal))

  console.log('\n── The last use cannot be spent twice ──────────────────────\n')

  const seqBefore = toNum((await siteQueryOne<any>(SITE,
    'SELECT next_number FROM document_sequences WHERE terminal_id = ? AND doc_type = ?',
    [terminalId, 'invoice']))?.next_number)

  const saleB = await codeSale()
  const postedB = await finaliseDocument(SITE, actor, {
    documentId: saleB,
    tenders: [{ tenderTypeId: cash.id, amount: 180 }],
    discountCode: { codeId: oneUse, code: `TCONE${stamp}`, amountIncl: 20 },
  })
  ok('*** the second spend of a single-use code is refused ***', !postedB.ok,
      postedB.ok ? '' : postedB.error)
  ok('…with the plain sentence', !postedB.ok && postedB.error.includes('fully used'))

  const docB = await getDocument(SITE, saleB)
  ok('*** the refused sale rolled back — still a draft, no number ***',
      docB?.status !== 'finalised' && docB?.documentNumber === null,
      `${docB?.status}/${docB?.documentNumber}`)
  const seqAfter = toNum((await siteQueryOne<any>(SITE,
    'SELECT next_number FROM document_sequences WHERE terminal_id = ? AND doc_type = ?',
    [terminalId, 'invoice']))?.next_number)
  ok('*** and the number was NOT consumed ***', seqAfter === seqBefore, `${seqBefore} → ${seqAfter}`)

  console.log('\n── Nothing drifts ──────────────────────────────────────────\n')

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
    // The use row CASCADEs with the document — the ledger's own rule.
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [d.id])
  }
  await siteExecute(SITE,
    `UPDATE gl_accounts a SET a.balance = COALESCE((
        SELECT SUM(l.amount) FROM journal_lines l
          JOIN journal_batches b ON b.id = l.batch_id
         WHERE l.account_id = a.id AND b.status = 'posted'), 0)`)
  await siteExecute(SITE, 'DELETE FROM document_sequences WHERE terminal_id = ?', [terminalId])
  await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [terminalId])
  for (const id of codeIds) {
    await siteExecute(SITE, 'DELETE FROM discount_codes WHERE id = ?', [id])
  }
  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])

  const leftUses = codeIds.length
    ? await siteQuery(SITE, `SELECT id FROM discount_code_uses WHERE code_id IN (${codeIds.map(() => '?').join(',')})`, codeIds)
    : []
  ok('the uses went with their documents and codes', leftUses.length === 0)
  const left = await siteQuery(SITE, 'SELECT id FROM discount_codes WHERE code LIKE ?', [`TC%${stamp}%`])
  ok('test data cleaned up', left.length === 0)

  console.log(fails === 0 ? '\nAll till-code rules hold.\n' : `\n${fails} FAILURE(S)\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
