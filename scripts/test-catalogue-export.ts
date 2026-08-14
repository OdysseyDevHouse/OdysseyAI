/**
 * Catalogue export — the round trip is the feature.
 *
 * THE CLOSURE THIS EXISTS TO PROVE: every column the export writes has an
 * import field whose aliases match its heading, so export → edit in Excel →
 * import maps every column automatically. The headings are taken from the
 * spec at run time, so this cannot drift — but the test still proves it,
 * because "cannot drift by construction" is a claim about code that someone
 * will one day edit.
 *
 * Also proved: Opening Stock is deliberately absent (stock is a consequence
 * of movements), alias barcodes come out |-joined the way the import reads
 * them in, and lookups round-trip as the NAMES the import resolves, not ids.
 *
 *   npm run test:catalogue-export
 */
import { siteExecute, siteQuery } from '../src/lib/siteDb'
import { catalogueExport } from '../src/lib/export/products'
import { productSpec } from '../src/lib/import/specs/products'
import { fieldsFor } from '../src/lib/import/spec'
import { normaliseHeader } from '../src/lib/import/text'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const CODE_PATTERN = '^ZCE[0-9]{8}'

async function sweepStrays() {
  const products = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  await siteExecute(SITE, `DELETE FROM product_barcodes WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM product_prices WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
}

async function main() {
  await sweepStrays()
  const stamp = Date.now().toString().slice(-8)

  /* ── Fixture: a product with everything the export carries ───────────── */

  const vat = await siteQuery<any>(
    SITE, "SELECT id, code FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const structure = await siteQuery<any>(
    SITE, 'SELECT id, name FROM price_structures WHERE is_default=1 LIMIT 1')

  const created = await siteExecute(SITE,
    `INSERT INTO products (code, description, barcode, product_type, last_cost, average_cost, selling_vat_rate_id)
     VALUES (?,?,?,'normal',7.5,7.5,?)`,
    [`ZCE${stamp}A`, 'Catalogue export test', `600${stamp}0`, vat[0]?.id ?? null])
  const productId = created.insertId

  await siteExecute(SITE,
    'INSERT INTO product_barcodes (product_id, barcode) VALUES (?,?),(?,?)',
    [productId, `600${stamp}1`, productId, `600${stamp}2`])
  if (structure[0]) {
    await siteExecute(SITE,
      'INSERT INTO product_prices (product_id, price_structure_id, selling_price_incl) VALUES (?,?,19.99)',
      [productId, structure[0].id])
  }

  /* ── 1. The closure: every export heading maps to an import field ────── */

  const { columns, rows } = await catalogueExport(SITE)
  const lookups = await productSpec.loadLookups(SITE)
  const fields = fieldsFor(productSpec, lookups)

  const unmapped = columns.filter(
    (c) => !fields.some((f) => f.aliases.some((a) => normaliseHeader(a) === normaliseHeader(c.header))),
  )
  ok('*** every export heading matches an import alias ***',
    unmapped.length === 0, unmapped.map((c) => c.header).join(', ') || `${columns.length} columns`)

  ok('  and each heading is its field\'s FIRST alias — the template\'s own spelling',
    columns.every((c) => fields.some((f) => f.aliases[0] === c.header)))

  ok('*** Opening Stock is deliberately absent ***',
    !columns.some((c) => normaliseHeader(c.header) === normaliseHeader('Opening Stock')),
    'stock is a consequence of movements, not a column to re-import')

  const priceField = structure[0]
    ? fields.find((f) => f.key === `price:${structure[0].id}`)
    : undefined
  ok('  the dynamic price columns are in the closure too',
    !structure[0] || (priceField !== undefined && columns.some((c) => c.header === priceField!.aliases[0])))

  /* ── 2. The fixture row, as exported ─────────────────────────────────── */

  const record = rows.find((r) => r.code === `ZCE${stamp}A`)
  const cell = (header: string) => {
    const column = columns.find((c) => c.header === header)
    return column && record ? column.value(record) : undefined
  }

  ok('*** the product is in the file ***', record !== undefined)
  ok('  the main barcode rides its own column', cell('Barcode') === `600${stamp}0`)
  ok('  alias barcodes come out |-joined, the import\'s own separator',
    cell('Extra Barcodes') === `600${stamp}1|600${stamp}2`, String(cell('Extra Barcodes')))
  ok('  cost is a NUMBER, not a formatted string',
    typeof cell('Cost') === 'number' && Math.abs((cell('Cost') as number) - 7.5) < 0.001)
  ok('  VAT comes out as the CODE the import resolves',
    !vat[0] || cell('Selling VAT') === String(vat[0].code), String(cell('Selling VAT')))
  ok('  booleans come out as the Yes/No the import parses',
    cell('Show On Till') === 'Yes' || cell('Show On Till') === 'No')
  if (structure[0] && priceField) {
    ok('  the price landed in its structure\'s column',
      Math.abs(Number(cell(priceField.aliases[0])) - 19.99) < 0.005,
      String(cell(priceField.aliases[0])))
  }

  /* ── Clean up ────────────────────────────────────────────────────────── */

  await sweepStrays()
  const leftovers = await siteQuery<any>(
    SITE, `SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  ok('the run leaves nothing behind', leftovers.length === 0)

  console.log(fails === 0 ? '\nAll catalogue export checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
