/**
 * The variant grid wizard — expansion, and the atomicity of the create.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-variant-grid.ts
 *
 * test-variants.ts asserts the RULES a group must obey. This asserts the thing
 * the wizard adds on top of them: that "five sizes and three colours" turns
 * into fifteen correct products, in one transaction, or into none at all.
 *
 * The assertions that matter here:
 *
 *   · THE GRID IS ALL-OR-NOTHING. A range half-created is worse than one not
 *     created: the person cannot tell which rows are missing without comparing
 *     the grid to the product list by eye, and re-running would then refuse
 *     every code that did save. So a duplicate code on row 15 must leave rows
 *     1-14 uncreated.
 *   · CHILDREN ARE REAL PRODUCTS with their own code, price and cost, and are
 *     properly attached — parent_id set, has_variants 0, both axis values
 *     stored. That is what makes the till's picker work.
 *   · THE PARENT STILL CANNOT HOLD STOCK. The wizard writes children directly
 *     rather than through attachChild, so the invariant attachChild protects
 *     has to be re-proven on this path.
 *   · variant_sort IS ASSIGNED, and continues from the end of the group when a
 *     second batch is added. Left at its default 0 both pickers fall through to
 *     their alphabetical tiebreak, which sorts S, M, L, XL to L, M, S, XL —
 *     the exact nonsense the column exists to prevent (070).
 *   · REGRID KEEPS EDITS. Typing a fourth colour must not wipe the prices just
 *     set on the first twelve rows.
 */
import { siteExecute, siteQuery } from '../src/lib/siteDb'
import {
  createVariantGrid,
  getGroup,
  isParent,
  type GridRow,
} from '../src/lib/site/productVariants'
import { recordMovement } from '../src/lib/site/stockMovements'
import { siteTransaction } from '../src/lib/siteDb'
import { buildGrid, parseAxisValues, regrid, gridProblem, codeSuffix } from '../src/lib/variantGrid'

const SITE = 1
const ACTOR = { userId: 1, userName: 'grid-test' }
const TAG = 'ZZTESTGRID'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
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
  // Prices and children first: a child is FK'd to its parent with RESTRICT.
  await siteExecute(
    SITE,
    `DELETE FROM product_prices WHERE product_id IN
       (SELECT id FROM products WHERE code LIKE '${TAG}%')`,
  )
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
  await siteExecute(
    SITE,
    `DELETE FROM products WHERE code LIKE '${TAG}%' AND parent_id IS NOT NULL`,
  )
  await siteExecute(SITE, `DELETE FROM products WHERE code LIKE '${TAG}%'`)
}

/** The rows the wizard would submit for a given grid. */
function rowsFor(
  parentCode: string,
  parentName: string,
  sizes: string[],
  colours: string[],
  sellIncl = 499,
): GridRow[] {
  return buildGrid({
    parentCode,
    parentDescription: parentName,
    axis1Values: sizes,
    axis2Values: colours,
    costExcl: 250,
    sellIncl,
  }).map((cell) => ({
    axis1: cell.axis1,
    axis2: cell.axis2,
    code: cell.code,
    description: cell.description,
    barcode: cell.barcode,
    costExcl: cell.costExcl,
    sellIncl: cell.sellIncl,
  }))
}

