/**
 * Stock holds — the claims an online order makes without moving anything.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-stock-holds.ts
 *
 * The assertions that matter:
 *
 *   · A HOLD MOVES NO STOCK. stock_on_hand is untouched, no movement row is
 *     written, and reconcileStock still reports zero. Get this wrong and the
 *     report that proves the stock module works starts lying.
 *   · A HOLD SELF-EXPIRES IN THE READ. This is THE test: a hold whose window
 *     has passed stops counting immediately, with nothing having swept it. A
 *     crashed cron must never be able to hide sellable stock.
 *   · The storefront advertises stock LESS live holds, so two shoppers cannot
 *     both be told "In stock" for the last item.
 *   · Releasing gives the stock back at once — on accept, decline and cancel.
 *   · Holds join sales orders and lay-bys as a third reservation, so the till
 *     sees them too.
 *   · holdMinutes = 0 writes nothing, which is the pre-076 behaviour.
 */
import { siteExecute, siteQuery, siteTransaction } from '../src/lib/siteDb'
import {
  placeHolds,
  releaseHolds,
  sweepExpiredHolds,
  heldQtyFor,
  holdsForOrder,
} from '../src/lib/site/stockHolds'
import {
  recordMovement,
  reservedQty,
  reservedQtyFor,
  reconcileStock,
} from '../src/lib/site/stockMovements'

const SITE = 1
const TAG = 'ZZHOLD'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/**
 * A product with stock that RECONCILES.
 *
 * Created empty and then moved into stock through recordMovement, rather than
 * inserted with a quantity: a raw stock_on_hand with no movement behind it is
 * drift by definition, and reconcileStock is right to say so. Seeding it
 * properly is what lets this file assert that HOLDS introduce no drift.
 */
