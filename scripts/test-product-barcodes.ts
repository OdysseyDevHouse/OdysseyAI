/**
 * Alias barcodes — the extra codes a product answers to.
 *
 * What must hold:
 *
 *   AN ALIAS SCAN IS DETERMINISTIC. The table is strictly unique, and an
 *   alias may not shadow another product's primary barcode or code — a scan
 *   that could mean two things rings up the wrong one eventually.
 *
 *   EVERY TILL PATH RESOLVES THEM: resolveScan, the type-ahead's exact rank,
 *   and the browse filter.
 */

import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  addProductBarcode,
  listProductBarcodes,
  removeProductBarcode,
  setProductBarcodes,
} from '../src/lib/site/productBarcodes'
import { resolveScan, searchForTill, browseForTill } from '../src/lib/site/tillSearch'

const SITE = 1

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(SITE, "SELECT id FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")

  const ids: number[] = []
  async function makeProduct(code: string, barcode: string | null) {
    const res = await siteExecute(SITE,
      `INSERT INTO products (code, description, product_type, barcode, selling_vat_rate_id, visible_in_pos)
       VALUES (?,?,'service',?,?,1)`,
      [code, `Barcode test ${code}`, barcode, vat?.id ?? null])
    ids.push(res.insertId)
    return res.insertId
  }

  const a = await makeProduct(`PBA${stamp}`, `PRIM${stamp}A`)
  const b = await makeProduct(`PBB${stamp}`, `PRIM${stamp}B`)

  console.log('\n── Adding and refusing ─────────────────────────────────────\n')

  const added = await addProductBarcode(SITE, a, `ALIAS${stamp}1`, 'six-pack')
  ok('an alias is added', added.ok, added.ok ? '' : added.error)
  await addProductBarcode(SITE, a, `ALIAS${stamp}2`)

  const dup = await addProductBarcode(SITE, b, `ALIAS${stamp}1`)
  ok('*** a duplicate alias is refused, naming the holder ***',
      !dup.ok && dup.error.includes(`PBA${stamp}`), dup.ok ? '' : dup.error)

  const shadowPrimary = await addProductBarcode(SITE, b, `PRIM${stamp}A`)
  ok('*** an alias cannot shadow another product’s PRIMARY barcode ***',
      !shadowPrimary.ok, shadowPrimary.ok ? '' : shadowPrimary.error)

  const shadowCode = await addProductBarcode(SITE, b, `PBA${stamp}`)
  ok('…nor its CODE', !shadowCode.ok)

  const own = await addProductBarcode(SITE, a, `PRIM${stamp}A`)
  ok('a product’s own primary is a pointless duplicate, refused', !own.ok)

  console.log('\n── Every till path resolves an alias ───────────────────────\n')

  const scanned = await resolveScan(SITE, `ALIAS${stamp}1`, null)
  ok('*** resolveScan finds by alias ***', scanned?.id === a, String(scanned?.id))
  ok('…and the product carries its alias list',
      (scanned?.barcodes ?? []).includes(`ALIAS${stamp}1`), JSON.stringify(scanned?.barcodes))

  const searched = await searchForTill(SITE, `ALIAS${stamp}2`, null)
  ok('the type-ahead finds by alias, ranked first', searched[0]?.id === a,
      JSON.stringify(searched.map((p) => p.code)))

  const browsed = await browseForTill(SITE, { term: `ALIAS${stamp}1` })
  ok('the browse filter finds by alias', browsed.some((p) => p.id === a))

  const primaryStill = await resolveScan(SITE, `PRIM${stamp}B`, null)
  ok('primaries still resolve as before', primaryStill?.id === b)

  console.log('\n── Replace-set, and the cascade ────────────────────────────\n')

  const set = await setProductBarcodes(SITE, a, [`NEW${stamp}1`, `NEW${stamp}2`, `PRIM${stamp}B`])
  ok('replace-set drops removed aliases and warns on the refusals',
      set.warnings.length === 1, JSON.stringify(set.warnings))
  const list = await listProductBarcodes(SITE, a)
  ok('the set is what survived', JSON.stringify(list.map((r) => r.barcode).sort()) ===
      JSON.stringify([`NEW${stamp}1`, `NEW${stamp}2`].sort()), JSON.stringify(list))

  await removeProductBarcode(SITE, list[0].id)
  ok('a single remove works', (await listProductBarcodes(SITE, a)).length === 1)

  // The delta-visibility rule: alias writes touch the product row.
  const touched = await siteQueryOne<any>(SITE,
    'SELECT updated_at >= NOW() - INTERVAL 60 SECOND AS fresh FROM products WHERE id = ?', [a])
  ok('*** alias writes touch products.updated_at — the offline delta sees them ***',
      Number(touched?.fresh) === 1)

  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [a])
  const orphans = await siteQuery(SITE, 'SELECT id FROM product_barcodes WHERE product_id = ?', [a])
  ok('*** deleting the product cascades its aliases ***', orphans.length === 0)

  console.log('\n── Cleanup ────────────────────────────────────────────────\n')

  for (const id of ids) {
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [id]).catch(() => {})
  }
  const left = await siteQuery(SITE, 'SELECT id FROM products WHERE code LIKE ?', [`PB%${stamp}`])
  ok('test data cleaned up', left.length === 0)

  console.log(fails === 0 ? '\nAll alias-barcode rules hold.\n' : `\n${fails} FAILURE(S)\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
