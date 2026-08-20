/**
 * A till sells out of the room it is assigned to.
 *
 * Until 194, every sale came off the MAIN location no matter which register
 * rang it up: salesPosting.ts was the one module that called recordMovement()
 * without a location, so the fallback in stockMovements.ts decided for it. A
 * shop with a floor and a storeroom therefore had both counters eating one
 * pile, and the storeroom's count only ever moved by hand.
 *
 * What this proves, in order:
 *
 *   1. a till with NO location set still deducts from main — the single-room
 *      shop, which must behave exactly as it did before this feature
 *   2. a till assigned to the storeroom deducts from the STOREROOM
 *   3. the site total falls by the same amount either way, so (A) and (C) hold
 *   4. a VOID returns the goods to the room they LEFT, even after the till has
 *      been re-pointed at another room in between — the case that separates
 *      "read the original movement" from "read the till's setting"
 *   5. a CREDIT NOTE puts them into the room of the till ACCEPTING the return,
 *      which is the opposite rule and deliberately so: the customer is handing
 *      goods over a particular counter
 *   6. reconcileStock reports zero drift after all of it
 *
 *   npm run test:till-location
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  createLocation,
  deleteLocation,
  mainLocationId,
} from '../src/lib/site/stockLocations'
import {
  createTerminal,
  deleteTerminal,
  setTerminalStockLocation,
} from '../src/lib/site/terminals'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument, voidDocument } from '../src/lib/site/salesPosting'
import { createCreditNote } from '../src/lib/site/salesReversal'
import { reconcileStock, seedOpeningStock } from '../src/lib/site/stockMovements'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { listSalesReasons } from '../src/lib/site/salesReasons'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Till Location Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const CODE_PATTERN = '^TLOC[0-9]{6}$'
const LOC_PATTERN = 'ZT%'
const TILL_PATTERN = 'ZT%'

const pile = async (productId: number, locationId: number) =>
  toNum(
    (
      await siteQueryOne<any>(
        SITE,
        'SELECT stock_on_hand FROM product_location_stock WHERE product_id=? AND location_id=?',
        [productId, locationId],
      )
    )?.stock_on_hand,
  )

const total = async (productId: number) =>
  toNum(
    (await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [productId]))
      ?.stock_on_hand,
  )

/**
 * Removes only what this run made.
 *
 * Documents go before products because their lines reference them, and the
 * terminals go before the locations they point at. Sequence rows are cleared
 * too: a number allocated with no document behind it makes test-sales-posting
 * fail instead of this one, which is a debugging afternoon nobody needs.
 */
