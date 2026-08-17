/**
 * An order placed on a group storefront must land in the BRANCH's database.
 *
 * This is the assertion the whole feature exists for. A chain's head office owns
 * the product file; the shop that will pack the order owns the order, the stock
 * it moves and the money it takes. If this suite passes and every other one
 * fails, the feature still works. If this one fails, nothing else matters.
 *
 * The negative assertion is as important as the positive: the order must NOT
 * also appear at head office. A row written to both databases would be filled
 * twice and paid for once.
 *
 *   npm run test:multistore-orders
 */
import { createPublicStoreToken } from '../src/lib/publicStoreToken'
import { resolveStoreRouting } from '../src/lib/storeRouting'
import { storefrontContext, placePublicOrder, publishedProducts } from '../src/lib/site/storefront'
import { branchProductsByCode, translateToBranch } from '../src/lib/site/branchCatalogue'
import { groupForSite, membersOfGroup, setGroupOnlineMode } from '../src/lib/storeGroups'
import { branchPinsFor, setBranchPin, syncBranchPin } from '../src/lib/control/storeBranches'
import { addModule, entitlementsForSite, has as hasModule } from '../src/lib/control/modules'
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { execute, queryOne } from '../src/lib/db'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const undo: (() => Promise<void>)[] = []
  const placedOrderIds: { siteId: number; orderId: number }[] = []

  const group = await groupForSite(1)
  if (!group) {
    console.log('SKIP  site 1 is in no store group')
    process.exit(0)
  }
  const members = await membersOfGroup(group.id)
  const PRIMARY = group.primarySiteId ?? members[0].siteId
  const branchMember = members.find((m) => m.siteId !== PRIMARY && m.hasDatabase)
  if (!branchMember) {
    console.log('SKIP  the group has only one usable store')
    process.exit(0)
  }
  const BRANCH = branchMember.siteId
  console.log(`  catalogue = site ${PRIMARY}, branch = site ${BRANCH}`)

  // ── Lend both stores what a group storefront needs ────────────────────────
  for (const siteId of [PRIMARY, BRANCH]) {
    const ent = await entitlementsForSite(siteId)
    if (!hasModule(ent, 'online_store')) {
      await addModule(siteId, 'online_store', { name: 'test', email: null }, null)
      const row = await queryOne<{ id: number }>(
        `SELECT id FROM cp2_site_modules WHERE site_id = ? AND module_key = 'online_store'
          ORDER BY id DESC LIMIT 1`,
        [siteId],
      )
      if (row) undo.push(async () => void (await execute('DELETE FROM cp2_site_modules WHERE id = ?', [row.id])))
    }
    const was = await siteQueryOne<{ is_enabled: number }>(
      siteId,
      'SELECT is_enabled FROM online_store_settings WHERE id = 1',
    )
    const previous = was?.is_enabled ?? 0
    await siteExecute(siteId, 'UPDATE online_store_settings SET is_enabled = 1 WHERE id = 1')
    undo.push(async () => {
      await siteExecute(siteId, 'UPDATE online_store_settings SET is_enabled = ? WHERE id = 1', [previous])
    })
  }

  const modeBefore = group.onlineGroupMode
  undo.push(async () => void (await setGroupOnlineMode(group.id, modeBefore)))
  const pinsBefore = await branchPinsFor([PRIMARY, BRANCH])
  undo.push(async () => {
    for (const id of [PRIMARY, BRANCH]) {
      const was = pinsBefore.find((p) => p.siteId === id)
      await setBranchPin(id, was?.latitude ?? null, was?.longitude ?? null)
    }
  })
  await syncBranchPin(PRIMARY)
  await syncBranchPin(BRANCH)
  await setBranchPin(PRIMARY, -33.9249, 18.4241)
  await setBranchPin(BRANCH, -33.9805, 18.4653)
  await setGroupOnlineMode(group.id, true)

  // ── The routing the storefront would resolve ──────────────────────────────
  console.log('\n— The storefront resolves to two shops —')
  const routing = await resolveStoreRouting(await createPublicStoreToken(BRANCH))
  ok('it is a group storefront', routing?.isGroup === true)
  ok('the catalogue is head office', routing?.catalogueSiteId === PRIMARY)
  ok('the branch is the shop that will pack it', routing?.branchSiteId === BRANCH)
  if (!routing) {
    for (const step of undo.reverse()) await step()
    console.log('\n1 FAILED.')
    process.exit(1)
  }

  const context = await storefrontContext(routing.catalogueSiteId, routing.branchSiteId)
  if (!context) {
    console.log('**FAIL**  the storefront context could not be built')
    for (const step of undo.reverse()) await step()
    process.exit(1)
  }
  ok('the context prices from the catalogue', context.catalogueSiteId === PRIMARY)
  ok('and owes from the branch', context.siteId === BRANCH)
  // Two different names for two different jobs: the shop front is head office's,
  // but a sentence about what is on the shelf must name the branch.
  ok(
    'the branch is named separately from the shop front',
    context.branchName !== context.storeName,
    `front "${context.storeName}" vs branch "${context.branchName}"`,
  )
  ok('and it is the branch’s own name', context.branchName === branchMember.displayName,
    context.branchName)

  /*
   * ── A product both shops carry ──────────────────────────────────────────
   *
   * Seeded rather than found. The demo stores are linked administratively but
   * have never shared a catalogue — 41,112 products at head office, 138 at the
   * branch, no code in common — so there is nothing real to order. Two rows
   * with the SAME CODE and deliberately different ids are also a sharper test
   * than any real pair would be: if the code translated to the wrong id, a real
   * product file might coincidentally line up and hide it.
   *
   * Both rows are removed in the cleanup below, along with anything ordered
   * against them, because a leaked row on a UNIQUE code column fails the next
   * suite rather than this one.
   */
  console.log('\n— A product both shops carry —')
  const CODE = `ZZTEST-MS-${Date.now().toString().slice(-8)}`
  const DESCRIPTION = 'Multi-store routing test item'

  const primaryDept = await siteQueryOne<{ id: number }>(
    PRIMARY,
    'SELECT id FROM departments WHERE show_online = 1 ORDER BY id LIMIT 1',
  )
  const branchDept = await siteQueryOne<{ id: number }>(
    BRANCH,
    'SELECT id FROM departments WHERE show_online = 1 ORDER BY id LIMIT 1',
  )

  for (const [siteId, deptId] of [
    [PRIMARY, primaryDept?.id ?? null],
    [BRANCH, branchDept?.id ?? null],
  ] as const) {
    /*
     * stock_on_hand stays 0 and no movement is written. An earlier version
     * seeded 50 and could not delete the row afterwards: stock_movements has an
     * FK to products, so a fixture that touches stock cannot be undone by
     * deleting the product, and the leftover row sat on a UNIQUE code column
     * waiting to fail somebody else's suite.
     *
     * Nothing here needs stock. Holds are off for a group storefront and the
     * branch judges availability when it accepts the order.
     */
    await siteExecute(
      siteId,
      `INSERT INTO products (code, description, department_id, stock_on_hand, show_online)
            VALUES (?, ?, ?, 0, 1)`,
      [CODE, DESCRIPTION, deptId],
    )
    const created = await siteQueryOne<{ id: number }>(
      siteId,
      'SELECT id FROM products WHERE code = ?',
      [CODE],
    )
    /*
     * The catalogue joins product_prices INNER, so a product with no price row
     * is not published at all — which would look like the translation failing
     * rather than the fixture being incomplete. Priced in the store's default
     * structure, the same one an anonymous shopper is quoted from.
     */
    await siteExecute(
      siteId,
      `INSERT INTO product_prices (product_id, price_structure_id, selling_price_incl)
       SELECT ?, id, 25.00 FROM price_structures WHERE is_default = 1 ORDER BY id LIMIT 1`,
      [created?.id ?? 0],
    )
    undo.push(async () => {
      /*
       * Children first, and every child that has an FK to products — not only
       * the ones this test wrote. A DELETE that fails on a constraint leaves the
       * row behind silently, and a leaked product on a UNIQUE code column fails
       * the NEXT suite rather than this one, which is a miserable thing to debug.
       */
      const ids = await siteQuery<{ id: number }>(
        siteId,
        'SELECT id FROM products WHERE code = ?',
        [CODE],
      )
      for (const { id } of ids) {
        await siteExecute(siteId, 'DELETE FROM stock_movements WHERE product_id = ?', [id])
        await siteExecute(siteId, 'DELETE FROM product_location_stock WHERE product_id = ?', [id])
        await siteExecute(siteId, 'DELETE FROM product_prices WHERE product_id = ?', [id])
        await siteExecute(siteId, 'DELETE FROM products WHERE id = ?', [id])
      }
    })
  }

  const seededPrimary = await siteQueryOne<{ id: number }>(
    PRIMARY,
    'SELECT id FROM products WHERE code = ?',
    [CODE],
  )
  const seededBranch = await siteQueryOne<{ id: number }>(
    BRANCH,
    'SELECT id FROM products WHERE code = ?',
    [CODE],
  )
  ok('the catalogue has it', seededPrimary !== null)
  ok('the branch has it too', seededBranch !== null)
  // The whole reason codes are the identity: the same product is a different row.
  ok(
    'and their ids genuinely differ',
    Number(seededPrimary?.id) !== Number(seededBranch?.id),
    `catalogue ${seededPrimary?.id} vs branch ${seededBranch?.id}`,
  )

  const published = await publishedProducts(context, { limit: 200 })
  ok('the catalogue publishes it', published.some((p) => p.code === CODE), String(published.length))

  const branchProducts = await branchProductsByCode(BRANCH, [CODE])
  const item = published.find((p) => p.code === CODE)
  if (!item || !seededBranch) {
    console.log('**FAIL**  the seeded product is not publishable — cannot continue')
    fails++
    for (const step of undo.reverse()) await step()
    process.exit(1)
  }
  const branchRow = branchProducts.get(CODE.toUpperCase())!
  console.log(`  using ${CODE} — catalogue id ${item.id}, branch id ${branchRow.id}`)

  // ── Translation ───────────────────────────────────────────────────────────
  console.log('\n— Codes translate, ids do not travel —')
  const good = translateToBranch(
    [{ code: item.code, description: item.description }],
    branchProducts,
  )
  ok('a shared code translates', good.ok)
  ok('to the branch’s own id', good.ok && good.lines[0].branchProductId === branchRow.id)

  const bad = translateToBranch(
    [{ code: 'NO-SUCH-CODE-XYZ', description: 'Imaginary Thing' }],
    branchProducts,
  )
  ok('a code the branch lacks refuses', !bad.ok)
  ok('and names the item', !bad.ok && bad.missing[0] === 'Imaginary Thing')

  // ── The order ─────────────────────────────────────────────────────────────
  console.log('\n— Placing the order —')
  const result = await placePublicOrder(context, {
    fulfilment: 'collect',
    contactName: 'Branch Routing Test',
    contactPhone: '0210000000',
    contactEmail: '',
    lines: [{ productId: item.id, qty: 1 }],
  })
  ok('the order is accepted', result.ok, result.ok ? result.orderNumber : result.error)
  if (!result.ok) {
    for (const step of undo.reverse()) await step()
    console.log(`\n${fails} FAILED.`)
    process.exit(1)
  }
  placedOrderIds.push({ siteId: BRANCH, orderId: result.orderId })

  // THE assertion.
  console.log('\n— Where the order landed —')
  const atBranch = await siteQueryOne<{ id: number; order_number: string; total_incl: string }>(
    BRANCH,
    'SELECT id, order_number, total_incl FROM online_orders WHERE id = ?',
    [result.orderId],
  )
  ok('the order is in the BRANCH’s database', atBranch !== null, atBranch?.order_number ?? 'absent')

  const atPrimary = await siteQueryOne<{ id: number }>(
    PRIMARY,
    'SELECT id FROM online_orders WHERE order_number = ?',
    [result.orderNumber],
  )
  // If this fails the order would be packed twice and paid for once.
  ok('and NOT at head office', atPrimary === null)

  console.log('\n— The lines point at the branch’s own products —')
  const lines = await siteQuery<{ product_id: number; product_code: string }>(
    BRANCH,
    'SELECT product_id, product_code FROM online_order_lines WHERE order_id = ?',
    [result.orderId],
  )
  ok('a line was written', lines.length === 1, String(lines.length))
  ok('it carries the branch’s product id', Number(lines[0]?.product_id) === branchRow.id,
    `${lines[0]?.product_id} vs branch ${branchRow.id}`)
  ok('and the shared code', String(lines[0]?.product_code) === item.code)

  const resolves = await siteQueryOne<{ id: number }>(
    BRANCH,
    'SELECT id FROM products WHERE id = ?',
    [Number(lines[0]?.product_id)],
  )
  ok('that id is a real row in the branch', resolves !== null)

  console.log('\n— The number came from the branch’s own run —')
  ok('it looks like a web order', /^WEB-\d+$/.test(result.orderNumber), result.orderNumber)
  const dupes = await siteQuery<{ n: number }>(
    BRANCH,
    'SELECT COUNT(*) AS n FROM online_orders WHERE order_number = ?',
    [result.orderNumber],
  )
  ok('and is unique in that shop', Number(dupes[0]?.n) === 1)

  console.log('\n— A product the branch does not carry —')
  // Deleted from the branch only, leaving head office still publishing it —
  // which is exactly the Sea Point-has-seafood case a chain really hits.
  await siteExecute(
    BRANCH,
    'DELETE FROM product_prices WHERE product_id IN (SELECT id FROM products WHERE code = ?)',
    [CODE],
  )
  await siteExecute(BRANCH, 'DELETE FROM products WHERE code = ?', [CODE])
  const stillPublished = await publishedProducts(context, { limit: 200 })
  const onlyAtPrimary = stillPublished.find((p) => p.code === CODE)
  if (!onlyAtPrimary) {
    console.log('SKIP  the catalogue no longer publishes the seeded item')
  } else {
    const refused = await placePublicOrder(context, {
      fulfilment: 'collect',
      contactName: 'Branch Routing Test',
      contactPhone: '0210000000',
      contactEmail: '',
      lines: [{ productId: onlyAtPrimary.id, qty: 1 }],
    })
    ok('the order is refused', !refused.ok)
    ok(
      'and the shopper is told which item',
      !refused.ok && refused.error.includes(onlyAtPrimary.description.slice(0, 12)),
      !refused.ok ? refused.error : '',
    )
    // The BRANCH is what does not carry it. Naming head office here would tell
    // the shopper the wrong shop is out of stock.
    ok(
      'and which shop does not carry it',
      !refused.ok && refused.error.startsWith(context.branchName),
      !refused.ok ? refused.error.slice(0, 60) : '',
    )
    const leaked = await siteQueryOne<{ n: number }>(
      BRANCH,
      'SELECT COUNT(*) AS n FROM online_orders WHERE contact_name = ? AND id > ?',
      ['Branch Routing Test', result.orderId],
    )
    ok('nothing was written anywhere', Number(leaked?.n ?? 0) === 0)
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  console.log('\n— Cleanup —')
  for (const { siteId, orderId } of placedOrderIds) {
    await siteExecute(siteId, 'DELETE FROM online_stock_holds WHERE order_id = ?', [orderId])
    await siteExecute(siteId, 'DELETE FROM online_order_lines WHERE order_id = ?', [orderId])
    await siteExecute(siteId, 'DELETE FROM online_orders WHERE id = ?', [orderId])
  }
  const left = await siteQueryOne<{ n: number }>(
    BRANCH,
    'SELECT COUNT(*) AS n FROM online_orders WHERE contact_name = ?',
    ['Branch Routing Test'],
  )
  ok('every test order removed', Number(left?.n ?? 0) === 0, String(left?.n ?? 0))

  for (const step of undo.reverse()) await step()
  ok('group mode put back', (await groupForSite(1))?.onlineGroupMode === modeBefore)

  /*
   * Proved, not assumed. `code` is UNIQUE, so a product this test failed to
   * remove would fail somebody else's suite days later with an error that says
   * nothing about where it came from.
   */
  for (const siteId of [PRIMARY, BRANCH]) {
    const left = await siteQueryOne<{ n: number }>(
      siteId,
      "SELECT COUNT(*) AS n FROM products WHERE code LIKE 'ZZTEST-MS-%'",
    )
    ok(`no test products left in site ${siteId}`, Number(left?.n ?? 0) === 0, String(left?.n ?? 0))
  }

  console.log(fails === 0 ? '\nAll multi-store order checks passed.' : `\n${fails} FAILED.`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
