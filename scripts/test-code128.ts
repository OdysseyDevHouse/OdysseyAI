/**
 * CODE128 and the label data — what puts a scannable price on a shelf edge.
 *
 * The encoder is pinned against hand-computed symbol values (get the checksum
 * wrong and every label in the shop scans as nothing), and labelItems is
 * checked for the one behaviour that justifies its existence: a schedule's
 * labels show the SCHEDULED price, printed before it fires.
 */

import { encodeCode128, code128Bars } from '../src/lib/labels/code128'
import { labelItems } from '../src/lib/site/labels'
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const SITE = 1

async function main() {
  console.log('\n── The encoder, pinned ─────────────────────────────────────\n')

  /* "ABC" in Code B: start 104, A=33, B=34, C=35.
     checksum = (104 + 33·1 + 34·2 + 35·3) mod 103 = 310 mod 103 = 1. */
  ok('*** "ABC" encodes with the hand-computed checksum ***',
      JSON.stringify(encodeCode128('ABC')) === JSON.stringify([104, 33, 34, 35, 1, 106]),
      JSON.stringify(encodeCode128('ABC')))

  /* All digits, even count → Code C: start 105, pairs 12,34.
     checksum = (105 + 12·1 + 34·2) mod 103 = 185 mod 103 = 82. */
  ok('*** an even digit run picks Code C ***',
      JSON.stringify(encodeCode128('1234')) === JSON.stringify([105, 12, 34, 82, 106]),
      JSON.stringify(encodeCode128('1234')))

  const ean = encodeCode128('5449000000996')
  ok('an EAN-13 (13 digits) encodes', ean !== null)
  ok('…mostly in Code C (short symbol stream)', (ean?.length ?? 99) <= 11, String(ean?.length))

  ok('mixed content switches sets', encodeCode128('AB1234567890') !== null)
  ok('the empty string refuses', encodeCode128('') === null)
  ok('control characters refuse', encodeCode128('AB') === null)
  ok('non-ASCII refuses (no silent mangling)', encodeCode128('Aé') === null)

  const bars = code128Bars('ABC')
  ok('bars carry quiet zones', bars !== null && bars.bars[0].x === 10)
  ok('total width includes both quiet zones',
      bars !== null && bars.totalModules === bars.bars[bars.bars.length - 1].x +
        bars.bars[bars.bars.length - 1].width + 10)

  console.log('\n── A schedule’s labels show the SCHEDULED price ────────────\n')

  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(SITE, "SELECT id FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const structure = await siteQueryOne<any>(SITE, 'SELECT id FROM price_structures WHERE is_default = 1 LIMIT 1')

  const p = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, barcode, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'service',?,?,1)`,
    [`LBL${stamp}`, `Label test ${stamp}`, `6001${stamp}`, vat?.id ?? null])
  const productId = p.insertId
  await siteExecute(SITE,
    `INSERT INTO product_prices (product_id, price_structure_id, selling_price_incl) VALUES (?,?,?)`,
    [productId, structure.id, '19.9900'])

  const sched = await siteExecute(SITE,
    `INSERT INTO price_schedules (name, status, effective_at, created_by) VALUES (?, 'armed', '2099-01-01 06:00', 'Label Test')`,
    [`Label sched ${stamp}`])
  const scheduleId = sched.insertId
  await siteExecute(SITE,
    `INSERT INTO price_schedule_lines (schedule_id, product_id, price_structure_id, old_price_incl, new_price_incl)
     VALUES (?,?,?,?,?)`,
    [scheduleId, productId, structure.id, '19.9900', '24.9900'])

  const fromSchedule = await labelItems(SITE, { kind: 'schedule', scheduleId }, structure.id)
  ok('*** the label shows the six o’clock price at five ***',
      fromSchedule[0]?.priceIncl === 24.99, String(fromSchedule[0]?.priceIncl))
  ok('…and carries the old for the strike-through', fromSchedule[0]?.wasPriceIncl === 19.99)

  const fromProducts = await labelItems(SITE, { kind: 'products', ids: [productId], qty: { [productId]: 3 } }, null)
  ok('a hand-picked label prices at the shelf', fromProducts[0]?.priceIncl === 19.99,
      String(fromProducts[0]?.priceIncl))
  ok('…and carries its qty for the sheet', fromProducts[0]?.qty === 3)
  ok('…and its barcode', fromProducts[0]?.barcode === `6001${stamp}`)

  console.log('\n── Cleanup ────────────────────────────────────────────────\n')

  await siteExecute(SITE, 'DELETE FROM price_schedule_lines WHERE schedule_id = ?', [scheduleId])
  await siteExecute(SITE, 'DELETE FROM price_schedules WHERE id = ?', [scheduleId])
  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])
  const left = await siteQuery(SITE, 'SELECT id FROM products WHERE code = ?', [`LBL${stamp}`])
  ok('test data cleaned up', left.length === 0)

  console.log(fails === 0 ? '\nAll label rules hold.\n' : `\n${fails} FAILURE(S)\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