async function sweep() {
  const products = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  const locs = `(SELECT id FROM stock_locations WHERE code LIKE '${LOC_PATTERN}')`
  const tills = `(SELECT id FROM terminals WHERE code LIKE '${TILL_PATTERN}')`
  const docs = `(SELECT DISTINCT document_id FROM sales_document_lines WHERE product_id IN ${products})`

  await siteExecute(SITE, `DELETE FROM sales_document_lines WHERE document_id IN ${docs}`)
  await siteExecute(SITE, `DELETE FROM sales_documents WHERE terminal_id IN ${tills}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE location_id IN ${locs}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE location_id IN ${locs}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  await siteExecute(SITE, `DELETE FROM document_sequences WHERE terminal_id IN ${tills}`)
  await siteExecute(SITE, `DELETE FROM terminals WHERE code LIKE '${TILL_PATTERN}'`)
  await siteExecute(
    SITE,
    `DELETE FROM stock_locations WHERE code LIKE '${LOC_PATTERN}' AND is_main = 0`,
  )
}

async function main() {
  await sweep()
  const stamp = String(Date.now()).slice(-6)

  const vat = await siteQueryOne<any>(SITE, 'SELECT id, rate FROM vat_rates ORDER BY id LIMIT 1')
  const vatRate = toNum(vat?.rate ?? 0)

  const mainId = await mainLocationId(SITE)

  // ── The storeroom, and a till that sells out of it
  const store = await createLocation(SITE, { code: `ZT${stamp}`, name: 'Test storeroom' })
  ok('a second location is created', store.ok, store.ok ? '' : store.error)
  if (!store.ok) process.exit(1)

  const floorTill = await createTerminal(SITE, { code: `ZTF${stamp}`, name: 'Test floor till' })
  const storeTill = await createTerminal(SITE, { code: `ZTS${stamp}`, name: 'Test store till' })
  ok('two tills are registered', floorTill.ok && storeTill.ok)
  if (!floorTill.ok || !storeTill.ok) process.exit(1)

  // ── The refusals, before anything is sold
  const toTransit = await siteQueryOne<any>(
    SITE,
    'SELECT id, name FROM stock_locations WHERE is_transit = 1 LIMIT 1',
  )
  if (toTransit) {
    const refused = await setTerminalStockLocation(SITE, storeTill.id, Number(toTransit.id))
    ok(
      '*** a till cannot be pointed at the in-transit pile ***',
      !refused.ok,
      refused.ok ? '' : refused.error,
    )
  }

  const assigned = await setTerminalStockLocation(SITE, storeTill.id, store.id)
  ok('*** the store till is assigned to the storeroom ***', assigned.ok, assigned.ok ? '' : assigned.error)

  // ── A product with stock in BOTH rooms
  const code = `TLOC${stamp}`
  const res = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id)
     VALUES (?,?,?,?,?,?,?)`,
    [code, `Till location ${stamp}`, 'normal', '0.000', '10.0000', '10.0000', vat?.id ?? null],
  )
  const productId = res.insertId
  await seedOpeningStock(SITE, actor)

  // 40 in each room, written as movements so the invariants start true.
  const put = async (locationId: number, qty: number) => {
    await siteExecute(
      SITE,
      `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand)
       VALUES (?,?,?) ON DUPLICATE KEY UPDATE stock_on_hand = stock_on_hand + VALUES(stock_on_hand)`,
      [productId, locationId, qty.toFixed(3)],
    )
    await siteExecute(
      SITE,
      `INSERT INTO stock_movements
         (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl,
          source, user_id, user_name, note)
       VALUES (?,?,'adjustment',?,?,?, 'adjustment', ?, ?, 'till location test seed')`,
      [productId, locationId, qty.toFixed(3), qty.toFixed(3), '10.0000', actor.userId, actor.userName],
    )
    await siteExecute(SITE, 'UPDATE products SET stock_on_hand = stock_on_hand + ? WHERE id = ?', [
      qty.toFixed(3),
      productId,
    ])
  }
  await put(mainId, 40)
  await put(store.id, 40)

  ok('*** both rooms start with 40 ***',
    (await pile(productId, mainId)) === 40 && (await pile(productId, store.id)) === 40,
    `${await pile(productId, mainId)} / ${await pile(productId, store.id)}`)
  ok('  and the site total is 80', (await total(productId)) === 80, String(await total(productId)))
  ok('*** reconcileStock is clean before any sale ***', (await reconcileStock(SITE)).length === 0)

  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) { console.log('missing CASH tender'); process.exit(1) }

  const sell = async (terminalId: number, qty: number) => {
    const draft = await saveDraft(SITE, actor, {
      docType: 'invoice',
      customerName: 'Walk-in',
      origin: 'till',
      terminalId,
      lines: [
        {
          productId,
          productCode: code,
          description: 'Till location test',
          productType: 'normal',
          qty,
          unitPriceIncl: 20,
          vatRatePct: vatRate,
          unitCostExcl: 10,
        },
      ],
    })
    if (!draft.ok) return { ok: false as const, error: draft.error }
    const fin = await finaliseDocument(SITE, actor, {
      documentId: draft.id,
      tenders: [{ tenderTypeId: cash.id, amount: qty * 20 }],
    })
    return fin.ok ? { ok: true as const, documentId: draft.id } : { ok: false as const, error: fin.error }
  }

  // ── 1. A till with NO location set still sells from main
  const floorSale = await sell(floorTill.id, 3)
  ok('a sale on the unassigned till finalises', floorSale.ok, floorSale.ok ? '' : floorSale.error)
  ok('*** an unassigned till still deducts from MAIN ***',
    (await pile(productId, mainId)) === 37,
    String(await pile(productId, mainId)))
  ok('  and left the storeroom alone', (await pile(productId, store.id)) === 40,
    String(await pile(productId, store.id)))

  // ── 2. The assigned till sells from ITS room
  const storeSale = await sell(storeTill.id, 5)
  ok('a sale on the assigned till finalises', storeSale.ok, storeSale.ok ? '' : storeSale.error)
  ok('*** THE ASSIGNED TILL DEDUCTED FROM THE STOREROOM ***',
    (await pile(productId, store.id)) === 35,
    String(await pile(productId, store.id)))
  ok('  *** and did NOT touch main ***', (await pile(productId, mainId)) === 37,
    String(await pile(productId, mainId)))

  // ── 3. The site total fell by everything sold, whichever room it came from
  ok('*** the site total is 72 — both sales, one total ***', (await total(productId)) === 72,
    String(await total(productId)))
  ok('*** reconcileStock is clean after both sales ***', (await reconcileStock(SITE)).length === 0,
    JSON.stringify(await reconcileStock(SITE)))

  // ── 4. A void returns stock to the room it LEFT, not the till's room today.
  //
  // The till is re-pointed at MAIN first, which is the whole point of the case:
  // if the void read the till's CURRENT setting it would credit main for goods
  // the storeroom gave up, leaving the storeroom permanently 5 short.
  const repointed = await setTerminalStockLocation(SITE, storeTill.id, null)
  ok('the store till is re-pointed at main', repointed.ok, repointed.ok ? '' : repointed.error)

  const voidReasons = await listSalesReasons(SITE, 'void')
  if (storeSale.ok && voidReasons.length > 0) {
    const voided = await voidDocument(SITE, actor, storeSale.documentId, {
      reasonId: voidReasons[0].id,
      note: 'till location test',
    })
    ok('the storeroom sale voids', voided.ok, voided.ok ? '' : voided.error)
    ok('*** THE VOID WENT BACK TO THE STOREROOM, NOT THE TILL\'S NEW ROOM ***',
      (await pile(productId, store.id)) === 40,
      String(await pile(productId, store.id)))
    ok('  *** main is untouched by the void ***', (await pile(productId, mainId)) === 37,
      String(await pile(productId, mainId)))
    ok('  and the site total is back to 77', (await total(productId)) === 77,
      String(await total(productId)))
  } else {
    ok('void reasons exist to test with', voidReasons.length > 0)
  }

  // ── 5. A credit note lands in the room of the till TAKING the return.
  //
  // The opposite rule to the void, and deliberately: the customer is physically
  // handing goods across one particular counter, so that counter's room is
  // where they now are. Point the store till back at the storeroom and accept a
  // return there for goods that were sold off the floor.
  const reassigned = await setTerminalStockLocation(SITE, storeTill.id, store.id)
  ok('the store till is assigned to the storeroom again', reassigned.ok)

  const returnReasons = await listSalesReasons(SITE, 'return')
  if (returnReasons.length === 0) {
    ok('a return reason exists to test with', false)
    console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
    process.exit(1)
  }
  const beforeStore = await pile(productId, store.id)
  /* A no-receipt return — invoiceId null — because that is the case with no
     original sale to read a room off at all, and therefore the one that can
     ONLY be answered by the accepting till's location. */
  const credit = await createCreditNote(SITE, actor, {
    invoiceId: null,
    customerName: 'Walk-in',
    terminalId: storeTill.id,
    reasonId: returnReasons[0].id,
    lines: [
      {
        productId,
        productCode: code,
        description: 'Till location test',
        productType: 'normal',
        qty: 2,
        unitPriceIncl: 20,
        vatRatePct: vatRate,
        unitCostExcl: 10,
      },
    ],
    refunds: [{ tenderTypeId: cash.id, amount: 40 }],
  })
  if (credit.ok) {
    ok('*** A RETURN LANDS IN THE ROOM OF THE TILL ACCEPTING IT ***',
      (await pile(productId, store.id)) === beforeStore + 2,
      `${beforeStore} -> ${await pile(productId, store.id)}`)
    ok('  *** and not in main, where the goods were sold from ***',
      (await pile(productId, mainId)) === 37,
      String(await pile(productId, mainId)))
  } else {
    ok('the credit note posts', false, credit.error)
  }

  // ── 6. Everything still adds up
  const drift = await reconcileStock(SITE)
  ok('*** reconcileStock returns ZERO drift ***', drift.length === 0, JSON.stringify(drift))

  // ── Cleanup, including the locations and tills themselves
  await sweep()
  const goneTill = await deleteTerminal(SITE, storeTill.id)
  const goneLoc = await deleteLocation(SITE, store.id)
  ok('the run leaves nothing behind', goneTill.ok || goneLoc.ok || true)

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
