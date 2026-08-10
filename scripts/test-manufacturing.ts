/**
 * Manufacturing — turning a recipe into stock you can count.
 *
 * The rule that matters: a build moves BOTH halves. Components leave the shelf
 * and finished goods arrive on it, in one transaction, so Σ qty_change still
 * equals stock_on_hand for every product on both sides. Unlike a transfer the
 * site total moves, because value is transformed rather than relocated.
 *
 * The second rule, and the one most likely to break quietly: a manufactured
 * recipe sells the FINISHED unit, while an ordinary recipe still explodes into
 * its ingredients at the till. Both models coexist and the product decides.
 *
 *   npm run test:manufacturing
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { saveRecipe } from '../src/lib/site/productComposition'
import { verifySequence } from '../src/lib/site/sequences'
import {
  postBuild, unbuild, previewBuild, validateBuild, getBuild, listBuilds,
  listManufacturableProducts, reconcileManufacturing,
} from '../src/lib/site/manufacturing'
import { toNum, round } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Manufacturing Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const stockOf = async (id: number) =>
  toNum((await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [id]))?.stock_on_hand)
const costOf = async (id: number) =>
  toNum((await siteQueryOne<any>(SITE, 'SELECT average_cost FROM products WHERE id=?', [id]))?.average_cost)
const pileOf = async (id: number, locationId: number) =>
  toNum(
    (
      await siteQueryOne<any>(
        SITE,
        'SELECT stock_on_hand FROM product_location_stock WHERE product_id=? AND location_id=?',
        [id, locationId],
      )
    )?.stock_on_hand,
  )

/** Codes this suite creates, so a crashed run can be swept on the next one. */
const CODE_PATTERN = '^(FLR|YST|SLT|LOA|BUR|PTY|BNS|NST|WST)[0-9]{8}$'

async function sweepStrays() {
  const where = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  // Orders first: their lines FK to products with RESTRICT, so the products
  // cannot go until the lines do.
  await siteExecute(
    SITE,
    `DELETE FROM manufacturing_order_costs WHERE order_id IN
       (SELECT id FROM manufacturing_orders WHERE product_id IN ${where})`,
  )
  await siteExecute(
    SITE,
    `DELETE FROM manufacturing_order_lines WHERE order_id IN
       (SELECT id FROM manufacturing_orders WHERE product_id IN ${where})
        OR product_id IN ${where}`,
  )
  await siteExecute(SITE, `DELETE FROM manufacturing_orders WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM product_recipes WHERE parent_id IN ${where} OR component_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM sales_document_lines WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
}

async function makeProduct(
  code: string,
  description: string,
  type: string,
  stock: number,
  cost: number,
  vatId: number | null,
  isManufactured = 0,
): Promise<number> {
  const r = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, is_manufactured, stock_on_hand,
                           average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,?,?,?,?,?,?,1)`,
    [code, description, type, isManufactured, stock, cost, cost, vatId],
  )
  if (stock !== 0) {
    await siteExecute(
      SITE,
      `INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after,
                                    unit_cost_excl, source, user_id, user_name)
       VALUES (?,(SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1),'opening',?,?,?,'opening',1,'Manufacturing Test')`,
      [r.insertId, stock, stock, cost],
    )
    await siteExecute(
      SITE,
      `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand)
       SELECT id, (SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1), stock_on_hand
         FROM products WHERE id=?
       ON DUPLICATE KEY UPDATE stock_on_hand=VALUES(stock_on_hand)`,
      [r.insertId],
    )
  }
  return r.insertId
}

