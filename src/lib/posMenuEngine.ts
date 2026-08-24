/**
 * Which menu the till is showing, right now.
 *
 * Pure and free of `server-only`, for the same reason specialsEngine.ts is:
 * the till runs this in the browser against its own clock, the back office
 * runs it on the server to draw a preview, and the tests run it with no
 * database at all.
 *
 * ── WHY THE TILL DECIDES, AND NOT THE SERVER ─────────────────────────────
 *
 * A till re-syncs its catalogue every fifteen minutes (useOfflineTill.ts:30)
 * and is expected to trade for hours with no network at all. If the server
 * picked the menu, an 11:00 breakfast→lunch switch would land anywhere in a
 * fifteen-minute smear, at a different moment on each till in the shop — and
 * never at all on a till that has been offline since yesterday.
 *
 * So the server ships every menu UNEVALUATED and the till resolves the window
 * itself, exactly as `liveSpecials` → `specialActiveAt` already does
 * (specials.ts:167-175). The switchover is then instant, identical on every
 * till, and correct offline.
 */

/** A menu as the till holds it: a name, a window, and a scope. */
export type PosMenu = {
  id: number
  name: string
  isActive: boolean
  /** 'HH:MM', or '' for all day. End before start means overnight. */
  dailyStart: string
  dailyEnd: string
  /** Seven characters of 0/1, Monday first. */
  daysOfWeek: string
  /** Lower wins when two menus cover the same moment. */
  priority: number
  items: PosMenuItem[]
  /**
   * The tills this menu runs on. EMPTY MEANS EVERY TILL (232).
   *
   * Absence is "everywhere", never "nowhere" — so a menu written before
   * per-till pinning existed, or by a shop that never thought about it, runs
   * shop-wide; and a till added next year picks up the shop-wide menus without
   * anybody editing them. "Runs nowhere" is what `isActive` is for.
   */
  terminalIds: number[]
}

export type PosMenuItem = {
  /** 'exclude' always beats 'include', whatever order the rows arrive in. */
  effect: 'include' | 'exclude'
  productId: number | null
  /** Matches the department's whole subtree, not just its direct children. */
  departmentId: number | null
}

/**
 * 'HH:MM' → minutes past midnight, or null if it is not a time.
 *
 * Deliberately a copy of specialsEngine's private helper rather than an
 * import: exporting it from there would make a promotions module a dependency
 * of the till's grid, and the two features must be able to change apart.
 * Eight lines is a cheaper coupling than that.
 */
const minutesOf = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '')
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * Is this menu running at this moment?
 *
 * Three gates, all of which must pass: the owner's switch, the day mask, and
 * the daily band. There is no start/end DATE pair — unlike a special, a menu
 * is not a campaign with a first and last day. A shop that wants a menu gone
 * switches it off.
 */
export function menuActiveAt(menu: PosMenu, now: Date): boolean {
  if (!menu.isActive) return false

  // JS counts from Sunday; a shop counts from Monday. This conversion is the
  // one place it happens for menus.
  if (/^[01]{7}$/.test(menu.daysOfWeek)) {
    const mondayFirst = (now.getDay() + 6) % 7
    if (menu.daysOfWeek[mondayFirst] !== '1') return false
  }

  const from = minutesOf(menu.dailyStart)
  const to = minutesOf(menu.dailyEnd)
  // Both or neither. One alone is a half-configured band, and guessing the
  // other end would invent a window nobody asked for — so it runs all day and
  // the editor refuses to save it that way in the first place.
  if (from !== null && to !== null) {
    const mins = now.getHours() * 60 + now.getMinutes()
    if (from <= to) {
      // Start inclusive, END EXCLUSIVE — and this differs from a special
      // deliberately. Menus are written back-to-back (11:00 ends breakfast,
      // 11:00 starts lunch) and two inclusive bands would both own 11:00
      // exactly, leaving the tie to priority at one minute of the day. A
      // special's window is a promotion the shop wants to honour generously,
      // so it includes both ends; a menu boundary is a changeover.
      if (mins < from || mins >= to) return false
    } else {
      // Overnight: 22:00–02:00 means late OR early, not "between".
      if (mins < from && mins >= to) return false
    }
  }

  return true
}

