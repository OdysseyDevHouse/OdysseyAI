/**
 * How a storefront URL resolves to a catalogue and a branch.
 *
 * The assertion that matters most is the FIRST one: a single shop, and a shop
 * whose group has not switched the shared storefront on, must resolve exactly as
 * they did before any of this existed. Everything else here is new behaviour
 * that can be got wrong; that one is existing behaviour that must not be.
 *
 * After that, the cases are the ones a chain actually hits: a QR code on a
 * branch's door, a shopper coming back a week later, and a cookie that has gone
 * stale because the branch left the group or its subscription lapsed.
 *
 *   npm run test:branch-routing
 */
import { createPublicStoreToken } from '../src/lib/publicStoreToken'
import { resolveStoreRouting } from '../src/lib/storeRouting'
import { groupForSite, membersOfGroup, setGroupOnlineMode } from '../src/lib/storeGroups'
import { branchPinsFor, setBranchPin, syncBranchPin } from '../src/lib/control/storeBranches'
import { parseBranchCookie, branchCookieName } from '../src/lib/branchChoice'
import { addModule, entitlementsForSite, has as hasModule } from '../src/lib/control/modules'
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { execute, queryOne } from '../src/lib/db'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

type Restore = () => Promise<void>

async function main() {
  const undo: Restore[] = []

  console.log('\n— Reading the cookie —')
  ok('a plain id is read', parseBranchCookie('7') === 7)
  ok('an empty cookie is nothing', parseBranchCookie('') === null)
  ok('a missing cookie is nothing', parseBranchCookie(undefined) === null)
  ok('junk is nothing', parseBranchCookie('../../etc') === null)
  ok('a negative id is nothing', parseBranchCookie('-3') === null)
  ok('a decimal is nothing', parseBranchCookie('2.5') === null)
  // Keyed per catalogue so two chains in one browser do not overwrite each other.
  ok('the name is per catalogue', branchCookieName(1) !== branchCookieName(2))

  const group = await groupForSite(1)
  if (!group) {
    console.log('\nSKIP  site 1 is in no store group — routing not exercised')
    console.log(fails === 0 ? '\nAll routing checks passed.' : `\n${fails} FAILED.`)
    process.exit(fails === 0 ? 0 : 1)
  }

  const members = await membersOfGroup(group.id)
  const PRIMARY = group.primarySiteId ?? members[0].siteId
  const branchMember = members.find((m) => m.siteId !== PRIMARY && m.hasDatabase)
  if (!branchMember) {
    console.log('\nSKIP  the group has only one usable store')
    console.log(fails === 0 ? '\nAll routing checks passed.' : `\n${fails} FAILED.`)
    process.exit(fails === 0 ? 0 : 1)
  }
  const BRANCH = branchMember.siteId

  console.log('\n— Group mode off: nothing changes —')
  const modeBefore = group.onlineGroupMode
  undo.push(async () => void (await setGroupOnlineMode(group.id, modeBefore)))
  await setGroupOnlineMode(group.id, false)

  for (const siteId of [PRIMARY, BRANCH]) {
    const routing = await resolveStoreRouting(await createPublicStoreToken(siteId))
    const ent = await entitlementsForSite(siteId)
    if (!hasModule(ent, 'online_store')) {
      // A shop without the module 404s, which is 302d0a4's gate, not ours.
      ok(`site ${siteId} without the module is refused`, routing === null)
      continue
    }
    ok(`site ${siteId} serves itself`, routing?.catalogueSiteId === siteId)
    ok(`site ${siteId} fulfils its own orders`, routing?.branchSiteId === siteId)
    ok(`site ${siteId} is not a group storefront`, routing?.isGroup === false)
    ok(`site ${siteId} asks nobody to choose`, routing?.needsBranchChoice === false)
  }

  console.log('\n— A forged or empty token —')
  ok('nonsense resolves to nothing', (await resolveStoreRouting('not-a-token')) === null)
  ok('an empty token resolves to nothing', (await resolveStoreRouting('')) === null)

  /*
   * Everything below needs both shops open and entitled. The demo data has only
   * one of them holding online_store, so the modules and the settings are lent
   * for the duration of the test and handed back in the cleanup below.
   */
  console.log('\n— Group mode on —')
  for (const siteId of [PRIMARY, BRANCH]) {
    const ent = await entitlementsForSite(siteId)
    if (!hasModule(ent, 'online_store')) {
      /*
       * Lent through the real API rather than an INSERT: cp2_site_modules has no
       * unique key on (site_id, module_key) and carries dated periods, so hand
       * SQL here would either duplicate a row or invent a shape addModule does
       * not use. Cleanup deletes by the id this created and nothing else — a
       * DELETE by (site_id, module_key) would take a real subscription with it.
       */
      const added = await addModule(siteId, 'online_store', { name: 'test', email: null }, null)
      ok(`site ${siteId} is lent the online shop for this test`, added.ok)
      const row = await queryOne<{ id: number }>(
        `SELECT id FROM cp2_site_modules
          WHERE site_id = ? AND module_key = 'online_store'
          ORDER BY id DESC LIMIT 1`,
        [siteId],
      )
      if (row) {
        undo.push(async () => {
          await execute('DELETE FROM cp2_site_modules WHERE id = ?', [row.id])
        })
      }
    }

    const was = await siteQueryOne<{ is_enabled: number }>(
      siteId,
      'SELECT is_enabled FROM online_store_settings WHERE id = 1',
    )
    const previous = was?.is_enabled ?? 0
    await siteExecute(siteId, 'UPDATE online_store_settings SET is_enabled = 1 WHERE id = 1')
    undo.push(async () => {
      await siteExecute(siteId, 'UPDATE online_store_settings SET is_enabled = ? WHERE id = 1', [
        previous,
      ])
    })
  }

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

  const enabled = await setGroupOnlineMode(group.id, true)
  ok('the group storefront switches on', enabled.ok, 'ok' in enabled && !enabled.ok ? enabled.error : '')

  const primaryToken = await createPublicStoreToken(PRIMARY)
  const branchToken = await createPublicStoreToken(BRANCH)

  console.log('\n— The front door, with nothing chosen —')
  const fresh = await resolveStoreRouting(primaryToken)
  ok('it is a group storefront', fresh?.isGroup === true)
  ok('the catalogue is the primary', fresh?.catalogueSiteId === PRIMARY)
  ok('the shopper is asked to choose', fresh?.needsBranchChoice === true)
  ok('nothing is pinned by the link', fresh?.isPinned === false)
  ok('every open branch is offered', (fresh?.branches.length ?? 0) >= 2, String(fresh?.branches.length))
  // The catalogue still has to render while the picker is up, so the branch
  // falls back to the primary rather than being absent.
  ok('there is still a site to read from', (fresh?.branchSiteId ?? 0) > 0)

  console.log('\n— The QR code on a branch door —')
  const scanned = await resolveStoreRouting(branchToken)
  ok('the branch is the one in the link', scanned?.branchSiteId === BRANCH)
  ok('the catalogue is still the primary', scanned?.catalogueSiteId === PRIMARY)
  ok('it counts as pinned', scanned?.isPinned === true)
  ok('and nobody is asked to choose', scanned?.needsBranchChoice === false)

  console.log('\n— A shopper who came back —')
  const remembered = await resolveStoreRouting(primaryToken, BRANCH)
  ok('the remembered branch is used', remembered?.branchSiteId === BRANCH)
  ok('and they are not asked again', remembered?.needsBranchChoice === false)
  ok('but it is not treated as pinned', remembered?.isPinned === false)

  console.log('\n— The link beats the cookie —')
  // Somebody standing in the shop holding a phone that remembers another branch.
  const conflict = await resolveStoreRouting(branchToken, PRIMARY)
  ok('the scanned branch wins', conflict?.branchSiteId === BRANCH, String(conflict?.branchSiteId))

  console.log('\n— A cookie that has gone stale —')
  const stranger = await resolveStoreRouting(primaryToken, 999999)
  ok('a branch outside the group is ignored', stranger?.needsBranchChoice === true)
  ok('and the shopper is asked instead', stranger?.branchSiteId === PRIMARY)
  ok('a junk id is ignored', (await resolveStoreRouting(primaryToken, -1))?.needsBranchChoice === true)

  console.log('\n— Switching it back off —')
  await setGroupOnlineMode(group.id, false)
  const off = await resolveStoreRouting(branchToken)
  ok('the branch serves itself again', off?.catalogueSiteId === BRANCH)
  ok('and is no longer a group storefront', off?.isGroup === false)

  console.log('\n— Cleanup —')
  for (const step of undo.reverse()) await step()
  const after = await groupForSite(1)
  ok('group mode is back as it was', after?.onlineGroupMode === modeBefore)
  const pinsAfter = await branchPinsFor([PRIMARY, BRANCH])
  ok(
    'pins are back as they were',
    pinsAfter.every((p) => {
      const was = pinsBefore.find((b) => b.siteId === p.siteId)
      return (was?.latitude ?? null) === p.latitude && (was?.longitude ?? null) === p.longitude
    }),
  )
  for (const siteId of [PRIMARY, BRANCH]) {
    const ent = await entitlementsForSite(siteId)
    console.log(`  site ${siteId} online_store back to: ${hasModule(ent, 'online_store')}`)
  }

  console.log(fails === 0 ? '\nAll routing checks passed.' : `\n${fails} FAILED.`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