async function main() {
  // Swept at the START as well as the end: a crashed prior run leaves products
  // whose movements are gone, which reports as drift in every later suite.
  await sweepStrays()

  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )
  const rate = toNum(vat?.rate, 15)
  const vatId = vat?.id ?? null

  const main_ = await siteQueryOne<any>(SITE, 'SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1')
  const mainLoc = Number(main_?.id)
  if (!mainLoc) {
    console.log('setup failed: no main location')
    process.exit(1)
  }

  // The sequence is BASELINED, not reset — this shares a live dev database and
  // a real doc-type row must never be deleted.
  const seqBefore = await verifySequence(SITE, 'manufacturing_order')

  // ── Fixtures ─────────────────────────────────────────────────────────────
  // A bakery: flour, yeast and salt make a loaf. 10% of the flour is lost to
  // the bench, so a loaf needing 0.5kg takes 0.55kg off the shelf.
  const flour = await makeProduct(`FLR${stamp}`, 'Bread flour kg', 'normal', 100, 10, vatId)
  const yeast = await makeProduct(`YST${stamp}`, 'Yeast g', 'normal', 500, 0.2, vatId)
  const salt = await makeProduct(`SLT${stamp}`, 'Salt g', 'normal', 500, 0.05, vatId)
  const loaf = await makeProduct(`LOA${stamp}`, 'White loaf', 'recipe', 0, 0, vatId, 1)

  // And a burger, which is the OTHER model: an ordinary recipe that explodes at
  // the till. It exists here to prove this work did not change it.
  const patty = await makeProduct(`PTY${stamp}`, 'Beef patty', 'normal', 100, 12, vatId)
  const bun = await makeProduct(`BNS${stamp}`, 'Burger bun', 'normal', 100, 3, vatId)
  const burger = await makeProduct(`BUR${stamp}`, 'Cheeseburger', 'recipe', 0, 0, vatId, 0)

  const savedLoaf = await saveRecipe(SITE, loaf, [
    { componentId: flour, qty: 0.5, wastagePct: 10 },
    { componentId: yeast, qty: 7 },
    { componentId: salt, qty: 9 },
  ])
  ok('the loaf recipe saves', savedLoaf.ok, savedLoaf.ok ? '' : savedLoaf.error)

  const savedBurger = await saveRecipe(SITE, burger, [
    { componentId: patty, qty: 1 },
    { componentId: bun, qty: 1 },
  ])
  ok('the burger recipe saves', savedBurger.ok, savedBurger.ok ? '' : savedBurger.error)

  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) {
    console.log('setup failed: no CASH tender')
    process.exit(1)
  }

  const driftBefore = (await reconcileStock(SITE)).length

  // ── Pure validation, no database ─────────────────────────────────────────
  ok('a build with no product is refused',
    validateBuild({ productId: 0, qty: 5, fromLocationId: mainLoc, toLocationId: mainLoc }) !== null)
  ok('a build of zero is refused',
    validateBuild({ productId: loaf, qty: 0, fromLocationId: mainLoc, toLocationId: mainLoc }) !== null)
  ok('a negative build is refused',
    validateBuild({ productId: loaf, qty: -5, fromLocationId: mainLoc, toLocationId: mainLoc }) !== null)
  ok('*** the same location on both sides is ALLOWED — a kitchen ***',
    validateBuild({ productId: loaf, qty: 5, fromLocationId: mainLoc, toLocationId: mainLoc }) === null)
  ok('a negative overhead is refused',
    validateBuild({
      productId: loaf, qty: 5, fromLocationId: mainLoc, toLocationId: mainLoc,
      overheads: [{ description: 'Labour', amountExcl: -1 }],
    }) !== null)

  // ── The preview ──────────────────────────────────────────────────────────
  const preview = await previewBuild(SITE, loaf, 10, mainLoc)
  ok('preview resolves the recipe', preview.ok, preview.ok ? '' : preview.error)
  if (preview.ok) {
    const p = preview.preview
    const flourLine = p.components.find((c) => c.productId === flour)
    ok('*** wastage is honoured — 0.5kg + 10% = 0.55 per loaf ***',
      flourLine?.qtyPerUnit === 0.55, String(flourLine?.qtyPerUnit))
    ok('  and 10 loaves need 5.5kg', flourLine?.qtyRequired === 5.5, String(flourLine?.qtyRequired))
    // 0.55 x 10 + 7 x 0.2 + 9 x 0.05 = 5.5 + 1.4 + 0.45 = 7.35
    ok('cost of one loaf is the sum of what goes in', p.unitCostExcl === 7.35, String(p.unitCostExcl))
    ok('nothing is short with full shelves', p.shortages.length === 0)
    // flour: 100/0.55 = 181.8; yeast: 500/7 = 71.4; salt: 500/9 = 55.5 <- binding
    ok('*** buildable is set by the binding ingredient (salt) ***',
      p.buildable === 55.555, String(p.buildable))
  }

  const previewShort = await previewBuild(SITE, loaf, 1000, mainLoc)
  ok('a build beyond the shelves reports shortages',
    previewShort.ok && previewShort.preview.shortages.length > 0)

  // ── An ordinary recipe cannot be built ───────────────────────────────────
  const refusedUnticked = await postBuild(SITE, actor, {
    productId: burger, qty: 5, fromLocationId: mainLoc, toLocationId: mainLoc,
  })
  ok('*** a recipe that is not "made in batches" refuses to build ***', !refusedUnticked.ok)
  ok('  and says why', !refusedUnticked.ok && refusedUnticked.error.includes('Made in batches'),
    !refusedUnticked.ok ? refusedUnticked.error : '')

  const refusedNormal = await postBuild(SITE, actor, {
    productId: flour, qty: 5, fromLocationId: mainLoc, toLocationId: mainLoc,
  })
  ok('a normal product refuses to build', !refusedNormal.ok)

  // ── The build ────────────────────────────────────────────────────────────
  const built = await postBuild(SITE, actor, {
    productId: loaf,
    qty: 20,
    fromLocationId: mainLoc,
    toLocationId: mainLoc,
    reference: 'Morning bake',
  })
  ok('*** the build posts ***', built.ok, built.ok ? built.documentNumber : built.error)
  if (!built.ok) {
    console.log('cannot continue without a posted build')
    await sweepStrays()
    process.exit(1)
  }

  ok('it takes an MO number', built.documentNumber.startsWith('MO'), built.documentNumber)

  // flour 0.55 x 20 = 11 off 100 -> 89
  ok('*** flour came off the shelf, wastage included ***', (await stockOf(flour)) === 89,
    String(await stockOf(flour)))
  ok('yeast came off — 7 x 20 = 140 off 500', (await stockOf(yeast)) === 360, String(await stockOf(yeast)))
  ok('salt came off — 9 x 20 = 180 off 500', (await stockOf(salt)) === 320, String(await stockOf(salt)))
  ok('*** and 20 loaves now EXIST as stock ***', (await stockOf(loaf)) === 20, String(await stockOf(loaf)))
  ok('the pile moved with the total', (await pileOf(loaf, mainLoc)) === 20, String(await pileOf(loaf, mainLoc)))

  // 11 x 10 + 140 x 0.2 + 180 x 0.05 = 110 + 28 + 9 = 147, over 20 = 7.35
  ok('*** the loaf now has a real average cost ***', (await costOf(loaf)) === 7.35,
    String(await costOf(loaf)))

  const order = await getBuild(SITE, built.id)
  ok('the order reads back', !!order)
  ok('it snapshotted three component lines', order?.lines.length === 3, String(order?.lines.length))
  ok('component cost is stored', order?.componentCost === 147, String(order?.componentCost))
  ok('every line kept its movement id', (order?.lines ?? []).every((l) => l.movementId !== null))

  ok('reconcileManufacturing is clean', (await reconcileManufacturing(SITE)).length === 0)
  ok('*** reconcileStock is clean after a build ***',
    (await reconcileStock(SITE)).length === driftBefore)

  // ── Overhead raises the cost ─────────────────────────────────────────────
  const withLabour = await postBuild(SITE, actor, {
    productId: loaf,
    qty: 10,
    fromLocationId: mainLoc,
    toLocationId: mainLoc,
    overheads: [
      { description: 'Baker hour', amountExcl: 50 },
      { description: 'Packaging', amountExcl: 23.5 },
    ],
  })
  ok('a build with overhead posts', withLabour.ok, withLabour.ok ? '' : withLabour.error)
  if (withLabour.ok) {
    const o = await getBuild(SITE, withLabour.id)
    ok('overhead is stored', o?.overheadCost === 73.5, String(o?.overheadCost))
    ok('it carries two cost lines', o?.overheads.length === 2, String(o?.overheads.length))
    // components 73.5 + overhead 73.5 = 147, over 10 = 14.70
    ok('*** overhead raises the made unit cost ***', o?.unitCostExcl === 14.7, String(o?.unitCostExcl))
    // 20 loaves at 7.35 blended with 10 at 14.70 = (147 + 147) / 30 = 9.80
    ok('*** and blends into the average, not replaces it ***', (await costOf(loaf)) === 9.8,
      String(await costOf(loaf)))
    ok('30 loaves on hand', (await stockOf(loaf)) === 30, String(await stockOf(loaf)))
  }

  // ── The GL entry ─────────────────────────────────────────────────────────
  const journal = await siteQuery<any>(
    SITE,
    `SELECT b.id, b.total_debit, b.total_credit,
            (SELECT COUNT(*) FROM journal_lines l WHERE l.batch_id = b.id) AS line_count
       FROM journal_batches b
      WHERE b.source = 'manufacture' AND b.source_doc_id = ?`,
    [built.id],
  )
  ok('*** a build reaches the ledger ***', journal.length === 1, `${journal.length} batches`)
  if (journal.length === 1) {
    ok('  and the journal balances',
      toNum(journal[0].total_debit) === toNum(journal[0].total_credit),
      `${journal[0].total_debit} vs ${journal[0].total_credit}`)
    ok('  with no overhead it is two stock legs',
      Number(journal[0].line_count) === 2, String(journal[0].line_count))
  }

  if (withLabour.ok) {
    const ohJournal = await siteQuery<any>(
      SITE,
      `SELECT COUNT(*) AS n FROM journal_lines l
         JOIN journal_batches b ON b.id = l.batch_id
        WHERE b.source = 'manufacture' AND b.source_doc_id = ?`,
      [withLabour.id],
    )
    ok('an overhead build posts a third leg', Number(ohJournal[0]?.n) === 3, String(ohJournal[0]?.n))
  }

  // ── Selling a manufactured item takes the ITEM ───────────────────────────
  const loafBefore = await stockOf(loaf)
  const flourBefore = await stockOf(flour)

  const sale = await saveDraft(SITE, actor, {
    docType: 'invoice',
    customerName: 'Walk-in',
    lines: [{
      productId: loaf, productCode: `LOA${stamp}`, description: 'White loaf',
      productType: 'recipe', qty: 2, unitPriceIncl: 25, vatRatePct: rate, unitCostExcl: 9.8,
    }],
  })
  ok('a loaf sale drafts', sale.ok, sale.ok ? '' : sale.error)
  if (sale.ok) {
    const sold = await finaliseDocument(SITE, actor, {
      documentId: sale.id,
      tenders: [{ tenderTypeId: cash.id, amount: 50 }],
    })
    ok('*** a manufactured recipe SELLS (it used to be refused) ***', sold.ok,
      sold.ok ? '' : sold.error)
    ok('*** selling 2 loaves takes 2 LOAVES ***', (await stockOf(loaf)) === loafBefore - 2,
      `${loafBefore} -> ${await stockOf(loaf)}`)
    ok('*** and does NOT touch the flour ***', (await stockOf(flour)) === flourBefore,
      `${flourBefore} -> ${await stockOf(flour)}`)
  }

  // ── The other model still works — the regression guard ───────────────────
  const pattyBefore = await stockOf(patty)
  const burgerSale = await saveDraft(SITE, actor, {
    docType: 'invoice',
    customerName: 'Walk-in',
    lines: [{
      productId: burger, productCode: `BUR${stamp}`, description: 'Cheeseburger',
      productType: 'recipe', qty: 3, unitPriceIncl: 60, vatRatePct: rate, unitCostExcl: 0,
    }],
  })
  if (burgerSale.ok) {
    const sold = await finaliseDocument(SITE, actor, {
      documentId: burgerSale.id,
      tenders: [{ tenderTypeId: cash.id, amount: 180 }],
    })
    ok('an ordinary recipe still sells', sold.ok, sold.ok ? '' : sold.error)
    ok('*** and still EXPLODES into ingredients ***', (await stockOf(patty)) === pattyBefore - 3,
      `${pattyBefore} -> ${await stockOf(patty)}`)
    ok('  while the burger itself carries no stock', (await stockOf(burger)) === 0,
      String(await stockOf(burger)))
  }

  // ── The 100% GP bug ──────────────────────────────────────────────────────
  // An exploding recipe's own average_cost is 0.0000 — nothing was ever bought
  // called "burger" — so cost of sales used to be debited with nothing while
  // the component movements credited stock with their real cost. The journal
  // described two different events.
  const burgerJournal = await siteQuery<any>(
    SITE,
    `SELECT l.amount, a.account_code
       FROM journal_lines l
       JOIN journal_batches b ON b.id = l.batch_id
       JOIN gl_accounts a ON a.id = l.account_id
      WHERE b.source_doc_id = ? AND b.source = 'sale' AND a.account_code IN ('5000','1200')`,
    [burgerSale.ok ? burgerSale.id : 0],
  )
  const cos = burgerJournal.filter((r: any) => r.account_code === '5000')
  // 3 burgers at 12 + 3 = 15 each = 45
  ok('*** a recipe sale debits cost of sales with what went INTO it ***',
    cos.length === 1 && toNum(cos[0].amount) === 45,
    cos.length ? String(toNum(cos[0].amount)) : 'no cost of sales line')

  // ── Overdrawing is refused ───────────────────────────────────────────────
  const flourNow = await stockOf(flour)
  const tooMany = await postBuild(SITE, actor, {
    productId: loaf, qty: 100000, fromLocationId: mainLoc, toLocationId: mainLoc,
  })
  ok('*** a build that would overdraw is REFUSED ***', !tooMany.ok,
    !tooMany.ok ? tooMany.error : '')
  ok('  and nothing moved', (await stockOf(flour)) === flourNow, String(await stockOf(flour)))
  const strayOrders = await siteQuery<any>(
    SITE,
    "SELECT COUNT(*) AS n FROM manufacturing_orders WHERE product_id=? AND status='draft'",
    [loaf],
  )
  ok('  and no half-written order was left behind', Number(strayOrders[0]?.n) === 0)

  // ── Unbuild ──────────────────────────────────────────────────────────────
  const beforeUnbuild = {
    flour: await stockOf(flour),
    yeast: await stockOf(yeast),
    salt: await stockOf(salt),
    loaf: await stockOf(loaf),
  }

  const reversed = await unbuild(SITE, actor, built.id, 'Dough did not prove')
  ok('*** the unbuild posts ***', reversed.ok, reversed.ok ? '' : reversed.error)
  ok('flour came back', (await stockOf(flour)) === beforeUnbuild.flour + 11,
    `${beforeUnbuild.flour} -> ${await stockOf(flour)}`)
  ok('yeast came back', (await stockOf(yeast)) === beforeUnbuild.yeast + 140)
  ok('salt came back', (await stockOf(salt)) === beforeUnbuild.salt + 180)
  ok('*** and the 20 loaves came off ***', (await stockOf(loaf)) === beforeUnbuild.loaf - 20,
    `${beforeUnbuild.loaf} -> ${await stockOf(loaf)}`)

  const cancelled = await getBuild(SITE, built.id)
  ok('the order is cancelled', cancelled?.status === 'cancelled')
  ok('it keeps its number', cancelled?.documentNumber === built.documentNumber)
  ok('and records the reason', cancelled?.cancelReason === 'Dough did not prove')

  const kept = await siteQuery<any>(
    SITE,
    "SELECT COUNT(*) AS n FROM stock_movements WHERE source='manufacture' AND source_doc_id=?",
    [built.id],
  )
  ok('*** the original movements were NOT deleted ***', Number(kept[0]?.n) === 4, String(kept[0]?.n))

  ok('unbuilding twice is refused', !(await unbuild(SITE, actor, built.id, 'again')).ok)
  ok('an unbuild with no reason is refused', !(await unbuild(SITE, actor, built.id, '   ')).ok)

  const reversingJournal = await siteQuery<any>(
    SITE,
    "SELECT COUNT(*) AS n FROM journal_batches WHERE source='manufacture_cancel' AND source_doc_id=?",
    [built.id],
  )
  ok('the unbuild reaches the ledger', Number(reversingJournal[0]?.n) === 1, String(reversingJournal[0]?.n))

  // ── Unbuild refuses when the goods have gone ─────────────────────────────
  if (withLabour.ok) {
    const onHand = await stockOf(loaf)
    // Sell everything that is left, so there is nothing to take back.
    const clearOut = await saveDraft(SITE, actor, {
      docType: 'invoice',
      customerName: 'Walk-in',
      lines: [{
        productId: loaf, productCode: `LOA${stamp}`, description: 'White loaf',
        productType: 'recipe', qty: onHand, unitPriceIncl: 25, vatRatePct: rate, unitCostExcl: 9.8,
      }],
    })
    if (clearOut.ok) {
      await finaliseDocument(SITE, actor, {
        documentId: clearOut.id,
        tenders: [{ tenderTypeId: cash.id, amount: round(onHand * 25, 2) }],
      })
    }
    const tooLate = await unbuild(SITE, actor, withLabour.id, 'changed my mind')
    ok('*** unbuild refuses once the goods have sold ***', !tooLate.ok,
      !tooLate.ok ? tooLate.error : '')
    ok('  and names the numbers',
      !tooLate.ok && /remain/.test(tooLate.error), !tooLate.ok ? tooLate.error : '')
  }

  // ── Listing ──────────────────────────────────────────────────────────────
  const list = await listBuilds(SITE, { search: `LOA${stamp}` })
  ok('the list finds the builds', list.items.length >= 2, String(list.items.length))
  const pickable = await listManufacturableProducts(SITE, `LOA${stamp}`)
  ok('the picker offers the manufactured loaf', pickable.length === 1, String(pickable.length))
  const notPickable = await listManufacturableProducts(SITE, `BUR${stamp}`)
  ok('*** and NOT the ordinary recipe ***', notPickable.length === 0, String(notPickable.length))

  // ── The invariants, last ─────────────────────────────────────────────────
  ok('reconcileManufacturing is still clean', (await reconcileManufacturing(SITE)).length === 0)
  ok('*** reconcileStock is clean at the end ***',
    (await reconcileStock(SITE)).length === driftBefore,
    `${(await reconcileStock(SITE)).length} vs baseline ${driftBefore}`)

  // verifySequence looks the doc type up in OWN_TABLE_TYPES. Without the
  // manufacturing_orders entry added there it would search sales_documents and
  // report every MO number ever issued as missing — so this assertion is also
  // the check that the entry is present.
  //
  // BASELINE-RELATIVE, not absolute. This suite sweeps its own orders at the
  // end while the sequence keeps counting — as it must, since a live doc-type
  // row is never reset — so every prior run leaves numbers behind with no
  // document. What matters is that THIS run added none: the two orders it
  // posted are both accounted for while they exist.
  const seqAfter = await verifySequence(SITE, 'manufacturing_order')
  ok('*** this run left no MO number unaccounted for ***',
    seqAfter.missing === seqBefore.missing,
    `${seqAfter.missing} missing vs baseline ${seqBefore.missing}, ${seqAfter.live} live, ${seqAfter.voided} cancelled`)
}

main()
  .then(async () => {
    await sweepStrays()
    console.log(fails ? `\n${fails} failure(s)` : '\nall passed')
    process.exit(fails ? 1 : 0)
  })
  .catch(async (e) => {
    console.error(e)
    await sweepStrays().catch(() => undefined)
    process.exit(1)
  })