async function main() {
  await cleanup()

  /* ── 1. The pure expansion ───────────────────────────────────────────── */

  ok(
    'commas, newlines and tabs all separate values',
    JSON.stringify(parseAxisValues('6, 7\n8\t9;10')) === JSON.stringify(['6', '7', '8', '9', '10']),
    JSON.stringify(parseAxisValues('6, 7\n8\t9;10')),
  )
  ok(
    'a space does NOT split a value',
    JSON.stringify(parseAxisValues('Navy Blue, Black')) ===
      JSON.stringify(['Navy Blue', 'Black']),
    JSON.stringify(parseAxisValues('Navy Blue, Black')),
  )
  ok(
    'the same value twice collapses, case-insensitively',
    JSON.stringify(parseAxisValues('Black, black, BLACK')) === JSON.stringify(['Black']),
  )
  ok('a code suffix loses its punctuation', codeSuffix('Extra Large') === 'EXTRAL', codeSuffix('Extra Large'))

  const grid = buildGrid({
    parentCode: `${TAG}SHOE`,
    parentDescription: 'My Shoes',
    axis1Values: ['6', '7', '8', '9', '10'],
    axis2Values: ['Black', 'White', 'Brown'],
    costExcl: 250,
    sellIncl: 499,
  })
  ok('five sizes and three colours is fifteen rows', grid.length === 15, String(grid.length))
  ok(
    '  and axis 1 varies slowest, so it reads size by size',
    grid[0].axis1 === '6' && grid[1].axis1 === '6' && grid[3].axis1 === '7',
    grid.slice(0, 4).map((c) => `${c.axis1}/${c.axis2}`).join(' '),
  )
  ok(
    '  and each row has a readable derived code',
    grid[14].code === `${TAG}SHOE-10-BROWN`,
    grid[14].code,
  )
  ok('  and every row starts ticked', grid.every((c) => c.include))

  const oneAxis = buildGrid({
    parentCode: `${TAG}TEE`,
    parentDescription: 'Tee',
    axis1Values: ['S', 'M', 'L'],
    axis2Values: [],
    costExcl: 0,
    sellIncl: 0,
  })
  ok('a one-axis grid is just the sizes', oneAxis.length === 3, String(oneAxis.length))
  ok('  with an empty second axis', oneAxis.every((c) => c.axis2 === ''))

  /* ── 2. Regrid keeps what was edited ─────────────────────────────────── */

  const seedA = {
    parentCode: `${TAG}SHOE`,
    parentDescription: 'My Shoes',
    axis1Values: ['6', '7'],
    axis2Values: ['Black', 'White'],
    costExcl: 250,
    sellIncl: 499,
  }
  const edited = buildGrid(seedA).map((cell) =>
    cell.axis1 === '7' && cell.axis2 === 'Black'
      ? { ...cell, sellIncl: 599, code: 'HAND-TYPED', include: false }
      : cell,
  )
  const seedB = { ...seedA, axis2Values: ['Black', 'White', 'Brown'] }
  const after = regrid(seedB, edited, seedA)

  ok('adding a colour re-expands the grid', after.length === 6, String(after.length))
  const kept = after.find((c) => c.axis1 === '7' && c.axis2 === 'Black')
  ok('  and the edited price survives', kept?.sellIncl === 599, String(kept?.sellIncl))
  ok('  and the hand-typed code survives', kept?.code === 'HAND-TYPED', kept?.code)
  ok('  and so does the untick', kept?.include === false)

  const renamed = regrid(
    { ...seedA, parentDescription: 'Better Shoes' },
    buildGrid(seedA),
    seedA,
  )
  ok(
    'renaming the parent follows through to generated descriptions',
    renamed[0].description === 'Better Shoes 6 Black',
    renamed[0].description,
  )

  ok(
    'a grid with nothing ticked is refused',
    gridProblem(buildGrid(seedA).map((c) => ({ ...c, include: false }))) !== null,
  )
  ok(
    'a duplicated code is refused',
    gridProblem(buildGrid(seedA).map((c) => ({ ...c, code: 'SAME' }))) !== null,
  )
  ok('a good grid has no problem', gridProblem(buildGrid(seedA)) === null)

  /* ── 3. Creating the grid for real ───────────────────────────────────── */

  const shoe = await makeProduct(`${TAG}SHOE`, 'My Shoes')
  const made = await createVariantGrid(SITE, {
    parentId: shoe,
    axisLabels: ['Size', 'Colour'],
    rows: rowsFor(`${TAG}SHOE`, 'My Shoes', ['6', '7', '8', '9', '10'], ['Black', 'White', 'Brown']),
    priceStructureId: null,
  })

  ok('the grid creates every combination', made.ok && made.created === 15, JSON.stringify(made))
  ok('  and the product is now a parent', await isParent(SITE, shoe))

  const group = await getGroup(SITE, shoe)
  ok('  with both axes named', group?.axes.length === 2, String(group?.axes.length))
  ok(
    '  and fifteen children hanging off it',
    group?.children.length === 15,
    String(group?.children.length),
  )
  ok(
    '  each carrying both axis values',
    (group?.children ?? []).every((c) => c.axis1 !== '' && c.axis2 !== ''),
  )

  const sorts = (group?.children ?? []).map((c) => c.sort)
  ok(
    '  and a distinct sort position each, so the picker is not alphabetical',
    new Set(sorts).size === 15 && sorts.every((s) => s > 0),
    sorts.slice(0, 4).join(','),
  )

  const rows = await siteQuery<any>(
    SITE,
    `SELECT code, parent_id, has_variants, last_cost FROM products
      WHERE parent_id = ? ORDER BY variant_sort LIMIT 1`,
    [shoe],
  )
  ok(
    '  and a child is an ordinary product with a cost of its own',
    Number(rows[0].has_variants) === 0 &&
      Number(rows[0].parent_id) === shoe &&
      Math.abs(Number(rows[0].last_cost) - 250) < 0.005,
    JSON.stringify(rows[0]),
  )

  /* ── 4. The parent still cannot take stock ───────────────────────────── */

  let tookStock = false
  try {
    await siteTransaction(SITE, async (tx) => {
      await recordMovement(tx, ACTOR, {
        productId: shoe,
        movementType: 'adjustment',
        qtyChange: 5,
      })
    })
    tookStock = true
  } catch {
    tookStock = false
  }
  ok('a parent built by the wizard still refuses stock', !tookStock)

  /* ── 5. All or nothing ───────────────────────────────────────────────── */

  const before = await siteQuery<any>(
    SITE,
    `SELECT COUNT(*) AS n FROM products WHERE code LIKE '${TAG}BOOT%'`,
  )

  const boot = await makeProduct(`${TAG}BOOT`, 'My Boots')
  const clashing = rowsFor(`${TAG}BOOT`, 'My Boots', ['6', '7', '8'], ['Black', 'White'])
  // The LAST row collides with a product that already exists. Everything before
  // it is perfectly valid, which is what makes this the assertion worth making.
  clashing[clashing.length - 1].code = `${TAG}SHOE-6-BLACK`

  const refused = await createVariantGrid(SITE, {
    parentId: boot,
    axisLabels: ['Size', 'Colour'],
    rows: clashing,
    priceStructureId: null,
  })
  ok('a clashing code refuses the whole grid', !refused.ok, JSON.stringify(refused))

  const after5 = await siteQuery<any>(
    SITE,
    `SELECT COUNT(*) AS n FROM products WHERE code LIKE '${TAG}BOOT%'`,
  )
  ok(
    '  and creates NOTHING — not even the valid rows before it',
    Number(after5[0].n) === Number(before[0].n) + 1, // +1 is the parent itself
    `${before[0].n} -> ${after5[0].n}`,
  )
  ok('  and the product is not left a parent', !(await isParent(SITE, boot)))

  /* ── 6. A second batch appends to an existing group ──────────────────── */

  const second = await createVariantGrid(SITE, {
    parentId: shoe,
    axisLabels: [],
    rows: rowsFor(`${TAG}SHOE`, 'My Shoes', ['11'], ['Black', 'White', 'Brown']),
    priceStructureId: null,
  })
  ok('a second batch adds to the group', second.ok && second.created === 3, JSON.stringify(second))

  const grown = await getGroup(SITE, shoe)
  ok('  bringing it to eighteen', grown?.children.length === 18, String(grown?.children.length))

  const newSorts = (grown?.children ?? [])
    .filter((c) => c.axis1 === '11')
    .map((c) => c.sort)
  const oldTop = Math.max(
    ...(grown?.children ?? []).filter((c) => c.axis1 !== '11').map((c) => c.sort),
  )
  ok(
    '  and the new ones sort AFTER the existing ones',
    newSorts.every((s) => s > oldTop),
    `${newSorts.join(',')} vs ${oldTop}`,
  )

  const dupe = await createVariantGrid(SITE, {
    parentId: shoe,
    axisLabels: [],
    rows: rowsFor(`${TAG}SHOE`, 'My Shoes', ['11'], ['Black']).map((r) => ({
      ...r,
      code: `${TAG}SHOE-11-BLACK-2`,
    })),
    priceStructureId: null,
  })
  ok('a combination the group already has is refused', !dupe.ok, JSON.stringify(dupe))

  /* ── 7. A product holding stock cannot become a grid parent ──────────── */

  const stocked = await makeProduct(`${TAG}STOCKED`, 'Has stock', 4)
  const onStock = await createVariantGrid(SITE, {
    parentId: stocked,
    axisLabels: ['Size'],
    rows: rowsFor(`${TAG}STOCKED`, 'Has stock', ['S', 'M'], []),
    priceStructureId: null,
  })
  ok('a product holding stock cannot become a grid parent', !onStock.ok, JSON.stringify(onStock))
  const leaked = await siteQuery<any>(
    SITE,
    `SELECT COUNT(*) AS n FROM products WHERE parent_id = ?`,
    [stocked],
  )
  ok('  and no children were left behind', Number(leaked[0].n) === 0, String(leaked[0].n))

  /* ── Clean up ────────────────────────────────────────────────────────── */

  await cleanup()
  const [left] = await siteQuery<any>(
    SITE,
    `SELECT COUNT(*) AS n FROM products WHERE code LIKE '${TAG}%'`,
  )
  ok('the test leaves nothing behind', Number(left.n) === 0, String(left.n))

  console.log(fails === 0 ? '\nAll variant grid checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await cleanup().catch(() => {})
  process.exit(1)
})
