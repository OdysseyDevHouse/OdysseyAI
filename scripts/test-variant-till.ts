/**
 * Variant groups at the TILL — the grid, the picker's data, and the one rule
 * that must never break.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-variant-till.ts
 *
 * `test-variants.ts` covers the MODEL: what a parent may hold, who may become
 * one, and that stock reconciles. This covers what the till does with it, which
 * is a different question and has its own way of going wrong.
 *
 * ── THE ASSERTION THAT MATTERS ───────────────────────────────────────────
 *
 * A parent must never become a sale line. It holds no stock, `recordMovement`
 * refuses it, and a basket carrying one fails at the tender pad with the
 * customer's card already out. Before this feature the till was safe by
 * ABSENCE — `browseForTill` simply never returned a parent. It now returns one
 * deliberately, so absence no longer protects anything and the guard is code in
 * PosShell's `add()`. These checks stand behind that trade:
 *
 *   · The grid shows the GROUP and not its members, so a shirt is one tile.
 *   · Search and scan still refuse a parent outright — a scanned barcode is a
 *     physical item, and a group is not one.
 *   · A group with nothing live in it draws no tile at all, rather than a tile
 *     that opens on an empty picker.
 *   · `tillProductCounts` counts exactly what the grid will draw. The tile says
 *     "12 products" and must open on twelve.
 *   · The feed carries BOTH halves — parents to draw, children to pick from —
 *     because the picker runs with the server gone.
 */
import { siteExecute, siteQuery } from '../src/lib/siteDb'
import { makeParent, attachChild, allVariantAxes } from '../src/lib/site/productVariants'
import { browseForTill, searchForTill, resolveScan, tillProductCounts } from '../src/lib/site/tillSearch'
import {
  listMenuProducts,
  setProductsVisibleInPos,
  moveProductsToDepartment,
} from '../src/lib/site/menuDesigner'

const SITE = 1
const TAG = 'ZZTILLVAR'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** A department of our own, so the count assertions are not about the shop's data. */
async function makeDepartment(name: string): Promise<number> {
  await siteExecute(SITE, `INSERT INTO departments (name) VALUES (?)`, [name])
  const [row] = await siteQuery<any>(SITE, 'SELECT id FROM departments WHERE name = ?', [name])
  return Number(row.id)
}

async function makeProduct(
  code: string,
  description: string,
  departmentId: number,
  opts: { stock?: number; barcode?: string; price?: number } = {},
): Promise<number> {
  await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, department_id,
                           barcode, visible_in_pos, is_archived)
     VALUES (?,?,'normal',?,?,?,1,0)`,
    [code, description, (opts.stock ?? 0).toFixed(3), departmentId, opts.barcode ?? null],
  )
  const [row] = await siteQuery<any>(SITE, 'SELECT id FROM products WHERE code = ?', [code])
  const id = Number(row.id)

  /*
   * The PER-LOCATION row, not just the total on the product.
   *
   * The till reads its own room (see selectProduct), so a fixture that wrote
   * only `products.stock_on_hand` would have every assertion here read zero and
   * pass or fail for the wrong reason. This is exactly how the tile bug hid: a
   * hand-seeded product looks stocked in the database and empty at the counter.
   */
  if (opts.stock) {
    await siteExecute(
      SITE,
      `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand)
       VALUES (?, (SELECT id FROM stock_locations WHERE is_main = 1 ORDER BY id LIMIT 1), ?)
       ON DUPLICATE KEY UPDATE stock_on_hand = VALUES(stock_on_hand)`,
      [id, opts.stock.toFixed(3)],
    )
  }
  if (opts.price) {
    await siteExecute(
      SITE,
      `INSERT INTO product_prices (product_id, price_structure_id, selling_price_incl)
       VALUES (?,1,?) ON DUPLICATE KEY UPDATE selling_price_incl = VALUES(selling_price_incl)`,
      [id, opts.price.toFixed(2)],
    )
  }
  return id
}

async function cleanup() {
  /* The rows hanging off the products go first — a leaked product_prices or
     product_location_stock row outlives its product and shows up as a failure
     in an unrelated suite that counts them. */
  const owned = `SELECT id FROM products WHERE code LIKE '${TAG}%'`
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN (${owned})`)
  await siteExecute(SITE, `DELETE FROM product_prices WHERE product_id IN (${owned})`)
  // Children next: fk_product_parent is ON DELETE RESTRICT.
  await siteExecute(SITE, `DELETE FROM products WHERE code LIKE '${TAG}%' AND parent_id IS NOT NULL`)
  await siteExecute(SITE, `DELETE FROM products WHERE code LIKE '${TAG}%'`)
  await siteExecute(SITE, `DELETE FROM departments WHERE name LIKE '${TAG}%'`)
}

const codes = (rows: { code: string }[]) => rows.map((r) => r.code).sort().join(',')

