/**
 * Voiding a till sale — the reversal the POS offers from its receipt.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-pos-void.ts
 *
 * The POS's Void button posts through `voidDocument`, the same engine the back
 * office uses. What is checked here is what a cashier will actually meet: that a
 * same-day per-till sale voids, that stock comes BACK, that the number is kept as
 * cancelled rather than deleted, and that the refusals the till relies on to shape
 * its UI really do refuse.
 *
 * Calls reconcileStock, so the runner schedules it solo — it asserts a site-wide
 * invariant that another test's in-flight sale would move underneath it.
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument, voidDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { reconcileStock, seedOpeningStock } from '../src/lib/site/stockMovements'
import { toNum } from '../src/lib/decimals'
import { findSalesReasonByCode } from '../src/lib/site/salesReasons'

const SITE = 1

/*
 * The seeded reason codes, resolved once.
 *
 * Every void and credit note now names a row rather than carrying free text, so
 * these tests need real ids. Read from the site rather than hardcoded: the ids
 * are AUTO_INCREMENT and differ per site, and 102 seeds the codes by name.
 */
let VOID_REASON_ID = 0

async function loadReasonIds() {
  const v = await findSalesReasonByCode(SITE, 'void', 'WRONG-ITEM')
  if (!v) throw new Error('Seeded void reason WRONG-ITEM is missing — run site-migrate for 102.')
  VOID_REASON_ID = v.id
}

