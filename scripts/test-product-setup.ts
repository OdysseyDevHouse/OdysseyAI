/**
 * The product-setup save paths behind the product form's new tabs.
 *
 * The composition ENGINE already has its own suite (test-composition.ts) which
 * proves what leaves the shelf. This covers the layer the form sits on: saving
 * a whole set at once, the single preferred supplier, and — the part that
 * matters most — that a refused save leaves the previous setup untouched rather
 * than half-written.
 *
 *   npm run test:product-setup
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { listProductSuppliers, saveProductSuppliers } from '../src/lib/site/productSuppliers'
import {
  saveRecipe,
  listRecipe,
  saveRefer,
  getRefer,
  clearRefer,
} from '../src/lib/site/productComposition'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/**
 * Codes this suite creates, so a crashed run can be swept on the next one.
 *
 * Anchored and digit-counted so the sweep can only ever match rows this file
 * made: an unanchored prefix would delete a real shop's products the first time
 * someone happened to code one "RCP…".
 */
const PRODUCT_PATTERN = '^(PSU|RCP|PTY|BUN2|REF2|SGL)[0-9]{8}$'
const SUPPLIER_PATTERN = '^(SPA|SPB)[0-9]{8}$'

async function sweepStrays() {
  const products = `(SELECT id FROM products WHERE code REGEXP '${PRODUCT_PATTERN}')`
  const suppliers = `(SELECT id FROM suppliers WHERE code REGEXP '${SUPPLIER_PATTERN}')`
  await siteExecute(SITE, `DELETE FROM product_recipes WHERE parent_id IN ${products} OR component_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM product_refers WHERE product_id IN ${products} OR target_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM product_suppliers WHERE product_id IN ${products} OR supplier_id IN ${suppliers}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${PRODUCT_PATTERN}'`)
  await siteExecute(SITE, `DELETE FROM suppliers WHERE code REGEXP '${SUPPLIER_PATTERN}'`)
}

