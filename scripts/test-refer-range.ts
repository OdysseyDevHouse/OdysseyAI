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
  referGroupIds,
  referGroupMethod,
  setReferGroupMethod,
} from '../src/lib/site/referRange'
import { getRefer } from '../src/lib/site/productComposition'
import { createSupplier } from '../src/lib/site/suppliers'
import { toNum } from '../src/lib/decimals'
import { derivedCode } from '../src/lib/referCodes'

const SITE = 1

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/*
 * Repeating the suffix group: the derived-code tests build codes on top of a
 * base that already carries one, so a rung reads "RG12345678-900-6". A pattern
 * allowing only ONE suffix swept the base and left the rungs behind, and a
 * leaked product code is what makes an unrelated suite fail on its first
 * assertion.
 */
const CODE_PATTERN = '^(RG)[0-9]{8}(-[0-9]+)*$'

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

  /*
   * The structure the wizard's one "Selling" column writes to. Read rather
   * than hardcoded: a literal id fails on the DATA the moment a site is set up
   * with different structures.
   */
  const defaultStructure = toNum(
    (await siteQueryOne<any>(SITE,
      'SELECT id FROM price_structures WHERE is_default = 1 ORDER BY position, id LIMIT 1'))?.id,
  )
  ok('the site has a default price structure to price into', defaultStructure > 0,
    String(defaultStructure))

  const built = await createReferRange(SITE, {
    method: 'normal',
    supplierId: sup.id,
    rows: [
      { description: 'Range single', code: `RG${stamp}`, packSize: 1, costExcl: 10, supplierCode: 'SGL',
        prices: { [defaultStructure]: 15 } },
      { description: 'Range six', code: `RG${stamp}-6`, packSize: 6, costExcl: 60, supplierCode: 'SIX',
        prices: { [defaultStructure]: 85 } },
      { description: 'Range case', code: `RG${stamp}-24`, packSize: 24, costExcl: 240, supplierCode: 'CSE',
        prices: { [defaultStructure]: 330 } },
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

  /*
   * ── The selling price of EVERY rung ──────────────────────────────────────
   *
   * The wizard prices each pack size — there is a Selling column, a "fill down
   * by pack size" button and a margin shown against it — and none of it used
   * to reach the server: the row it submitted carried costExcl and simply left
   * `prices` out. Every range was therefore created with the costs saved and
   * every shelf price at nothing, and the six-pack rang up at 0.00 until
   * somebody opened it and re-typed the price they had already typed.
   *
   * Asserted per rung rather than "some price row exists": the cost cascade
   * (recostFromBase) rewrites costs UP the ladder afterwards, and a check that
   * only counted rows would pass just as happily if every rung ended up on the
   * base's price.
   */
  const priceOf = async (id: number) =>
    toNum((await siteQueryOne<any>(SITE,
      'SELECT selling_price_incl FROM product_prices WHERE product_id = ? AND price_structure_id = ?',
      [id, defaultStructure]))?.selling_price_incl)

  const costOf = async (id: number) =>
    toNum((await siteQueryOne<any>(SITE,
      'SELECT last_cost FROM products WHERE id = ?', [id]))?.last_cost)

  ok('*** the base rung kept the price it was given ***', (await priceOf(single)) === 15,
    String(await priceOf(single)))
  ok('*** so did the six-pack — its OWN price, not the base\'s ***', (await priceOf(six)) === 85,
    String(await priceOf(six)))
  ok('*** and the case ***', (await priceOf(box)) === 330, String(await priceOf(box)))

  // A rung priced at nothing must not write a 0.00 shelf price: the wizard
  // sends no `prices` for an empty box, and empty is not "sells for nothing".
  const unpriced = await createReferRange(SITE, {
    method: 'normal',
    rows: [
      { description: 'Unpriced single', code: `RG${stamp}-500`, packSize: 1, costExcl: 4 },
      { description: 'Unpriced six', code: `RG${stamp}-506`, packSize: 6 },
    ],
  })
  ok('a range with no prices is still created', unpriced.ok, unpriced.ok ? '' : unpriced.error)
  if (unpriced.ok) {
    const rows = await siteQuery<any>(SITE,
      `SELECT product_id FROM product_prices WHERE product_id IN (?, ?)`,
      [unpriced.productIds[0], unpriced.productIds[1]])
    ok('*** and a blank price box writes NO price row, not a 0.00 one ***', rows.length === 0,
      `${rows.length} row(s)`)
  }

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
  // It asked for 'subtract', but the single already runs a 'normal' ladder and
  // the method belongs to the group. Joining a ladder does not re-decide it.
  ok("*** and it keeps the existing ladder's method, ignoring the one asked for ***",
    extended.ok && (await getRefer(SITE, extended.productIds[1]))?.method === 'normal',
    extended.ok ? String((await getRefer(SITE, extended.productIds[1]))?.method) : '')

  /*
   * WHAT WAS TYPED ON THE EXISTING ROW HAS TO BE SAVED.
   *
   * The wizard offers a cost and a selling price on every line, including the
   * one holding a product that already exists — and that is nearly always
   * line 1, because the dialog opens off that product's Refer tab. Those two
   * figures used to be dropped: `prepared` is null for an existing row, so the
   * build loop pushed the id and moved on.
   *
   * The result was the wrong way round from anything you would guess. The
   * six-pack and the case, both freshly created, came out priced correctly —
   * and the single they were built FROM sat at 0.00 with no shelf price. It
   * also survived the recost afterwards only because cascadeCompositionCosts
   * refuses to write a zero, so the packs kept the costs typed against them
   * while the base they are supposed to derive from held nothing.
   *
   * Asserted against a base seeded with a DIFFERENT cost, so a pass cannot
   * come from the seed happening to match.
   */
  const priced = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?, 'Typed base', 'normal', 0, 0, 3, 1)`, [`RG${stamp}-600`])
  const typedBase = priced.insertId
  const typedRange = await createReferRange(SITE, {
    method: 'normal',
    rows: [
      { productId: typedBase, description: 'Typed base', packSize: 1, costExcl: 12,
        prices: { [defaultStructure]: 20 } },
      { description: 'Typed six', code: `RG${stamp}-606`, packSize: 6, costExcl: 72,
        prices: { [defaultStructure]: 110 } },
    ],
  })
  ok('a range can be built on an existing product with a cost typed on its row',
    typedRange.ok, typedRange.ok ? '' : typedRange.error)
  ok('*** the EXISTING base keeps the cost typed against it, not 0.00 ***',
    (await costOf(typedBase)) === 12, String(await costOf(typedBase)))
  ok('*** and the price typed against it too ***',
    (await priceOf(typedBase)) === 20, String(await priceOf(typedBase)))
  // The whole reason the base matters: every pack above it is derived from it.
  // 6 × 12 is the figure the ladder MEANS, and it is what the cascade writes.
  if (typedRange.ok) {
    ok('  and the pack above it derives from that cost (6 × 12)',
      (await costOf(typedRange.productIds[1])) === 72,
      String(await costOf(typedRange.productIds[1])))
  }

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

  /*
   * ── One method per GROUP ──────────────────────────────────────────────
   *
   * The method is set per stock code but stored per group: a ladder running two
   * methods at once receives stock at one level and looks for it at another.
   * Changing it anywhere has to change every link connected to it — including
   * forks, which the ladder walk cannot see.
   */
  console.log('\n── One method per group ──')

  const groupIds = await referGroupIds(SITE, six)
  const ladder = await referChain(SITE, six)
  ok('*** the group is wider than the ladder — it includes the fork ***',
    groupIds.includes(loose.insertId) && groupIds.length > ladder.length,
    `group=${groupIds.length} ladder=${ladder.length}`)
  ok('  and it is the same set read from any member',
    (await referGroupIds(SITE, single)).sort().join(',') === [...groupIds].sort().join(','))

  ok('the group reports the method its links are on',
    (await referGroupMethod(SITE, single)) === 'normal')

  const switched = await setReferGroupMethod(SITE, six, 'subtract')
  ok('*** the method can be switched from any rung ***', switched.ok,
    switched.ok ? '' : switched.error)

  const afterSwitch = await siteQuery<any>(SITE,
    `SELECT method FROM product_refers WHERE product_id IN (${groupIds.map(() => '?').join(',')})`,
    groupIds)
  ok('*** EVERY link in the group moved, not just the one ***',
    afterSwitch.length > 1 && afterSwitch.every((r: any) => String(r.method) === 'subtract'),
    afterSwitch.map((r: any) => r.method).join(','))

  // The fork is the point: it is not on the ladder referChain walks, so a
  // per-ladder change would have left it behind on the old method.
  ok('*** including the fork the ladder walk never showed ***',
    (await getRefer(SITE, loose.insertId))?.method === 'subtract')

  // A rung added afterwards joins the group's method rather than its own
  // argument — otherwise the panel could re-mix what was just made uniform.
  const joined = await addReferRung(SITE, {
    belowId: single,
    code: `RG${stamp}-3`,
    description: 'Range three',
    packSize: 3,
    method: 'normal',
  })
  ok('a rung can be added to a group already on subtract', joined.ok,
    joined.ok ? '' : joined.error)
  ok("*** and it takes the GROUP's method, not the one it asked for ***",
    joined.ok && (await getRefer(SITE, joined.productId))?.method === 'subtract',
    joined.ok ? String((await getRefer(SITE, joined.productId))?.method) : '')

  // Same rule for a range built on top of an existing ladder.
  const joinedRange = await createReferRange(SITE, {
    method: 'normal',
    rows: [
      { productId: single, description: 'Range single', packSize: 1 },
      { description: 'Range thirty-six', code: `RG${stamp}-36`, packSize: 36 },
    ],
  })
  ok('a range can be built on a group already on subtract', joinedRange.ok,
    joinedRange.ok ? '' : joinedRange.error)
  ok("*** and it joins that method too, not the wizard's dropdown ***",
    joinedRange.ok && (await getRefer(SITE, joinedRange.productIds[1]))?.method === 'subtract',
    joinedRange.ok ? String((await getRefer(SITE, joinedRange.productIds[1]))?.method) : '')

  /*
   * Stock blocks the switch, because the same figure means a different thing
   * under each method — 10 cases under normal refers is 10 cases, and under
   * subtract pack it is a label on 240 singles nobody received. The BASE is
   * exempt: its pile is the same pile either way, and refusing on it would make
   * the change impossible for any shop that has ever received the thing.
   */
  await siteExecute(SITE, 'UPDATE products SET stock_on_hand = 5 WHERE id = ?', [six])
  const blocked = await setReferGroupMethod(SITE, single, 'normal')
  ok('*** a pack with stock on hand blocks the switch ***', !blocked.ok,
    !blocked.ok ? blocked.error : '')
  ok('  and nothing moved',
    (await getRefer(SITE, six))?.method === 'subtract')

  await siteExecute(SITE, 'UPDATE products SET stock_on_hand = 0 WHERE id = ?', [six])
  await siteExecute(SITE, 'UPDATE products SET stock_on_hand = 99 WHERE id = ?', [single])
  const baseExempt = await setReferGroupMethod(SITE, single, 'normal')
  ok('*** stock on the BASE does not block it ***', baseExempt.ok,
    baseExempt.ok ? '' : baseExempt.error)
  await siteExecute(SITE, 'UPDATE products SET stock_on_hand = 0 WHERE id = ?', [single])

  /*
   * ── Unlinking a fork ──────────────────────────────────────────────────
   *
   * The panel names a fork in a warning, and now offers to unlink it there —
   * naming a problem and giving no way to act on it just moves the work to
   * another screen. removeReferRung re-reads the chain from whatever product it
   * is handed, so a fork is a rung of its OWN chain and needs no special path.
   *
   * Left until after the group tests, which need the fork to still exist.
   */
  console.log('\n── Unlinking a fork ──')

  /*
   * A fork built for the purpose: a leaf hanging off the base, on nothing and
   * with nothing on it. Scavenging "the first fork on the chain" picks up a
   * rung the ladder is BUILT ON by this point in the script, and removing that
   * legitimately shortens it — which says nothing about unlinking a fork.
   */
  const leaf = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?, 'Fork leaf', 'refer', 0, 0, 5, 1)`, [`RG${stamp}-777`])
  await siteExecute(SITE,
    'INSERT INTO product_refers (product_id, target_id, factor, method) VALUES (?,?,?,?)',
    [leaf.insertId, single, 7, 'subtract'])

  const beforeFork = await referChain(SITE, single)
  ok('the leaf shows up as a fork, not as a rung',
    beforeFork.flatMap((r) => r.alsoDrawnOnBy).some((o) => o.productId === leaf.insertId) &&
      !beforeFork.some((r) => r.productId === leaf.insertId))

  const unlinked = await removeReferRung(SITE, leaf.insertId)
  ok('*** a fork can be unlinked from the ladder it hangs off ***', unlinked.ok,
    unlinked.ok ? '' : unlinked.error)
  ok('  and the link is actually gone', (await getRefer(SITE, leaf.insertId)) === null)

  const afterFork = await referChain(SITE, single)
  ok('*** the ladder it hung off is untouched ***',
    afterFork.length === beforeFork.length,
    `${beforeFork.length} -> ${afterFork.length}`)
  ok('  and the warning has one fewer entry',
    afterFork.flatMap((r) => r.alsoDrawnOnBy).length <
      beforeFork.flatMap((r) => r.alsoDrawnOnBy).length,
    `${beforeFork.flatMap((r) => r.alsoDrawnOnBy).length} -> ${afterFork.flatMap((r) => r.alsoDrawnOnBy).length}`)

  /*
   * Two packs on the same rung, both re-pointed when it goes. The old code
   * followed one branch of a display walk and re-pointed only the winner,
   * stranding the other on a link that no longer existed.
   */
  const mid = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?, 'Doomed middle', 'refer', 0, 0, 5, 1)`, [`RG${stamp}-800`])
  const upA = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?, 'Above A', 'refer', 0, 0, 5, 1)`, [`RG${stamp}-801`])
  const upB = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?, 'Above B', 'refer', 0, 0, 5, 1)`, [`RG${stamp}-802`])
  const ins = (p: number, t: number, f: number) => siteExecute(SITE,
    'INSERT INTO product_refers (product_id, target_id, factor, method) VALUES (?,?,?,?)',
    [p, t, f, 'subtract'])
  await ins(mid.insertId, single, 2)
  await ins(upA.insertId, mid.insertId, 3)
  await ins(upB.insertId, mid.insertId, 5)

  ok('*** a rung with TWO packs above it can be removed ***',
    (await removeReferRung(SITE, mid.insertId)).ok)
  const a = await getRefer(SITE, upA.insertId)
  const b = await getRefer(SITE, upB.insertId)
  ok('*** BOTH were re-pointed at the base, neither stranded ***',
    a?.targetId === single && b?.targetId === single,
    `A->${a?.targetId} B->${b?.targetId} (base ${single})`)
  ok('  and both kept their base-unit count (3×2=6, 5×2=10)',
    a?.factor === 6 && b?.factor === 10, `A=${a?.factor} B=${b?.factor}`)

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

  /*
   * ── Setting the type to Refer on the product form ──────────────────────
   *
   * The save used to demote a refer with no link back to 'normal', to keep an
   * unsellable product out of the catalogue. But the Refer tab — the only
   * place a link can be MADE — is offered only once the type is refer, so the
   * demotion made the setting unreachable: pick Refer, save, and the dropdown
   * was quietly back on Normal with the tab gone. Nothing said why.
   *
   * So the type sticks, and the sale path keeps the invariant instead: a refer
   * with no link yet is half-finished, and the till refuses it by NAME. Both
   * halves are asserted here, because keeping the type is only safe while that
   * refusal holds.
   */
  console.log('\n── Choosing Refer on the product form ──')

  const { updateProduct, getProduct } = await import('../src/lib/site/products')
  const { resolveComponents, saveRefer } = await import('../src/lib/site/productComposition')

  /* Seeded by INSERT rather than createProduct, which refuses on a store with
     no VAT number registered — a setup rule that has nothing to do with this. */
  const switcher = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?, 'Type switch', 'normal', 0, 0, 5, 1)`, [`RG${stamp}-900`])
  const madeId = switcher.insertId

  /* `prices` is dropped from the spread deliberately: getProduct returns the
     price ROWS, while ProductInput wants { structureId: incl }, and handing one
     shape to the other fails inside the price writer rather than here. */
  const { prices: _ignored, ...beforeSwitch } = (await getProduct(SITE, madeId)) as any
  const saved = await updateProduct(SITE, madeId, {
    ...beforeSwitch,
    code: `RG${stamp}-900`,
    description: 'Type switch',
    productType: 'refer',
  })
  ok('saving an existing product as a Refer is accepted', saved.ok,
    saved.ok ? '' : (saved as any).error)
  ok('*** and the type STAYS refer, rather than reverting to normal ***',
    (await typeOf(madeId)) === 'refer', await typeOf(madeId))

  // The invariant that lets the type stand: unsellable until it is linked, and
  // refused in words that name the missing link rather than silently changed.
  const resolved = await resolveComponents(SITE, madeId, 'refer').catch(() => null)
  ok('*** but it is still refused at the till while nothing is linked ***',
    resolved !== null && !resolved.ok,
    resolved && !resolved.ok ? resolved.error : String(resolved))

  // And once a link exists it resolves — which is the point of keeping the
  // type: the Refer tab is reachable now, and finishes the job.
  const nowLinked = await saveRefer(SITE, madeId, single, 6, 'normal')
  ok('  a link can then be made on the Refer tab', nowLinked.ok,
    nowLinked.ok ? '' : (nowLinked as any).error)
  const afterLink = await resolveComponents(SITE, madeId, 'refer').catch(() => null)
  ok('*** and now it resolves and can be sold ***', afterLink !== null && afterLink.ok,
    afterLink && !afterLink.ok ? afterLink.error : '')

  // ── Codes derived from the base rung
  console.log("\n── Codes derived from the base rung ──")

  /*
   * A pack range is ONE product in the shop head, and its rungs should read
   * that way on a stock report. Three unrelated auto-numbers made a ladder
   * impossible to pick out of a list, so the rungs above the base take the
   * base own code with the pack size after it.
   *
   * The rule itself is unit-tested here because it is what the wizard PUTS in
   * the boxes; the range below then proves the server stores exactly that.
   */
  ok("*** a rung code is the base code plus its pack size ***",
    derivedCode("AMSTEL1", 6) === "AMSTEL1-6", derivedCode("AMSTEL1", 6))
  ok("  and it follows the size that was typed",
    derivedCode("AMSTEL1", 24) === "AMSTEL1-24", derivedCode("AMSTEL1", 24))
  ok("  surrounding space on the base code is ignored",
    derivedCode("  AMSTEL1  ", 6) === "AMSTEL1-6", derivedCode("  AMSTEL1  ", 6))
  // No opinion rather than a guess: the caller falls back to auto-numbering.
  ok("*** no base code yields no derived code, not \"-6\" ***",
    derivedCode("", 6) === "", derivedCode("", 6))
  ok("  a pack size of zero yields none either",
    derivedCode("AMSTEL1", 0) === "", derivedCode("AMSTEL1", 0))
  /*
   * products.code is VARCHAR(48). A suffix that would overflow it falls back
   * to auto-numbering rather than being saved truncated — a truncated code no
   * longer matches the base it came from, and could collide with a real one.
   */
  ok("*** a code that would exceed 48 characters is declined ***",
    derivedCode("X".repeat(47), 6) === "", "len " + derivedCode("X".repeat(47), 6).length)
  ok("  and one that exactly fits is kept",
    derivedCode("X".repeat(46), 6).length === 48, "len " + derivedCode("X".repeat(46), 6).length)

  // Now the whole range, saved with the codes the wizard would have offered.
  const codeBase = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?, "Amstel single", "normal", 0, 0, 12, 1)`, [`RG${stamp}-910`])
  const derivedRange = await createReferRange(SITE, {
    method: "normal",
    rows: [
      { productId: codeBase.insertId, description: "Amstel single", packSize: 1, costExcl: 12 },
      { description: "Amstel six", code: derivedCode(`RG${stamp}-910`, 6), packSize: 6, costExcl: 72 },
      { description: "Amstel case", code: derivedCode(`RG${stamp}-910`, 24), packSize: 24, costExcl: 288 },
    ],
  })
  ok("*** a range built with derived codes saves ***", derivedRange.ok,
    derivedRange.ok ? "" : derivedRange.error)
  if (derivedRange.ok) {
    const saved = await siteQuery<any>(SITE,
      "SELECT code FROM products WHERE id IN (?, ?) ORDER BY pack_size",
      [derivedRange.productIds[1], derivedRange.productIds[2]])
    ok("*** the six-pack was stored as <base>-6 ***",
      saved[0]?.code === `RG${stamp}-910-6`, String(saved[0]?.code))
    ok("*** the case was stored as <base>-24 ***",
      saved[1]?.code === `RG${stamp}-910-24`, String(saved[1]?.code))
  }

  /*
   * A derived code can COLLIDE — the shop may already sell something under it.
   * It must be refused by name rather than silently duplicated, because
   * findByBarcode-style lookups take the first match and the till would ring
   * up whichever product was created first.
   */
  await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?, "Already using that code", "normal", 0, 0, 1, 1)`, [`RG${stamp}-920-6`])
  const clashBase = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?, "Clash base", "normal", 0, 0, 1, 1)`, [`RG${stamp}-920`])
  const codeClash = await createReferRange(SITE, {
    method: "normal",
    rows: [
      { productId: clashBase.insertId, description: "Clash base", packSize: 1, costExcl: 1 },
      { description: "Clash six", code: derivedCode(`RG${stamp}-920`, 6), packSize: 6, costExcl: 6 },
    ],
  })
  ok("*** a derived code already in use is refused, not duplicated ***", !codeClash.ok,
    codeClash.ok ? "created anyway" : codeClash.error)

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
