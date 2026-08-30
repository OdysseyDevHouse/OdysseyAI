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
  opts: { stock?: number; barcode?: string } = {},
): Promise<number> {
  await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, department_id,
                           barcode, visible_in_pos, is_archived)
     VALUES (?,?,'normal',?,?,?,1,0)`,
    [code, description, (opts.stock ?? 0).toFixed(3), departmentId, opts.barcode ?? null],
  )
  const [row] = await siteQuery<any>(SITE, 'SELECT id FROM products WHERE code = ?', [code])
  return Number(row.id)
}

async function cleanup() {
  // Children first: fk_product_parent is ON DELETE RESTRICT.
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
  const small = await makeProduct(`${TAG}-S`, 'Test shirt S', dept, { stock: 4, barcode: `${TAG}S` })
  const medium = await makeProduct(`${TAG}-M`, 'Test shirt M', dept, { stock: 0 })
  const large = await makeProduct(`${TAG}-L`, 'Test shirt L', dept, { stock: 2 })
  await attachChild(SITE, shirt, small, 'S', '')
  await attachChild(SITE, shirt, medium, 'M', '')
  await attachChild(SITE, shirt, large, 'L', '')

  const cap = await makeProduct(`${TAG}-CAP`, 'Test cap', dept, { stock: 9 })

  const empty = await makeProduct(`${TAG}-EMPTY`, 'Test empty group', dept)
  await makeParent(SITE, empty, [{ position: 1, label: 'Size' }])

  /* ── 1. The grid: groups stand for their members ─────────────────────── */

  const grid = await browseForTill(SITE, { departmentId: dept, includeVariantParents: true })
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

  const oldWay = await browseForTill(SITE, { departmentId: dept })
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

  /* ── 6. The count is a promise about the tile ────────────────────────── */

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
