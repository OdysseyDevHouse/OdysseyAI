/**
 * The refer wizard's engine — building a pack range in one go.
 *
 * Two things have to hold. The chain must store factors RELATIVE to the rung
 * below (12 above a 6 is a factor of 2, not 12), and the whole range must land
 * atomically — a half-created range would leave a six-pack referring to
 * nothing, indistinguishable from a deliberate setup.
 *
 *   npm run test:refer-range
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  planRange,
  createReferRange,
  referChain,
  addReferRung,
  removeReferRung,
} from '../src/lib/site/referRange'
import { getRefer } from '../src/lib/site/productComposition'
import { createSupplier } from '../src/lib/site/suppliers'
import { toNum } from '../src/lib/decimals'

const SITE = 1

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const CODE_PATTERN = '^(RG)[0-9]{8}(-[0-9]+)?$'

async function sweepStrays() {
  const where = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  await siteExecute(SITE, `DELETE FROM product_refers WHERE product_id IN ${where} OR target_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM product_prices WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM product_suppliers WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
}

async function main() {
  await sweepStrays()
  const stamp = Date.now().toString().slice(-8)

  // ── planRange: the arithmetic, with no database involved
  console.log('\n── The chain arithmetic ──')

  const good = planRange([
    { description: 'Single', packSize: 1 },
    { description: 'Six pack', packSize: 6 },
    { description: 'Case', packSize: 24 },
  ])
  ok('*** 1 / 6 / 24 is a valid chain ***', good.ok)
  ok('*** factors are RELATIVE: [_, 6, 4] not [_, 6, 24] ***',
    good.ok && good.factors[1] === 6 && good.factors[2] === 4,
    good.ok ? JSON.stringify(good.factors) : good.error)

  const notAscending = planRange([
    { description: 'A', packSize: 6 },
    { description: 'B', packSize: 6 },
  ])
  ok('a pack size that does not grow is refused', !notAscending.ok)

  const notWhole = planRange([
    { description: 'A', packSize: 6 },
    { description: 'B', packSize: 10 },
  ])
  ok('*** 10 is not a whole number of 6s, so it is refused ***', !notWhole.ok,
    !notWhole.ok ? notWhole.error : '')

  ok('a single row is not a range', !planRange([{ description: 'A', packSize: 1 }]).ok)
  ok('seven rows is too many',
    !planRange(Array.from({ length: 7 }, (_, i) => ({ description: `P${i}`, packSize: i + 1 }))).ok)

  // ── Creating a range
  console.log('\n── Creating a range ──')

  const sup = await createSupplier(SITE, { userId: 1, userName: 'Range Test' }, {
    code: `RGS${stamp}`, name: 'Range Test Wholesalers', paymentTermsDays: 30,
  })
  if (!sup.ok) { console.log('setup failed —', sup.error); process.exit(1) }

  const built = await createReferRange(SITE, {
    method: 'normal',
    supplierId: sup.id,
    rows: [
      { description: 'Range single', code: `RG${stamp}`, packSize: 1, costExcl: 10, supplierCode: 'SGL' },
      { description: 'Range six', code: `RG${stamp}-6`, packSize: 6, costExcl: 60, supplierCode: 'SIX' },
      { description: 'Range case', code: `RG${stamp}-24`, packSize: 24, costExcl: 240, supplierCode: 'CSE' },
    ],
  })
  ok('*** the range was created ***', built.ok, built.ok ? '' : built.error)
  if (!built.ok) { await sweepStrays(); process.exit(1) }

  ok('  three products created', built.created === 3, String(built.created))
  const [single, six, box] = built.productIds

  const typeOf = async (id: number) =>
    String((await siteQueryOne<any>(SITE, 'SELECT product_type FROM products WHERE id=?', [id]))?.product_type)
  ok('*** the base rung is a NORMAL product, not a refer ***', (await typeOf(single)) === 'normal',
    await typeOf(single))
  ok('  the rungs above it are refers',
    (await typeOf(six)) === 'refer' && (await typeOf(box)) === 'refer')

  const sixLink = await getRefer(SITE, six)
  const boxLink = await getRefer(SITE, box)
  ok('*** the six-pack refers to the single, factor 6 ***',
    sixLink?.targetId === single && sixLink?.factor === 6,
    `target ${sixLink?.targetId} factor ${sixLink?.factor}`)
  ok('*** the case refers to the SIX-PACK, factor 4 ***',
    boxLink?.targetId === six && boxLink?.factor === 4,
    `target ${boxLink?.targetId} factor ${boxLink?.factor}`)
  ok('  and it is NOT starred onto the single', boxLink?.targetId !== single)
  ok('*** the chosen method is on every link ***',
    sixLink?.method === 'normal' && boxLink?.method === 'normal')

  const supRows = await siteQuery<any>(SITE,
    'SELECT product_id, supplier_code FROM product_suppliers WHERE supplier_id = ? ORDER BY product_id', [sup.id])
  ok('*** each rung kept its own supplier code ***', supRows.length === 3, String(supRows.length))

  // ── Extending an existing product
  console.log('\n── Extending an existing product ──')

  const extended = await createReferRange(SITE, {
    method: 'subtract',
    rows: [
      { productId: single, description: 'Range single', packSize: 1 },
      { description: 'Range twelve', code: `RG${stamp}-12`, packSize: 12, costExcl: 120 },
    ],
  })
  ok('*** a range can start from a product that already exists ***', extended.ok,
    extended.ok ? '' : extended.error)
  ok('  and only creates the new rung', extended.ok && extended.created === 1,
    extended.ok ? String(extended.created) : '')
  ok('  reusing the existing product as rung 1',
    extended.ok && extended.productIds[0] === single)

  /*
   * The usual way in is the Refer tab of a product that is ALREADY type
   * 'refer' — so the base rung arrives as a refer with nothing under it. Left
   * that way every sale of it is refused for having no link, and the whole
   * range is unsellable.
   */
  const orphan = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?, 'Orphan base', 'refer', 0, 0, 5, 1)`, [`RG${stamp}-400`])
  const rescued = await createReferRange(SITE, {
    method: 'normal',
    rows: [
      { productId: orphan.insertId, description: 'Orphan base', packSize: 1 },
      { description: 'Orphan six', code: `RG${stamp}-406`, packSize: 6 },
    ],
  })
  ok('*** a range built on an unlinked refer product is allowed ***', rescued.ok,
    rescued.ok ? '' : rescued.error)
  ok('*** and the base becomes a NORMAL product, not a dangling refer ***',
    (await typeOf(orphan.insertId)) === 'normal', await typeOf(orphan.insertId))

  // But a base that already has a link of its own is a longer chain, not a new
  // bottom, and that link has to survive.
  const onTop = await createReferRange(SITE, {
    method: 'normal',
    rows: [
      { productId: six, description: 'Range six', packSize: 6 },
      { description: 'Range ninety-six', code: `RG${stamp}-496`, packSize: 96 },
    ],
  })
  ok('a range can be built on top of an existing chain', onTop.ok, onTop.ok ? '' : onTop.error)
  ok('*** and the existing link underneath it is untouched ***',
    (await getRefer(SITE, six))?.targetId === single && (await typeOf(six)) === 'refer')

  // ── The chain, a rung at a time (the Refer tab)
  console.log('\n── One rung at a time ──')

  const chain = await referChain(SITE, six)
  ok('*** the whole ladder is readable from ANY rung ***', chain.length === 3,
    chain.map((r) => r.code).join(' -> '))
  ok('  bottom rung first', chain[0].productId === single)
  ok('  and it knows which one you are looking at',
    chain.find((r) => r.isCurrent)?.productId === six)
  ok('*** pack size is in BASE units, not the stored factor ***',
    chain[1].packSize === 6 && chain[2].packSize === 24,
    `six=${chain[1].packSize} case=${chain[2].packSize}`)
  ok('  while the factor stays relative', chain[2].factor === 4, String(chain[2].factor))

  /*
   * The 96 added earlier ALSO draws on the six-pack, so the six-pack is a
   * fork. The walk up can only follow one branch, so the other has to be
   * reported — a pack the panel never shows is a pack nobody can fix.
   */
  const forked = chain.find((r) => r.productId === six)
  ok('*** a second pack drawing on the same rung is REPORTED, not hidden ***',
    forked?.alsoDrawnOnBy.some((o) => o.code === `RG${stamp}-496`) ?? false,
    JSON.stringify(forked?.alsoDrawnOnBy.map((o) => o.code)))
  ok('  and the ladder itself is not double-counted',
    chain[2].alsoDrawnOnBy.length === 0)

  // Adding a pack size on top, creating the product as we go.
  const added = await addReferRung(SITE, {
    belowId: box,
    code: `RG${stamp}-48`,
    description: 'Range pallet',
    packSize: 48,
    method: 'normal',
  })
  ok('*** a pack size can be added from the rung below it ***', added.ok,
    added.ok ? '' : added.error)

  const grown = await referChain(SITE, six)
  ok('  the ladder grew', grown.length === 4, String(grown.length))
  ok('*** 48 base units above a 24 stores factor 2 ***',
    grown[3].factor === 2 && grown[3].packSize === 48,
    `factor=${grown[3].factor} pack=${grown[3].packSize}`)

  // Linking one that already exists.
  const loose = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?, 'Loose pack', 'normal', 0, 0, 5, 1)`, [`RG${stamp}-96`])
  const linked = await addReferRung(SITE, {
    belowId: added.ok ? added.productId : 0,
    productId: loose.insertId,
    packSize: 96,
    method: 'normal',
  })
  ok('*** an existing product can be linked in as a pack size ***', linked.ok,
    linked.ok ? '' : linked.error)
  ok('  and it becomes a refer product', (await typeOf(loose.insertId)) === 'refer',
    await typeOf(loose.insertId))

  ok('a pack size that does not divide evenly is refused',
    !(await addReferRung(SITE, { belowId: six, packSize: 10, code: `RG${stamp}-x`, method: 'normal' })).ok)
  ok('a pack size smaller than the one below is refused',
    !(await addReferRung(SITE, { belowId: box, packSize: 2, code: `RG${stamp}-y`, method: 'normal' })).ok)
  ok('a product already on the chain cannot be added again',
    !(await addReferRung(SITE, { belowId: box, productId: six, packSize: 48, method: 'normal' })).ok)

  /*
   * Removing a middle rung has to CLOSE THE GAP. Deleting the link alone would
   * strand everything above it pointing at nothing.
   */
  const removed = await removeReferRung(SITE, box)
  ok('*** a middle rung can be removed ***', removed.ok, removed.ok ? '' : removed.error)

  // Was single -> six -> 24 -> 48 -> 96; the 24 came out and the rest closed
  // up behind it.
  const closed = await referChain(SITE, six)
  ok('  the removed rung is gone, the rest stay',
    closed.length === 4 && !closed.some((r) => r.productId === box),
    closed.map((r) => r.code).join(' -> '))
  const pallet = closed.find((r) => r.code === `RG${stamp}-48`)
  ok('*** the gap CLOSED: the pallet now draws on the six-pack ***',
    pallet?.factor === 8, `factor=${pallet?.factor}`)
  ok('*** and it still holds the same 48 base units ***', pallet?.packSize === 48,
    String(pallet?.packSize))

  ok('the base rung cannot be removed', !(await removeReferRung(SITE, single)).ok)

  // ── Refusals leave nothing behind
  console.log('\n── Refusals ──')

  const before = toNum((await siteQueryOne<any>(SITE,
    `SELECT COUNT(*) c FROM products WHERE code REGEXP '${CODE_PATTERN}'`))?.c)

  const clash = await createReferRange(SITE, {
    method: 'normal',
    rows: [
      { description: 'Clash A', code: `RG${stamp}`, packSize: 1 },
      { description: 'Clash B', code: `RG${stamp}-99`, packSize: 6 },
    ],
  })
  ok('*** a duplicate product code is refused ***', !clash.ok, !clash.ok ? clash.error : '')

  const after = toNum((await siteQueryOne<any>(SITE,
    `SELECT COUNT(*) c FROM products WHERE code REGEXP '${CODE_PATTERN}'`))?.c)
  ok('*** and NOTHING was created — the whole range rolls back ***', after === before,
    `${before} before, ${after} after`)

  const badChain = await createReferRange(SITE, {
    method: 'normal',
    rows: [
      { description: 'Bad A', code: `RG${stamp}-101`, packSize: 6 },
      { description: 'Bad B', code: `RG${stamp}-102`, packSize: 10 },
    ],
  })
  ok('a chain that cannot divide evenly is refused', !badChain.ok, !badChain.ok ? badChain.error : '')

  // A barcode already on another product must be refused, because
  // products.barcode has no unique index to catch it.
  await siteExecute(SITE, 'UPDATE products SET barcode = ? WHERE id = ?', [`BC${stamp}`, single])
  const dupBarcode = await createReferRange(SITE, {
    method: 'normal',
    rows: [
      { description: 'BC A', code: `RG${stamp}-201`, packSize: 1 },
      { description: 'BC B', code: `RG${stamp}-202`, packSize: 6, barcode: `BC${stamp}` },
    ],
  })
  ok('*** a barcode already in use is refused ***', !dupBarcode.ok,
    !dupBarcode.ok ? dupBarcode.error : '')

  const sameBarcodeTwice = await createReferRange(SITE, {
    method: 'normal',
    rows: [
      { description: 'BC C', code: `RG${stamp}-301`, packSize: 1, barcode: `BD${stamp}` },
      { description: 'BC D', code: `RG${stamp}-302`, packSize: 6, barcode: `BD${stamp}` },
    ],
  })
  ok('  and the same barcode twice within one range is too', !sameBarcodeTwice.ok)

  // ── Cleanup
  await sweepStrays()
  await siteExecute(SITE, 'DELETE FROM product_suppliers WHERE supplier_id = ?', [sup.id])
  await siteExecute(SITE, 'DELETE FROM supplier_transactions WHERE supplier_id = ?', [sup.id])
  await siteExecute(SITE, 'DELETE FROM suppliers WHERE id = ?', [sup.id])

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await sweepStrays()
  console.log('\nCRASHED — strays swept')
  process.exit(1)
})
