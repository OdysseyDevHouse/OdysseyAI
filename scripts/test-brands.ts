/**
 * The brand list — and specifically, that a brand in use cannot be deleted.
 *
 * THE THING THIS EXISTS TO PROVE is the delete refusal. `fk_product_brand` is
 * ON DELETE SET NULL, so a DELETE against a brand that products carry succeeds
 * at the database and silently strips the brand off every one of them. The
 * products survive; their brand does not; nothing says so; and the old value is
 * gone, so there is no undo. deleteBrand() has to refuse that, and a test that
 * only deleted unused brands would never touch the branch that matters.
 *
 * Also proved: the name is globally unique and the clash is caught as a
 * sentence rather than a driver error, renaming to a brand's OWN name is not a
 * clash, deactivating leaves products' brand_id intact (which is what makes it
 * the safe alternative the screen offers), and the setup listing counts
 * products and includes inactive brands while the picker's listBrands() does
 * not.
 *
 *   npm run test:brands
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  createBrand,
  updateBrand,
  deleteBrand,
  setBrandActive,
  getBrand,
  listBrandsForSetup,
} from '../src/lib/site/brands'
import { listBrands } from '../src/lib/site/lookups'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/* Unique per run: the table has a global UNIQUE on the name, so a fixed
   literal would pass once and then fail on a leftover row from the run before.
   Everything created here is torn down in the finally. */
const TAG = `ZBRAND${Date.now()}`
const made: number[] = []
let productId: number | null = null

async function main() {
  // ── Create, and the name clash ────────────────────────────────────────
  const first = await createBrand(SITE, { name: `${TAG} One`, isActive: true })
  ok('creates a brand', first.ok, first.ok ? '' : first.error)
  if (!first.ok) return
  made.push(first.id)

  const dupe = await createBrand(SITE, { name: `${TAG} One`, isActive: true })
  ok('refuses a duplicate name', !dupe.ok)
  ok(
    'the refusal names the brand',
    !dupe.ok && dupe.error.includes(`${TAG} One`),
    dupe.ok ? '' : dupe.error,
  )

  // Case and surrounding space are the same name to MariaDB's collation, which
  // is what stops 'coca cola' becoming a second Coca Cola.
  const cased = await createBrand(SITE, { name: `  ${TAG.toLowerCase()} one  `, isActive: true })
  ok('refuses the same name in another case', !cased.ok, cased.ok ? 'created it anyway' : '')
  if (cased.ok) made.push(cased.id)

  const blank = await createBrand(SITE, { name: '   ', isActive: true })
  ok('refuses a blank name', !blank.ok)
  if (blank.ok) made.push(blank.id)

  const long = await createBrand(SITE, { name: 'x'.repeat(121), isActive: true })
  ok('refuses a name past the column width', !long.ok)
  if (long.ok) made.push(long.id)

  // ── Rename ────────────────────────────────────────────────────────────
  const second = await createBrand(SITE, { name: `${TAG} Two`, isActive: true })
  if (!second.ok) {
    ok('creates a second brand', false, second.error)
    return
  }
  made.push(second.id)

  const clash = await updateBrand(SITE, second.id, { name: `${TAG} One`, isActive: true })
  ok('refuses a rename onto another brand', !clash.ok)

  // The excludeId branch: saving a brand under the name it already has must
  // not see itself as a clash, or nothing could ever be edited.
  const same = await updateBrand(SITE, second.id, { name: `${TAG} Two`, isActive: false })
  ok('allows a save under its own unchanged name', same.ok, same.ok ? '' : same.error)
  const afterSame = await getBrand(SITE, second.id)
  ok('that save still applied the other field', afterSame?.isActive === false)

  // ── Listing ───────────────────────────────────────────────────────────
  const setupList = await listBrandsForSetup(SITE, true)
  ok(
    'the setup listing includes an inactive brand',
    setupList.some((b) => b.id === second.id),
  )
  const activeOnly = await listBrandsForSetup(SITE, false)
  ok(
    'the setup listing hides it when asked for active only',
    !activeOnly.some((b) => b.id === second.id),
  )
  const picker = await listBrands(SITE)
  ok(
    "the product picker's list excludes an inactive brand",
    !picker.some((b) => b.id === second.id),
  )
  ok(
    'the product picker still offers the active one',
    picker.some((b) => b.id === first.id),
  )

  // ── A brand in use ────────────────────────────────────────────────────
  /* A real product carrying the brand, because the refusal is driven by a
     COUNT over products — a fake in-memory row would prove nothing about the
     query that actually runs. */
  const prod = await siteExecute(
    SITE,
    'INSERT INTO products (code, description, brand_id) VALUES (?,?,?)',
    [TAG, `${TAG} probe product`, first.id],
  )
  productId = prod.insertId

  const counted = await getBrand(SITE, first.id)
  ok('the brand now counts one product', counted?.productCount === 1, `saw ${counted?.productCount}`)

  const refused = await deleteBrand(SITE, first.id)
  ok('REFUSES to delete a brand a product carries', !refused.ok)
  ok(
    'the refusal names the count and offers deactivating',
    !refused.ok && refused.error.includes('1 product') && refused.error.includes('deactivate'),
    refused.ok ? '' : refused.error,
  )

  // The whole point of the refusal: the product kept its brand.
  const stillBranded = await siteQueryOne<{ brand_id: number | null }>(
    SITE,
    'SELECT brand_id FROM products WHERE id = ?',
    [productId],
  )
  ok('the product kept its brand', Number(stillBranded?.brand_id) === first.id)

  // ── Deactivating is the offered way out, and must not touch products ──
  const off = await setBrandActive(SITE, first.id, false)
  ok('deactivates a brand in use', off.ok, off.ok ? '' : off.error)
  const afterOff = await siteQueryOne<{ brand_id: number | null }>(
    SITE,
    'SELECT brand_id FROM products WHERE id = ?',
    [productId],
  )
  ok(
    'deactivating left the product on the brand',
    Number(afterOff?.brand_id) === first.id,
    'this is what makes it the safe alternative to deleting',
  )
  const afterOffBrand = await getBrand(SITE, first.id)
  ok('the deactivated brand still counts its product', afterOffBrand?.productCount === 1)

  // ── Delete once nothing carries it ────────────────────────────────────
  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])
  productId = null

  const deleted = await deleteBrand(SITE, first.id)
  ok('deletes a brand once no product carries it', deleted.ok, deleted.ok ? '' : deleted.error)
  ok('the deleted brand is gone', (await getBrand(SITE, first.id)) === null)

  const twice = await deleteBrand(SITE, first.id)
  ok('deleting it again is refused rather than throwing', !twice.ok)
}

/* Litter on a UNIQUE column fails the NEXT run before its first assertion, so
   this cleans up whatever the run got as far as making — including after a
   throw, which is why it is a finally rather than the tail of main(). */
async function cleanUp() {
  if (productId !== null) {
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])
  }
  await siteExecute(SITE, 'DELETE FROM products WHERE code = ?', [TAG])
  for (const id of made) {
    await siteExecute(SITE, 'UPDATE products SET brand_id = NULL WHERE brand_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM brands WHERE id = ?', [id])
  }
}

main()
  .catch((err) => {
    fails++
    console.error('**FAIL**  threw:', err)
  })
  .then(cleanUp)
  .then(() => {
    console.log(fails === 0 ? '\nAll brand checks passed.' : `\n${fails} check(s) failed.`)
    process.exit(fails === 0 ? 0 : 1)
  })
