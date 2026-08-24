/**
 * Which lot a sale is booked against, when the till NAMES one (234).
 *
 * THE PROPERTY THIS EXISTS TO PROVE: an observation beats an inference. FEFO
 * picks the earliest expiry because it is the only lot the server has reason to
 * prefer; a lot number scanned off the pack or typed by a clerk is a fact about
 * the goods that actually left, and must win.
 *
 * The cases a shop pays for:
 *   - a named lot draws from THAT lot, leaving the earliest-expiry one alone
 *   - a named lot that is already empty goes NEGATIVE rather than silently
 *     re-routing the sale to a lot nobody named
 *   - an unknown lot REFUSES under strict, and falls back to FEFO otherwise —
 *     recording what it was told either way
 *   - the invariants (T1/T2/T3) survive all of it
 *
 *   npm run test:lot-capture
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { createSupplier } from '../src/lib/site/suppliers'
import { receiveGoods } from '../src/lib/site/purchasePosting'
import { reconcileBatches } from '../src/lib/site/batches'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { lotCaptureFor, parseGs1, gtinCandidates } from '../src/lib/gs1'
import { addToBasket } from '../src/lib/basket'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Lot Capture Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const CODE_PATTERN = '^ZLC[0-9]{8}'
const TAG = 'ZLC test'

/**
 * Anything a previous run left behind, swept BEFORE the run as well as after.
 * A crash mid-run must not poison the next one — the 148 suite's rule.
 */
async function sweepStrays() {
  const docs = await siteQuery<any>(
    SITE,
    `SELECT id FROM sales_documents WHERE customer_name LIKE '${TAG}%'`,
  )
  for (const d of docs) {
    await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id = ?', [d.id])
    await siteExecute(SITE, 'DELETE FROM document_audit WHERE document_id = ?', [d.id])
    await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [d.id])
    await siteExecute(
      SITE,
      'DELETE jl FROM journal_lines jl JOIN journal_batches jb ON jb.id = jl.batch_id WHERE jb.source_doc_id = ?',
      [d.id],
    )
    await siteExecute(SITE, 'DELETE FROM journal_batches WHERE source_doc_id = ?', [d.id])
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [d.id])
  }

  const products = await siteQuery<any>(
    SITE,
    `SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}'`,
  )
  for (const p of products) {
    await siteExecute(
      SITE,
      'DELETE bm FROM batch_movements bm JOIN product_batches b ON b.id = bm.batch_id WHERE b.product_id = ?',
      [p.id],
    )
    await siteExecute(SITE, 'DELETE FROM product_batches WHERE product_id = ?', [p.id])
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [p.id])
    await siteExecute(SITE, 'DELETE FROM product_location_stock WHERE product_id = ?', [p.id])
    await siteExecute(SITE, 'DELETE FROM product_suppliers WHERE product_id = ?', [p.id])
    await siteExecute(SITE, 'DELETE FROM activity_log WHERE entity = ? AND entity_id = ?', [
      'product',
      p.id,
    ])
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [p.id])
  }

  /*
   * The suppliers too, and their ledger first.
   *
   * A leaked supplier carries a stale stored balance, which fails the
   * site-wide reconcile checks in OTHER suites — the failure lands somewhere
   * that has nothing to do with lots. The GRVs above wrote supplier_transactions
   * rows, and the FK will not let the parent go while they exist.
   */
  const sups = await siteQuery<any>(SITE, `SELECT id FROM suppliers WHERE name LIKE '${TAG}%'`)
  for (const s of sups) {
    await siteExecute(SITE, 'DELETE FROM supplier_transactions WHERE supplier_id = ?', [s.id])
    await siteExecute(SITE, 'DELETE FROM purchase_document_lines WHERE document_id IN (SELECT id FROM purchase_documents WHERE supplier_id = ?)', [s.id])
    await siteExecute(SITE, 'DELETE FROM purchase_documents WHERE supplier_id = ?', [s.id])
    await siteExecute(SITE, 'DELETE FROM suppliers WHERE id = ?', [s.id])
  }
}

const lotQty = async (productId: number, batchNo: string): Promise<number> =>
  toNum(
    (
      await siteQueryOne<any>(
        SITE,
        'SELECT SUM(qty_remaining) AS q FROM product_batches WHERE product_id=? AND batch_no=?',
        [productId, batchNo],
      )
    )?.q,
  )

