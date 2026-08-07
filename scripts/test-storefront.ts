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
  publishedProduct,
  publishedProducts,
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

async function cleanup() {
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

  const original = await getOnlineSettings(SITE)
  const { updatedAt: _a, updatedBy: _b, ...base } = original
  const zonesBefore = await listDeliveryZones(SITE)
  const deptsOn = (await listDepartmentVisibility(SITE)).filter((d) => d.showOnline).map((d) => d.id)

  /* ── The token ────────────────────────────────────────────────────────── */
  console.log('\n— The store link —')
  const token = await createPublicStoreToken(SITE)
  ok('the same store always mints the same link', token === (await createPublicStoreToken(SITE)))
  ok('it resolves back to the store', (await verifyPublicStoreToken(token)) === SITE)
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
  const departments = await listDepartmentVisibility(SITE)
  const parent = departments.find((d) => d.parentId === null)
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
    ok('the fee is the store’s, not the shopper’s', toNum(row?.delivery_fee_incl) === 35)
    ok('the total includes it', Math.abs(toNum(row?.total_incl) - (target.priceIncl + 35)) < 0.01)
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

  /* ── Restore ──────────────────────────────────────────────────────────── */
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

  console.log(`\n${fails === 0 ? 'All storefront checks passed.' : `${fails} FAILED.`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await cleanup().catch(() => {})
  process.exit(1)
})
