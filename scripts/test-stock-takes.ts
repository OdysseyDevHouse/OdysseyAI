/**
 * Stock takes — counting what is there, and writing the difference.
 *
 * THE ARITHMETIC THIS EXISTS TO PROVE is that a posted sheet writes
 * `counted - current`, never `counted - snapshot`. The two differ exactly when
 * something sold while the count was happening, which is the ordinary case in a
 * shop that stays open — so a module that got this wrong would look correct in
 * every quiet test and be wrong every real Saturday.
 *
 * Case 3 below is that test: sell during the count, then assert the pile equals
 * what was counted rather than the count minus the sale.
 *
 * Also proved here: zero-variance lines write NO movement (the difference
 * between 12 rows and 4,000), a cancel reverses without deleting history, and
 * reconcileStock stays clean throughout.
 *
 *   npm run test:stock-takes
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { createLocation, mainLocationId } from '../src/lib/site/stockLocations'
import {
  createStockTake,
  recountStockTake,
  saveCounts,
  freezeStockTake,
  postStockTake,
  cancelStockTake,
  deleteStockTake,
  getStockTake,
  listStockTakes,
  validateStockTake,
  reconcileStockTakes,
} from '../src/lib/site/stockTakes'
import { reconcileStock, recordMovement } from '../src/lib/site/stockMovements'
import { reconcileSerials } from '../src/lib/site/serials'
import { verifySequence } from '../src/lib/site/sequences'
import { siteTransaction } from '../src/lib/siteDb'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Stock Take Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const CODE_PATTERN = '^ZST[0-9]{8}'
const LOC_PATTERN = 'ZS%'

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

const movementCount = async (productId: number) =>
  Number(
    (
      await siteQueryOne<any>(
        SITE,
        "SELECT COUNT(*) AS n FROM stock_movements WHERE product_id=? AND source LIKE 'stock_take%'",
        [productId],
      )
    )?.n ?? 0,
  )

/**
 * Runs at the START of the run, not only at the end.
 *
 * A crashed prior run leaves rows behind, and a leaked scratch product on a
 * UNIQUE code kills the next run before its first assertion.
 */