async function newProduct(code: string, description: string, type: string): Promise<number> {
  await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost)
     VALUES (?,?,?,?,?)`,
    [code, description, type, 100, 5],
  )
  const row = await siteQueryOne<{ id: number }>(SITE, 'SELECT id FROM products WHERE code = ?', [code])
  return Number(row!.id)
}

async function newSupplier(code: string, name: string): Promise<number> {
  await siteExecute(SITE, 'INSERT INTO suppliers (code, name) VALUES (?,?)', [code, name])
  const row = await siteQueryOne<{ id: number }>(SITE, 'SELECT id FROM suppliers WHERE code = ?', [code])
  return Number(row!.id)
}

async function main() {
  await sweepStrays()
  const stamp = Date.now().toString().slice(-8)

  console.log('\n── Supplier links ────────────────────────────────────────────\n')

  const productId = await newProduct(`PSU${stamp}`, `Setup test ${stamp}`, 'normal')
  const supplierA = await newSupplier(`SPA${stamp}`, `Supplier A ${stamp}`)
  const supplierB = await newSupplier(`SPB${stamp}`, `Supplier B ${stamp}`)

  const saved = await saveProductSuppliers(SITE, productId, [
    { supplierId: supplierA, supplierCode: 'THEIR-A1', lastCost: 12.5, packSize: 6, isPreferred: true },
    { supplierId: supplierB, supplierCode: 'THEIR-B1', lastCost: 13.75, packSize: 1 },
  ])
  ok('two suppliers link', saved.ok, saved.ok ? '' : saved.error)

  let links = await listProductSuppliers(SITE, productId)
  ok('both read back', links.length === 2, String(links.length))
  const a = links.find((l) => l.supplierId === supplierA)
  ok("*** the supplier's own stock code is kept ***", a?.supplierCode === 'THEIR-A1', a?.supplierCode ?? '')
  ok('the price is kept', a?.lastCost === 12.5, String(a?.lastCost))
  ok('the pack size is kept', a?.packSize === 6, String(a?.packSize))
  ok('*** the preferred one sorts first ***', links[0].supplierId === supplierA && links[0].isPreferred)
  ok('and the other is not preferred', links.find((l) => l.supplierId === supplierB)?.isPreferred === false)

  // Replace, not merge: what the form submits IS the intended set.
  const replaced = await saveProductSuppliers(SITE, productId, [
    { supplierId: supplierB, supplierCode: 'THEIR-B2', lastCost: 14, packSize: 1, isPreferred: true },
  ])
  ok('a replacing save succeeds', replaced.ok, replaced.ok ? '' : replaced.error)
  links = await listProductSuppliers(SITE, productId)
  ok('*** the removed supplier is really gone ***', links.length === 1 && links[0].supplierId === supplierB, String(links.length))
  ok('and the survivor took its new code', links[0].supplierCode === 'THEIR-B2')

  const twoPreferred = await saveProductSuppliers(SITE, productId, [
    { supplierId: supplierA, isPreferred: true },
    { supplierId: supplierB, isPreferred: true },
  ])
  ok('*** two preferred suppliers is refused ***', !twoPreferred.ok, twoPreferred.ok ? '' : twoPreferred.error)

  const duplicate = await saveProductSuppliers(SITE, productId, [
    { supplierId: supplierA },
    { supplierId: supplierA },
  ])
  ok('the same supplier twice is refused', !duplicate.ok, duplicate.ok ? '' : duplicate.error)

  const zeroPack = await saveProductSuppliers(SITE, productId, [{ supplierId: supplierA, packSize: 0 }])
  ok('a zero pack size is refused', !zeroPack.ok, zeroPack.ok ? '' : zeroPack.error)

  const negative = await saveProductSuppliers(SITE, productId, [{ supplierId: supplierA, lastCost: -1 }])
  ok('a negative price is refused', !negative.ok, negative.ok ? '' : negative.error)

  const missing = await saveProductSuppliers(SITE, productId, [{ supplierId: 99_999_999 }])
  ok('a supplier that does not exist is refused', !missing.ok, missing.ok ? '' : missing.error)

  links = await listProductSuppliers(SITE, productId)
  ok('*** every refusal left the previous set intact ***', links.length === 1 && links[0].supplierId === supplierB, String(links.length))

  // Emptying is legitimate — a product may genuinely have no supplier.
  const cleared = await saveProductSuppliers(SITE, productId, [])
  ok('clearing every supplier is allowed', cleared.ok)
  ok('and reads back empty', (await listProductSuppliers(SITE, productId)).length === 0)

  console.log('\n── Recipe, as the form saves it ──────────────────────────────\n')

  const burger = await newProduct(`RCP${stamp}`, `Recipe ${stamp}`, 'recipe')
  const patty = await newProduct(`PTY${stamp}`, `Patty ${stamp}`, 'normal')
  const bun = await newProduct(`BUN2${stamp}`, `Bun ${stamp}`, 'normal')

  const recipe = await saveRecipe(SITE, burger, [
    { componentId: patty, qty: 2, wastagePct: 0 },
    { componentId: bun, qty: 1, wastagePct: 10 },
  ])
  ok('a recipe saves', recipe.ok, recipe.ok ? '' : recipe.error)

  let lines = await listRecipe(SITE, burger)
  ok('both ingredients read back', lines.length === 2, String(lines.length))
  ok('quantity kept', lines.find((l) => l.componentId === patty)?.qty === 2)
  ok('wastage kept', lines.find((l) => l.componentId === bun)?.wastagePct === 10)
  ok('*** position preserves the order they were added ***', lines[0].componentId === patty)

  const shorter = await saveRecipe(SITE, burger, [{ componentId: patty, qty: 3 }])
  ok('a replacing save succeeds', shorter.ok, shorter.ok ? '' : shorter.error)
  lines = await listRecipe(SITE, burger)
  ok('*** the removed ingredient is gone ***', lines.length === 1, String(lines.length))
  ok('and the survivor took its new quantity', lines[0].qty === 3)

  const selfRef = await saveRecipe(SITE, burger, [{ componentId: burger, qty: 1 }])
  ok('*** a recipe containing itself is refused ***', !selfRef.ok, selfRef.ok ? '' : selfRef.error)

  const dupeLine = await saveRecipe(SITE, burger, [
    { componentId: patty, qty: 1 },
    { componentId: patty, qty: 2 },
  ])
  ok('the same ingredient twice is refused', !dupeLine.ok, dupeLine.ok ? '' : dupeLine.error)

  const zeroQty = await saveRecipe(SITE, burger, [{ componentId: patty, qty: 0 }])
  ok('a zero quantity is refused', !zeroQty.ok, zeroQty.ok ? '' : zeroQty.error)

  const badWastage = await saveRecipe(SITE, burger, [{ componentId: patty, qty: 1, wastagePct: 100 }])
  ok('100% wastage is refused', !badWastage.ok, badWastage.ok ? '' : badWastage.error)

  const onNormal = await saveRecipe(SITE, patty, [{ componentId: bun, qty: 1 }])
  ok('*** a normal product cannot carry a recipe ***', !onNormal.ok, onNormal.ok ? '' : onNormal.error)

  console.log('\n── Refer, as the form saves it ───────────────────────────────\n')

  const sixpack = await newProduct(`REF2${stamp}`, `Six-pack ${stamp}`, 'refer')
  const single = await newProduct(`SGL${stamp}`, `Single ${stamp}`, 'normal')

  const refer = await saveRefer(SITE, sixpack, single, 6)
  ok('a refer links', refer.ok, refer.ok ? '' : refer.error)

  let link = await getRefer(SITE, sixpack)
  ok('it reads back', link?.targetId === single)
  ok('with its factor', link?.factor === 6, String(link?.factor))

  // Re-saving must update in place rather than fail on the primary key — this
  // is the path an ordinary second save through the form takes.
  const relinked = await saveRefer(SITE, sixpack, single, 12)
  ok('*** re-saving updates rather than duplicating ***', relinked.ok, relinked.ok ? '' : relinked.error)
  link = await getRefer(SITE, sixpack)
  ok('and the new factor took', link?.factor === 12, String(link?.factor))

  const selfTarget = await saveRefer(SITE, sixpack, sixpack, 1)
  ok('a refer pointing at itself is refused', !selfTarget.ok, selfTarget.ok ? '' : selfTarget.error)

  const zeroFactor = await saveRefer(SITE, sixpack, single, 0)
  ok('a zero factor is refused', !zeroFactor.ok, zeroFactor.ok ? '' : zeroFactor.error)

  const referOnNormal = await saveRefer(SITE, single, sixpack, 1)
  ok('*** a normal product cannot be a refer ***', !referOnNormal.ok, referOnNormal.ok ? '' : referOnNormal.error)

  link = await getRefer(SITE, sixpack)
  ok('*** the refused saves left the link intact ***', link?.targetId === single && link?.factor === 12)

  await clearRefer(SITE, sixpack)
  ok('unlinking works', (await getRefer(SITE, sixpack)) === null)

  await sweepStrays()

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await sweepStrays()
  console.log('\nCRASHED — strays swept')
  process.exit(1)
})
