/**
 * Online store setup checks against a live site database.
 *
 * The thing worth testing here is not that settings round-trip — it is that a
 * half-configured storefront CANNOT be opened. Every guard below corresponds
 * to a way a store could otherwise go public and quietly turn customers away.
 *
 *   npm run test:online-store
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { getGateway, saveGateway } from '../src/lib/site/payments'
import {
  deleteDeliveryZone,
  getOnlineSettings,
  getPublishCounts,
  listDeliveryZones,
  listOrderStatuses,
  saveDeliveryZone,
  saveOnlineSettings,
  type OnlineSettingsInput,
} from '../src/lib/site/onlineStore'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** Settings as a plain input, so a test can vary one field at a time. */
function inputFrom(s: Awaited<ReturnType<typeof getOnlineSettings>>): OnlineSettingsInput {
  const { updatedAt: _a, updatedBy: _b, ...rest } = s
  return rest
}

async function main() {
  const original = await getOnlineSettings(SITE)
  const base = inputFrom(original)
  const zonesBefore = await listDeliveryZones(SITE)

  console.log('\n— Seeded defaults —')
  // The SCHEMA defaults, not the live row. A store that has since been
  // configured is not evidence about what a NEW store ships as, and asserting
  // against the current values makes this fail for anyone who has used the app.
  const defaults = await siteQuery<{ COLUMN_NAME: string; COLUMN_DEFAULT: string | null }>(
    SITE,
    `SELECT COLUMN_NAME, COLUMN_DEFAULT FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'online_store_settings'`,
  )
  // MySQL reports an ENUM's default wrapped in quotes ('departments'), so
  // unwrap before comparing.
  const defaultOf = (column: string) =>
    (defaults.find((d) => d.COLUMN_NAME === column)?.COLUMN_DEFAULT ?? '').replace(/^'|'$/g, '')

  ok('a new store ships CLOSED', defaultOf('is_enabled') === '0', String(defaultOf('is_enabled')))
  ok(
    'publish defaults to the narrowest option',
    defaultOf('publish_mode') === 'departments',
    String(defaultOf('publish_mode')),
  )
  ok(
    'payment defaults to pay-on-collection',
    defaultOf('payment_mode') === 'on_collection',
    String(defaultOf('payment_mode')),
  )

  const statuses = await listOrderStatuses(SITE)
  ok('a default pipeline exists', statuses.length >= 3, `${statuses.length} statuses`)
  for (const role of ['new', 'completed', 'cancelled'] as const) {
    const held = statuses.filter((s) => s.role === role)
    ok(`exactly one status holds the "${role}" role`, held.length === 1, `${held.length}`)
  }
  ok(
    'statuses come back in pipeline order',
    statuses.every((s, i) => i === 0 || s.sortOrder >= statuses[i - 1].sortOrder),
  )

  console.log('\n— Publish counts —')
  const counts = await getPublishCounts(SITE)
  ok('a total is reported', counts.total > 0, `${counts.total} sellable products`)
  ok('"all" equals the total', counts.all === counts.total)
  ok('counts never exceed the total', counts.departments <= counts.total && counts.flagged <= counts.total)

  // Ticking a PARENT department must publish everything filed beneath it too.
  const parent = await siteQueryOne<{ id: number; name: string; kids: number }>(
    SITE,
    `SELECT d.id, d.name,
            (SELECT COUNT(*) FROM departments c WHERE c.parent_id = d.id) AS kids
       FROM departments d WHERE d.parent_id IS NULL
      ORDER BY kids DESC LIMIT 1`,
  )
  if (parent && Number(parent.kids) > 0) {
    await siteExecute(SITE, `UPDATE departments SET show_online = 1 WHERE id = ?`, [parent.id])
    const withTree = await getPublishCounts(SITE)
    const directOnly = await siteQueryOne<{ n: number }>(
      SITE,
      `SELECT COUNT(*) AS n FROM products p
        WHERE p.is_archived = 0 AND p.product_type IN ('normal','returnable')
          AND p.department_id = ?`,
      [parent.id],
    )
    ok(
      'a ticked parent publishes its children too',
      withTree.departments > Number(directOnly?.n ?? 0),
      `${withTree.departments} via tree vs ${Number(directOnly?.n ?? 0)} filed directly`,
    )
    await siteExecute(SITE, `UPDATE departments SET show_online = 0 WHERE id = ?`, [parent.id])
  } else {
    console.log('SKIP  nested-department check — no parent department has children')
  }

  console.log('\n— A half-configured store cannot be opened —')
  // Publish something, so each guard below is tested in isolation rather than
  // being masked by the empty-catalogue one.
  await siteExecute(SITE, `UPDATE products SET show_online = 1 WHERE id = (SELECT MIN(id) FROM (SELECT id FROM products WHERE is_archived = 0) t)`)
  const publishable = { ...base, publishMode: 'flagged' as const }

  const noFulfilment = await saveOnlineSettings(
    SITE,
    { ...publishable, isEnabled: true, collectEnabled: false, deliverEnabled: false },
    'test',
  )
  ok('refuses to open with no collection and no delivery', !noFulfilment.ok)

  const emptyCatalogue = await saveOnlineSettings(
    SITE,
    { ...base, isEnabled: true, publishMode: 'departments', collectEnabled: true },
    'test',
  )
  ok('refuses to open with an empty catalogue', !emptyCatalogue.ok)

  // This check asserts a PRECONDITION it does not create — "there are no
  // delivery areas" — so it has to establish it. A zone left behind by another
  // test (or by a developer poking at the screen) would otherwise make the
  // guard look broken when it is working perfectly.
  const zonesNow = await listDeliveryZones(SITE)
  for (const z of zonesNow) await deleteDeliveryZone(SITE, z.id)

  const deliveryNoZones = await saveOnlineSettings(
    SITE,
    { ...publishable, isEnabled: true, collectEnabled: false, deliverEnabled: true },
    'test',
  )
  ok(
    'refuses to offer delivery with no areas',
    !deliveryNoZones.ok,
    deliveryNoZones.ok ? 'the store opened with zero zones' : '',
  )

  // Asserted HERE, while every save so far has been a refusal — after the
  // pay-online pair below one of them legitimately opens the store, and
  // checking afterwards would prove nothing.
  ok(
    'a refused save never opens the store',
    (await getOnlineSettings(SITE)).isEnabled === false,
  )

  // Same reasoning as the zones above: this asserts "no working payment
  // account exists", so it has to make that true rather than hope.
  const gatewayBefore = await getGateway(SITE)
  await siteExecute(SITE, `DELETE FROM payment_gateways WHERE provider = 'payfast'`)

  const payOnline = await saveOnlineSettings(
    SITE,
    { ...publishable, isEnabled: true, paymentMode: 'online' },
    'test',
  )
  ok('refuses pay-online with no payment account', !payOnline.ok)

  // And the other half: once an account IS connected, it is allowed. Without
  // this the guard could be permanently broken and the suite would not notice.
  await saveGateway(
    SITE,
    { isActive: true, isSandbox: true, merchantId: '10000100', merchantKey: 'k', passphrase: 'p' },
    'test',
  )
  const payOnlineAllowed = await saveOnlineSettings(
    SITE,
    { ...publishable, isEnabled: true, paymentMode: 'online' },
    'test',
  )
  ok(
    'allows pay-online once an account is connected',
    payOnlineAllowed.ok,
    payOnlineAllowed.ok ? '' : payOnlineAllowed.error,
  )

  // Put the gateway back exactly as it was found.
  await siteExecute(SITE, `DELETE FROM payment_gateways WHERE provider = 'payfast'`)
  if (gatewayBefore) {
    await saveGateway(
      SITE,
      {
        isActive: gatewayBefore.isActive,
        isSandbox: gatewayBefore.isSandbox,
        merchantId: gatewayBefore.merchantId,
        merchantKey: gatewayBefore.merchantKey,
        passphrase: gatewayBefore.passphrase,
      },
      gatewayBefore.updatedBy || 'test',
    )
  }

  // The pay-online pair above ends with the store legitimately open. Close it
  // so the checks below start from a known state.
  await saveOnlineSettings(SITE, { ...base, isEnabled: false }, 'test')

  console.log('\n— Valid configurations are accepted —')
  const offIsFine = await saveOnlineSettings(
    SITE,
    { ...base, isEnabled: false, blurb: 'Half-finished but saved.' },
    'test',
  )
  ok('a half-configured store saves while CLOSED', offIsFine.ok)
  ok('the value persisted', (await getOnlineSettings(SITE)).blurb === 'Half-finished but saved.')

  const collectOnly = await saveOnlineSettings(
    SITE,
    { ...publishable, isEnabled: true, collectEnabled: true, deliverEnabled: false },
    'test',
  )
  ok('collection-only with a catalogue opens', collectOnly.ok, collectOnly.ok ? '' : collectOnly.error)
  ok('and the store really is open', (await getOnlineSettings(SITE)).isEnabled === true)

  console.log('\n— Delivery areas —')
  const added = await saveDeliveryZone(SITE, {
    name: 'Test area',
    matchType: 'suburb',
    matchValue: '__test_suburb__',
    feeIncl: 35,
    freeOverIncl: 500,
    minOrderIncl: 0,
    isActive: true,
    sortOrder: 99,
  })
  ok('an area can be added', added.ok)

  const duplicate = await saveDeliveryZone(SITE, {
    name: 'Overlapping',
    matchType: 'suburb',
    matchValue: '__test_suburb__',
    feeIncl: 10,
    freeOverIncl: 0,
    minOrderIncl: 0,
    isActive: true,
    sortOrder: 100,
  })
  ok('two areas cannot claim one suburb', !duplicate.ok)

  const unnamed = await saveDeliveryZone(SITE, { ...added, name: '  ', matchType: 'suburb', matchValue: 'x', feeIncl: 0, freeOverIncl: 0, minOrderIncl: 0, isActive: true, sortOrder: 0 })
  ok('an area must be named', !unnamed.ok)

  const withZone = await saveOnlineSettings(
    SITE,
    { ...publishable, isEnabled: true, deliverEnabled: true },
    'test',
  )
  ok('delivery opens once an area exists', withZone.ok, withZone.ok ? '' : withZone.error)

  console.log('\n— Validation —')
  ok(
    'an absurd preparation time is refused',
    !(await saveOnlineSettings(SITE, { ...publishable, leadTimeMinutes: 99_999 }, 'test')).ok,
  )
  ok(
    'a negative minimum order is refused',
    !(await saveOnlineSettings(SITE, { ...publishable, minOrderIncl: -1 }, 'test')).ok,
  )

  // ── Restore everything this test touched ──────────────────────────────
  // Delivery areas are cleared above and then re-created from what was there,
  // so a site that had zones before this ran still has them afterwards.
  for (const z of await listDeliveryZones(SITE)) await deleteDeliveryZone(SITE, z.id)
  for (const z of zonesBefore) {
    await saveDeliveryZone(SITE, {
      name: z.name,
      matchType: z.matchType,
      matchValue: z.matchValue,
      feeIncl: z.feeIncl,
      freeOverIncl: z.freeOverIncl,
      minOrderIncl: z.minOrderIncl,
      isActive: z.isActive,
      sortOrder: z.sortOrder,
    })
  }
  await siteExecute(SITE, `UPDATE products SET show_online = 0`)
  await saveOnlineSettings(SITE, base, original.updatedBy || 'test')

  const restored = await getOnlineSettings(SITE)
  ok('settings restored', restored.isEnabled === original.isEnabled && restored.blurb === original.blurb)
  ok(
    'delivery areas left as they were',
    (await listDeliveryZones(SITE)).length === zonesBefore.length,
  )

  console.log(`\n${fails === 0 ? 'All online store checks passed.' : `${fails} FAILED.`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