async function sweepStrays() {
  const products = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  const locs = `(SELECT id FROM stock_locations WHERE code LIKE '${LOC_PATTERN}')`

  // Serials first: their movements reference the serial rows, and both must go
  // before the products they hang off. A leaked in_stock serial would otherwise
  // fail reconcileSerials on the NEXT run, in a suite that never created it.
  await siteExecute(SITE,
    `DELETE FROM serial_movements WHERE serial_id IN
       (SELECT id FROM product_serials WHERE product_id IN ${products})`)
  await siteExecute(SITE, `DELETE FROM product_serials WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM stock_take_lines WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM stock_takes WHERE location_id IN ${locs}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE location_id IN ${locs}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE location_id IN ${locs}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  await siteExecute(SITE, `DELETE FROM stock_locations WHERE code LIKE '${LOC_PATTERN}' AND is_main = 0`)
}

/** Puts an opening pile in a room without pretending it moved there. */
async function seed(productId: number, locationId: number, qty: number, cost: number) {
  await siteExecute(
    SITE,
    `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE stock_on_hand = VALUES(stock_on_hand)`,
    [productId, locationId, qty],
  )
  await siteExecute(SITE, 'UPDATE products SET stock_on_hand = ? WHERE id = ?', [qty, productId])
  await siteExecute(
    SITE,
    `INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after,
                                  unit_cost_excl, source, user_id, user_name)
     VALUES (?,?,'opening',?,?,?,'opening',1,'Stock Take Test')`,
    [productId, locationId, qty, qty, cost],
  )
}

async function main() {
  await sweepStrays()

  const stamp = Date.now().toString().slice(-8)
  // Baselined rather than reset: this runs against a shared dev database, and
  // the stock_take sequence row is real. Measured across the run instead.
  const seqBefore = await verifySequence(SITE, 'stock_take')
  const stockDriftBefore = (await reconcileStock(SITE)).length

  /* ── 1. The pure validator, no database ──────────────────────────────── */

  ok('*** a sheet with no location is refused ***',
    validateStockTake({ locationId: 0, scope: 'full' }) !== null)
  ok('  a manual sheet with no products is refused',
    validateStockTake({ locationId: 1, scope: 'manual', productIds: [] }) !== null)
  ok('  a department sheet with no department is refused',
    validateStockTake({ locationId: 1, scope: 'department' }) !== null)
  ok('  a full sheet passes',
    validateStockTake({ locationId: 1, scope: 'full' }) === null)

  /* ── Fixtures ────────────────────────────────────────────────────────── */

  const room = await createLocation(SITE, { code: `ZS${stamp}`, name: 'Stock take room' })
  if (!room.ok) { console.log('location setup failed'); process.exit(1) }
  const roomId = room.id

  const vat = await siteQueryOne<any>(
    SITE, "SELECT id FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")

  const makeProduct = async (suffix: string, qty: number, cost: number, type = 'normal') => {
    const r = await siteExecute(SITE,
      `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id)
       VALUES (?,?,?,0,?,?,?)`,
      [`ZST${stamp}${suffix}`, `Stock take ${suffix}`, type, cost, cost, vat?.id ?? null])
    await seed(r.insertId, roomId, qty, cost)
    return r.insertId as number
  }

  // short  — counted less than believed (a write-off)
  // over   — counted more than believed (a write-on)
  // exact  — counts exactly right; must write NO movement
  const short = await makeProduct('A', 50, 10)
  const over = await makeProduct('B', 20, 4)
  const exact = await makeProduct('C', 30, 7)

  ok('the room starts with the seeded piles',
    (await pile(short, roomId)) === 50 && (await pile(over, roomId)) === 20 && (await pile(exact, roomId)) === 30)

  /* ── 2. Creating a sheet ─────────────────────────────────────────────── */

  const created = await createStockTake(SITE, actor, {
    locationId: roomId,
    scope: 'manual',
    productIds: [short, over, exact],
    reference: 'Test count',
  })
  ok('*** a manual sheet is created with a line per product ***',
    created.ok && created.lineCount === 3,
    created.ok ? `${created.lineCount} lines` : created.error)
  if (!created.ok) { console.log('cannot continue'); process.exit(1) }
  const takeId = created.id

  const sheet = await getStockTake(SITE, takeId)
  ok('  it has no document number while it is a draft', sheet?.documentNumber === null)
  ok('  the snapshot captured what the system believed',
    sheet?.lines.find((l) => l.productId === short)?.snapshotQty === 50)
  ok('  every line starts UNCOUNTED, which is not the same as zero',
    sheet?.lines.every((l) => l.countedQty === null) === true)
  ok('  posting a sheet nobody has counted is refused',
    !(await postStockTake(SITE, actor, takeId)).ok)

  /* ── 3. Freezing ─────────────────────────────────────────────────────── */

  const frozen = await freezeStockTake(SITE, actor, takeId)
  ok('*** freezing moves the sheet to counting ***',
    frozen.ok && (await getStockTake(SITE, takeId))?.status === 'counting')
  ok('  and stamps when it was frozen',
    (await getStockTake(SITE, takeId))?.frozenAt !== null)
  ok('  freezing a frozen sheet is refused',
    !(await freezeStockTake(SITE, actor, takeId)).ok)

  /* ── 4. Counting ─────────────────────────────────────────────────────── */

  const lines = (await getStockTake(SITE, takeId))!.lines
  const lineFor = (pid: number) => lines.find((l) => l.productId === pid)!

  const saved = await saveCounts(SITE, actor, takeId, [
    { lineId: lineFor(short).id, countedQty: 47 },   // 3 missing
    { lineId: lineFor(over).id, countedQty: 23 },    // 3 found
    { lineId: lineFor(exact).id, countedQty: 30 },   // dead right
  ])
  ok('*** counts save against the lines ***', saved.ok)
  ok('  and record who counted them',
    (await getStockTake(SITE, takeId))!.lines.every((l) => l.countedBy !== null))
  ok('  a negative count is refused',
    !(await saveCounts(SITE, actor, takeId, [{ lineId: lineFor(short).id, countedQty: -1 }])).ok)

  /* ── 5. THE CENTRAL CASE: something sells mid-count ──────────────────── */

  // Two units of `short` sell AFTER it was counted at 47. The pile is now 48.
  // The count says 47 units are on the shelf; the sale took 2 more off it.
  // Posting must land the pile on 47 -- the count is the truth about the shelf,
  // and the sale is already reflected in what is left there.
  await siteTransaction(SITE, async (tx) => {
    await recordMovement(tx, actor, {
      productId: short,
      locationId: roomId,
      movementType: 'sale',
      qtyChange: -2,
      unitCostExcl: 10,
      source: 'sale',
      note: 'Sold during the count',
    })
  })
  ok('two units sell while the count is in progress', (await pile(short, roomId)) === 48)

  /* ── 6. Posting ──────────────────────────────────────────────────────── */

  const posted = await postStockTake(SITE, actor, takeId)
  ok('*** the sheet posts ***', posted.ok, posted.ok ? posted.documentNumber : posted.error)
  if (!posted.ok) { console.log('cannot continue'); process.exit(1) }

  ok('  it takes a document number at POST, not at create',
    /^STK\d{6}$/.test(posted.documentNumber), posted.documentNumber)

  ok('*** THE PILE MATCHES WHAT WAS COUNTED, not counted-minus-the-sale ***',
    (await pile(short, roomId)) === 47, `pile is ${await pile(short, roomId)}, expected 47`)
  ok('  the write-on landed too', (await pile(over, roomId)) === 23)
  ok('  the correct line did not move', (await pile(exact, roomId)) === 30)

  ok('  the site total agrees with the pile', (await total(short)) === 47)

  const postedSheet = (await getStockTake(SITE, takeId))!
  const shortLine = postedSheet.lines.find((l) => l.productId === short)!
  ok('  the line records the pile it actually posted against',
    shortLine.postedQtyBefore === 48,
    `posted_qty_before=${shortLine.postedQtyBefore}`)
  ok('  so the variance written is -1, not the -3 the counter would have said',
    shortLine.varianceQty === -1, `variance=${shortLine.varianceQty}`)
  ok('  and the snapshot still says what the counter was working against',
    shortLine.snapshotQty === 50)

  /* ── 7. Zero-variance lines write nothing ────────────────────────────── */

  ok('*** a line that counted exactly right wrote NO movement ***',
    (await movementCount(exact)) === 0)
  ok('  while the two that varied wrote one each',
    (await movementCount(short)) === 1 && (await movementCount(over)) === 1)
  ok('  and the correct line carries no movement id',
    postedSheet.lines.find((l) => l.productId === exact)!.movementId === null)

  /* ── 7b. But every counted line IS stamped as counted ─────────────────
   *
   * last_stock_take_date answers "when did somebody last walk up and look",
   * which is a different question from "when did the figure last change". So it
   * is written ABOVE the zero-variance skip: a shelf counted and found correct
   * was still counted, and it is exactly the product a stale-count report must
   * not flag. Separate from last_adjust_date, which a posted take also stamps.
   */
  const countedAt = async (id: number) =>
    (await siteQueryOne<any>(SITE, 'SELECT last_stock_take_date d FROM products WHERE id=?', [id]))?.d

  ok('*** the counted-right product is still STAMPED as counted ***',
    (await countedAt(exact)) !== null,
    String(await countedAt(exact)))
  ok('  and so are the two that varied',
    (await countedAt(short)) !== null && (await countedAt(over)) !== null)

  /* ── 8. Valuation ────────────────────────────────────────────────────── */

  // -1 x 10 = -10, +3 x 4 = +12. Net +2.
  ok('the sheet totals the variance in value', Math.abs(postedSheet.varianceValue - 2) < 0.005,
    `value=${postedSheet.varianceValue}`)
  ok('  a count does not restate average_cost',
    toNum((await siteQueryOne<any>(SITE, 'SELECT average_cost FROM products WHERE id=?', [over]))?.average_cost) === 4)
  ok('  last_adjust_date is finally written',
    (await siteQueryOne<any>(SITE, 'SELECT last_adjust_date FROM products WHERE id=?', [short]))
      ?.last_adjust_date !== null)

  ok('  posting twice is refused', !(await postStockTake(SITE, actor, takeId)).ok)

  /* ── 8b. The ledger entry ────────────────────────────────────────────── */

  const journal = await siteQuery<any>(SITE,
    `SELECT l.account_id, l.amount, a.account_code
       FROM journal_lines l
       JOIN journal_batches b ON b.id = l.batch_id
       JOIN gl_accounts a ON a.id = l.account_id
      WHERE b.source = 'stock_take' AND b.source_doc_id = ?`, [takeId])
  ok('*** posting writes a ledger entry ***', journal.length === 2,
    `${journal.length} lines`)
  ok('  and it balances',
    Math.abs(journal.reduce((s: number, l: any) => s + toNum(l.amount), 0)) < 0.005)
  ok('  hitting stock control and stock adjustments (5100)',
    journal.some((l: any) => l.account_code === '5100'))
  ok('  with the net variance as its value',
    Math.abs(Math.abs(toNum(journal[0]?.amount)) - 2) < 0.005,
    `line value ${journal[0]?.amount}`)

  /* ── 9. Top-up mode ──────────────────────────────────────────────────── */

  const topupTake = await createStockTake(SITE, actor, {
    locationId: roomId, scope: 'manual', productIds: [over],
  })
  if (!topupTake.ok) { console.log('topup setup failed'); process.exit(1) }
  const topupLine = (await getStockTake(SITE, topupTake.id))!.lines[0]
  await saveCounts(SITE, actor, topupTake.id, [
    { lineId: topupLine.id, lineMode: 'topup', enteredQty: 5 },
  ])
  const topupPosted = await postStockTake(SITE, actor, topupTake.id)
  ok('*** a top-up ADDS to the pile rather than replacing it ***',
    topupPosted.ok && (await pile(over, roomId)) === 28,
    `pile is ${await pile(over, roomId)}, expected 28`)

  /* ── 10. Cancelling a posted sheet ───────────────────────────────────── */

  const beforeCancel = await pile(short, roomId)
  const cancelled = await cancelStockTake(SITE, actor, takeId, 'Recount ordered')
  ok('*** a posted sheet can be cancelled ***', cancelled.ok,
    cancelled.ok ? '' : (cancelled as any).error)
  ok('  and the pile goes back to where it was',
    (await pile(short, roomId)) === beforeCancel + 1,
    `pile is ${await pile(short, roomId)}`)
  ok('  by REVERSING, not by deleting history',
    (await movementCount(short)) === 2)
  ok('  a cancel with no reason is refused',
    !(await cancelStockTake(SITE, actor, topupTake.id, '  ')).ok)

  /* ── 10b. Re-counting ────────────────────────────────────────────────── */

  // topupTake posted a +5 variance on `over`, so it has something to re-count.
  const recounted = await recountStockTake(SITE, actor, topupTake.id)
  ok('*** a posted sheet builds a re-count of the lines that varied ***',
    recounted.ok && recounted.lineCount === 1,
    recounted.ok ? `${recounted.lineCount} line` : recounted.error)

  if (recounted.ok) {
    const rc = (await getStockTake(SITE, recounted.id))!
    ok('  its lines are marked as a re-count', rc.lines[0]?.lineMode === 'recount')

    // Asserted against the LIVE pile rather than a hardcoded figure. The pile
    // has moved twice by now — the top-up wrote it up, and cancelling the first
    // sheet wrote it back down — and a literal here would be asserting this
    // test's history rather than the behaviour under test.
    const livePile = await pile(over, roomId)
    ok('  and it snapshots the pile as it is NOW, not as the first sheet left it',
      rc.lines[0]?.snapshotQty === livePile,
      `snapshot=${rc.lines[0]?.snapshotQty}, pile=${livePile}`)

    // Confirming what the pile already says must write nothing at all: this is
    // the whole point of a re-count that agrees with the original.
    await saveCounts(SITE, actor, recounted.id, [{ lineId: rc.lines[0].id, countedQty: livePile }])
    const rcPosted = await postStockTake(SITE, actor, recounted.id)
    ok('  confirming the count posts no movement at all',
      rcPosted.ok && rcPosted.movements === 0,
      rcPosted.ok ? `${rcPosted.movements} movements` : rcPosted.error)
    ok('  and leaves the pile exactly where it was',
      (await pile(over, roomId)) === livePile)
  }

  const noVariance = await createStockTake(SITE, actor, {
    locationId: roomId, scope: 'manual', productIds: [exact],
  })
  if (noVariance.ok) {
    const nvLine = (await getStockTake(SITE, noVariance.id))!.lines[0]
    await saveCounts(SITE, actor, noVariance.id, [{ lineId: nvLine.id, countedQty: 30 }])
    await postStockTake(SITE, actor, noVariance.id)
    ok('  a sheet where everything matched refuses to re-count',
      !(await recountStockTake(SITE, actor, noVariance.id)).ok)
  }

  // takeId was cancelled above, and a cancelled sheet is not a posted one.
  ok('  a sheet that is not posted cannot be re-counted',
    !(await recountStockTake(SITE, actor, takeId)).ok)

  /* ── 10c. Serial-tracked products ────────────────────────────────────── */

  // Invariant (S1) from 027: in_stock serials == quantity on hand. A serial
  // count that moved a quantity without reconciling the units would break it,
  // and reconcileSerials at the end is what proves this did not.
  const phone = await makeProduct('P', 0, 500, 'serial')
  await siteExecute(SITE,
    `INSERT INTO product_serials (product_id, location_id, serial, status, cost_excl, received_at)
     VALUES (?,?,?, 'in_stock', 500, NOW()), (?,?,?, 'in_stock', 500, NOW()), (?,?,?, 'in_stock', 500, NOW())`,
    [phone, roomId, `SN${stamp}A`, phone, roomId, `SN${stamp}B`, phone, roomId, `SN${stamp}C`])
  await siteExecute(SITE, 'UPDATE products SET stock_on_hand = 3 WHERE id = ?', [phone])
  await siteExecute(SITE,
    `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) VALUES (?,?,3)
     ON DUPLICATE KEY UPDATE stock_on_hand = 3`, [phone, roomId])
  await siteExecute(SITE,
    `INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after,
                                  unit_cost_excl, source, user_id, user_name)
     VALUES (?,?,'opening',3,3,500,'opening',1,'Stock Take Test')`, [phone, roomId])

  const serialDriftBefore = (await reconcileSerials(SITE)).length

  const serialTake = await createStockTake(SITE, actor, {
    locationId: roomId, scope: 'manual', productIds: [phone],
  })
  if (!serialTake.ok) { console.log('serial sheet failed:', serialTake.error); process.exit(1) }
  const serialLine = (await getStockTake(SITE, serialTake.id))!.lines[0]

  // Found: A and C on the shelf, B missing, plus a unit nobody has on file.
  await saveCounts(SITE, actor, serialTake.id, [{
    lineId: serialLine.id,
    serials: [`SN${stamp}A`, `SN${stamp}C`, `SN${stamp}NEW`],
  }])

  const serialPosted = await postStockTake(SITE, actor, serialTake.id)
  ok('*** a serial sheet posts from the units scanned, not a typed figure ***',
    serialPosted.ok, serialPosted.ok ? '' : serialPosted.error)
  ok('  the pile follows the scan count', (await pile(phone, roomId)) === 3,
    `pile is ${await pile(phone, roomId)}`)

  const serialStatus = async (suffix: string) =>
    String((await siteQueryOne<any>(SITE,
      'SELECT status FROM product_serials WHERE product_id=? AND serial=?',
      [phone, `SN${stamp}${suffix}`]))?.status ?? 'absent')

  ok('  a unit that was NOT found is written off', (await serialStatus('B')) === 'written_off')
  ok('  the units that were found stay in stock',
    (await serialStatus('A')) === 'in_stock' && (await serialStatus('C')) === 'in_stock')
  ok('  a unit nobody had on file is taken into stock', (await serialStatus('NEW')) === 'in_stock')

  ok('*** the serial invariant still holds ***',
    (await reconcileSerials(SITE)).length === serialDriftBefore,
    `${(await reconcileSerials(SITE)).length} vs ${serialDriftBefore} before`)

  // A unit on the shelf that the books say was SOLD is a data problem a count
  // cannot fix, so it is refused rather than silently resurrected.
  await siteExecute(SITE,
    "UPDATE product_serials SET status='sold', location_id=NULL WHERE product_id=? AND serial=?",
    [phone, `SN${stamp}C`])
  const soldTake = await createStockTake(SITE, actor, {
    locationId: roomId, scope: 'manual', productIds: [phone],
  })
  if (soldTake.ok) {
    const sl = (await getStockTake(SITE, soldTake.id))!.lines[0]
    await saveCounts(SITE, actor, soldTake.id, [{ lineId: sl.id, serials: [`SN${stamp}C`] }])
    const refused = await postStockTake(SITE, actor, soldTake.id)
    ok('*** scanning a unit the books say was SOLD is refused ***',
      !refused.ok && /sold/i.test(refused.ok ? '' : refused.error),
      refused.ok ? 'it posted' : refused.error.slice(0, 60))
    await deleteStockTake(SITE, soldTake.id)
  }

  /* ── 11. Drafts ──────────────────────────────────────────────────────── */

  const draft = await createStockTake(SITE, actor, {
    locationId: roomId, scope: 'manual', productIds: [exact],
  })
  ok('a draft can be deleted outright', draft.ok && (await deleteStockTake(SITE, draft.id)).ok)
  ok('  but a posted one cannot', !(await deleteStockTake(SITE, topupTake.id)).ok)

  /* ── 12. Exclusions ──────────────────────────────────────────────────── */

  const service = await makeProduct('S', 0, 0, 'service')
  const full = await createStockTake(SITE, actor, { locationId: roomId, scope: 'full' })
  if (full.ok) {
    const fullSheet = (await getStockTake(SITE, full.id))!
    ok('*** a service product never reaches a count sheet ***',
      !fullSheet.lines.some((l) => l.productId === service))
    ok('  and a full sheet skips products with a pile of zero by default',
      !fullSheet.lines.some((l) => l.snapshotQty === 0))
    await deleteStockTake(SITE, full.id)
  } else {
    ok('*** a full sheet builds ***', false, full.error)
  }

  /* ── 13. The reconciliations ─────────────────────────────────────────── */

  const takeDrift = await reconcileStockTakes(SITE)
  ok('*** every posted line agrees with the movement it produced ***',
    takeDrift.length === 0, `${takeDrift.length} drifting`)

  const stockDrift = await reconcileStock(SITE)
  ok('*** the three stock invariants still hold ***',
    stockDrift.length === stockDriftBefore,
    `${stockDrift.length} vs ${stockDriftBefore} before`)

  const seqAfter = await verifySequence(SITE, 'stock_take')
  ok('no stock take number went missing',
    seqAfter.missing === seqBefore.missing,
    `${seqAfter.missing} vs ${seqBefore.missing} before`)

  const listed = await listStockTakes(SITE, { locationId: roomId })
  ok('the list finds the sheets', listed.length >= 2)

  /* ── Clean up ────────────────────────────────────────────────────────── */

  await sweepStrays()
  const leftovers = await siteQuery<any>(
    SITE, `SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  ok('the run leaves nothing behind', leftovers.length === 0)

  console.log(fails === 0 ? '\nAll stock take checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
