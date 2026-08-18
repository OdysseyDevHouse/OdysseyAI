/**
 * The PUBLIC storefront, against a live site database.
 *
 * This is the only surface in the app an anonymous stranger can reach, so the
 * checks here are mostly adversarial. Each one corresponds to something a
 * hostile or careless request could otherwise achieve:
 *
 *   reading a shop that is closed, or one that never opened;
 *   ordering something the shop did not publish;
 *   buying a television for one cent;
 *   getting free delivery by posting a zero fee.
 *
 *   npm run test:storefront
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { execute, query } from '../src/lib/db'
import { createPublicStoreToken, verifyPublicStoreToken } from '../src/lib/publicStoreToken'
import {
  getOnlineSettings,
  listDeliveryZones,
  deleteDeliveryZone,
  saveDeliveryZone,
  saveOnlineSettings,
  setDepartmentVisibility,
  listDepartmentVisibility,
  type OnlineSettingsInput,
} from '../src/lib/site/onlineStore'
import {
  placePublicOrder,
  popularProducts,
  productsOnSpecial,
  publishedProduct,
  publishedProducts,
  publishedProductsCount,
  safeSort,
  CATALOGUE_SORTS,
  resolveSectionContent,
  publishedDepartments,
  quoteDeliveryFor,
  storefrontContext,
} from '../src/lib/site/storefront'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const TAG = '__TEST_SHOPPER__'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** Marks the rows this suite created, so cleanup finds exactly those. */
const MODULE_FIXTURE = 'test-storefront'

/**
 * The storefront is behind the Online Store module, checked inside
 * verifyPublicStoreToken(): the shop front is served outside the (app) route
 * group, so that resolver is the only place able to close it.
 *
 * Granted for the run and removed in cleanup, so this suite tests the
 * STOREFRONT rather than whatever this machine happens to have bought.
 */
async function grantOnlineStore() {
  await execute(
    `INSERT INTO cp2_site_modules (site_id, module_key, starts_on, created_by)
     VALUES (?, 'online_store', ?, ?)
     ON DUPLICATE KEY UPDATE ends_on = NULL`,
    [SITE, new Date().toISOString().slice(0, 10), MODULE_FIXTURE],
  )
}

async function cleanup() {
  await execute('DELETE FROM cp2_site_modules WHERE created_by = ?', [MODULE_FIXTURE])

  const orders = await siteQuery<{ id: number }>(
    SITE,
    `SELECT id FROM online_orders WHERE contact_name = ?`,
    [TAG],
  )
  for (const o of orders) {
    await siteExecute(SITE, `DELETE FROM online_order_lines WHERE order_id = ?`, [o.id])
  }
  await siteExecute(SITE, `DELETE FROM online_orders WHERE contact_name = ?`, [TAG])
}

const shopper = { contactName: TAG, contactPhone: '0820000000', contactEmail: '' }

