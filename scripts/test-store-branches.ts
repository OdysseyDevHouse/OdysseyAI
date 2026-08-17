/**
 * Branch pins and the group storefront switch.
 *
 * Two things are worth testing here, and they are different in kind.
 *
 * The RANKING is pure, so it is tested exhaustively and with no database at all:
 * every way a shopper can fail to have a usable location, and every way a group
 * can fail to have pinned its shops, has to leave the picker usable. Those are
 * the cases that decide whether a chain loses a sale, and they are exactly the
 * ones nobody exercises by hand.
 *
 * The PIN COPY is a cache of two other tables, so what is tested is that it says
 * so honestly — a sync that cannot read a store reports it rather than writing a
 * zero, and a hand-placed pin is not silently wiped by the next settings save.
 *
 *   npm run test:store-branches
 */
import {
  branchPin,
  branchPinsFor,
  forgetBranchPin,
  setBranchPin,
  syncBranchPin,
} from '../src/lib/control/storeBranches'
import {
  formatKm,
  isUsableFix,
  nearestBranch,
  rankBranches,
  type RankableBranch,
} from '../src/lib/storeBranchPicker'
import { groupForSite, setGroupOnlineMode } from '../src/lib/storeGroups'
import { query } from '../src/lib/db'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** Cape Town landmarks, far enough apart that the ordering is unambiguous. */
const CBD = { lat: -33.9249, lng: 18.4241 }
const branch = (
  siteId: number,
  name: string,
  lat: number | null,
  lng: number | null,
  sortOrder = 0,
): RankableBranch => ({ siteId, displayName: name, latitude: lat, longitude: lng, sortOrder })

const CLAREMONT = branch(101, 'Claremont', -33.9805, 18.4653, 1)
const SEAPOINT = branch(102, 'Sea Point', -33.9146, 18.3843, 2)
const BELLVILLE = branch(103, 'Bellville', -33.8938, 18.6294, 3)
const UNPINNED = branch(104, 'Somerset West', null, null, 4)

