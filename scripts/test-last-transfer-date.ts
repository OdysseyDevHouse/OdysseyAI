/**
 * Does moving stock between locations stamp `products.last_transfer_date`?
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-last-transfer-date.ts
 *
 * The column (236) is written in `recordMovement` on a transfer_in or
 * transfer_out, which is the one chokepoint BOTH transfer paths go through —
 * location-to-location and inter-store.
 *
 * The backfill in 236 could not prove any of this: no site on this machine had
 * ever posted a transfer, so it ran against zero rows and reported success
 * either way. This posts a real one.
 *
 * Fixtures are removed on the way out — a leaked product with a UNIQUE code
 * fails an unrelated suite before its first assertion.
 */
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../src/lib/siteDb'
import { postTransfer } from '../src/lib/site/stockTransfers'
import { reconcileStock, recordMovement } from '../src/lib/site/stockMovements'

const SITE = 2
const actor = { userId: 1, userName: 'Last-transfer Test' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function lastTransfer(productId: number): Promise<Date | null> {
  const row = await siteQueryOne<any>(
    SITE,
    'SELECT last_transfer_date FROM products WHERE id = ?',
    [productId],
  )
  return row?.last_transfer_date ? new Date(row.last_transfer_date) : null
}

async function main() {
  const stamp = Date.now().toString().slice(-8)

  // Two real locations to move between. 025 seeds MAIN and refuses to delete a
  // location holding stock, so there is always at least one; a site with only
  // one cannot be tested.
  const locations = await siteQuery<any>(
    SITE,
    `SELECT id, code, name FROM stock_locations WHERE is_active = 1 ORDER BY id LIMIT 2`,
  )
  if (locations.length < 2) {
    console.log('This site has fewer than two active locations — cannot test a transfer.')
    process.exit(1)
  }
  const [from, to] = locations

  const res = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost)
     VALUES (?,?,?,?,?,?)`,
    [`LTD${stamp}`, `Last-transfer probe ${stamp}`, 'normal', '0.000', '5.0000', '5.0000'],
  )
  const productId = res.insertId
  let transferId: number | null = null

  try {
    /*
     * Stock has to BE somewhere before it can move, and it must arrive as a
     * MOVEMENT.
     *
     * Writing stock_on_hand directly (the obvious shortcut) leaves
     * Σ qty_change ≠ stock_on_hand for this product, so reconcileStock reports
     * drift — and the first version of this test duly failed on a row it had
     * created itself, which reads as a transfer bug and is not one.
     */
    await siteTransaction(SITE, async (tx) => {
      await recordMovement(tx, actor, {
        productId,
        locationId: from.id,
        movementType: 'opening',
        qtyChange: 20,
        unitCostExcl: 5,
        note: 'last_transfer_date probe seed',
      })
    })

    ok('starts with no last-transfer date', (await lastTransfer(productId)) === null)

    const posted = await postTransfer(SITE, actor, {
      fromLocationId: from.id,
      toLocationId: to.id,
      note: 'last_transfer_date probe',
      lines: [
        {
          productId,
          productCode: `LTD${stamp}`,
          description: `Last-transfer probe ${stamp}`,
          qty: 5,
          unitCostExcl: 5,
        },
      ],
    })
    ok('transfer posted', posted.ok, posted.ok ? posted.documentNumber : posted.error)
    if (!posted.ok) throw new Error(posted.error)
    transferId = posted.id

    const after = await lastTransfer(productId)
    ok('a transfer stamps last_transfer_date', after !== null, String(after))

    // Both legs write it, so the movements should be a matched pair.
    const kinds = await siteQuery<any>(
      SITE,
      `SELECT movement_type, COUNT(*) AS n FROM stock_movements
        WHERE product_id = ? GROUP BY movement_type ORDER BY movement_type`,
      [productId],
    )
    ok(
      'both legs recorded (plus the opening seed)',
      kinds.length === 3,
      kinds.map((k: any) => `${k.movement_type}×${k.n}`).join(', '),
    )

    const drift = await reconcileStock(SITE)
    ok('stock still reconciles', drift.length === 0, `${drift.length} drifting`)
  } finally {
    if (transferId) {
      await siteExecute(SITE, 'DELETE FROM stock_transfer_lines WHERE transfer_id = ?', [transferId])
      await siteExecute(SITE, 'DELETE FROM stock_transfers WHERE id = ?', [transferId])
    }
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId])
    await siteExecute(SITE, 'DELETE FROM product_location_stock WHERE product_id = ?', [productId])
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])
  }

  console.log(fails === 0 ? '\nAll checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

void main()