async function main() {
  await cleanup()

  const dept = await makeDepartment(`${TAG} Clothing`)

  /* One group of three sizes, one loose product, and one EMPTY group — the
     three shapes the grid has to tell apart. */
  const shirt = await makeProduct(`${TAG}-SHIRT`, 'Test shirt', dept)
  await makeParent(SITE, shirt, [{ position: 1, label: 'Size' }])
  /* Prices differ deliberately: the large costs more, so "the group quotes its
     cheapest" is a real assertion rather than one true by coincidence. And the
     sizes are attached S, M, L — the order a person types them, and the order
     the picker must show rather than the alphabet's L, M, S. */
  const small = await makeProduct(`${TAG}-S`, 'Test shirt S', dept, {
    stock: 4,
    barcode: `${TAG}S`,
    price: 100,
  })
  const medium = await makeProduct(`${TAG}-M`, 'Test shirt M', dept, { stock: 0, price: 100 })
  const large = await makeProduct(`${TAG}-L`, 'Test shirt L', dept, { stock: 2, price: 150 })
  await attachChild(SITE, shirt, small, 'S', '')
  await attachChild(SITE, shirt, medium, 'M', '')
  await attachChild(SITE, shirt, large, 'L', '')

  const cap = await makeProduct(`${TAG}-CAP`, 'Test cap', dept, { stock: 9 })

  const empty = await makeProduct(`${TAG}-EMPTY`, 'Test empty group', dept)
  await makeParent(SITE, empty, [{ position: 1, label: 'Size' }])

  /* ── 1. The grid: groups stand for their members ─────────────────────── */

  const grid = await browseForTill(SITE, { departmentId: dept, priceStructureId: 1, includeVariantParents: true })
  ok(
    'the grid draws the GROUP, not its sizes',
    codes(grid) === `${TAG}-CAP,${TAG}-SHIRT`,
    codes(grid),
  )
  ok(
    'and the group tile is marked as one',
    grid.find((p) => p.code === `${TAG}-SHIRT`)?.hasVariants === true,
  )
  ok(
    'an EMPTY group draws no tile at all',
    !grid.some((p) => p.code === `${TAG}-EMPTY`),
    'a tile that opens on nothing is worse than no tile',
  )
  ok('a loose product is untouched', grid.some((p) => p.code === `${TAG}-CAP`))

  /* ── 2. Without the flag, nothing changed ────────────────────────────── */

  const oldWay = await browseForTill(SITE, { departmentId: dept, priceStructureId: 1 })
  ok(
    'the default read is exactly what it always was',
    codes(oldWay) === `${TAG}-CAP,${TAG}-L,${TAG}-M,${TAG}-S`,
    codes(oldWay),
  )
  ok(
    'so the invoice picker never sees a group',
    !oldWay.some((p) => p.hasVariants),
    'a parent cannot go on an invoice line either',
  )

  /* ── 3. The members, which is what the picker lists ──────────────────── */

  const members = oldWay.filter((p) => p.parentId === shirt)
  ok('every size carries its parent', members.length === 3, String(members.length))
  ok(
    'and its own axis value',
    codes(members) === `${TAG}-L,${TAG}-M,${TAG}-S` &&
      members.every((m) => m.axis1Value.length > 0),
    members.map((m) => `${m.code}=${m.axis1Value}`).join(' '),
  )
  ok(
    'a sold-out size is still offered',
    members.some((m) => m.code === `${TAG}-M` && m.availableQty <= 0),
    'the customer is holding it; the count is only the shop’s claim',
  )

  /* ── 4. The axis labels, which live on the group ─────────────────────── */

  const axes = await allVariantAxes(SITE)
  ok('the group’s axis is named', axes[shirt]?.[0]?.label === 'Size', JSON.stringify(axes[shirt]))
  ok('a loose product has no axes', axes[cap] === undefined)

  /* ── 5. Search and scan still refuse a parent ────────────────────────── */

  const found = await searchForTill(SITE, 'Test shirt', null)
  ok(
    'searching never turns up the group',
    !found.some((p) => p.code === `${TAG}-SHIRT`),
    codes(found),
  )
  ok('but does turn up its sizes', found.some((p) => p.code === `${TAG}-S`))

  const scanned = await resolveScan(SITE, `${TAG}S`, null, null)
  ok('a scanned barcode resolves to the SIZE', scanned?.code === `${TAG}-S`, scanned?.code ?? 'null')
  ok('and it is not a group', scanned?.hasVariants === false)

  /* ── 6. What the GROUP'S TILE says about itself ──────────────────────── */

  /*
   * Both of these were wrong on a real till before they were checked here, and
   * neither showed up in a fixture: a parent has no stock row and no price row
   * of its own, so the tile read "none on hand · R0.00" for a shirt with 17 on
   * the shelf. A cashier reading that would tell a customer the shop was out.
   */
  const tile = grid.find((p) => p.code === `${TAG}-SHIRT`)!
  ok(
    'the group tile sums its members’ stock',
    tile.stockOnHand === 6,
    `read ${tile.stockOnHand}, expected 4+0+2`,
  )
  ok(
    'and quotes its cheapest member',
    tile.priceIncl === 100,
    `read ${tile.priceIncl}, expected the 100 not the 150`,
  )

  /*
   * The order the picker shows, which is the whole reason variant_sort exists.
   * Alphabetically these sort L, M, S — nonsense on a shelf edge. attachChild
   * assigns a position so attachment order wins, and it is the order a person
   * types sizes in.
   */
  const ordered = oldWay
    .filter((p) => p.parentId === shirt)
    .sort((a, b) => a.variantSort - b.variantSort)
    .map((p) => p.axis1Value)
    .join(',')
  ok('members carry a real position, in attachment order', ordered === 'S,M,L', ordered)

  /* ── 7. The MENU DESIGNER, which arranges the same tiles ─────────────── */

  /*
   * The designer's palette is the other half of "a group is one tile". If it
   * offered the members too, a shopkeeper could drag a shirt and a medium onto
   * the same menu and get two tiles a cashier cannot tell apart — and, worse,
   * every writer in that module would then be able to single out a member:
   * moving one to its own department breaks rule 5's inheritance, and hiding
   * one leaves it answering to a picker behind a tile that is gone.
   */
  const palette = await listMenuProducts(SITE)
  const mine = palette.filter((p) => p.code.startsWith(TAG))
  ok(
    'the designer palette offers the GROUP, not its sizes',
    codes(mine) === `${TAG}-CAP,${TAG}-EMPTY,${TAG}-SHIRT`,
    codes(mine),
  )
  const paletteTile = mine.find((p) => p.code === `${TAG}-SHIRT`)!
  ok('and badges it as a group', paletteTile.hasVariants && paletteTile.variantCount === 3,
    `hasVariants=${paletteTile.hasVariants} count=${paletteTile.variantCount}`)
  ok(
    'quoting its cheapest member rather than R0.00',
    paletteTile.price === 100,
    String(paletteTile.price),
  )

  /*
   * And it has to come back in a reasonable time.
   *
   * The first version of that query put an unguarded correlated subquery on
   * every row and took NINE MINUTES on this site's 40,000 products — for a
   * shop with no variant groups at all. It is guarded by `has_variants = 1`
   * now, and this assertion is here because the failure mode is a designer
   * that simply never loads rather than an error anybody can read.
   *
   * Deliberately loose: 10s is nowhere near the ~500ms it measures at, so this
   * will not go red on a slow laptop or a cold buffer pool. It is a tripwire
   * for a return to minutes, not a benchmark.
   */
  const started = Date.now()
  await listMenuProducts(SITE)
  const took = Date.now() - started
  ok('the palette query stays off the products table’s neck', took < 10_000, `${took}ms`)

  /* Hiding a group must reach its members: LIVE_GROUP_ONLY deliberately does
     not check visible_in_pos on a child, so a parent-only write would leave
     five sizes answering to a picker behind a tile that is no longer there. */
  await setProductsVisibleInPos(SITE, [shirt], false)
  const hidden = await siteQuery<any>(
    SITE,
    `SELECT visible_in_pos FROM products WHERE id = ? OR parent_id = ?`,
    [shirt, shirt],
  )
  ok(
    'hiding a group hides its members too',
    hidden.length === 4 && hidden.every((r: any) => Number(r.visible_in_pos) === 0),
    hidden.map((r: any) => r.visible_in_pos).join(','),
  )
  await setProductsVisibleInPos(SITE, [shirt], true)
  const shown = await siteQuery<any>(
    SITE,
    `SELECT visible_in_pos FROM products WHERE id = ? OR parent_id = ?`,
    [shirt, shirt],
  )
  ok(
    'and showing it brings them back',
    shown.every((r: any) => Number(r.visible_in_pos) === 1),
    shown.map((r: any) => r.visible_in_pos).join(','),
  )

  /* Department is INHERITED (rule 5), so dragging the group's tile to another
     department has to carry the members — a group under Clothing whose mediums
     sit under Groceries is a broken record. */
  const other = await makeDepartment(`${TAG} Elsewhere`)
  await moveProductsToDepartment(SITE, [shirt], other)
  const moved = await siteQuery<any>(
    SITE,
    `SELECT department_id FROM products WHERE parent_id = ?`,
    [shirt],
  )
  ok(
    'moving a group carries its members’ department',
    moved.every((r: any) => Number(r.department_id) === other),
    moved.map((r: any) => r.department_id).join(','),
  )
  await moveProductsToDepartment(SITE, [shirt], dept)

  /* ── 8. The count is a promise about the tile ────────────────────────── */

  const counts = await tillProductCounts(SITE)
  ok(
    'the count matches what the grid will draw',
    counts[dept] === grid.length,
    `counted ${counts[dept]}, grid has ${grid.length}`,
  )

  /* ── 7. Cleanup ──────────────────────────────────────────────────────── */

  await cleanup()
  const [left] = await siteQuery<any>(
    SITE,
    `SELECT COUNT(*) AS n FROM products WHERE code LIKE '${TAG}%'`,
  )
  ok('the test leaves nothing behind', Number(left.n) === 0, String(left.n))

  console.log(fails === 0 ? '\nAll till variant checks passed.' : `\n${fails} FAILED.`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await cleanup().catch(() => {})
  process.exit(1)
})