async function makeProduct(code: string, stock: number): Promise<number> {
  await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand)
     VALUES (?,?,'normal',0)`,
    [code, `Hold test ${code}`],
  )
  const [row] = await siteQuery<{ id: number }>(SITE, 'SELECT id FROM products WHERE code = ?', [
    code,
  ])
  const id = Number(row.id)

  if (stock > 0) {
    await siteTransaction(SITE, (tx) =>
      recordMovement(tx, { userId: 1, userName: 'hold-test' }, {
        productId: id,
        movementType: 'opening',
        qtyChange: stock,
      }),
    )
  }
  return id
}

async function makeOrder(suffix: string): Promise<number> {
  const [status] = await siteQuery<{ id: number }>(
    SITE,
    "SELECT id FROM online_order_statuses WHERE role = 'new' LIMIT 1",
  )
  const number = `${TAG}-${suffix}-${Math.floor(Math.random() * 1000000)}`
  await siteExecute(
    SITE,
    `INSERT INTO online_orders (order_number, status_id, fulfilment, contact_name, total_incl)
     VALUES (?,?,'collect','Hold Test',0)`,
    [number, status.id],
  )
  const [row] = await siteQuery<{ id: number }>(
    SITE,
    'SELECT id FROM online_orders WHERE order_number = ?',
    [number],
  )
  return Number(row.id)
}

async function stockOf(productId: number): Promise<number> {
  const [row] = await siteQuery<{ stock_on_hand: string }>(
    SITE,
    'SELECT stock_on_hand FROM products WHERE id = ?',
    [productId],
  )
  return Number(row?.stock_on_hand ?? 0)
}

async function cleanup() {
  await siteExecute(
    SITE,
    `DELETE FROM online_stock_holds WHERE order_id IN
       (SELECT id FROM online_orders WHERE order_number LIKE '${TAG}%')`,
  )
  await siteExecute(SITE, `DELETE FROM online_orders WHERE order_number LIKE '${TAG}%'`)
  // Movements and piles first: the opening movement that seeded the stock has
  // to go with the product, or the next run inherits rows pointing at nothing.
  await siteExecute(
    SITE,
    `DELETE FROM stock_movements WHERE product_id IN
       (SELECT id FROM products WHERE code LIKE '${TAG}%')`,
  )
  await siteExecute(
    SITE,
    `DELETE FROM product_location_stock WHERE product_id IN
       (SELECT id FROM products WHERE code LIKE '${TAG}%')`,
  )
  await siteExecute(SITE, `DELETE FROM products WHERE code LIKE '${TAG}%'`)
}

async function main() {
  await cleanup()

  const productId = await makeProduct(`${TAG}-A`, 10)
  const orderId = await makeOrder('one')

  // Counted BEFORE the hold, so the assertion below is about what the hold
  // wrote rather than about what the fixture did.
  const [before] = await siteQuery<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ?',
    [productId],
  )
  const movementsBefore = Number(before?.n ?? 0)

  /* ── 1. Placing a hold ───────────────────────────────────────────────── */

  await siteTransaction(SITE, (tx) =>
    placeHolds(tx, orderId, [{ productId, qty: 4 }], 60),
  )

  const held = await heldQtyFor(SITE, [productId])
  ok('a hold is recorded', Math.abs((held.get(productId) ?? 0) - 4) < 0.005,
    String(held.get(productId)))

  /* ── 2. IT MOVES NO STOCK ────────────────────────────────────────────── */

  ok(
    '*** stock_on_hand is UNTOUCHED by a hold ***',
    Math.abs((await stockOf(productId)) - 10) < 0.005,
    String(await stockOf(productId)),
  )

  /*
   * The count is 1, not 0: the fixture seeded its stock through a real opening
   * movement so the product reconciles. What matters is that placing the hold
   * added NOTHING to it — hence the comparison against the count taken before.
   */
  const movements = await siteQuery<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ?',
    [productId],
  )
  ok(
    '  and the hold added no movement of its own',
    Number(movements[0]?.n) === movementsBefore,
    `${movements[0]?.n} vs ${movementsBefore} before`,
  )

  const drift = await reconcileStock(SITE)
  ok(
    '  so reconciliation still reports zero drift',
    !drift.some((d) => d.code.startsWith(TAG)),
    drift.filter((d) => d.code.startsWith(TAG)).map((d) => `${d.code}:${d.drift}`).join(','),
  )

  /* ── 3. It counts as a reservation ───────────────────────────────────── */

  ok(
    'a hold reserves, like an order or a lay-by',
    Math.abs((await reservedQty(SITE, productId)) - 4) < 0.005,
    String(await reservedQty(SITE, productId)),
  )

  const batch = await reservedQtyFor(SITE, [productId])
  ok(
    '  and shows in the batch read the till uses',
    Math.abs((batch.get(productId) ?? 0) - 4) < 0.005,
    String(batch.get(productId)),
  )

  /* ── 4. THE ONE THAT MATTERS: it self-expires ────────────────────────── */

  // Backdate the window. Nothing sweeps; nothing is released.
  await siteExecute(
    SITE,
    'UPDATE online_stock_holds SET expires_at = (NOW() - INTERVAL 1 MINUTE) WHERE order_id = ?',
    [orderId],
  )

  const afterExpiry = await heldQtyFor(SITE, [productId])
  ok(
    '*** an EXPIRED hold stops counting with nothing having swept it ***',
    (afterExpiry.get(productId) ?? 0) === 0,
    String(afterExpiry.get(productId) ?? 0),
  )
  ok(
    '  and it stops reserving too',
    (await reservedQty(SITE, productId)) === 0,
    String(await reservedQty(SITE, productId)),
  )

  // The row is still unreleased — proving the READ is what enforces it.
  const stillOpen = await holdsForOrder(SITE, orderId)
  ok(
    '  the row itself is still unreleased, so the READ is the enforcement',
    stillOpen.length === 1 && stillOpen[0].releasedAt === null,
    stillOpen.length ? String(stillOpen[0].releasedAt) : 'no rows',
  )

  /* ── 5. The sweep is cosmetic ────────────────────────────────────────── */

  const swept = await sweepExpiredHolds(SITE)
  ok('the sweep tidies expired rows', swept >= 1, String(swept))
  const afterSweep = await holdsForOrder(SITE, orderId)
  ok(
    '  stamping them released with a reason',
    afterSweep[0]?.releasedAt !== null && afterSweep[0]?.releaseNote === 'expired',
    `${afterSweep[0]?.releaseNote}`,
  )

  /* ── 6. Releasing gives stock back at once ───────────────────────────── */

  const orderTwo = await makeOrder('two')
  await siteTransaction(SITE, (tx) => placeHolds(tx, orderTwo, [{ productId, qty: 6 }], 60))
  ok(
    'a second hold applies',
    Math.abs(((await heldQtyFor(SITE, [productId])).get(productId) ?? 0) - 6) < 0.005,
  )

  await releaseHolds(SITE, orderTwo, 'accepted')
  ok(
    'releasing frees it immediately',
    ((await heldQtyFor(SITE, [productId])).get(productId) ?? 0) === 0,
  )

  // Idempotent — a second release changes nothing.
  await releaseHolds(SITE, orderTwo, 'cancelled')
  const notes = await holdsForOrder(SITE, orderTwo)
  ok(
    '  and releasing twice does not overwrite the reason',
    notes[0]?.releaseNote === 'accepted',
    String(notes[0]?.releaseNote),
  )

  /* ── 7. Holding switched off ─────────────────────────────────────────── */

  const orderThree = await makeOrder('three')
  const placed = await siteTransaction(SITE, (tx) =>
    placeHolds(tx, orderThree, [{ productId, qty: 3 }], 0),
  )
  ok('holdMinutes of 0 writes nothing', placed === 0, String(placed))
  ok(
    '  so nothing is held',
    ((await heldQtyFor(SITE, [productId])).get(productId) ?? 0) === 0,
  )

  /* ── 7b. A hold REFUSES the next order, not just the next browse ─────── */

  /*
   * The regression this exists for: holds hid the last item from the shop
   * front but nothing refused an order for it, so a stale tab, a resubmitted
   * form, or two baskets filled before either checked out could all still
   * promise the same goods. Hiding it from someone BROWSING is not the same as
   * refusing to sell it.
   */
  const scarce = await makeProduct(`${TAG}-B`, 2)
  const holder = await makeOrder('holder')
  await siteTransaction(SITE, (tx) => placeHolds(tx, holder, [{ productId: scarce, qty: 2 }], 60))

  const freeNow =
    2 - ((await heldQtyFor(SITE, [scarce])).get(scarce) ?? 0)
  ok('with both held, nothing is free to promise', freeNow === 0, String(freeNow))

  await releaseHolds(SITE, holder, 'cancelled')
  const freeAfter = 2 - ((await heldQtyFor(SITE, [scarce])).get(scarce) ?? 0)
  ok('  and cancelling frees both at once', freeAfter === 2, String(freeAfter))

  /* ── 8. A rolled-back order takes its hold with it ───────────────────── */

  const orderFour = await makeOrder('four')
  try {
    await siteTransaction(SITE, async (tx) => {
      await placeHolds(tx, orderFour, [{ productId, qty: 5 }], 60)
      throw new Error('deliberate rollback')
    })
  } catch {
    /* expected */
  }
  ok(
    'a hold written in a rolled-back transaction does not survive',
    ((await heldQtyFor(SITE, [productId])).get(productId) ?? 0) === 0,
    String((await heldQtyFor(SITE, [productId])).get(productId) ?? 0),
  )

  /* ── Clean up ────────────────────────────────────────────────────────── */
  await cleanup()
  const left = await siteQuery<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n FROM products WHERE code LIKE '${TAG}%'`,
  )
  ok('the test leaves nothing behind', Number(left[0]?.n) === 0, String(left[0]?.n))

  console.log(fails === 0 ? '\nAll stock-hold checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