/**
 * Does this menu run on this till? (232)
 *
 * An empty `terminalIds` means every till — see the type's note and 232's
 * docblock for why absence is "everywhere" rather than "nowhere".
 *
 * `terminalId` is null on a machine that matches no terminal row — a browser
 * that has never claimed a till, or the back office previewing the screen.
 * Such a machine gets the SHOP-WIDE menus only: it cannot be told which
 * pinned menu it should be showing, and guessing one would put a bar's menu on
 * an unclaimed machine at random.
 */
export function menuRunsOnTerminal(menu: PosMenu, terminalId: number | null): boolean {
  if (menu.terminalIds.length === 0) return true
  if (terminalId === null) return false
  return menu.terminalIds.includes(terminalId)
}

/**
 * The menu in force at this moment, or null when none is.
 *
 * Lowest priority number wins; ties go to the lower id, so the answer is
 * stable rather than dependent on how the rows came back from the database.
 *
 * ⚠ ONE MENU WINS OUTRIGHT — menus never union. Two overlapping menus merged
 * would draw a breakfast/lunch hybrid at 09:00 that no customer can order
 * from, and the shop would have no way to say which it meant.
 *
 * `terminalId` narrows to the menus pinned to this till (232). Omitted — which
 * is what the back office's own preview does — every menu is considered, so
 * the setup screen can answer "what is running somewhere right now" rather
 * than pretending to be a till it is not.
 */
export function activeMenu(
  menus: PosMenu[],
  now: Date,
  terminalId?: number | null,
): PosMenu | null {
  const live = menus.filter(
    (m) =>
      menuActiveAt(m, now) &&
      // `undefined` means "do not narrow at all"; `null` means "a machine with
      // no till", which is a real question with the answer above. The two are
      // deliberately different, so `?? null` here would be a bug.
      (terminalId === undefined || menuRunsOnTerminal(m, terminalId)),
  )
  if (live.length === 0) return null
  return live.reduce((best, m) =>
    m.priority !== best.priority ? (m.priority < best.priority ? m : best) : m.id < best.id ? m : best,
  )
}

/**
 * The departments worth drawing, given what the menu leaves on the grid.
 *
 * ── WHY THE RAIL HAS TO BE FILTERED TOO ──────────────────────────────────
 *
 * Filtering only the product grid leaves the till drawing every department it
 * ever had, and at breakfast most of them open onto nothing. A cashier presses
 * "Burgers & Mains", waits for a fetch, and gets an empty pane with no
 * explanation — which reads as a broken till rather than as a menu doing its
 * job. Measured on the seeded café: 9 of 14 top-level buttons were dead at
 * 08:00.
 *
 * ── KEPT IF ANY DESCENDANT SURVIVES ──────────────────────────────────────
 *
 * A parent is drawn when anything beneath it is on the menu, not only when it
 * holds surviving products itself. "Drinks" is usually an empty folder whose
 * children hold everything, and dropping it would strand its children behind a
 * button that no longer exists.
 *
 * `keep` receives each department id and says whether the menu leaves anything
 * in it — the caller owns that, because only it knows the product list.
 */
export function departmentsOnMenu<T extends { id: number; parentId: number | null }>(
  departments: T[],
  menu: PosMenu | null,
  keep: (departmentId: number) => boolean,
): T[] {
  // Same bargain as productsOnMenu: no menu, or a menu that says nothing,
  // leaves the till exactly as it was.
  if (!menu || menu.items.length === 0) return departments

  const childrenOf = new Map<number | null, T[]>()
  for (const d of departments) {
    const list = childrenOf.get(d.parentId)
    if (list) list.push(d)
    else childrenOf.set(d.parentId, [d])
  }

  /* Depth-first, memoised: a department survives if it keeps anything itself
     or if any descendant does. Without the memo a deep tree would re-walk the
     same subtree once per ancestor. */
  const survives = new Map<number, boolean>()
  const walk = (d: T): boolean => {
    const hit = survives.get(d.id)
    if (hit !== undefined) return hit
    // Marked BEFORE recursing, so a mis-parented cycle terminates rather than
    // hanging the till — the same defence `ancestors()` takes.
    survives.set(d.id, false)
    let ok = keep(d.id)
    for (const child of childrenOf.get(d.id) ?? []) {
      if (walk(child)) ok = true
    }
    survives.set(d.id, ok)
    return ok
  }
  for (const d of departments) walk(d)

  return departments.filter((d) => survives.get(d.id))
}

