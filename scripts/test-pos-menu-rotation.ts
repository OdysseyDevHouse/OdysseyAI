/**
 * End-to-end: does the till's grid actually rotate?
 *
 * Reads the REAL menus and departments for a site, then asks the engine what
 * the grid would hold at several times of day. This is the question the unit
 * test cannot answer, because it is about this shop's own data — the seeded
 * café has a Breakfast menu whose departments must actually differ from
 * Lunch's, or the feature is switched on and doing nothing.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-pos-menu-rotation.ts [siteId]
 */
import { livePosMenus, departmentPathsFor } from '../src/lib/site/posMenus'
import { listDepartments } from '../src/lib/site/departments'
import { browseForTill } from '../src/lib/site/tillSearch'
import { activeMenu, productsOnMenu } from '../src/lib/posMenuEngine'

const SITE = Number(process.argv[2] || 33)

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** A Monday, at the given hour on the shop's own clock. */
const at = (hh: number, mm = 0) => new Date(2026, 7, 24, hh, mm)

async function main() {
  const menus = await livePosMenus(SITE)
  console.log(`site ${SITE}: ${menus.length} live menu(s)`)
  for (const m of menus) {
    console.log(
      `  ${m.name}: ${m.dailyStart || '--'}-${m.dailyEnd || '--'} days=${m.daysOfWeek} prio=${m.priority} items=${m.items.length}`,
    )
  }
  if (menus.length === 0) {
    console.log('\nNo menus on this site — nothing to prove. Seed some first.')
    process.exit(0)
  }

  const departments = await listDepartments(SITE)
  const pathFor = await departmentPathsFor(SITE)

  // The whole sellable catalogue, exactly as the till's browse would load it.
  const all = await browseForTill(SITE, { limit: 50_000 })
  console.log(`\ncatalogue: ${all.length} products, ${departments.length} departments`)
  ok('the catalogue is not empty', all.length > 0, 'an empty file proves nothing below')

  // ── The grid, hour by hour ──────────────────────────────────────────────
  const hours = [3, 8, 13, 19, 23]
  const seen = new Map<string, number>()
  console.log('')
  // Sampled as an ORDINARY till — one no menu is pinned to — so this column
  // shows what a normal counter draws rather than what wins shop-wide.
  const ORDINARY = 999_000
  for (const h of hours) {
    const now = at(h)
    const live = activeMenu(menus, now, ORDINARY)
    const grid = productsOnMenu(all, live, pathFor)
    const label = live?.name ?? '(no menu — whole catalogue)'
    seen.set(label, grid.length)
    console.log(`  ${String(h).padStart(2, '0')}:00  ${label.padEnd(28)} ${grid.length} products`)
  }

  // ── What must be true ───────────────────────────────────────────────────
  const breakfast = menus.find((m) => m.name === 'Breakfast')
  const lunch = menus.find((m) => m.name === 'Lunch')

  if (breakfast && lunch) {
    const bGrid = productsOnMenu(all, breakfast, pathFor)
    const lGrid = productsOnMenu(all, lunch, pathFor)

    ok('breakfast shows fewer products than the whole catalogue', bGrid.length < all.length,
      `${bGrid.length} of ${all.length}`)
    ok('breakfast shows something at all', bGrid.length > 0,
      'an empty grid would be a till nobody can sell from')

    const bIds = new Set(bGrid.map((p) => p.id))
    const lIds = new Set(lGrid.map((p) => p.id))
    const onlyBreakfast = [...bIds].filter((id) => !lIds.has(id))
    const onlyLunch = [...lIds].filter((id) => !bIds.has(id))
    ok('*** the two menus actually differ ***', onlyBreakfast.length > 0 || onlyLunch.length > 0,
      `${onlyBreakfast.length} breakfast-only, ${onlyLunch.length} lunch-only`)

    /*
     * The changeover, to the minute. This is the whole feature.
     *
     * Asked as a specific UNPINNED till rather than shop-wide: once 232 let a
     * menu be pinned to one till, the shop-wide question legitimately answers
     * "whatever wins on priority anywhere", which may be a bar menu no ordinary
     * counter will ever draw. `UNPINNED_TILL` is an id no menu names, so it
     * sees exactly the shop-wide menus a normal counter sees.
     */
    const UNPINNED_TILL = 999_000
    const at1059 = activeMenu(menus, at(10, 59), UNPINNED_TILL)?.name
    const at1100 = activeMenu(menus, at(11, 0), UNPINNED_TILL)?.name
    ok('*** 10:59 is Breakfast and 11:00 is Lunch (on an ordinary till) ***',
      at1059 === 'Breakfast' && at1100 === 'Lunch',
      `10:59=${at1059} 11:00=${at1100}`)
  } else {
    console.log('\n(no Breakfast/Lunch pair on this site — skipping the comparison)')
  }

  /*
   * The weekend overnight menu, which the weekday sweep above cannot see.
   *
   * 2026-08-29 is a SATURDAY. A menu running 22:00-02:00 on weekends must be
   * live at 23:00 on Saturday and NOT at 23:00 on Monday — the case where a
   * Sunday-first day mask would look perfectly plausible and be wrong.
   */
  const lateNight = menus.find((m) => m.name === 'Late night')
  if (lateNight) {
    const satNight = new Date(2026, 7, 29, 23, 0)
    const monNight = at(23)
    ok('*** the weekend late menu runs on Saturday night ***',
      activeMenu(menus, satNight)?.name === 'Late night',
      `got ${activeMenu(menus, satNight)?.name ?? 'none'}`)
    ok('the weekend late menu does NOT run on Monday night',
      activeMenu(menus, monNight)?.name !== 'Late night')
    // 01:00 Sunday is still SATURDAY's late service, by the overnight rule.
    const sunEarly = new Date(2026, 7, 30, 1, 0)
    ok('*** 01:00 Sunday is still the Saturday late menu ***',
      activeMenu(menus, sunEarly)?.name === 'Late night',
      'the overnight band belongs to the day it started on')
  }

  /*
   * Per-till pinning (232), against this site's REAL tills.
   *
   * The whole point of the feature: at one moment, two tills in the same shop
   * showing different grids. If every menu on this site is unpinned there is
   * nothing to prove, and the check says so rather than passing vacuously.
   */
  const pinned = menus.filter((m) => m.terminalIds.length > 0)
  if (pinned.length === 0) {
    console.log('\n(no menu on this site is pinned to a till — skipping the per-till checks)')
  } else {
    const tills = [...new Set(menus.flatMap((m) => m.terminalIds))]
    console.log(`\nper-till, at 13:00 (${pinned.length} pinned menu(s)):`)
    const seen = new Map<number, string>()
    for (const t of tills) {
      const m = activeMenu(menus, at(13), t)
      const g = productsOnMenu(all, m, pathFor)
      seen.set(t, m?.name ?? 'none')
      console.log(`  till ${t}: ${(m?.name ?? 'no menu').padEnd(14)} ${g.length} products`)
    }
    // A till with no pinning of its own, to compare against.
    const otherId = Math.max(...tills) + 1000
    const other = activeMenu(menus, at(13), otherId)
    const otherGrid = productsOnMenu(all, other, pathFor)
    console.log(`  till ${otherId} (unpinned): ${(other?.name ?? 'no menu').padEnd(6)} ${otherGrid.length} products`)

    ok('*** a pinned till and an unpinned one show DIFFERENT menus ***',
      [...seen.values()].some((name) => name !== (other?.name ?? 'none')),
      `pinned tills saw ${JSON.stringify([...seen.values()])}, unpinned saw ${other?.name ?? 'none'}`)
    ok('the unpinned till still gets a shop-wide menu',
      other !== null && other.terminalIds.length === 0,
      'an unpinned till must never be left with nothing because of somebody else’s pinning')
  }

  // Off-menu products must stay findable, which is the promise 231 makes.
  const live8 = activeMenu(menus, at(8))
  if (live8) {
    const grid = productsOnMenu(all, live8, pathFor)
    const offMenu = all.filter((p) => !grid.some((g) => g.id === p.id))
    ok('*** off-menu products still exist in the catalogue ***', offMenu.length > 0,
      `${offMenu.length} products are off the 08:00 grid but still sellable by scan or search`)
  }

  console.log(fails === 0 ? '\nAll good.' : `\n${fails} FAILED.`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
