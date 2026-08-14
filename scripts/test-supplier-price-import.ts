/**
 * Supplier price import — a price list lands in supplier_prices, nowhere else.
 *
 * THE RULE THIS EXISTS TO PROVE: rows write what the supplier SAID they would
 * charge (supplier_prices, effective-dated, upserting) and never touch
 * product_suppliers.last_cost — what we happened to PAY, which only a goods
 * receipt may move.
 *
 * Also proved: product resolution by our code, by main barcode, and by a 143
 * alias barcode; an ambiguous barcode is refused BY NAME rather than guessed;
 * and re-importing a corrected line fixes it rather than stacking a second
 * row for the same date.
 *
 *   npm run test:supplier-price-import
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { supplierPriceSpec } from '../src/lib/import/specs/supplierPrices'
import { priceFor } from '../src/lib/site/supplierPrices'
import type { ApplyContext } from '../src/lib/import/spec'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const CODE_PATTERN = '^ZSP[0-9]{8}'
const SUP_CODE_LIKE = 'ZSP%'

async function sweepStrays() {
  const products = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  await siteExecute(SITE, `DELETE FROM supplier_prices WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM product_barcodes WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  await siteExecute(SITE,
    `DELETE FROM suppliers WHERE code LIKE '${SUP_CODE_LIKE}' AND name LIKE 'ZSP %'`)
}

async function main() {
  await sweepStrays()
  const stamp = Date.now().toString().slice(-8)

  /* ── Fixtures ────────────────────────────────────────────────────────── */

  const supplier = await siteExecute(SITE,
    `INSERT INTO suppliers (code, name) VALUES (?, 'ZSP price list supplier')`,
    [`ZSP${stamp.slice(0, 4)}`])
  const supplierCode = `ZSP${stamp.slice(0, 4)}`

  const makeProduct = async (suffix: string, barcode: string | null) => {
    const r = await siteExecute(SITE,
      `INSERT INTO products (code, description, barcode, product_type, last_cost, average_cost)
       VALUES (?,?,?,'normal',5,5)`,
      [`ZSP${stamp}${suffix}`, `Price import ${suffix}`, barcode])
    return r.insertId as number
  }

  const byCode = await makeProduct('A', null)
  const byBarcode = await makeProduct('B', `710${stamp}0`)
  const byAlias = await makeProduct('C', null)
  await siteExecute(SITE, 'INSERT INTO product_barcodes (product_id, barcode) VALUES (?,?)',
    [byAlias, `710${stamp}1`])
  // Two products sharing one MAIN barcode — legal, and exactly the ambiguity
  // the import must refuse to guess through.
  const sharedOne = await makeProduct('D', `710${stamp}9`)
  await makeProduct('E', `710${stamp}9`)
  void sharedOne

  const lookups = await supplierPriceSpec.loadLookups(SITE)
  const ctx: ApplyContext = {
    siteId: SITE,
    actor: { userId: 1, userName: 'Price Import Test' },
    lookups,
    mapped: new Set(['supplierCode', 'productCode', 'barcode', 'costExcl', 'effectiveFrom', 'packSize']),
  }
  const apply = (draft: Record<string, unknown>, existingId: number | null = null) =>
    supplierPriceSpec.applyRow!(ctx, draft, existingId, 'update')

  /* ── 1. The lookups know the barcodes ────────────────────────────────── */

  ok('*** the barcode lookup carries main barcodes ***',
    lookups.productIdByBarcode.get(`710${stamp}0`) === byBarcode)
  ok('  and the 143 aliases', lookups.productIdByBarcode.get(`710${stamp}1`) === byAlias)
  ok('  a barcode two products share is ambiguous, not first-wins',
    lookups.barcodeAmbiguous.has(`710${stamp}9`) && !lookups.productIdByBarcode.has(`710${stamp}9`))

  /* ── 2. Validation refuses what cannot resolve ───────────────────────── */

  const v = supplierPriceSpec.validateRow!
  ok('*** a row naming no product is refused ***',
    v({ supplierCode, costExcl: 10 }, lookups) !== null)
  ok('  an ambiguous barcode is refused by name',
    /More than one product/.test(v({ supplierCode, barcode: `710${stamp}9`, costExcl: 10 }, lookups) ?? ''),
    v({ supplierCode, barcode: `710${stamp}9`, costExcl: 10 }, lookups) ?? 'passed')
  ok('  an unknown barcode is refused',
    v({ supplierCode, barcode: '000000000000', costExcl: 10 }, lookups) !== null)
  ok('  a clean row passes', v({ supplierCode, barcode: `710${stamp}0`, costExcl: 10 }, lookups) === null)

  /* ── 3. Applying writes supplier_prices — and nothing else ───────────── */

  const r1 = await apply(
    { supplierCode, productCode: `ZSP${stamp}A`, costExcl: 11.5, effectiveFrom: '2026-08-01', packSize: 6 },
    byCode,
  )
  ok('*** a row lands by OUR product code ***', r1.status === 'updated', r1.reason ?? '')
  const p1 = await priceFor(SITE, supplier.insertId, byCode, '2026-08-14')
  ok('  and reads back through the app\'s own effective-date rule',
    p1 !== null && Math.abs(p1.costExcl - 11.5) < 0.0005 && p1.packSize === 6,
    JSON.stringify({ cost: p1?.costExcl, pack: p1?.packSize }))

  const links = await siteQuery<any>(SITE,
    'SELECT product_id FROM product_suppliers WHERE product_id IN (?,?,?)', [byCode, byBarcode, byAlias])
  ok('*** product_suppliers.last_cost is untouched — no link rows appeared ***',
    links.length === 0, `${links.length} rows`)

  const r2 = await apply({ supplierCode, barcode: `710${stamp}0`, costExcl: 8.25, effectiveFrom: '2026-08-01' })
  ok('*** a row lands by MAIN barcode when the code column is blank ***',
    r2.status === 'created', r2.reason ?? '')
  ok('  against the right product',
    (await priceFor(SITE, supplier.insertId, byBarcode, '2026-08-14'))?.costExcl === 8.25)

  const r3 = await apply({ supplierCode, barcode: `710${stamp}1`, costExcl: 3.1, effectiveFrom: '2026-08-01' })
  ok('*** a row lands by ALIAS barcode too ***', r3.status === 'created', r3.reason ?? '')
  ok('  against the product holding the alias',
    (await priceFor(SITE, supplier.insertId, byAlias, '2026-08-14'))?.costExcl === 3.1)

  /* ── 4. Corrections upsert; history stays ────────────────────────────── */

  await apply({ supplierCode, productCode: `ZSP${stamp}A`, costExcl: 12.0, effectiveFrom: '2026-08-01' }, byCode)
  const rows = await siteQuery<any>(SITE,
    `SELECT cost_excl FROM supplier_prices WHERE product_id = ? AND effective_from = '2026-08-01'`, [byCode])
  ok('*** re-importing a corrected line FIXES it, one row per date ***',
    rows.length === 1 && Math.abs(Number(rows[0].cost_excl) - 12.0) < 0.0005,
    `${rows.length} rows at ${rows[0]?.cost_excl}`)

  await apply({ supplierCode, productCode: `ZSP${stamp}A`, costExcl: 13.0, effectiveFrom: '2026-09-01' }, byCode)
  const august = await priceFor(SITE, supplier.insertId, byCode, '2026-08-14')
  const september = await priceFor(SITE, supplier.insertId, byCode, '2026-09-14')
  ok('  a future-dated list waits its turn',
    Math.abs((august?.costExcl ?? 0) - 12.0) < 0.0005 && Math.abs((september?.costExcl ?? 0) - 13.0) < 0.0005,
    `aug=${august?.costExcl} sep=${september?.costExcl}`)

  /* ── 5. Failures name the problem ────────────────────────────────────── */

  const bad = await apply({ supplierCode: 'NOSUCH', productCode: `ZSP${stamp}A`, costExcl: 5 }, byCode)
  ok('an unknown supplier fails by name', bad.status === 'failed' && /NOSUCH/.test(bad.reason ?? ''))
  const badProduct = await apply({ supplierCode, productCode: 'NOSUCHCODE', costExcl: 5 }, null)
  ok('an unknown product fails by name',
    badProduct.status === 'failed' && /NOSUCHCODE/.test(badProduct.reason ?? ''))

  /* ── Clean up ────────────────────────────────────────────────────────── */

  await sweepStrays()
  const leftovers = await siteQueryOne<any>(
    SITE, `SELECT COUNT(*) AS n FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  ok('the run leaves nothing behind', Number(leftovers?.n ?? 1) === 0)

  console.log(fails === 0 ? '\nAll supplier price import checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