/* ── Gaps ─────────────────────────────────────────────────────────────────── */

/** An hour of the week nothing covers. `from`/`to` are 'HH:MM' on that day. */
export type MenuGap = {
  /** 0 = Monday, matching the stored mask. */
  day: number
  dayName: string
  from: string
  to: string
  /** Whole minutes, for ranking the worst one first. */
  minutes: number
}

const DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const

const hhmm = (mins: number) => {
  const m = ((mins % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/**
 * The hours of the week no menu covers.
 *
 * ── WHY THIS IS WORTH COMPUTING ──────────────────────────────────────────
 *
 * Breakfast 08:00–10:00 and lunch 11:00–16:00 leave 10:00–11:00 uncovered,
 * and `productsOnMenu` answers an uncovered hour by showing the WHOLE
 * catalogue. That is the right safety behaviour and a poor surprise: the shop
 * believes it has arranged its day, and for one hour the till reverts to the
 * everything-grid the menus existed to replace.
 *
 * Nothing breaks, so nothing complains. The only way an owner finds out is by
 * standing at a till at ten past ten — which is why this is computed and shown
 * rather than left to be discovered.
 *
 * ── PER DAY, BECAUSE A DAY MASK MAKES ITS OWN GAPS ───────────────────────
 *
 * A weekday-only breakfast leaves a Saturday morning hole that a scan of "the
 * week" as one timeline could not see. So each of the seven days is swept
 * separately, against only the menus that run on that day.
 *
 * ── AN ALL-DAY MENU FILLS EVERYTHING ─────────────────────────────────────
 *
 * A menu with no band covers 00:00–24:00 on the days it runs, so a shop with
 * an all-day menu underneath its services has no gaps by construction — which
 * is the recommended way to arrange a day and should therefore report clean.
 */
export function menuGaps(menus: PosMenu[], terminalId?: number | null): MenuGap[] {
  const live = menus.filter(
    (m) =>
      m.isActive &&
      // Narrowed to one till when asked (232): a bar till pinned to a drinks
      // menu all evening has no gap where the food counter has a big one, and
      // reporting the shop's combined coverage would hide both facts. Omitted,
      // every menu counts — which answers "is the SHOP covered".
      (terminalId === undefined || menuRunsOnTerminal(m, terminalId)),
  )

  /*
   * NO MENUS AT ALL IS NOT A GAP — but "none that reach this till" is.
   *
   * Asked about the shop (`terminalId` omitted) with no menus configured, the
   * honest answer is silence: a shop that has never made a menu has nothing to
   * warn about, and 231 already says an uncovered hour shows the whole
   * catalogue, which is exactly what that shop wants.
   *
   * Asked about ONE till that every menu skips, the answer is the opposite —
   * that till is uncovered all week and somebody should know. Returning []
   * there would report a till nobody has catered for as perfectly arranged.
   */
  if (live.length === 0) {
    if (terminalId === undefined) return []
    return Array.from({ length: 7 }, (_, day) => ({
      day,
      dayName: DAY_NAMES[day],
      from: '00:00',
      to: '24:00',
      minutes: 1440,
    }))
  }

  const gaps: MenuGap[] = []

  for (let day = 0; day < 7; day++) {
    const runsToday = live.filter((m) => !/^[01]{7}$/.test(m.daysOfWeek) || m.daysOfWeek[day] === '1')
    if (runsToday.length === 0) {
      // Nothing at all runs today. Reported as one whole-day gap rather than
      // silence: a shop whose menus are all weekdays has a real Sunday hole.
      gaps.push({ day, dayName: DAY_NAMES[day], from: '00:00', to: '24:00', minutes: 1440 })
      continue
    }

    /*
     * Paint the day's covered minutes, then read off the holes.
     *
     * 1440 booleans per day is 10k for the week — trivial, and it sidesteps
     * the interval-merging edge cases (touching, nested, overnight-wrapping)
     * that are where a cleverer implementation would get one minute wrong.
     */
    const covered = new Array<boolean>(1440).fill(false)
    for (const m of runsToday) {
      const from = minutesOf(m.dailyStart)
      const to = minutesOf(m.dailyEnd)
      if (from === null || to === null) {
        covered.fill(true) // No band: all day.
        break
      }
      if (from <= to) {
        // End EXCLUSIVE, matching menuActiveAt — so back-to-back menus
        // (…11:00 / 11:00…) leave no one-minute hole between them.
        for (let i = from; i < to; i++) covered[i] = true
      } else {
        // Overnight: from the start to midnight, and midnight to the end.
        // The early half belongs to the NEXT day, and is painted there by
        // that day's own pass — this is why the sweep is per day and not one
        // continuous week.
        for (let i = from; i < 1440; i++) covered[i] = true
        for (let i = 0; i < to; i++) covered[i] = true
      }
    }

    /*
     * Read the holes off the painted day.
     *
     * The loop runs over the 1440 real minutes only, and a run still open at
     * the end is closed afterwards. An earlier version ran to `i <= 1440` with
     * a sentinel, which set `start` to 1440 on a fully-covered day and emitted
     * a zero-length gap for every day of the week — a warning about nothing,
     * on exactly the shops that had arranged their day correctly.
     */
    let start: number | null = null
    for (let i = 0; i < 1440; i++) {
      if (!covered[i]) {
        if (start === null) start = i
        continue
      }
      if (start !== null) {
        gaps.push({
          day,
          dayName: DAY_NAMES[day],
          from: hhmm(start),
          to: hhmm(i),
          minutes: i - start,
        })
        start = null
      }
    }
    if (start !== null) {
      gaps.push({
        day,
        dayName: DAY_NAMES[day],
        from: hhmm(start),
        // 24:00 rather than 00:00 so a gap running to midnight reads as an
        // end rather than as a zero-length window at the start of the day.
        to: '24:00',
        minutes: 1440 - start,
      })
    }
  }

  return gaps
}

/**
 * Does this menu put this product on the grid?
 *
 * `departmentPath` is the product's department AND every ancestor above it,
 * so a menu naming "Drinks" catches a coffee filed under Drinks → Hot. The
 * caller builds it once per department rather than per product — see
 * `departmentPaths` in lib/site/posMenus.ts.
 */
export function menuAllows(
  menu: PosMenu,
  product: { id: number; departmentId: number | null },
  departmentPath: number[],
): boolean {
  const path = new Set(departmentPath)
  let included = false

  for (const item of menu.items) {
    const hit =
      item.productId !== null
        ? item.productId === product.id
        : item.departmentId !== null && path.has(item.departmentId)
    if (!hit) continue
    // Exclude wins immediately and cannot be overturned by a later include —
    // the narrower statement is the more deliberate one.
    if (item.effect === 'exclude') return false
    included = true
  }

  return included
}

/**
 * Filter a product list down to what the current menu shows.
 *
 * ── AN EMPTY MENU LIST SHOWS EVERYTHING ──────────────────────────────────
 *
 * Two different "no menu" cases, one answer, and it is deliberate:
 *
 *   The shop has never made a menu   → nothing about the till changes. Menus
 *                                      are an upgrade to the grid, never a
 *                                      requirement of it.
 *   It is 03:00 and no menu covers   → the shop is trading at an hour it did
 *   this hour                          not plan for, and the useful answer is
 *                                      the whole catalogue.
 *
 * The alternative — an empty grid — reads as a broken till, and the cashier's
 * only recourse would be to scan every item. A till showing too much is a
 * nuisance; a till showing nothing stops the shop.
 */
export function productsOnMenu<T extends { id: number; departmentId: number | null }>(
  products: T[],
  menu: PosMenu | null,
  pathFor: (departmentId: number | null) => number[],
): T[] {
  if (!menu) return products
  // A menu with no scope rows is an empty statement, not an empty shop. It
  // shows everything, so a half-built menu saved at five to eleven cannot
  // blank the grid at eleven.
  if (menu.items.length === 0) return products
  return products.filter((p) => menuAllows(menu, p, pathFor(p.departmentId)))
}
