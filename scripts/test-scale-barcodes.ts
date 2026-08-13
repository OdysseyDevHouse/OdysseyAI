/**
 * Scale barcodes — the money is IN the barcode, so reading it wrong is a
 * mischarge, not a glitch.
 *
 * The rule under test: the embedded value becomes a WEIGHT or a PRICE, never
 * both. resolveScan used to return it as both and no caller chose, so the
 * basket applied it as the quantity AND the unit price — value², silently.
 * The product's variable_type now decides at the source.
 *
 *   npm run test:scale-barcodes
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { parseVariableBarcode } from '../src/lib/barcodes'
import { resolveScan } from '../src/lib/site/tillSearch'
import { getSettings, setSetting } from '../src/lib/site/settings'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const stamp = Date.now().toString().slice(-6)

async function main() {
  // ── The pure parser
  const cfg = { prefix: '2', pluLength: 5, divisor: 100 }
  const parsed = parseVariableBarcode('2007770015000', cfg)
  ok('parses prefix + PLU + value', parsed?.plu === '00777' && parsed?.value === 15,
    JSON.stringify(parsed))
  ok('an ordinary EAN-13 misses quietly', parseVariableBarcode('6001234567890', cfg) === null)
  ok('a short code misses quietly', parseVariableBarcode('12345', cfg) === null)
  ok('text misses quietly', parseVariableBarcode('not-a-code', cfg) === null)

  // ── The decide-at-source rule, against real products
  const original = await getSettings(SITE, [
    'barcode_variable_prefix', 'barcode_plu_length', 'barcode_value_divisor',
  ])
  await setSetting(SITE, 'barcode_variable_prefix', '2')
  await setSetting(SITE, 'barcode_plu_length', '5')
  await setSetting(SITE, 'barcode_value_divisor', '100')

  const vat = await siteQueryOne<any>(SITE,
    "SELECT id FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")

  // PLUs that cannot collide with real data: pure digits, high range.
  const weighPlu = `98${stamp.slice(0, 3)}`
  const pricePlu = `97${stamp.slice(0, 3)}`

  const mkProduct = async (code: string, variableType: string) => {
    const res = await siteExecute(SITE,
      `INSERT INTO products (code, description, product_type, selling_vat_rate_id, purchase_vat_rate_id,
                             scale_item, variable_type)
       VALUES (?, ?, 'normal', ?, ?, 1, ?)`,
      [code, `Scale test ${variableType}`, vat?.id ?? null, vat?.id ?? null, variableType])
    return (res as any).insertId as number
  }
  const weighId = await mkProduct(weighPlu, 'weight')
  const priceId = await mkProduct(pricePlu, 'price')

  const weighScan = await resolveScan(SITE, `2${weighPlu}0012505`, null)
  ok('*** a weight barcode resolves to its product ***', weighScan?.id === weighId,
    String(weighScan?.id))
  ok('  the value becomes the QUANTITY', weighScan?.scannedQty === 12.505 || weighScan?.scannedQty === 12.5,
    String(weighScan?.scannedQty))
  ok('*** and never the price ***', weighScan?.scannedPrice === undefined,
    String(weighScan?.scannedPrice))

  const priceScan = await resolveScan(SITE, `2${pricePlu}0012505`, null)
  ok('*** a price barcode resolves to its product ***', priceScan?.id === priceId)
  ok('  the value becomes the PRICE', priceScan?.scannedPrice === 12.505 || priceScan?.scannedPrice === 12.5,
    String(priceScan?.scannedPrice))
  ok('*** and never the quantity ***', priceScan?.scannedQty === undefined,
    String(priceScan?.scannedQty))

  const plainMiss = await resolveScan(SITE, '2999990012509', null)
  ok('an unknown PLU still returns null', plainMiss === null)

  // ── The flags the till's weigh prompt rides on
  ok('scaleItem rides the till product', weighScan?.scaleItem === true)
  ok('variableType rides the till product', weighScan?.variableType === 'weight')

  // ── Cleanup — settings back exactly as found, products gone.
  await setSetting(SITE, 'barcode_variable_prefix', original.barcode_variable_prefix ?? '2')
  await setSetting(SITE, 'barcode_plu_length', original.barcode_plu_length ?? '5')
  await setSetting(SITE, 'barcode_value_divisor', original.barcode_value_divisor ?? '100')
  await siteExecute(SITE, 'DELETE FROM products WHERE id IN (?,?)', [weighId, priceId])

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await siteExecute(SITE, "DELETE FROM products WHERE description LIKE 'Scale test %'").catch(() => {})
  console.log('\nCRASHED — strays swept')
  process.exit(1)
})
