/**
 * Does selling a product stamp `products.last_sold_date`?
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-last-sold-date.ts
 *
 * The column has existed since 001 and nothing wrote it, so "Last sold" was
 * blank on every store and the dead-stock alert could not tell a product that
 * has never sold from one that sold this morning. `recordMovement` now stamps
 * it on a 'sale' movement.
 *
 * Three claims, because the interesting one is the third:
 *   1. a sale sets the date
 *   2. a SECOND sale moves it forward (it is "last sold", not "first sold")
 *   3. stock coming BACK does not touch it — stamping a return would make a
 *      product that has only ever been refunded look freshly sold, which is the
 *      exact line dead stock exists to catch.
 *
 * (3) goes through voidDocument, which is what actually writes a 'sale_return'.
 * A negative invoice line is refused outright, so the first version of this test
 * "passed" by comparing a date against itself after the refusal — proving
 * nothing at all.
 *
 * Fixtures are deleted on the way out: a leaked product with a UNIQUE code
 * fails an unrelated suite before its first assertion.
 */
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument, voidDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { toNum } from '../src/lib/decimals'
import { findSalesReasonByCode } from '../src/lib/site/salesReasons'

const SITE = 1
const actor = { userId: 1, userName: 'Last-sold Test' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** The raw column, as a comparable number — null when never stamped. */
async function lastSold(productId: number): Promise<Date | null> {
  const row = await siteQueryOne<any>(
    SITE,
    'SELECT last_sold_date FROM products WHERE id = ?',
    [productId],
  )
  return row?.last_sold_date ? new Date(row.last_sold_date) : null
}

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )
  const vatRate = toNum(vat?.rate, 15)

  const res = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id)
     VALUES (?,?,?,?,?,?,?)`,
    [`LSD${stamp}`, `Last-sold probe ${stamp}`, 'normal', '100.000', '8.0000', '8.0000', vat?.id ?? null],
  )
  const productId = res.insertId
  const docIds: number[] = []

  try {
    const cash = await getTenderByCode(SITE, 'CASH')
    if (!cash) {
      console.log('missing seeded CASH tender')
      process.exit(1)
    }

    ok('starts with no last-sold date', (await lastSold(productId)) === null)

    // ── 1. A sale stamps it.
    const sell = async (qty: number) => {
      const draft = await saveDraft(SITE, actor, {
        docType: 'invoice',
        customerName: 'Walk-in',
        lines: [
          {
            productId,
            productCode: `LSD${stamp}`,
            description: 'Last-sold probe',
            productType: 'normal',
            qty,
            unitPriceIncl: 20,
            vatRatePct: vatRate,
            unitCostExcl: 8,
          },
        ],
      })
      if (!draft.ok) throw new Error(`draft failed: ${draft.error}`)
      docIds.push(draft.id)
      const fin = await finaliseDocument(SITE, actor, {
        documentId: draft.id,
        tenders: [{ tenderTypeId: cash.id, amount: 500 }],
      })
      if (!fin.ok) throw new Error(`finalise failed: ${fin.error}`)
      return draft.id
    }

    await sell(2)
    const afterFirst = await lastSold(productId)
    ok('a sale stamps last_sold_date', afterFirst !== null, String(afterFirst))

    // ── 2. A later sale moves it FORWARD.
    // MySQL NOW() has second resolution, so two sales in the same second would
    // compare equal and prove nothing. Wait past the tick rather than assert a
    // difference that the clock cannot express.
    await new Promise((r) => setTimeout(r, 1100))
    const secondDocId = await sell(1)
    const afterSecond = await lastSold(productId)
    ok(
      'a second sale moves it forward',
      afterFirst !== null && afterSecond !== null && afterSecond.getTime() > afterFirst.getTime(),
      `${afterFirst?.toISOString()} -> ${afterSecond?.toISOString()}`,
    )

    /*
     * ── 3. Stock coming BACK must not move it.
     *
     * Through voidDocument, which is what actually writes a 'sale_return'
     * movement. A negative line on an invoice is refused outright ("take the
     * returned goods on a credit note"), so testing that way asserts nothing —
     * the check passed against a refusal, comparing a date to itself.
     */
    await new Promise((r) => setTimeout(r, 1100))
    const reason = await findSalesReasonByCode(SITE, 'void', 'WRONG-ITEM')
    if (!reason) throw new Error('Seeded void reason WRONG-ITEM is missing — run site-migrate.')

    const voided = await voidDocument(SITE, actor, secondDocId, { reasonId: reason.id })
    const afterReturn = await lastSold(productId)
    ok(
      'the void wrote a sale_return',
      voided.ok,
      voided.ok ? '' : `void refused: ${voided.error}`,
    )
    ok(
      'stock coming back does NOT move last_sold_date',
      voided.ok &&
        afterSecond !== null &&
        afterReturn !== null &&
        afterReturn.getTime() === afterSecond.getTime(),
      `${afterSecond?.toISOString()} -> ${afterReturn?.toISOString()}`,
    )

    // ── The movements actually written, for the record.
    const kinds = await siteQuery<any>(
      SITE,
      `SELECT movement_type, COUNT(*) AS n FROM stock_movements
        WHERE product_id = ? GROUP BY movement_type ORDER BY movement_type`,
      [productId],
    )
    console.log(
      '   movements: ' + kinds.map((k: any) => `${k.movement_type}×${k.n}`).join(', '),
    )
  } finally {
    // Documents first: their lines and movements point at the product.
    for (const id of docIds) {
      await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [id])
      await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id = ?', [id])
      await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [id])
    }
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId])
    await siteExecute(SITE, 'DELETE FROM product_location_stock WHERE product_id = ?', [productId])
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])
  }

  console.log(fails === 0 ? '\nAll checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

void main()