async function main() {
  await sweepStrays()
  const stamp = Date.now().toString().slice(-8)

  /* ── The barcode, before any database work ─────────────────────────────── */

  const GS = '\x1d'
  const g1 = parseGs1(`010600123456789017260831${GS}10L2408A`)
  ok(
    '*** a GS1 barcode yields the GTIN, the expiry and the LOT ***',
    g1?.gtin === '06001234567890' && g1?.expiryDate === '2026-08-31' && g1?.batchNo === 'L2408A',
    JSON.stringify(g1),
  )
  ok(
    '  the lot is found with no separator, when it comes last',
    parseGs1('01060012345678901726083110L2408A')?.batchNo === 'L2408A',
  )
  ok(
    '  a ]C1 symbology prefix is tolerated',
    parseGs1(`]C1010600123456789017260831${GS}10L2408A`)?.batchNo === 'L2408A',
  )
  ok(
    '*** DD=00 means END of month, not the last day of the previous one ***',
    parseGs1('010600123456789017260400')?.expiryDate === '2026-04-30' &&
      parseGs1('010600123456789017240200')?.expiryDate === '2024-02-29',
    `${parseGs1('010600123456789017260400')?.expiryDate} / ${parseGs1('010600123456789017240200')?.expiryDate}`,
  )
  const withSerial = parseGs1(`0106001234567890${GS}21SN99887766`)
  ok(
    '*** a SERIAL never becomes a lot — it would mint one per item sold ***',
    withSerial?.batchNo === null && withSerial?.serial === 'SN99887766',
    JSON.stringify(withSerial),
  )
  ok(
    'a lot that swallowed the next field is FLAGGED, not silently minted',
    parseGs1('010600123456789010L2408A17260831')?.runOnRisk === true,
  )
  ok(
    '*** an ordinary EAN-13 is not an element string ***',
    parseGs1('6001234567890') === null && parseGs1('2007770001500') === null,
  )
  ok(
    'a GTIN-14 offers its EAN-13 form for matching',
    gtinCandidates('06001234567890').includes('6001234567890'),
    gtinCandidates('06001234567890').join(','),
  )
  ok(
    '  but an OUTER CASE code does not — that is a case, not a single',
    gtinCandidates('16001234567890').length === 1,
    gtinCandidates('16001234567890').join(','),
  )

  /* ── The pure resolver, before any database work ───────────────────────── */

  ok(
    'fefo is the default when nothing is set',
    lotCaptureFor({}).mode === 'fefo' && lotCaptureFor({}).strict === false,
  )
  ok(
    'an unknown mode falls back to fefo rather than throwing',
    lotCaptureFor({ lot_capture_mode: 'nonsense' }).mode === 'fefo',
  )
  ok(
    '*** strict is FORCED OFF under fefo — nothing is captured, so nothing can fail ***',
    lotCaptureFor({ lot_capture_mode: 'fefo', lot_capture_strict: '1' }).strict === false,
  )
  ok(
    'strict holds under barcode',
    lotCaptureFor({ lot_capture_mode: 'barcode', lot_capture_strict: '1' }).strict === true,
  )
  ok(
    'strict holds under prompt',
    lotCaptureFor({ lot_capture_mode: 'prompt', lot_capture_strict: '1' }).strict === true,
  )

  /* ── The basket: two lots are two facts, never a quantity of two ───────── */

  const tile: any = {
    id: 1,
    code: 'MILK',
    barcode: null,
    barcodes: [],
    description: 'Milk 1L',
    productType: 'batch',
    departmentId: null,
    priceIncl: 15,
    vatRatePct: 15,
    costExcl: 8,
    stockOnHand: 20,
    reservedQty: 0,
    availableQty: 20,
    askPriceAtSale: false,
    allowFractions: false,
    scaleItem: false,
    variableType: 'none',
    maxDiscountPct: 0,
    imageColor: null,
    posSortOrder: 0,
  }
  const plainTwice = addToBasket(addToBasket([], tile, 1), tile, 1)
  ok(
    'two plain units still MERGE — the ordinary rule is untouched',
    plainTwice.length === 1 && plainTwice[0]!.qty === 2,
    `${plainTwice.length} line(s)`,
  )

  const twoLots = addToBasket(
    addToBasket([], { ...tile, scannedBatchNo: 'LOT-A' }, 1),
    { ...tile, scannedBatchNo: 'LOT-B' },
    1,
  )
  ok(
    '*** two DIFFERENT lots stay two lines — merging would discard one number ***',
    twoLots.length === 2 && twoLots[0]!.batchNo === 'LOT-A' && twoLots[1]!.batchNo === 'LOT-B',
    twoLots.map((l) => l.batchNo ?? '-').join(','),
  )

  const lotThenPlain = addToBasket(
    addToBasket([], { ...tile, scannedBatchNo: 'LOT-A' }, 1),
    tile,
    1,
  )
  ok(
    '  a lot line never absorbs an unnamed unit',
    lotThenPlain.length === 2,
    `${lotThenPlain.length} line(s)`,
  )

  const plainThenLot = addToBasket(addToBasket([], tile, 1), {
    ...tile,
    scannedBatchNo: 'LOT-A',
  }, 1)
  ok(
    '  nor does an unnamed line absorb a lot',
    plainThenLot.length === 2,
    `${plainThenLot.length} line(s)`,
  )

  /* ── Fixtures ──────────────────────────────────────────────────────────── */

  const driftBefore = (await reconcileStock(SITE)).length
  const batchDriftBefore = (await reconcileBatches(SITE)).length

  const vat = await siteQueryOne<any>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )
  const rate = toNum(vat?.rate)

  const supplier = await createSupplier(SITE, actor, {
    code: `ZLCS${stamp}`,
    name: `${TAG} supplier ${stamp}`,
  } as never)
  if (!supplier.ok) throw new Error('supplier: ' + supplier.error)

  const code = `ZLC${stamp}`
  const res = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, selling_vat_rate_id, purchase_vat_rate_id)
     VALUES (?, ?, 'batch', ?, ?)`,
    [code, `Milk ${stamp}`, vat?.id ?? null, vat?.id ?? null],
  )
  const milk = (res as any).insertId as number

  // Two lots, deliberately in the order a shop actually receives them: the one
  // expiring SOONEST is the one FEFO would always reach for.
  const receive = async (batchNo: string, expiry: string, qty: number) => {
    const r = await receiveGoods(SITE, actor, {
      supplierId: supplier.id,
      lines: [
        {
          productId: milk,
          productCode: code,
          description: `Milk ${stamp}`,
          productType: 'batch',
          qtyReceived: qty,
          unitCostExcl: 8,
          vatRatePct: rate,
          batchNo,
          expiryDate: expiry,
        },
      ],
    } as never)
    if (!r.ok) throw new Error(`receive ${batchNo}: ${r.error}`)
    return r
  }

  const soon = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10)
  const later = new Date(Date.now() + 21 * 86400_000).toISOString().slice(0, 10)
  await receive('SOON-A', soon, 10)
  await receive('LATER-B', later, 10)

  ok(
    'two lots received',
    (await lotQty(milk, 'SOON-A')) === 10 && (await lotQty(milk, 'LATER-B')) === 10,
  )

  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) throw new Error('CASH tender missing.')

  /**
   * Sell, optionally naming the lot the customer actually carried off.
   *
   * `strict` is passed as the SHOP SETTING, written before the sale and put
   * back to the documented default afterwards — never to "what was there
   * before", which would faithfully restore a previous crash's pollution.
   */
  const sell = async (qty: number, batchNo?: string, strict = false) => {
    await siteExecute(
      SITE,
      `INSERT INTO settings (setting_key, setting_value) VALUES ('lot_capture_mode', ?), ('lot_capture_strict', ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [batchNo ? 'prompt' : 'fefo', strict ? '1' : '0'],
    )
    try {
      const draft = await saveDraft(SITE, actor, {
        docType: 'invoice',
        customerName: `${TAG} ${stamp}`,
        lines: [
          {
            productId: milk,
            productCode: code,
            description: `Milk ${stamp}`,
            productType: 'batch',
            qty,
            unitPriceIncl: 15,
            vatRatePct: rate,
            unitCostExcl: 8,
            ...(batchNo ? { batchNo } : {}),
          },
        ],
      } as never)
      if (!draft.ok) return { ok: false as const, error: draft.error }
      return await finaliseDocument(SITE, actor, {
        documentId: draft.id,
        tenders: [{ tenderTypeId: cash.id, amount: qty * 15 }],
      })
    } finally {
      await siteExecute(
        SITE,
        `INSERT INTO settings (setting_key, setting_value) VALUES ('lot_capture_mode','fefo'), ('lot_capture_strict','0')
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      )
    }
  }

  /* ── 1. The baseline: nothing named, FEFO chooses ──────────────────────── */

  const s1 = await sell(2)
  ok(
    'with no lot named, the EARLIEST expiry is drawn down',
    s1.ok && (await lotQty(milk, 'SOON-A')) === 8 && (await lotQty(milk, 'LATER-B')) === 10,
    s1.ok ? `A=${await lotQty(milk, 'SOON-A')} B=${await lotQty(milk, 'LATER-B')}` : s1.error,
  )

  /* ── 2. The whole point: a named lot beats FEFO ─────────────────────────── */

  const s2 = await sell(3, 'LATER-B')
  ok(
    '*** naming the lot draws from THAT lot, not the earliest expiry ***',
    s2.ok && (await lotQty(milk, 'LATER-B')) === 7 && (await lotQty(milk, 'SOON-A')) === 8,
    s2.ok ? `A=${await lotQty(milk, 'SOON-A')} B=${await lotQty(milk, 'LATER-B')}` : s2.error,
  )

  /*
   * Case. MariaDB's default collation is case-INSENSITIVE, so 'later-b' finds
   * the lot stored as 'LATER-B'. Asserted rather than assumed: if a site is
   * ever built with a binary collation this silently becomes a miss, and a
   * clerk typing the number in lower case would mint FEFO fallbacks all day
   * without anyone knowing why.
   */
  const bBefore = await lotQty(milk, 'LATER-B')
  const s3 = await sell(1, 'later-b')
  ok(
    '  a lower-case lot still finds the lot as stored',
    s3.ok && (await lotQty(milk, 'LATER-B')) === bBefore - 1,
    s3.ok ? `B=${bBefore} -> ${await lotQty(milk, 'LATER-B')}` : s3.error,
  )

  /* ── 3. An unknown lot ──────────────────────────────────────────────────── */

  const beforeStrict = { a: await lotQty(milk, 'SOON-A'), b: await lotQty(milk, 'LATER-B') }
  const strictSale = await sell(1, 'NO-SUCH-LOT', true)
  ok(
    '*** STRICT refuses a lot that is not on file ***',
    !strictSale.ok,
    strictSale.ok ? 'it posted anyway' : strictSale.error,
  )
  ok(
    '  and the refusal moves NO stock',
    (await lotQty(milk, 'SOON-A')) === beforeStrict.a &&
      (await lotQty(milk, 'LATER-B')) === beforeStrict.b,
    `A=${await lotQty(milk, 'SOON-A')} B=${await lotQty(milk, 'LATER-B')}`,
  )
  ok(
    '  and it names the lot the clerk gave, not a generic failure',
    !strictSale.ok && /NO-SUCH-LOT/i.test(strictSale.error ?? ''),
    strictSale.ok ? '' : strictSale.error,
  )

  const lenient = await sell(1, 'NO-SUCH-LOT', false)
  ok(
    '*** LENIENT still sells, falling back to earliest expiry ***',
    lenient.ok && (await lotQty(milk, 'SOON-A')) === beforeStrict.a - 1,
    lenient.ok ? `A=${await lotQty(milk, 'SOON-A')}` : lenient.error,
  )

  const logged = await siteQueryOne<any>(
    SITE,
    `SELECT detail FROM activity_log
      WHERE entity='product' AND entity_id=? AND action='lot_not_found'
      ORDER BY id DESC LIMIT 1`,
    [milk],
  )
  ok(
    '  *** and SAYS SO — an unplaceable lot number is evidence, not silence ***',
    !!logged && /NO-SUCH-LOT/i.test(String(logged.detail)),
    logged ? String(logged.detail) : 'no activity_log row',
  )

  /* ── 4. A named lot that is empty goes negative ─────────────────────────── */

  const drain = await sell(await lotQty(milk, 'LATER-B'), 'LATER-B')
  ok('the named lot can be drained to zero', drain.ok && (await lotQty(milk, 'LATER-B')) === 0)

  const overdraw = await sell(1, 'LATER-B')
  ok(
    '*** an EMPTY named lot goes negative rather than silently re-routing ***',
    overdraw.ok && (await lotQty(milk, 'LATER-B')) === -1,
    overdraw.ok ? `B=${await lotQty(milk, 'LATER-B')}` : overdraw.error,
  )

  /* ── 5. The invariants survive all of it ───────────────────────────────── */

  const driftAfter = (await reconcileStock(SITE)).length
  const batchDriftAfter = (await reconcileBatches(SITE)).length
  ok('stock invariants hold', driftAfter === driftBefore, `${driftBefore} -> ${driftAfter}`)
  ok(
    '*** T1/T2/T3 hold — lot sums still equal the piles ***',
    batchDriftAfter === batchDriftBefore,
    `${batchDriftBefore} -> ${batchDriftAfter}`,
  )

  /* ── Cleanup ───────────────────────────────────────────────────────────── */

  await sweepStrays()
  const left = await siteQuery<any>(
    SITE,
    `SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}'`,
  )
  ok('the run leaves nothing behind', left.length === 0, `${left.length} product(s) left`)

  const settings = await siteQuery<any>(
    SITE,
    "SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'lot_capture%'",
  )
  ok(
    'and puts the settings back to their DEFAULTS',
    settings.every((r: any) =>
      r.setting_key === 'lot_capture_mode' ? r.setting_value === 'fefo' : r.setting_value === '0',
    ),
    settings.map((r: any) => `${r.setting_key}=${r.setting_value}`).join(' '),
  )

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