const actor = { userId: 1, userName: 'POS void test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const stockOf = async (id: number) =>
  toNum((await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id = ?', [id]))?.stock_on_hand)

async function main() {
  await loadReasonIds()
  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )
  const vatRate = toNum(vat?.rate, 15)

  const product = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id)
     VALUES (?,?,'normal','40.000','6.0000','6.0000',?)`,
    [`VD${stamp}`, `Void test ${stamp}`, vat?.id ?? null],
  )
  const productId = product.insertId
  await seedOpeningStock(SITE, actor)

  const till = await siteQueryOne<any>(
    SITE,
    'SELECT id, code FROM terminals WHERE till_number IS NOT NULL ORDER BY id LIMIT 1',
  )
  const cash = await getTenderByCode(SITE, 'CASH')

  /** A finished till sale of `qty`, returning what the engine issued. */
  async function sell(qty: number) {
    const draft = await saveDraft(SITE, actor, {
      docType: 'invoice',
      terminalId: till?.id ?? null,
      terminalCode: till?.code ?? null,
      customerName: 'Walk-in',
      lines: [
        {
          productId,
          description: 'Void test line',
          qty,
          unitPriceIncl: 10,
          discountPct: 0,
          vatRatePct: vatRate,
        },
      ],
    } as never)
    if (!draft.ok) throw new Error(`draft failed: ${draft.error}`)
    const posted = await finaliseDocument(SITE, actor, {
      documentId: draft.id,
      tenders: [{ tenderTypeId: cash!.id, amount: 10 * qty }],
    })
    if (!posted.ok) throw new Error(`finalise failed: ${posted.error}`)
    return { id: draft.id, number: posted.documentNumber }
  }

  /* ── 1. A same-day sale voids, and the stock comes back ───────────────── */

  const before = await stockOf(productId)
  const sale = await sell(3)
  const afterSale = await stockOf(productId)
  ok('selling 3 takes 3 off the shelf', afterSale === before - 3, `${before} -> ${afterSale}`)

  // The number the till shows on its receipt, which is what Void acts on.
  ok('the till sale carries a per-till number', sale.number.includes('_'), sale.number)

  const voided = await voidDocument(SITE, actor, sale.id, { reasonId: VOID_REASON_ID, note: 'wrong item scanned' })
  ok('a same-day sale voids', voided.ok, voided.ok ? '' : voided.error)

  const afterVoid = await stockOf(productId)
  ok('the stock comes BACK', afterVoid === before, `${afterSale} -> ${afterVoid} (was ${before})`)

  /* ── 2. The number is KEPT, as cancelled ─────────────────────────────────
     This is the whole reason a void is not a delete: the invoice stays on the
     books so the gap in the numbering is explainable. verifySequence counts on
     it — a deleted row would read as a missing invoice forever. */

  const row = await siteQueryOne<any>(
    SITE,
    'SELECT status, document_number, cancel_reason FROM sales_documents WHERE id = ?',
    [sale.id],
  )
  ok('the voided sale still exists', row !== null)
  ok('its status is cancelled', row?.status === 'cancelled', String(row?.status))
  ok('it KEEPS its number', row?.document_number === sale.number, String(row?.document_number))
  ok(
    'the reason is recorded against it',
    String(row?.cancel_reason ?? '').includes('wrong item'),
    String(row?.cancel_reason),
  )

  /* ── 3. The refusals the till's UI depends on ────────────────────────── */

  const twice = await voidDocument(SITE, actor, sale.id, { reasonId: VOID_REASON_ID, note: 'again' })
  ok('voiding twice is refused', !twice.ok, twice.ok ? 'accepted!' : twice.error)

  const noReason = await sell(1)
  const blank = await voidDocument(SITE, actor, noReason.id, { reasonId: 0, note: null })
  ok('a missing reason is refused', !blank.ok, blank.ok ? 'accepted!' : blank.error)
  // An id that names no live void reason is refused too — the client sent it, so
  // it is not trusted. The dialog disables its button until one is picked; the
  // engine is the boundary and this is what it actually enforces.
  const unknown = await voidDocument(SITE, actor, noReason.id, { reasonId: 999999, note: null })
  ok('an unknown reason id is refused', !unknown.ok, unknown.ok ? 'accepted!' : unknown.error)
  await voidDocument(SITE, actor, noReason.id, { reasonId: VOID_REASON_ID, note: 'tidy up' })

  /* A sale dated YESTERDAY must refuse — this is why the till only offers Void
     from the receipt, on the sale just taken, and sends anything older to a
     credit note. If this ever starts passing, that UI decision is wrong. */
  const older = await sell(1)
  await siteExecute(
    SITE,
    'UPDATE sales_documents SET document_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY) WHERE id = ?',
    [older.id],
  )
  const stale = await voidDocument(SITE, actor, older.id, { reasonId: VOID_REASON_ID, note: 'yesterday' })
  ok('a PRIOR-DAY sale is refused, and says so', !stale.ok, stale.ok ? 'accepted!' : stale.error)
  ok(
    'the refusal points at a credit note',
    !stale.ok && /credit note/i.test(stale.error),
    stale.ok ? '' : stale.error,
  )
  // Put it back so the cleanup below can void it and return its stock.
  await siteExecute(SITE, 'UPDATE sales_documents SET document_date = CURDATE() WHERE id = ?', [
    older.id,
  ])
  await voidDocument(SITE, actor, older.id, { reasonId: VOID_REASON_ID, note: 'test cleanup' })

  const settled = await stockOf(productId)
  ok('every test sale is reversed, so stock is back where it started', settled === before,
    `${settled} vs ${before}`)

  /* ── Cleanup ─────────────────────────────────────────────────────────────
     The documents STAY — they are finalised-then-cancelled invoices that keep
     their numbers, and deleting them would leave verifySequence reporting real
     missing invoices. Only the scratch product goes, and it can only go once
     nothing references it. */
  const refs = await siteQueryOne<any>(
    SITE,
    'SELECT COUNT(*) n FROM sales_document_lines WHERE product_id = ?',
    [productId],
  )
  if (toNum(refs?.n) === 0) {
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId])
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])
    console.log('      (scratch product removed)')
  } else {
    // Referenced by cancelled invoices that must survive. Archived instead, so it
    // stops appearing at the till without breaking the documents that name it.
    await siteExecute(SITE, 'UPDATE products SET visible_in_pos = 0 WHERE id = ?', [productId])
      .catch(() => {})
    console.log(`      (scratch product kept — ${refs?.n} line(s) reference it — and hidden)`)
  }

  const drift = await reconcileStock(SITE)
  ok('*** reconcileStock returns ZERO drift ***', drift.length === 0, JSON.stringify(drift))

  console.log(fails === 0 ? '\nAll void checks passed.' : `\n${fails} check(s) failed.`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