async function main() {
  console.log('\n— A usable fix —')
  ok('a normal reading is usable', isUsableFix(CBD))
  ok('null is not', !isUsableFix(null))
  ok('undefined is not', !isUsableFix(undefined))
  // 0,0 is in the Gulf of Guinea. A browser returning it means the reading
  // failed, and treating it as a location puts every SA shopper 6000km away.
  ok('the null island reading is refused', !isUsableFix({ lat: 0, lng: 0 }))
  ok('a swapped pair out of range is refused', !isUsableFix({ lat: 200, lng: 18 }))
  ok('NaN is refused', !isUsableFix({ lat: Number.NaN, lng: 18 }))

  console.log('\n— Ranking with a fix —')
  const all = [BELLVILLE, UNPINNED, CLAREMONT, SEAPOINT]
  const ranked = rankBranches(all, CBD)
  ok('every branch is returned', ranked.length === 4, String(ranked.length))
  ok(
    'the nearest pinned branch is first',
    ranked[0].displayName === 'Sea Point',
    ranked.map((r) => r.displayName).join(' < '),
  )
  ok('an unpinned branch sorts last', ranked[3].displayName === 'Somerset West')
  ok('an unpinned branch has no distance', ranked[3].km === null)
  ok(
    'distances increase down the list',
    ranked[0].km !== null && ranked[1].km !== null && ranked[0].km <= ranked[1].km,
  )
  // The whole point of the km figure: a shopper in the CBD is a few km from
  // Sea Point, not a few hundred.
  ok('the distance is plausible', (ranked[0].km ?? 0) < 15, `${ranked[0].km?.toFixed(1)} km`)

  console.log('\n— Ranking with no fix —')
  const noFix = rankBranches(all, null)
  ok('every branch is still returned', noFix.length === 4)
  ok('nothing claims a distance', noFix.every((b) => b.km === null))
  ok(
    'the owner’s running order is used',
    noFix.map((b) => b.displayName).join(',') ===
      'Claremont,Sea Point,Bellville,Somerset West',
    noFix.map((b) => b.displayName).join(','),
  )
  // The picker must be usable for a shopper who declined location. If this
  // fails, a denied permission empties the shop.
  ok('a refused location still lists every branch', rankBranches(all, { lat: 0, lng: 0 }).length === 4)

  console.log('\n— Ranking is stable —')
  const a = rankBranches(all, CBD).map((b) => b.siteId).join(',')
  const b = rankBranches(all, CBD).map((x) => x.siteId).join(',')
  ok('the same inputs give the same order', a === b, a)
  ok('an empty group ranks to nothing', rankBranches([], CBD).length === 0)

  console.log('\n— The nearest branch —')
  ok('a shopper in the CBD gets one', nearestBranch(all, CBD)?.displayName === 'Sea Point')
  ok('with no fix, nobody is chosen for them', nearestBranch(all, null) === null)
  ok('with nothing pinned, nobody is chosen', nearestBranch([UNPINNED], CBD) === null)
  // Johannesburg. Auto-allocating this shopper to a Cape Town branch would take
  // an order the shop cannot deliver.
  const JHB = { lat: -26.2041, lng: 28.0473 }
  ok('a shopper in another province is asked, not guessed', nearestBranch(all, JHB) === null)
  ok('…unless the limit is widened', nearestBranch(all, JHB, 2000) !== null)

  console.log('\n— Distances a person would say —')
  ok('under a kilometre reads in metres', formatKm(0.6) === '600 m', formatKm(0.6))
  ok('a short hop keeps one decimal', formatKm(2.43) === '2.4 km', formatKm(2.43))
  ok('a long one is whole kilometres', formatKm(41.7) === '42 km', formatKm(41.7))
  ok('no distance renders as nothing', formatKm(null) === '')

  console.log('\n— The pin copy —')
  const pinBefore = await branchPin(SITE)
  const sync = await syncBranchPin(SITE)
  ok('a real site syncs', sync.ok, sync.error ?? '')
  const afterSync = await branchPin(SITE)
  ok('a row now exists', afterSync !== null)
  ok('it carries the shop’s name', (afterSync?.displayName ?? '') !== '')
  ok('and records when it was copied', afterSync?.syncedAt !== null)

  console.log('\n— Pins are validated, not clamped —')
  const bad = await setBranchPin(SITE, 200, 18)
  ok('an out-of-range latitude is refused', !bad.ok)
  ok('and says why', !bad.ok && bad.error.includes('-90'))
  const half = await setBranchPin(SITE, -33.9, null)
  ok('half a pin is refused', !half.ok)

  const good = await setBranchPin(SITE, -33.9249, 18.4241)
  ok('a real pin is accepted', good.ok)
  const pinned = await branchPin(SITE)
  ok('and reads back as a number', typeof pinned?.latitude === 'number', String(pinned?.latitude))
  ok('with the value it was given', Math.abs((pinned?.latitude ?? 0) + 33.9249) < 0.0001)

  // The reason syncBranchPin uses COALESCE: a shop whose main location has no
  // coordinates must not lose a pin somebody placed by hand on the setup screen.
  await syncBranchPin(SITE)
  const afterResync = await branchPin(SITE)
  ok(
    'a hand-placed pin survives the next sync',
    afterResync?.latitude !== null && afterResync?.longitude !== null,
    `${afterResync?.latitude},${afterResync?.longitude}`,
  )

  const cleared = await setBranchPin(SITE, null, null)
  ok('a pin can be cleared deliberately', cleared.ok)
  ok('and reads back as unpinned', (await branchPin(SITE))?.latitude === null)

  console.log('\n— Reading a group’s pins —')
  ok('no sites means no query and no rows', (await branchPinsFor([])).length === 0)
  ok('a junk id is ignored', (await branchPinsFor([0, -1])).length === 0)
  const many = await branchPinsFor([SITE, 999999])
  ok('a missing site is simply absent', many.length <= 1)

  console.log('\n— A store that cannot be read —')
  const ghost = await syncBranchPin(999999)
  ok('syncing an unknown site fails', !ghost.ok)
  ok('and reports rather than throws', typeof ghost.error === 'string')

  console.log('\n— The group storefront switch —')
  const group = await groupForSite(SITE)
  if (!group) {
    console.log('SKIP  site 1 is in no store group — switch not exercised')
  } else {
    const was = group.onlineGroupMode
    const off = await setGroupOnlineMode(group.id, false)
    ok('it can always be switched off', off.ok)
    ok('and reads back off', (await groupForSite(SITE))?.onlineGroupMode === false)

    const on = await setGroupOnlineMode(group.id, true)
    // Either outcome is correct and both are informative: it turns on when the
    // primary's shop is open, and refuses with a reason when it is not.
    ok(
      'switching on either works or says why',
      on.ok || (!on.ok && on.error.length > 0),
      on.ok ? 'enabled' : on.error,
    )
    await setGroupOnlineMode(group.id, was)
    ok('the switch is put back', (await groupForSite(SITE))?.onlineGroupMode === was)
  }

  console.log('\n— A group with no primary —')
  const orphan = await query<{ id: number }>(
    'SELECT id FROM cp2_store_groups WHERE primary_site_id IS NULL LIMIT 1',
  )
  if (orphan.length === 0) {
    console.log('SKIP  no group without a primary to test against')
  } else {
    const res = await setGroupOnlineMode(orphan[0].id, true)
    ok('a group with no main store is refused', !res.ok)
    ok('and is told what to fix', !res.ok && res.error.toLowerCase().includes('store'))
  }

  console.log('\n— Cleanup —')
  if (pinBefore === null) {
    await forgetBranchPin(SITE)
    ok('the row this test created is removed', (await branchPin(SITE)) === null)
  } else {
    await setBranchPin(SITE, pinBefore.latitude, pinBefore.longitude)
    const restored = await branchPin(SITE)
    ok(
      'the original pin is restored',
      restored?.latitude === pinBefore.latitude && restored?.longitude === pinBefore.longitude,
    )
  }

  console.log(fails === 0 ? '\nAll branch checks passed.' : `\n${fails} FAILED.`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
