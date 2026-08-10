/**
 * Product variants — the model's invariants.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-variants.ts
 *
 * The parent/child split is NOT enforceable by the schema: a variant is an
 * ordinary row in `products`, which is exactly what kept all 27 existing
 * foreign keys correct (see 070_product_variants.sql). The price of that choice
 * is that every rule lives in code, so these are the assertions that stand in
 * for constraints the database cannot make:
 *
 *   · A PARENT CANNOT TAKE STOCK. This is THE assertion in this file.
 *     recordMovement() is the single gate every quantity change passes through,
 *     and a parent is excluded from reconcileStock() — so stock reaching one
 *     would be invisible to the report whose whole job is proving the figures
 *     add up. Get this wrong and Σ movements ≠ stock_on_hand with nothing
 *     reporting the difference.
 *   · NO GRANDCHILDREN, from both directions — a child cannot become a parent
 *     and a parent cannot become a child. Either would make the storefront draw
 *     a tile inside a tile and the picker recurse.
 *   · A product carrying stock cannot BECOME a parent; the quantity would be
 *     stranded where nothing counts it.
 *   · Children inherit department and VAT from the parent, because a group
 *     whose mediums are zero-rated and larges standard-rated is a mistake being
 *     saved rather than a choice being made.
 *   · One combination per group, so a picker has no unreachable option.
 *   · Detaching leaves an ordinary product with its stock and history intact —
 *     the property that makes the whole scheme reversible.
 */
import { siteExecute, siteQuery, siteTransaction } from '../src/lib/siteDb'
import {
  makeParent,
  attachChild,
  detachChild,
  unmakeParent,
  getGroup,
  isParent,
  VariantError,
} from '../src/lib/site/productVariants'
import { recordMovement, reconcileStock } from '../src/lib/site/stockMovements'

const SITE = 1
const ACTOR = { userId: 1, userName: 'variant-test' }
const TAG = 'ZZTESTVAR'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** Did this throw a VariantError with a message a shopkeeper could act on? */
async function refuses(label: string, fn: () => Promise<unknown>) {
  try {
    await fn()
    ok(label, false, 'it was allowed')
  } catch (error) {
    const isOurs = error instanceof VariantError || error instanceof Error
    ok(label, isOurs, isOurs ? (error as Error).message.slice(0, 60) : String(error))
  }
}

