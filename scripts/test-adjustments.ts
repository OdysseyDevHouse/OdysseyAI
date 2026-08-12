/**
 * Stock adjustments — and specifically, counting a shelf that is empty.
 *
 * THE THING THIS EXISTS TO PROVE is that "there are none" is an answer, not a
 * blank row. Both arrive as a zero delta when the pile is already zero, and the
 * validator used to refuse both — so a person counting an empty shelf was told
 * to "say how many were gained or lost", which is not a question they can
 * answer. countedQty is what separates them: count mode sets it, delta mode
 * does not.
 *
 * Also proved: a counted zero posts NO movement (the same rule stock takes
 * follow for a zero variance), adjusting a real pile to zero still works, and
 * an untouched row is still refused.
 *
 *   npm run test:adjustments
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  validateAdjustment,
  postNewAdjustment,
  listReasons,
  type AdjustmentInput,
} from '../src/lib/site/stockAdjustments'
import { mainLocationId } from '../src/lib/site/stockLocations'
import { reconcileStock, recordMovement } from '../src/lib/site/stockMovements'
import { siteTransaction } from '../src/lib/siteDb'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Adjustment Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const CODE_PATTERN = '^ZADJ[0-9]{8}'

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

const movementCount = async (productId: number) =>
  Number(
    (
      await siteQueryOne<any>(
        SITE,
        'SELECT COUNT(*) c FROM stock_movements WHERE product_id=?',
        [productId],
      )
    )?.c ?? 0,
  )

/*
 * Teardown.
 *
 * The posted documents are DELETED, numbers and all, because stock_adjustment
 * is in OWN_TABLE_TYPES — verifySequence counts rows in stock_adjustments and
 * reports every issued number with no row as missing. Cancelling instead would
 * leave the rows (good) but also leave test litter in a real shop's document
 * list (bad), so the rows go and the sequence is wound back to match.
 *
 * Winding the counter back is safe HERE and nowhere else: these are the last
 * numbers issued, allocated seconds ago by this script, on a test site.
 */
async function sweepStrays() {
  const where = `(SELECT id FROM (SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}') x)`
  const docs = `(SELECT id FROM (SELECT a.id FROM stock_adjustments a WHERE a.reference LIKE 'ZADJ-%') y)`

  const mine = await siteQuery<any>(
    SITE,
    `SELECT document_number FROM stock_adjustments
      WHERE reference LIKE 'ZADJ-%' AND document_number IS NOT NULL`,
  )

  await siteExecute(SITE, `DELETE FROM stock_adjustment_lines WHERE adjustment_id IN ${docs}`)
  await siteExecute(SITE, `DELETE FROM stock_adjustments WHERE reference LIKE 'ZADJ-%'`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM product_prices WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)

  // Give the numbers back, so the next run starts where this one did and
  // verifySequence sees no hole where these documents used to be.
  if (mine.length > 0) {
    await siteExecute(
      SITE,
      `UPDATE document_sequences
          SET next_number = next_number - ?
        WHERE doc_type = 'stock_adjustment' AND next_number > ?`,
      [mine.length, mine.length],
    ).catch(() => undefined)
  }
}