async function main() {
  await cleanup()
  await grantOnlineStore()

  const original = await getOnlineSettings(SITE)
  const { updatedAt: _a, updatedBy: _b, ...base } = original
  const zonesBefore = await listDeliveryZones(SITE)
  const deptsOn = (await listDepartmentVisibility(SITE)).filter((d) => d.showOnline).map((d) => d.id)

  /* ── The token ────────────────────────────────────────────────────────── */
  console.log('\n— The store link —')
  const token = await createPublicStoreToken(SITE)
  ok('the same store always mints the same link', token === (await createPublicStoreToken(SITE)))
  ok('it resolves back to the store', (await verifyPublicStoreToken(token)) === SITE)

  /* The module half of the resolver. A shop front left serving for a shop that
     stopped paying is the product being given away to the public, so this fails
     CLOSED — unlike the back office, which fails open.

     Every module row for this site is cleared, not just this suite's fixture:
     the check is "does the site hold online_store", and a row left behind by
     any other suite would keep the shop open and make this pass for the wrong
     reason. It did exactly that once. Whatever was there is restored below. */
  const otherRows = await query<{ module_key: string; starts_on: string; created_by: string | null }>(
    `SELECT module_key, starts_on, created_by FROM cp2_site_modules
      WHERE site_id = ? AND module_key = 'online_store'`,
    [SITE],
  )
  await execute("DELETE FROM cp2_site_modules WHERE site_id = ? AND module_key = 'online_store'", [SITE])
  ok(
    'a store without the Online Store module resolves to nothing',
    (await verifyPublicStoreToken(token)) === null,
  )
  for (const r of otherRows) {
    await execute(
      `INSERT INTO cp2_site_modules (site_id, module_key, starts_on, created_by)
       VALUES (?, 'online_store', ?, ?) ON DUPLICATE KEY UPDATE ends_on = NULL`,
      [SITE, r.starts_on, r.created_by],
    )
  }
  await grantOnlineStore()
  ok('and resolves again once the module is back', (await verifyPublicStoreToken(token)) === SITE)
  ok('a forged token resolves to nothing', (await verifyPublicStoreToken('a.b.c')) === null)
  ok('an empty token resolves to nothing', (await verifyPublicStoreToken('')) === null)

  /* ── A closed shop is invisible ───────────────────────────────────────── */
  console.log('\n— A closed shop serves nothing —')
  await saveOnlineSettings(SITE, { ...base, isEnabled: false }, 'test')
  ok('there is no context for a closed shop', (await storefrontContext(SITE)) === null)
  ok(
    'and an order cannot be placed at one',
    !(await placePublicOrder(SITE, { ...shopper, fulfilment: 'collect', lines: [{ productId: 1, qty: 1 }] })).ok,
  )

  /* ── Open it ──────────────────────────────────────────────────────────── */
  /*
   * A top-level department that actually HAS sellable products.
   *
   * "The first one with no parent" was picking whichever department happened to sort
   * first, and on 2026-08-13 that was `Imp 76738812` — an import-test fixture with
   * ZERO products. saveOnlineSettings then refused to open the shop, correctly:
   * publishMode 'departments' counts products in published departments, not the
   * flags themselves, so an empty published department is still an empty shop. The
   * suite failed on its own fixture while the guard was right.
   */
  const departments = await listDepartmentVisibility(SITE)
  const stocked = await siteQuery<any>(
    SITE,
    `SELECT p.department_id AS id, COUNT(*) AS n
       FROM products p
      WHERE p.is_archived = 0 AND p.department_id IS NOT NULL
      GROUP BY p.department_id
      ORDER BY n DESC`,
  )
  const stockedIds = new Set(stocked.map((r: any) => Number(r.id)))
  const parent =
    departments.find((d) => d.parentId === null && stockedIds.has(d.id)) ??
    departments.find((d) => d.parentId === null)
  if (!parent) throw new Error('Need a department to publish.')
  await setDepartmentVisibility(SITE, parent.id, true)

  const open: OnlineSettingsInput = {
    ...base,
    isEnabled: true,
    publishMode: 'departments',
    collectEnabled: true,
    deliverEnabled: false,
    minOrderIncl: 0,
  }
  const opened = await saveOnlineSettings(SITE, open, 'test')
  ok('the shop opens', opened.ok, opened.ok ? '' : opened.error)

  const context = await storefrontContext(SITE)
  ok('an open shop has a context', context !== null)
  if (!context) {
    await cleanup()
    process.exit(1)
  }
  ok('it knows the shop name', context.storeName.length > 0, context.storeName)

  const catalogue = await publishedProducts(context, { limit: 5 })
  ok('the catalogue has products', catalogue.length > 0, `${catalogue.length}`)
  ok(
    'every published product is priced',
    catalogue.every((p) => p.priceIncl > 0),
  )
  ok('departments are listed', (await publishedDepartments(context)).length > 0)

  const target = catalogue[0]

  /* ── The important one ────────────────────────────────────────────────── */
  console.log('\n— A shopper cannot set the price —')
  const tampered = await placePublicOrder(SITE, {
    ...shopper,
    fulfilment: 'collect',
    // A basket claiming this costs a cent. Everything but productId and qty
    // must be ignored.
    lines: [{ productId: target.id, qty: 2, unitPriceIncl: 0.01, price: 0.01 } as never],
  })
  ok('the order is accepted', tampered.ok, tampered.ok ? '' : tampered.error)
  if (tampered.ok) {
    const line = await siteQueryOne<Record<string, unknown>>(
      SITE,
      `SELECT unit_price_incl, line_total_incl FROM online_order_lines WHERE order_id = ?`,
      [tampered.orderId],
    )
    ok(
      'but it is stored at the CATALOGUE price',
      toNum(line?.unit_price_incl) === target.priceIncl,
      `stored ${toNum(line?.unit_price_incl)}, catalogue ${target.priceIncl}`,
    )
    ok(
      'and the total is the real one',
      Math.abs(tampered.total - target.priceIncl * 2) < 0.01,
      `${tampered.total}`,
    )
  }

  /* ── Unpublished stock is not for sale ────────────────────────────────── */
  console.log('\n— Only published products are orderable —')
  const hidden = await siteQueryOne<{ id: number }>(
    SITE,
    `SELECT id FROM products
      WHERE is_archived = 0 AND (department_id IS NULL OR department_id <> ?) LIMIT 1`,
    [parent.id],
  )
  if (hidden) {
    ok('an unpublished product is not readable', (await publishedProduct(context, hidden.id)) === null)
    ok(
      'and cannot be ordered even by id',
      !(await placePublicOrder(SITE, {
        ...shopper,
        fulfilment: 'collect',
        lines: [{ productId: hidden.id, qty: 1 }],
      })).ok,
    )
  } else {
    console.log('SKIP  every product is in the published department')
  }

  ok(
    'a made-up product id is refused',
    !(await placePublicOrder(SITE, {
      ...shopper,
      fulfilment: 'collect',
      lines: [{ productId: 99_999_999, qty: 1 }],
    })).ok,
  )

  /* ── Ordinary validation ──────────────────────────────────────────────── */
  console.log('\n— Validation —')
  const bad = async (input: Parameters<typeof placePublicOrder>[1]) =>
    !(await placePublicOrder(SITE, input)).ok

  ok('a name is required', await bad({ ...shopper, contactName: '  ', fulfilment: 'collect', lines: [{ productId: target.id, qty: 1 }] }))
  ok(
    'some way to reach them is required',
    await bad({ contactName: TAG, contactPhone: '', contactEmail: '', fulfilment: 'collect', lines: [{ productId: target.id, qty: 1 }] }),
  )
  ok('an empty basket is refused', await bad({ ...shopper, fulfilment: 'collect', lines: [] }))
  ok('a zero quantity is refused', await bad({ ...shopper, fulfilment: 'collect', lines: [{ productId: target.id, qty: 0 }] }))
  ok('a negative quantity is refused', await bad({ ...shopper, fulfilment: 'collect', lines: [{ productId: target.id, qty: -5 }] }))
  ok('an absurd quantity is refused', await bad({ ...shopper, fulfilment: 'collect', lines: [{ productId: target.id, qty: 10_000 }] }))
  ok(
    'delivery is refused while the shop only collects',
    await bad({ ...shopper, fulfilment: 'deliver', deliveryLine1: '1 Main Rd', lines: [{ productId: target.id, qty: 1 }] }),
  )

  console.log('\n— Minimum order —')
  await saveOnlineSettings(SITE, { ...open, minOrderIncl: target.priceIncl * 10 }, 'test')
  ok(
    'an order under the minimum is refused',
    await bad({ ...shopper, fulfilment: 'collect', lines: [{ productId: target.id, qty: 1 }] }),
  )
  await saveOnlineSettings(SITE, open, 'test')

  /* ── Delivery ─────────────────────────────────────────────────────────── */
  console.log('\n— Delivery —')
  await saveDeliveryZone(SITE, {
    name: 'Test zone',
    matchType: 'suburb',
    matchValue: '__test_suburb__',
    feeIncl: 35,
    freeOverIncl: 500,
    minOrderIncl: 0,
    isActive: true,
    sortOrder: 1,
  })
  await saveOnlineSettings(SITE, { ...open, deliverEnabled: true }, 'test')

  const quoted = await quoteDeliveryFor(SITE, { suburb: '__test_suburb__', postcode: '' }, 100)
  ok('a known suburb is quoted', quoted.zone !== null && quoted.fee === 35, `fee ${quoted.fee}`)
  const free = await quoteDeliveryFor(SITE, { suburb: '__test_suburb__', postcode: '' }, 600)
  ok('free delivery applies over the threshold', free.fee === 0)
  const partial = await quoteDeliveryFor(SITE, { suburb: '__test_sub', postcode: '' }, 100)
  // "Sand" must not match "Sandton" — otherwise a shopper gets a fee for an
  // area the shop does not actually serve.
  ok('a partial suburb name does NOT match', partial.zone === null)
  const nowhere = await quoteDeliveryFor(SITE, { suburb: 'Somewhere else', postcode: '' }, 100)
  ok('an unserved address is turned down politely', nowhere.zone === null && nowhere.reason !== '')

  ok(
    'delivery to an unserved address is refused',
    await bad({ ...shopper, fulfilment: 'deliver', deliveryLine1: '1 Main Rd', deliverySuburb: 'Somewhere else', lines: [{ productId: target.id, qty: 1 }] }),
  )
  ok(
    'a delivery address is required',
    await bad({ ...shopper, fulfilment: 'deliver', deliverySuburb: '__test_suburb__', lines: [{ productId: target.id, qty: 1 }] }),
  )

  const delivered = await placePublicOrder(SITE, {
    ...shopper,
    fulfilment: 'deliver',
    deliveryLine1: '1 Main Rd',
    deliverySuburb: '__test_suburb__',
    lines: [{ productId: target.id, qty: 1 }],
  })
  ok('a deliverable order is accepted', delivered.ok, delivered.ok ? '' : delivered.error)
  if (delivered.ok) {
    const row = await siteQueryOne<Record<string, unknown>>(
      SITE,
      `SELECT delivery_fee_incl, total_incl, zone_id FROM online_orders WHERE id = ?`,
      [delivered.orderId],
    )
    // The fee is money: it must come from the zone, not from the browser.
    //
    // Which fee depends on the basket. The zone above gives free delivery over
    // R500, and catalogue[0] is whatever the shop happens to list first — at
    // R944 it qualifies, so the correct fee is ZERO. Asserting a flat 35 made
    // this fail whenever the first product happened to be expensive, which
    // reads as a delivery bug and is nothing of the sort.
    const expectedFee = target.priceIncl >= 500 ? 0 : 35
    ok(
      'the fee is the store’s, not the shopper’s',
      toNum(row?.delivery_fee_incl) === expectedFee,
      `fee ${toNum(row?.delivery_fee_incl)}, expected ${expectedFee} on a basket of ${target.priceIncl.toFixed(2)}`,
    )
    ok(
      'the total includes it',
      Math.abs(toNum(row?.total_incl) - (target.priceIncl + expectedFee)) < 0.01,
      `total ${toNum(row?.total_incl)}`,
    )
    ok('the zone is recorded', row?.zone_id !== null)
  }

  /* ── The order reaches the queue ──────────────────────────────────────── */
  console.log('\n— Orders reach the shop —')
  const placed = await siteQuery<Record<string, unknown>>(
    SITE,
    `SELECT o.order_number, s.role
       FROM online_orders o JOIN online_order_statuses s ON s.id = o.status_id
      WHERE o.contact_name = ?`,
    [TAG],
  )
  ok('orders were created', placed.length >= 2, `${placed.length}`)
  ok(
    'each lands in the "new" step for staff to see',
    placed.every((r) => String(r.role) === 'new'),
  )
  ok(
    'each has a readable order number',
    placed.every((r) => /^WEB-\d{5}$/.test(String(r.order_number))),
    placed.map((r) => r.order_number).join(', '),
  )
  ok(
    'order numbers are unique',
    new Set(placed.map((r) => String(r.order_number))).size === placed.length,
  )

  /* ── Hand-picked product rows ─────────────────────────────────────────── */
  console.log('\n— A hand-picked row —')
  if (catalogue.length >= 3) {
    /*
     * Pick three, DELIBERATELY not in the catalogue's own order, because the
     * whole point of a hand-picked row is that the owner's order survives.
     * The catalogue sorts by description, so reversing guarantees the two
     * orderings differ and the assertion can actually fail.
     */
    const picks = [catalogue[2], catalogue[0], catalogue[1]]
    const pickedIds = picks.map((p) => p.id)

    const [row] = await resolveSectionContent(context, [
      { kind: 'products', source: 'manual', productIds: pickedIds, maxItems: 8 },
    ])
    ok('a picked row returns exactly what was picked', row.products?.length === 3, `${row.products?.length}`)
    ok(
      'in the order the owner picked them',
      (row.products ?? []).map((p) => p.id).join(',') === pickedIds.join(','),
      `${(row.products ?? []).map((p) => p.id).join(',')} vs ${pickedIds.join(',')}`,
    )

    // maxItems is a RULE's cap. A stale 2 left over from a "newest" rule must
    // not silently swallow the third product someone deliberately chose.
    const [uncapped] = await resolveSectionContent(context, [
      { kind: 'products', source: 'manual', productIds: pickedIds, maxItems: 2 },
    ])
    ok('a stale maxItems never truncates the picks', uncapped.products?.length === 3, `${uncapped.products?.length}`)

    // The publish rules still apply on top of the pick. An id that is not
    // sellable must drop OUT of the row, not appear because it was chosen.
    // `hidden` is resolved above: a real product outside the published
    // department. Picking it must not override the publish rules.
    if (hidden) {
      const [mixed] = await resolveSectionContent(context, [
        { kind: 'products', source: 'manual', productIds: [...pickedIds, hidden.id] },
      ])
      ok(
        'a picked product that is not published drops out',
        mixed.products?.length === 3,
        `${mixed.products?.length}`,
      )
    }

    // Nothing picked must mean nothing shown. If the empty list were treated
    // as "no restriction" the front page would show the whole catalogue.
    const [none] = await resolveSectionContent(context, [
      { kind: 'products', source: 'manual', productIds: [] },
    ])
    ok('an empty pick list shows nothing, not everything', none.products?.length === 0, `${none.products?.length}`)
  }

  console.log('\n— The self-maintaining product rules —')

  /*
   * ── THE REGRESSION THIS EXISTS FOR ──────────────────────────────────
   *
   * `popularProducts` originally ranked the best sellers and THEN applied the
   * publish rules. On a shop publishing a handful of a large catalogue, every
   * one of the top rows was something it does not sell online, so the filter
   * removed the lot and the row came back empty while the shop plainly had
   * recent sales. Over-fetching a fixed multiple only moves the number at
   * which that happens.
   *
   * The fix put the publish filter INSIDE the ranking query. This asserts the
   * property that fix guarantees: whatever comes back is published, and if
   * anything published has sold recently, something comes back.
   */
  const popular = await popularProducts(context, 8)

  /*
   * "Is each of these published?" asked of the publish query ITSELF, by id.
   *
   * NOT by membership of a fetched list: `publishedProducts` caps at 120, and
   * this shop publishes far more than that, so a sampled set would report
   * perfectly well-published products as missing. That mistake failed this
   * assertion on eight real products before the cap was the obvious culprit —
   * the sample is the thing that was wrong, not the row.
   */
  const backCheck = popular.length
    ? await publishedProducts(context, {
        ids: popular.map((p) => p.id),
        limit: popular.length,
      })
    : []
  ok(
    'every best seller returned is actually published',
    backCheck.length === popular.length,
    `${backCheck.length} of ${popular.length} confirmed`,
  )

  /*
   * Does anything published have a recent sale at all? If so the row must not
   * be empty — that is exactly the regression.
   *
   * The publish rule is expressed in SQL here rather than by listing ids, for
   * the same reason as above: a shop can publish more products than any one
   * query returns, so the question has to be asked of the whole catalogue.
   */
  const [recent] = await siteQuery<Record<string, unknown>>(
    SITE,
    `SELECT COUNT(DISTINCT l.product_id) AS n
       FROM sales_document_lines l
       JOIN sales_documents d ON d.id = l.document_id
       JOIN products p ON p.id = l.product_id
       JOIN product_prices pp
         ON pp.product_id = p.id
        AND pp.price_structure_id = COALESCE(?, (
              SELECT id FROM price_structures WHERE is_default = 1 ORDER BY id LIMIT 1
            ))
      WHERE d.status = 'finalised'
        AND d.doc_type IN ('invoice','credit_note')
        AND d.document_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
        AND p.is_archived = 0
        AND p.product_type IN ('normal','returnable')
        AND pp.selling_price_incl > 0`,
    [context.settings.priceStructureId],
  )
  const soldRecently = Number(recent?.n ?? 0)
  if (soldRecently > 0) {
    ok(
      'a published product with recent sales reaches the best-seller row',
      popular.length > 0,
      `${soldRecently} published products sold recently, row returned ${popular.length}`,
    )
  } else {
    ok('nothing published has sold recently, so an empty row is correct', popular.length === 0)
  }

  ok('the best-seller row honours its limit', (await popularProducts(context, 2)).length <= 2)

  /*
   * The specials rule answers "what is reduced" by pricing the catalogue the
   * way the shop does and keeping what came back struck through — so a row it
   * returns can never disagree with the shelf. Assert exactly that.
   */
  const onSpecial = await productsOnSpecial(context, 8)
  ok(
    'every product on the specials row really is reduced',
    onSpecial.every((p) => p.wasPriceIncl !== null && p.wasPriceIncl > p.priceIncl),
    onSpecial.map((p) => `${p.id}:${p.wasPriceIncl}->${p.priceIncl}`).join(' ') || 'none on special',
  )
  const specialsBackCheck = onSpecial.length
    ? await publishedProducts(context, {
        ids: onSpecial.map((p) => p.id),
        limit: onSpecial.length,
      })
    : []
  ok(
    'every product on the specials row is published',
    specialsBackCheck.length === onSpecial.length,
    `${specialsBackCheck.length} of ${onSpecial.length} confirmed`,
  )
  ok(
    'the specials row is sorted by biggest saving first',
    onSpecial.every(
      (p, i) =>
        i === 0 ||
        (onSpecial[i - 1].wasPriceIncl ?? 0) - onSpecial[i - 1].priceIncl >=
          (p.wasPriceIncl ?? 0) - p.priceIncl,
    ),
  )

  // Both rules go through resolveSectionContent in the shop, so the wiring
  // matters as much as the functions.
  const [specialRow, popularRow] = await resolveSectionContent(context, [
    { kind: 'products', source: 'special', maxItems: 4 },
    { kind: 'products', source: 'popular', maxItems: 4 },
  ])
  ok('the specials rule is wired into the resolver', Array.isArray(specialRow.products))
  ok('the best-seller rule is wired into the resolver', Array.isArray(popularRow.products))

  /* ── Restore ──────────────────────────────────────────────────────────── */
  console.log('\n— Paging a listing —')
  {
    const total = await publishedProductsCount(context, {})
    ok('the catalogue can be counted', total > 0, String(total))

    /*
     * The count and the listing share one filter, so they cannot disagree.
     * Compared over a PAGE rather than the whole catalogue: this shop has
     * forty thousand products and the listing caps a single page at 120, so
     * "count equals rows" is only a fair question when the page can hold them.
     */
    const firstPage = await publishedProducts(context, { limit: 10 })
    const pageCount = Math.min(total, 10)
    ok(
      'the count agrees with the page it filters',
      firstPage.length === pageCount,
      `${firstPage.length} of a possible ${pageCount}`,
    )

    // And the filter really is shared: a narrower one must move BOTH.
    const narrowTotal = await publishedProductsCount(context, { search: 'a' })
    ok('a filter narrows the count too', narrowTotal <= total, `${narrowTotal} <= ${total}`)

    /*
     * Walk the pages and check the ids are disjoint. Without the id
     * tie-break in every ORDER BY, two products with the same price have no
     * defined order BETWEEN pages, so one appears twice and another never —
     * the bug that looks like a product vanishing from the catalogue.
     */
    /*
     * A BOUNDED walk. This shop carries forty thousand products, and paging
     * all of them five at a time is eight thousand queries for a property the
     * first few pages already demonstrate. Capped at what is enough to catch a
     * boundary that repeats or skips, and the cap is said out loud below
     * rather than left to look like full coverage.
     */
    const per = 5
    const walkPages = Math.min(Math.ceil(total / per), 12)
    const seen = new Set<number>()
    let repeats = 0
    for (let page = 0; page < walkPages; page++) {
      const rows = await publishedProducts(context, { limit: per, offset: page * per, sort: 'priceAsc' })
      for (const r of rows) {
        if (seen.has(r.id)) repeats++
        seen.add(r.id)
      }
    }
    ok('paging repeats nothing', repeats === 0, `${repeats} repeated`)
    ok(
      'paging reaches every row it walked',
      seen.size === Math.min(total, walkPages * per),
      `${seen.size} over ${walkPages} pages of ${total}`,
    )
    // Past the end is empty rather than an error — the route redirects, but
    // the query underneath must not throw for a caller that does not.
    const beyond = await publishedProducts(context, { limit: per, offset: total + 100 })
    ok('a page past the end is simply empty', beyond.length === 0)
  }

  console.log('\n— Ordering a listing —')
  {
    const rows = await publishedProducts(context, { limit: 20 })
    if (rows.length >= 2) {
      const asc = await publishedProducts(context, { limit: 20, sort: 'priceAsc' })
      const desc = await publishedProducts(context, { limit: 20, sort: 'priceDesc' })
      const rising = asc.every((r, i) => i === 0 || toNum(asc[i - 1].priceIncl) <= toNum(r.priceIncl))
      const falling = desc.every((r, i) => i === 0 || toNum(desc[i - 1].priceIncl) >= toNum(r.priceIncl))
      ok('cheapest first really is', rising)
      ok('dearest first really is', falling)

      /*
       * `description`, not `name` — a StorefrontProduct has no `name`, and the
       * first version of this compared undefined to undefined on every row.
       * That passes for every input, which is worse than failing: it is a check
       * that reports the sort is right without ever having looked at it.
       *
       * Compared with localeCompare and not `<=`. JavaScript's operators sort
       * by code unit, so "Zebra" precedes "apple" and "Éclair" lands after both;
       * MySQL's collation is case- and accent-insensitive, and disagreeing with
       * it here would fail a correct ORDER BY on the first shop that stocks a
       * capital letter in the wrong place.
       */
      const byName = await publishedProducts(context, { limit: 20, sort: 'name' })
      const alphabetical = byName.every(
        (r, i) =>
          i === 0 ||
          byName[i - 1].description.localeCompare(r.description, 'en', { sensitivity: 'base' }) <= 0,
      )
      ok('by name really is', alphabetical, byName[0]?.description ?? '(no rows)')
    }

    /*
     * The value decides an ORDER BY and arrives from a query string, which is
     * the classic place an injection gets in. A fixed vocabulary makes one
     * unrepresentable rather than something to escape.
     */
    ok('a junk sort falls back', safeSort('; DROP TABLE products--') === 'name')
    ok('an absent sort falls back', safeSort(undefined) === 'name')
    ok('every declared sort survives its own check',
      CATALOGUE_SORTS.every((s) => safeSort(s) === s))

    // Each one has to actually run: a name in the list with no SQL behind it
    // would only fail the day somebody picked it.
    let ran = 0
    for (const s of CATALOGUE_SORTS) {
      const out = await publishedProducts(context, { limit: 2, sort: s })
      if (Array.isArray(out)) ran++
    }
    ok('every sort runs', ran === CATALOGUE_SORTS.length, `${ran} of ${CATALOGUE_SORTS.length}`)
  }

  console.log('\n— Cleanup —')
  await cleanup()
  for (const z of await listDeliveryZones(SITE)) {
    if (!zonesBefore.some((b) => b.id === z.id)) await deleteDeliveryZone(SITE, z.id)
  }
  for (const d of await listDepartmentVisibility(SITE)) {
    const was = deptsOn.includes(d.id)
    if (d.showOnline !== was) await setDepartmentVisibility(SITE, d.id, was)
  }
  await saveOnlineSettings(SITE, base, original.updatedBy || 'test')

  const after = await getOnlineSettings(SITE)
  ok('settings restored', after.isEnabled === original.isEnabled)
  ok('test orders removed', (await siteQuery(SITE, `SELECT id FROM online_orders WHERE contact_name = ?`, [TAG])).length === 0)

  // The module row this suite granted itself must not outlive it: the billing
  // screen would show it as bought, and the next suite would count it.
  await execute('DELETE FROM cp2_site_modules WHERE created_by = ?', [MODULE_FIXTURE])
  ok(
    'the fixture module row is cleaned up',
    (await query<{ id: number }>('SELECT id FROM cp2_site_modules WHERE created_by = ?', [MODULE_FIXTURE])).length === 0,
  )

  console.log(`\n${fails === 0 ? 'All storefront checks passed.' : `${fails} FAILED.`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await cleanup().catch(() => {})
  process.exit(1)
})
