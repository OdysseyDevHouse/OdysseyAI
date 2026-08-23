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
  approvalState,
  approveVarianceLines,
} from '../src/lib/site/stockTakes'
import { setSetting } from '../src/lib/site/settings'
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

/**
 * Both variance thresholds back to OFF, which is the shipped default (218).
 *
 * Restored to the DEFAULT rather than to whatever was found, and that is the
 * whole point. The obvious version — read the value, put it back in a finally
 * — is wrong in a way that takes a while to see: if a previous run died between
 * the setSetting and the finally, the "original" this run reads back IS the
 * pollution, and it gets faithfully written back at the end. The site then
 * stays dirty for ever, and the failure lands on some unrelated suite that
 * posts a count.
 *
 * That is not hypothetical — it happened while this was being written, and the
 * earlier sections of this file exit(1) on a fixture failure, which skips a
 * finally entirely.
 *
 * Run at the START as well as the end, for the same reason sweepStrays is.
 */
async function sweepThresholds() {
  await setSetting(SITE, 'stock_take_variance_qty_pct', '0')
  await setSetting(SITE, 'stock_take_variance_value', '0')
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
  await sweepThresholds()

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

  /* ── 12b. Blind counting (218) ───────────────────────────────────────── */

  /*
   * The FLAG is what is tested here, not the rendering.
   *
   * Blindness is enforced by the grid not receiving the column, and the page
   * resolves `blind = isBlind && !readOnly` before the component sees it. What
   * a server-side suite can prove is that the flag survives a round trip, that
   * a re-count inherits it, and — the part that would actually be a bug — that
   * turning it on changes NOTHING about what posts. A blind sheet that valued
   * or posted differently from a sighted one would be a second code path
   * through the arithmetic, which is exactly what this design refuses.
   */
  const blindA = await makeProduct('N', 40, 6)
  const blindTake = await createStockTake(SITE, actor, {
    locationId: roomId,
    scope: 'manual',
    productIds: [blindA],
    isBlind: true,
  })
  ok('*** a sheet can be created blind ***', blindTake.ok,
    blindTake.ok ? '' : blindTake.error)

  if (blindTake.ok) {
    const bs = (await getStockTake(SITE, blindTake.id))!
    ok('  the flag survives the round trip', bs.isBlind === true)
    ok('  and the snapshot is still captured — hidden from the COUNTER, not from the books',
      bs.lines[0]?.snapshotQty === 40)

    await freezeStockTake(SITE, actor, blindTake.id)
    await saveCounts(SITE, actor, blindTake.id, [{ lineId: bs.lines[0].id, countedQty: 34 }])
    const bp = await postStockTake(SITE, actor, blindTake.id)
    ok('  a blind sheet posts exactly as a sighted one does', bp.ok && bp.movements === 1,
      bp.ok ? `${bp.movements} movement` : bp.error)
    ok('  and writes the same difference', (await pile(blindA, roomId)) === 34,
      `pile is ${await pile(blindA, roomId)}`)

    const bre = await recountStockTake(SITE, actor, blindTake.id)
    ok('*** a re-count of a blind sheet is blind too ***',
      bre.ok && (await getStockTake(SITE, bre.id))!.isBlind === true)
    if (bre.ok) await deleteStockTake(SITE, bre.id)
  }

  /* ── 12c. Variance sign-off (218) ────────────────────────────────────── */

  /*
   * The gate, end to end: a threshold flags a line, posting is REFUSED while
   * it is unsigned, a signature clears it, and re-typing the count takes the
   * signature back.
   *
   * The last of those is the one worth having a test for. A signature that
   * survived an edit would let somebody approve "40 where the books said 400"
   * and then post a 4 — a control that reads as enforced and is not, which is
   * strictly worse than no control at all.
   *
   * ── THE THRESHOLDS ARE RESTORED TO ZERO, NOT TO WHAT WAS FOUND ─────────
   *
   * Settings are SITE-GLOBAL on a shared dev database, and the obvious version
   * of this — read the value, restore it in a finally — is wrong in a way that
   * takes a while to see: if a previous run died between the setSetting and the
   * finally, the "original" this run reads back IS the pollution, and it gets
   * faithfully written back at the end. The suite then leaves the site dirty
   * for ever after, and the failure lands on some unrelated test that posts a
   * count.
   *
   * That is not hypothetical — it happened while this was being written. The
   * earlier sections of this suite exit(1) on a fixture failure, which skips
   * the finally entirely.
   *
   * So the restore target is the DEFAULT (both off) rather than whatever was
   * observed. Zero is what settings.ts ships and what every untouched site
   * carries, so a run always leaves the site in the state a fresh one is in.
   * A dev site that had deliberately set a threshold loses it — an acceptable
   * trade for a suite that cannot poison the shared database.
   */
  // sweepThresholds() also ran at the very top of main(), beside sweepStrays,
  // so the earlier sections never post against a leftover threshold.

  try {
    // 10% of 100 is 10 units; the line below moves 40, which is 40%.
    await setSetting(SITE, 'stock_take_variance_qty_pct', '10')
    await setSetting(SITE, 'stock_take_variance_value', '0')

    const gateBig = await makeProduct('G', 100, 5)
    const gateSmall = await makeProduct('H', 100, 5)
    const gate = await createStockTake(SITE, actor, {
      locationId: roomId, scope: 'manual', productIds: [gateBig, gateSmall],
    })
    if (!gate.ok) {
      ok('*** the sign-off gate builds a sheet ***', false, gate.error)
    } else {
      await freezeStockTake(SITE, actor, gate.id)
      const gs = (await getStockTake(SITE, gate.id))!
      const bigLine = gs.lines.find((l) => l.productId === gateBig)!
      const smallLine = gs.lines.find((l) => l.productId === gateSmall)!

      // 60 against 100 is 40% out — over. 95 against 100 is 5% — under.
      await saveCounts(SITE, actor, gate.id, [
        { lineId: bigLine.id, countedQty: 60 },
        { lineId: smallLine.id, countedQty: 95 },
      ])

      const state1 = await approvalState(SITE, (await getStockTake(SITE, gate.id))!)
      ok('*** a line over the percentage threshold is flagged ***',
        state1.flagged.length === 1 && state1.flagged[0].line.productId === gateBig,
        `${state1.flagged.length} flagged`)
      ok('  a line under it is not', !state1.flagged.some((f) => f.line.productId === gateSmall))
      ok('  and the flag explains itself', /%/.test(state1.flagged[0]?.reason ?? ''),
        state1.flagged[0]?.reason ?? '(none)')

      const refused = await postStockTake(SITE, actor, gate.id)
      ok('*** posting is REFUSED while a flagged line is unsigned ***', !refused.ok,
        refused.ok ? 'it posted anyway' : '')
      ok('  and the refusal names the product',
        !refused.ok && refused.error.includes(`ZST${stamp}G`),
        refused.ok ? '' : refused.error.slice(0, 90))

      const reason = await siteQueryOne<any>(
        SITE, 'SELECT id FROM stock_adjustment_reasons WHERE is_active=1 ORDER BY sort_order LIMIT 1')

      const signed = await approveVarianceLines(SITE, actor, gate.id, [bigLine.id],
        { reasonId: reason?.id ?? null, note: 'Counted twice, shelf is genuinely short' })
      ok('*** a flagged line can be signed off ***', signed.ok,
        signed.ok ? '' : signed.error)

      const state2 = await approvalState(SITE, (await getStockTake(SITE, gate.id))!)
      ok('  which clears what was outstanding', state2.outstanding.length === 0,
        `${state2.outstanding.length} left`)
      ok('  while the line stays flagged, so the sheet still shows it was checked',
        state2.flagged.length === 1)

      /* The one that matters most. */
      await saveCounts(SITE, actor, gate.id, [{ lineId: bigLine.id, countedQty: 55 }])
      const state3 = await approvalState(SITE, (await getStockTake(SITE, gate.id))!)
      ok('*** re-typing the count WITHDRAWS the sign-off ***',
        state3.outstanding.length === 1,
        'a signature belongs to the figure it was given for')
      ok('  so posting is refused again', !(await postStockTake(SITE, actor, gate.id)).ok)

      // Sign the new figure, and it goes through.
      await approveVarianceLines(SITE, actor, gate.id, [bigLine.id],
        { reasonId: reason?.id ?? null, note: 'Re-counted' })
      const posted = await postStockTake(SITE, actor, gate.id)
      ok('*** once signed at the counted figure, the sheet posts ***', posted.ok,
        posted.ok ? `${posted.movements} movements` : posted.error)
      ok('  and both lines wrote their real difference',
        (await pile(gateBig, roomId)) === 55 && (await pile(gateSmall, roomId)) === 95,
        `${await pile(gateBig, roomId)} / ${await pile(gateSmall, roomId)}`)
      ok('  the approval is recorded against the line',
        (await getStockTake(SITE, gate.id))!.lines
          .find((l) => l.productId === gateBig)?.approvedBy === actor.userName)

      /* An approval on a posted sheet must be refused — there is nothing left
         to gate, and letting it through would rewrite an audit record. */
      const late = await approveVarianceLines(SITE, actor, gate.id, [bigLine.id],
        { reasonId: reason?.id ?? null })
      ok('  a posted sheet can no longer be signed off', !late.ok)
    }

    /* ── Both thresholds off is the DEFAULT, and must gate nothing ─────── */

    await setSetting(SITE, 'stock_take_variance_qty_pct', '0')
    await setSetting(SITE, 'stock_take_variance_value', '0')

    const offP = await makeProduct('J', 100, 5)
    const off = await createStockTake(SITE, actor, {
      locationId: roomId, scope: 'manual', productIds: [offP],
    })
    if (off.ok) {
      await freezeStockTake(SITE, actor, off.id)
      const os = (await getStockTake(SITE, off.id))!
      await saveCounts(SITE, actor, off.id, [{ lineId: os.lines[0].id, countedQty: 1 }])
      const offState = await approvalState(SITE, (await getStockTake(SITE, off.id))!)
      ok('*** with both thresholds off, a 99% variance is not flagged ***',
        offState.flagged.length === 0, `${offState.flagged.length} flagged`)
      const offPost = await postStockTake(SITE, actor, off.id)
      ok('  and it posts with no signature at all', offPost.ok,
        offPost.ok ? '' : offPost.error)
    } else {
      ok('*** a thresholds-off sheet builds ***', false, off.error)
    }

    /* ── The VALUE half catches what a percentage cannot ───────────────── */

    await setSetting(SITE, 'stock_take_variance_qty_pct', '0')
    await setSetting(SITE, 'stock_take_variance_value', '500')

    // 1 of 3 missing is 33% — but at R14,000 each it is the biggest line on
    // any sheet. This is the case a percentage threshold alone lets through.
    const dear = await makeProduct('K', 3, 14000)
    const val = await createStockTake(SITE, actor, {
      locationId: roomId, scope: 'manual', productIds: [dear],
    })
    if (val.ok) {
      await freezeStockTake(SITE, actor, val.id)
      const vs = (await getStockTake(SITE, val.id))!
      await saveCounts(SITE, actor, val.id, [{ lineId: vs.lines[0].id, countedQty: 2 }])
      const vState = await approvalState(SITE, (await getStockTake(SITE, val.id))!)
      ok('*** the value threshold catches one missing expensive unit ***',
        vState.flagged.length === 1,
        vState.flagged[0]?.reason ?? `${vState.flagged.length} flagged`)
      ok('  and posting is held on it', !(await postStockTake(SITE, actor, val.id)).ok)
      await cancelStockTake(SITE, actor, val.id, 'Test teardown')
    } else {
      ok('*** a value-threshold sheet builds ***', false, val.error)
    }
  } finally {
    // Site-global. Left switched on, this fails every other suite that posts a
    // count against this shared dev database — which is exactly what it did.
    await sweepThresholds()
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
  await sweepThresholds()
  const leftovers = await siteQuery<any>(
    SITE, `SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  ok('the run leaves nothing behind', leftovers.length === 0)

  // Asserted, not assumed. A threshold left switched on is invisible here and
  // fails a different suite an hour later, which is the worst way to find it.
  const leftPct = await siteQueryOne<any>(
    SITE, "SELECT setting_value v FROM settings WHERE setting_key='stock_take_variance_qty_pct'")
  const leftVal = await siteQueryOne<any>(
    SITE, "SELECT setting_value v FROM settings WHERE setting_key='stock_take_variance_value'")
  ok('  and leaves both variance thresholds switched off',
    Number(leftPct?.v ?? 0) === 0 && Number(leftVal?.v ?? 0) === 0,
    `pct='${leftPct?.v ?? ''}' value='${leftVal?.v ?? ''}'`)

  console.log(fails === 0 ? '\nAll stock take checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