async function main() {
  await sweepStrays()
  const stamp = Date.now().toString().slice(-8)
  const drift = await reconcileStock(SITE)
  const driftBefore = drift.length

  const locationId = await mainLocationId(SITE)
  const reasons = await listReasons(SITE)
  const correct = reasons.find((r) => r.direction === 'both') ?? reasons[0]
  if (!correct) {
    console.log('no adjustment reasons on this site — cannot run')
    process.exit(1)
  }

  const make = async (suffix: string, onHand: number) => {
    const r = await siteExecute(
      SITE,
      `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
       VALUES (?, ?, 'normal', 0, 10, 10, 1)`,
      [`ZADJ${stamp}${suffix}`, `Adjustment test ${suffix}`],
    )
    const id = r.insertId
    // Stock arrives through a movement, never a bare UPDATE — writing
    // stock_on_hand directly is exactly what breaks the invariant asserted at
    // the end of this file.
    if (onHand !== 0) {
      await siteTransaction(SITE, async (tx) => {
        await recordMovement(tx, actor, {
          productId: id,
          locationId,
          movementType: 'opening',
          qtyChange: onHand,
          unitCostExcl: 10,
          source: 'opening',
          note: 'Adjustment test seed',
        })
      })
    }
    return id
  }

  const doc = (lines: AdjustmentInput['lines'], ref: string): AdjustmentInput => ({
    locationId,
    reasonId: correct.id,
    reference: ref,
    lines,
  })

  // ── The validator, with no database involved ────────────────────────────
  console.log('\n── Blank row versus counted-empty ──')

  const blankLine = { productId: 1, description: 'Thing', qtyBefore: 0, qtyChange: 0 }

  const blank = validateAdjustment(doc([blankLine], 'ZADJ-v1'))
  ok('*** an untouched row is still refused ***', blank !== null, blank ?? '')

  const countedEmpty = validateAdjustment(doc([{ ...blankLine, countedQty: 0 }], 'ZADJ-v2'))
  ok('*** counting an empty shelf is ACCEPTED ***', countedEmpty === null,
    countedEmpty ?? 'ok')

  const countedReal = validateAdjustment(
    doc([{ ...blankLine, qtyBefore: 5, qtyChange: -5, countedQty: 0 }], 'ZADJ-v3'),
  )
  ok('  and so is counting a real pile down to zero', countedReal === null, countedReal ?? 'ok')

  // ── Adjusting a real pile to zero ───────────────────────────────────────
  console.log('\n── Adjusting to zero ──')

  const withStock = await make('A', 7)
  ok('the product starts with 7', (await pile(withStock, locationId)) === 7,
    String(await pile(withStock, locationId)))

  const toZero = await postNewAdjustment(SITE, actor, doc([{
    productId: withStock,
    productCode: `ZADJ${stamp}A`,
    description: 'Adjustment test A',
    qtyBefore: 7,
    qtyChange: -7,
    countedQty: 0,
  }], 'ZADJ-zero'))
  ok('*** counting it to zero posts ***', toZero.ok, toZero.ok ? toZero.documentNumber : toZero.error)
  ok('*** and the pile IS zero ***', (await pile(withStock, locationId)) === 0,
    String(await pile(withStock, locationId)))

  // ── A counted zero on an already-empty shelf ────────────────────────────
  console.log('\n── Counting an empty shelf ──')

  const empty = await make('B', 0)
  const before = await movementCount(empty)

  const confirmEmpty = await postNewAdjustment(SITE, actor, doc([{
    productId: empty,
    productCode: `ZADJ${stamp}B`,
    description: 'Adjustment test B',
    qtyBefore: 0,
    qtyChange: 0,
    countedQty: 0,
  }], 'ZADJ-empty'))
  ok('*** confirming an empty shelf POSTS rather than refusing ***', confirmEmpty.ok,
    confirmEmpty.ok ? confirmEmpty.documentNumber : confirmEmpty.error)
  ok('*** and writes NO movement — nothing happened ***',
    (await movementCount(empty)) === before,
    `${before} -> ${await movementCount(empty)}`)
  ok('  the pile is still zero', (await pile(empty, locationId)) === 0)

  // ── A blank row still cannot be posted ──────────────────────────────────
  const stillRefused = await postNewAdjustment(SITE, actor, doc([{
    productId: empty,
    productCode: `ZADJ${stamp}B`,
    description: 'Adjustment test B',
    qtyBefore: 0,
    qtyChange: 0,
  }], 'ZADJ-blank'))
  ok('*** a row with no count at all is still refused ***', !stillRefused.ok,
    !stillRefused.ok ? stillRefused.error : '')

  // ── Invariant ───────────────────────────────────────────────────────────
  console.log('\n── Invariant ──')
  await sweepStrays()
  const after = await reconcileStock(SITE)
  ok('*** no stock drift introduced (Σ qty_change = stock_on_hand) ***',
    after.length === driftBefore, `${driftBefore} before, ${after.length} after`)

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await sweepStrays()
  console.log('\nCRASHED — strays swept')
  process.exit(1)
})
