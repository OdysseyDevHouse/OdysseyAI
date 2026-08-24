/**
 * The rotating menus' window arithmetic (231).
 *
 * Pure — no database, no site. Everything here is a question about a clock,
 * and the answers are the ones a café would give: breakfast ends when lunch
 * begins, a late menu crosses midnight, and an hour nobody planned for shows
 * the whole grid rather than an empty one.
 */
import {
  menuActiveAt,
  activeMenu,
  menuAllows,
  menuGaps,
  menuRunsOnTerminal,
  departmentsOnMenu,
  productsOnMenu,
  type PosMenu,
  type PosMenuItem,
} from '../src/lib/posMenuEngine'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const menu = (over: Partial<PosMenu> = {}): PosMenu => ({
  id: 1,
  name: 'Breakfast',
  isActive: true,
  dailyStart: '07:00',
  dailyEnd: '11:00',
  daysOfWeek: '1111111',
  priority: 0,
  items: [],
  terminalIds: [],
  ...over,
})

/** A Monday in August 2026, at the given wall-clock time. */
const at = (hh: number, mm = 0) => new Date(2026, 7, 24, hh, mm)

function main() {
  // ── The band ────────────────────────────────────────────────────────────
  ok('inside the band is live', menuActiveAt(menu(), at(9)))
  ok('before the band is not', !menuActiveAt(menu(), at(6, 59)))
  ok('the start is INCLUSIVE', menuActiveAt(menu(), at(7, 0)))

  /*
   * The changeover. Breakfast 07:00-11:00 and lunch 11:00-17:00 are written
   * back to back, which is how a person writes them — and if both ends were
   * inclusive both menus would own 11:00 exactly, leaving one minute of the
   * day decided by a priority tiebreak nobody set deliberately.
   */
  ok('*** the end is EXCLUSIVE, so 11:00 is lunch ***', !menuActiveAt(menu(), at(11, 0)))
  ok('the minute before the end is still breakfast', menuActiveAt(menu(), at(10, 59)))

  // ── Overnight ───────────────────────────────────────────────────────────
  const late = menu({ name: 'Late', dailyStart: '22:00', dailyEnd: '02:00' })
  ok('overnight: late evening is live', menuActiveAt(late, at(23)))
  ok('overnight: after midnight is live', menuActiveAt(late, at(1)))
  ok('overnight: the afternoon is not', !menuActiveAt(late, at(15)))
  ok('overnight: 02:00 itself has ended', !menuActiveAt(late, at(2, 0)))

  // ── All day, and the switch ─────────────────────────────────────────────
  ok('no band at all runs all day', menuActiveAt(menu({ dailyStart: '', dailyEnd: '' }), at(3)))
  ok('switched off is never live', !menuActiveAt(menu({ isActive: false }), at(9)))

  // ── The day mask, Monday first ──────────────────────────────────────────
  // 2026-08-24 is a MONDAY, so only the first character should matter.
  ok('day mask: Monday on', menuActiveAt(menu({ daysOfWeek: '1000000' }), at(9)))
  ok('*** day mask is MONDAY-FIRST, not Sunday-first ***',
    !menuActiveAt(menu({ daysOfWeek: '0000001' }), at(9)),
    'a Sunday-first reading would call this live')

  // ── Which menu wins ─────────────────────────────────────────────────────
  const breakfast = menu({ id: 1, name: 'Breakfast', priority: 0 })
  const allDay = menu({ id: 2, name: 'All day', dailyStart: '', dailyEnd: '', priority: 10 })
  ok('*** overlap is resolved by priority, not refused ***',
    activeMenu([allDay, breakfast], at(9))?.name === 'Breakfast')
  ok('outside breakfast the all-day menu takes over',
    activeMenu([allDay, breakfast], at(15))?.name === 'All day')
  ok('no menu covers the hour', activeMenu([breakfast], at(3)) === null)
  ok('ties break on the lower id, so the answer is stable',
    activeMenu([menu({ id: 5, priority: 0 }), menu({ id: 3, priority: 0 })], at(9))?.id === 3)

  // ── Scope ───────────────────────────────────────────────────────────────
  const item = (o: Partial<PosMenuItem>): PosMenuItem => ({
    effect: 'include',
    productId: null,
    departmentId: null,
    ...o,
  })
  const lunch = menu({ items: [item({ departmentId: 20 }), item({ productId: 99 })] })

  ok('a product in an included department is on',
    menuAllows(lunch, { id: 1, departmentId: 20 }, [20]))
  ok('a product named directly is on',
    menuAllows(lunch, { id: 99, departmentId: 77 }, [77]))
  ok('an unrelated product is off',
    !menuAllows(lunch, { id: 2, departmentId: 77 }, [77]))
  ok('*** a department catches its whole subtree ***',
    menuAllows(lunch, { id: 3, departmentId: 21 }, [21, 20]),
    'coffee under Drinks > Hot when the menu says Drinks')

  const withHole = menu({
    items: [item({ departmentId: 20 }), item({ effect: 'exclude', productId: 5 })],
  })
  ok('*** exclude beats include, whatever the row order ***',
    !menuAllows(withHole, { id: 5, departmentId: 20 }, [20]))
  ok('the rest of the department survives the exclusion',
    menuAllows(withHole, { id: 6, departmentId: 20 }, [20]))

  // ── The empty cases, which must never blank a till ──────────────────────
  const products = [
    { id: 1, departmentId: 20 },
    { id: 2, departmentId: 77 },
  ]
  const path = (d: number | null) => (d === null ? [] : [d])

  ok('*** no menu at all shows everything ***',
    productsOnMenu(products, null, path).length === 2)
  ok('*** a menu with an empty scope shows everything, not nothing ***',
    productsOnMenu(products, menu({ items: [] }), path).length === 2,
    'a half-built menu saved at 10:55 must not blank the grid at 11:00')
  ok('a real menu filters', productsOnMenu(products, lunch, path).length === 1)

  // ── Per-till pinning (232) ──────────────────────────────────────────────
  /* Bar takes a LOWER priority number so it would win the contest on merit.
     Equal priorities would let the lower id win, and then "the bar till gets
     the bar menu" could pass without the terminal filter doing anything —
     a test that proves nothing. */
  const shopWide = menu({ id: 1, name: 'Shop wide', priority: 5, terminalIds: [] })
  const barOnly = menu({ id: 2, name: 'Bar', priority: 0, terminalIds: [7] })

  ok('*** an unpinned menu runs on every till ***', menuRunsOnTerminal(shopWide, 7))
  ok('an unpinned menu runs on a different till too', menuRunsOnTerminal(shopWide, 99))
  ok('*** an unpinned menu runs on a machine with NO till ***',
    menuRunsOnTerminal(shopWide, null),
    'empty means everywhere — this is what keeps pre-232 menus working')
  ok('a pinned menu runs on its own till', menuRunsOnTerminal(barOnly, 7))
  ok('*** a pinned menu does NOT run on another till ***', !menuRunsOnTerminal(barOnly, 99))
  ok('*** a pinned menu does NOT run on an unclaimed machine ***',
    !menuRunsOnTerminal(barOnly, null),
    'guessing would put the bar menu on a random browser')

  // The same, through activeMenu — where it actually bites.
  ok('*** the bar till gets the bar menu ***',
    activeMenu([shopWide, barOnly], at(9), 7)?.name === 'Bar',
    'Bar wins on priority here, so a pass means the filter let it through')
  ok('another till falls back to the shop-wide menu',
    activeMenu([shopWide, barOnly], at(9), 99)?.name === 'Shop wide')
  ok('an unclaimed machine gets the shop-wide menu only',
    activeMenu([shopWide, barOnly], at(9), null)?.name === 'Shop wide')
  ok('*** omitting the till considers every menu (the back-office preview) ***',
    activeMenu([shopWide, barOnly], at(9))?.name === 'Bar',
    'undefined must NOT be treated as null')

  // Gaps are per till too.
  const pinnedShort = menu({ id: 3, dailyStart: '08:00', dailyEnd: '10:00', terminalIds: [7] })
  const gapsForOther = menuGaps([pinnedShort], 99)
  ok('*** a till the menu is not pinned to sees NO coverage from it ***',
    gapsForOther.length === 7 && gapsForOther.every((g) => g.minutes === 1440),
    'every day wholly uncovered on till 99')
  ok('the pinned till does get its coverage',
    menuGaps([pinnedShort], 7).some((g) => g.from === '10:00'))

  // ── The rail: departments must not open onto nothing ────────────────────
  const tree = [
    { id: 1, parentId: null }, // Drinks — an empty folder
    { id: 2, parentId: 1 }, //    Hot
    { id: 3, parentId: 1 }, //    Cold
    { id: 4, parentId: null }, // Burgers
  ]
  // A menu naming only "Hot" (2).
  const hotOnly = menu({ items: [item({ departmentId: 2 })] })
  const keptByScope = (id: number) => {
    const path: number[] = []
    let cur: (typeof tree)[number] | undefined = tree.find((d) => d.id === id)
    while (cur) {
      path.push(cur.id)
      cur = cur.parentId === null ? undefined : tree.find((d) => d.id === cur!.parentId)
    }
    const set = new Set(path)
    let inc = false
    for (const i of hotOnly.items) {
      if (i.departmentId === null || !set.has(i.departmentId)) continue
      if (i.effect === 'exclude') return false
      inc = true
    }
    return inc
  }
  const railed = departmentsOnMenu(tree, hotOnly, keptByScope).map((d) => d.id)
  ok('*** the empty parent survives because a child is on the menu ***',
    railed.includes(1), JSON.stringify(railed))
  ok('the on-menu child survives', railed.includes(2))
  ok('*** the off-menu sibling is dropped ***', !railed.includes(3))
  ok('*** an unrelated top-level department is dropped ***', !railed.includes(4))

  ok('no menu leaves every department drawn',
    departmentsOnMenu(tree, null, () => false).length === 4,
    'a shop with no menus must see the till it saw yesterday')
  ok('an empty scope leaves every department drawn',
    departmentsOnMenu(tree, menu({ items: [] }), () => false).length === 4)

  // ── Gaps: the hours nothing covers ──────────────────────────────────────
  const bfast = menu({ id: 1, name: 'Breakfast', dailyStart: '08:00', dailyEnd: '10:00' })
  const lunchM = menu({ id: 2, name: 'Lunch', dailyStart: '11:00', dailyEnd: '16:00' })

  const g = menuGaps([bfast, lunchM])
  const monday = g.filter((x) => x.day === 0)
  ok('*** the 10:00-11:00 hole is found ***',
    monday.some((x) => x.from === '10:00' && x.to === '11:00'),
    JSON.stringify(monday.map((x) => `${x.from}-${x.to}`)))
  ok('the small hours before the first menu are a gap',
    monday.some((x) => x.from === '00:00' && x.to === '08:00'))
  ok('the evening after the last menu is a gap',
    monday.some((x) => x.from === '16:00' && x.to === '24:00'))
  ok('gaps are reported for all seven days', new Set(g.map((x) => x.day)).size === 7)

  // Back-to-back must be clean — this is the end-exclusive rule paying off.
  const touching = menuGaps([
    menu({ id: 1, dailyStart: '00:00', dailyEnd: '11:00' }),
    menu({ id: 2, dailyStart: '11:00', dailyEnd: '00:00' }),
  ])
  ok('*** back-to-back menus leave NO gap between them ***',
    !touching.some((x) => x.from === '11:00' && x.minutes < 60),
    JSON.stringify(touching.map((x) => `${x.dayName} ${x.from}-${x.to}`)))

  ok('*** an all-day menu means no gaps at all ***',
    menuGaps([menu({ dailyStart: '', dailyEnd: '' })]).length === 0)

  ok('a switched-off menu does not fill a gap',
    menuGaps([menu({ isActive: false, dailyStart: '', dailyEnd: '' })]).length === 0,
    'no ACTIVE menus at all means nothing to warn about')

  // A weekday-only menu leaves a weekend hole a whole-week scan would miss.
  const weekdayOnly = menuGaps([
    menu({ dailyStart: '', dailyEnd: '', daysOfWeek: '1111100' }),
  ])
  ok('*** a weekday-only menu leaves the weekend uncovered ***',
    weekdayOnly.length === 2 &&
      weekdayOnly.every((x) => x.minutes === 1440 && (x.day === 5 || x.day === 6)),
    JSON.stringify(weekdayOnly.map((x) => `${x.dayName} ${x.from}-${x.to}`)))

  // The overnight band must cover BOTH ends of the clock.
  const overnightCover = menuGaps([
    menu({ id: 1, dailyStart: '06:00', dailyEnd: '22:00' }),
    menu({ id: 2, dailyStart: '22:00', dailyEnd: '06:00' }),
  ])
  ok('*** a day + overnight pair covers the whole week ***',
    overnightCover.length === 0,
    JSON.stringify(overnightCover.map((x) => `${x.dayName} ${x.from}-${x.to}`)))

  console.log(fails === 0 ? '\nAll good.' : `\n${fails} FAILED.`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