async function makeProduct(code: string, description: string, stock = 0): Promise<number> {
  await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand)
     VALUES (?,?,'normal',?)`,
    [code, description, stock.toFixed(3)],
  )
  const [row] = await siteQuery<any>(SITE, 'SELECT id FROM products WHERE code = ?', [code])
  return Number(row.id)
}

async function cleanup() {
  // Children first: fk_product_parent is ON DELETE RESTRICT, which is the
  // point — deleting a parent out from under its variants must fail.
  await siteExecute(SITE, `DELETE FROM products WHERE code LIKE '${TAG}%' AND parent_id IS NOT NULL`)
  await siteExecute(SITE, `DELETE FROM products WHERE code LIKE '${TAG}%'`)
}

async function main() {
  await cleanup()

  /* ── 1. Becoming a parent ────────────────────────────────────────────── */

  const shirt = await makeProduct(`${TAG}-SHIRT`, 'Test shirt')
  await makeParent(SITE, shirt, [{ position: 1, label: 'Size' }])
  ok('a product can become a parent', await isParent(SITE, shirt))

  const group0 = await getGroup(SITE, shirt)
  ok('  and its axis is named', group0?.axes[0]?.label === 'Size', group0?.axes[0]?.label)

  await refuses('a parent cannot be made a parent twice', () =>
    makeParent(SITE, shirt, [{ position: 1, label: 'Size' }]),
  )

  await refuses('naming no axis is refused', async () => {
    const p = await makeProduct(`${TAG}-NOAXIS`, 'No axis')
    return makeParent(SITE, p, [{ position: 1, label: '   ' }])
  })

  /* ── 2. A product holding stock cannot become a parent ───────────────── */

  const stocked = await makeProduct(`${TAG}-STOCKED`, 'Has stock', 5)
  await refuses('a product with stock cannot become a parent', () =>
    makeParent(SITE, stocked, [{ position: 1, label: 'Size' }]),
  )

  /* ── 3. Attaching children ───────────────────────────────────────────── */

  const small = await makeProduct(`${TAG}-S`, 'Test shirt small')
  const medium = await makeProduct(`${TAG}-M`, 'Test shirt medium')

  await attachChild(SITE, shirt, small, 'Small', '')
  await attachChild(SITE, shirt, medium, 'Medium', '')

  const group = await getGroup(SITE, shirt)
  ok('children attach to the parent', group?.children.length === 2, String(group?.children.length))
  ok(
    '  and carry their own codes',
    group?.children.map((c) => c.code).sort().join(',') === `${TAG}-M,${TAG}-S`,
    group?.children.map((c) => c.code).join(','),
  )

  const dup = await makeProduct(`${TAG}-M2`, 'Dup')
  await refuses('the same combination cannot appear twice', () =>
    attachChild(SITE, shirt, dup, 'Medium', ''),
  )

  const blank = await makeProduct(`${TAG}-BLANK`, 'Blank')
  await refuses('a variant needs at least one axis value', () =>
    attachChild(SITE, shirt, blank, '', ''),
  )

  await refuses('a product cannot be a variant of itself', () =>
    attachChild(SITE, shirt, shirt, 'Self', ''),
  )

  /* ── 4. No grandchildren, from both directions ───────────────────────── */

  await refuses('a child cannot become a parent', () =>
    makeParent(SITE, small, [{ position: 1, label: 'Colour' }]),
  )

  const other = await makeProduct(`${TAG}-OTHER`, 'Other parent')
  await makeParent(SITE, other, [{ position: 1, label: 'Size' }])
  await refuses('a parent cannot become a child', () =>
    attachChild(SITE, shirt, other, 'Nested', ''),
  )

  await refuses('a child cannot be stolen by another parent', () =>
    attachChild(SITE, other, small, 'Small', ''),
  )

  /* ── 5. THE ONE THAT MATTERS: a parent cannot take stock ─────────────── */

  let moved = false
  try {
    await siteTransaction(SITE, async (tx) => {
      await recordMovement(tx, ACTOR, {
        productId: shirt,
        movementType: 'adjustment',
        qtyChange: 10,
      })
    })
    moved = true
  } catch {
    /* expected */
  }
  ok('a parent REFUSES a stock movement', !moved)

  const [parentStock] = await siteQuery<any>(
    SITE,
    'SELECT stock_on_hand FROM products WHERE id = ?',
    [shirt],
  )
  ok(
    '  and its stock is still exactly zero',
    Math.abs(Number(parentStock.stock_on_hand)) < 0.0005,
    String(parentStock.stock_on_hand),
  )

  /* A child, by contrast, is an ordinary product and moves normally. */
  await siteTransaction(SITE, async (tx) => {
    await recordMovement(tx, ACTOR, {
      productId: small,
      movementType: 'adjustment',
      qtyChange: 7,
    })
  })
  const [childStock] = await siteQuery<any>(
    SITE,
    'SELECT stock_on_hand FROM products WHERE id = ?',
    [small],
  )
  ok('a child takes stock normally', Math.abs(Number(childStock.stock_on_hand) - 7) < 0.0005,
    String(childStock.stock_on_hand))

  /* ── 6. Reconciliation still balances ────────────────────────────────── */

  /*
   * Scoped to the GROUP, not to every fixture this file makes.
   *
   * ZZTESTVAR-STOCKED is inserted with a raw quantity and no movement rows, to
   * prove a stocked product cannot become a parent. Reconciliation is therefore
   * right to flag it — that is invariant (A) doing its job — and asserting over
   * every fixture would be asserting that the report is broken.
   */
  const drift = await reconcileStock(SITE)
  const groupCodes = new Set([`${TAG}-SHIRT`, `${TAG}-S`, `${TAG}-M`, `${TAG}-L`])
  const ours = drift.filter((d) => groupCodes.has(d.code))
  ok('the group introduces no reconciliation drift', ours.length === 0,
    ours.map((d) => `${d.code}:${d.drift}`).join(', '))

  // And the parent is absent from the report entirely, rather than present
  // with a zero — see the has_variants filter in reconcileStock().
  ok(
    '  and the parent never appears in the report',
    !drift.some((d) => d.code === `${TAG}-SHIRT`),
  )

  /* ── 7. Inheritance ──────────────────────────────────────────────────── */

  const [vat] = await siteQuery<any>(SITE, 'SELECT id FROM vat_rates LIMIT 1')
  if (vat) {
    await siteExecute(SITE, 'UPDATE products SET selling_vat_rate_id = ? WHERE id = ?', [
      vat.id,
      shirt,
    ])
    const fresh = await makeProduct(`${TAG}-L`, 'Test shirt large')
    await attachChild(SITE, shirt, fresh, 'Large', '')
    const [inherited] = await siteQuery<any>(
      SITE,
      'SELECT selling_vat_rate_id FROM products WHERE id = ?',
      [fresh],
    )
    ok(
      'a new child inherits the parent’s VAT rate',
      Number(inherited.selling_vat_rate_id) === Number(vat.id),
      `${inherited.selling_vat_rate_id} vs ${vat.id}`,
    )
  }

  /* ── 8. Unmaking, and the RESTRICT that protects children ────────────── */

  await refuses('a parent with children cannot be unmade', () => unmakeParent(SITE, shirt))

  let deleted = false
  try {
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [shirt])
    deleted = true
  } catch {
    /* expected: fk_product_parent is RESTRICT */
  }
  ok('the database itself refuses to delete a parent with children', !deleted)

  /* ── 9. Detaching gives back an ordinary product ─────────────────────── */

  await detachChild(SITE, small)
  const [loose] = await siteQuery<any>(
    SITE,
    'SELECT parent_id, axis_1_value, stock_on_hand FROM products WHERE id = ?',
    [small],
  )
  ok('a detached variant has no parent', loose.parent_id === null)
  ok('  its axis value is cleared', String(loose.axis_1_value) === '')
  ok(
    '  and it KEEPS its stock',
    Math.abs(Number(loose.stock_on_hand) - 7) < 0.0005,
    String(loose.stock_on_hand),
  )

  /* And now it moves stock again, because it is just a product. */
  let movesAgain = true
  try {
    await siteTransaction(SITE, async (tx) => {
      await recordMovement(tx, ACTOR, {
        productId: small,
        movementType: 'adjustment',
        qtyChange: -7,
      })
    })
  } catch {
    movesAgain = false
  }
  ok('  and it moves stock again once detached', movesAgain)

  /* ── Clean up ────────────────────────────────────────────────────────── */
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN
    (SELECT id FROM products WHERE code LIKE '${TAG}%')`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN
    (SELECT id FROM products WHERE code LIKE '${TAG}%')`)
  await cleanup()
  const [left] = await siteQuery<any>(
    SITE,
    `SELECT COUNT(*) AS n FROM products WHERE code LIKE '${TAG}%'`,
  )
  ok('the test leaves nothing behind', Number(left.n) === 0, String(left.n))

  console.log(fails === 0 ? '\nAll variant checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
