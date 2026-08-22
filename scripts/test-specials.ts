/**
 * The specials engine.
 *
 * Pure arithmetic, so this needs no database and can cover cases a live shop
 * would take months to produce. The parts worth the most attention:
 *
 *   CLAIMING. A three-for-two involves three lines but discounts one. If the
 *   other two are left unclaimed, a lower-priority special discounts the ones
 *   the customer is paying for, and the shop gives away more than it meant to.
 *
 *   NOT FIRING. A special that decides it has nothing to give must leave its
 *   lines alone, or it silently blocks every special beneath it.
 *
 *   TIME. Four gates, one of which runs backwards overnight, and a day mask
 *   that counts from Monday while JavaScript counts from Sunday.
 *
 *   npm run test:specials
 */
import { siteExecute } from '../src/lib/siteDb'
import {
  computeSpecials,
  effectiveDiscountPct,
  specialActiveAt,
  type BasketLine,
  type Special,
  type SpecialItem,
  type SpecialTier,
  type SpecialShape,
} from '../src/lib/specialsEngine'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}
const near = (a: number, b: number, tol = 0.001) => Math.abs(a - b) < tol

/** A special with every field defaulted, so each test states only what matters. */
function special(over: Partial<Special>): Special {
  return {
    id: 1,
    name: 'Test',
    shape: 'happy_hour',
    isActive: true,
    startsAt: '2026-01-01T00:00',
    endsAt: '2030-12-31T23:59',
    dailyStart: '',
    dailyEnd: '',
    daysOfWeek: '1111111',
    discountPct: 0,
    triggerQty: 0,
    bundlePriceIncl: 0,
    spendAmountIncl: 0,
    priority: 1,
    items: [],
    tiers: [],
    ...over,
  }
}

const scope = (productId: number, over: Partial<SpecialItem> = {}): SpecialItem => ({
  role: 'scope', productId, departmentId: null, qty: 1, priceIncl: 0, ...over,
})
const trigger = (productId: number, qty = 1): SpecialItem => ({
  role: 'trigger', productId, departmentId: null, qty, priceIncl: 0,
})
const reward = (productId: number, qty = 1): SpecialItem => ({
  role: 'reward', productId, departmentId: null, qty, priceIncl: 0,
})
/** A multibuy rung: this many units for this much. */
const tier = (qty: number, priceIncl: number): SpecialTier => ({ qty, priceIncl, discountPct: 0 })
/** A quantity-break rung: this many units, this much off each. */
const pctTier = (qty: number, discountPct: number): SpecialTier => ({
  qty, priceIncl: 0, discountPct,
})
const line = (productId: number, priceIncl: number, qty = 1, departmentId: number | null = 10):
  BasketLine => ({ productId, departmentId, priceIncl, qty })

// A Wednesday at 14:00.
const NOW = new Date(2026, 5, 10, 14, 0)

async function main() {
  /* ── Time windows ───────────────────────────────────────────────────── */
  console.log('\n— When a special is running —')

  ok('inside its dates, it runs', specialActiveAt(special({}), NOW))
  ok('switched off, it does not', !specialActiveAt(special({ isActive: false }), NOW))
  ok(
    'before it starts, it does not',
    !specialActiveAt(special({ startsAt: '2027-01-01T00:00' }), NOW),
  )
  ok('after it ends, it does not', !specialActiveAt(special({ endsAt: '2026-01-01T00:00' }), NOW))
  ok(
    'the end boundary is INCLUSIVE',
    specialActiveAt(special({ endsAt: '2026-06-10T14:00' }), NOW),
    'a special ending at 14:00 still runs at 14:00',
  )

  // The day mask is Monday-first; NOW is a Wednesday, so index 2.
  ok('a matching weekday runs', specialActiveAt(special({ daysOfWeek: '0010000' }), NOW))
  ok('a non-matching weekday does not', !specialActiveAt(special({ daysOfWeek: '1101111' }), NOW))
  ok(
    'Sunday is the LAST character, not the first',
    // If this were Sunday-first, '0001000' would match a Wednesday.
    !specialActiveAt(special({ daysOfWeek: '0001000' }), NOW),
  )

  ok(
    'inside the daily band, it runs',
    specialActiveAt(special({ dailyStart: '09:00', dailyEnd: '17:00' }), NOW),
  )
  ok(
    'outside it, it does not',
    !specialActiveAt(special({ dailyStart: '17:00', dailyEnd: '19:00' }), NOW),
  )
  ok(
    'a half-set band is ignored rather than guessed',
    specialActiveAt(special({ dailyStart: '17:00', dailyEnd: '' }), NOW),
  )

  // Overnight: 22:00–02:00 means late OR early, never "between".
  const overnight = special({ dailyStart: '22:00', dailyEnd: '02:00' })
  ok('an overnight band runs late at night', specialActiveAt(overnight, new Date(2026, 5, 10, 23, 0)))
  ok('and in the small hours', specialActiveAt(overnight, new Date(2026, 5, 10, 1, 0)))
  ok('but not in the afternoon', !specialActiveAt(overnight, NOW))

  /* ── Percentage off ─────────────────────────────────────────────────── */
  console.log('\n— A straight discount —')
  {
    const lines = [line(1, 100), line(2, 50)]
    const r = computeSpecials(lines, [special({ shape: 'happy_hour', discountPct: 10, items: [scope(1)] })], NOW)
    ok('the named product is discounted', near(r.lineSpecials[0]?.pct ?? 0, 10))
    ok('and nothing else is', r.lineSpecials[1] === undefined)
  }
  {
    const lines = [line(1, 100), line(2, 50)]
    const r = computeSpecials(lines, [special({ shape: 'happy_hour', discountPct: 15 })], NOW)
    ok('a whole-shop special hits everything', r.lineSpecials.every((s) => near(s?.pct ?? 0, 15)))
  }
  {
    const lines = [line(1, 100, 1, 7)]
    const dept: SpecialItem = { role: 'scope', productId: null, departmentId: 7, qty: 1, priceIncl: 0 }
    const r = computeSpecials(lines, [special({ shape: 'happy_hour', discountPct: 20, items: [dept] })], NOW)
    ok('a department scope matches by id', near(r.lineSpecials[0]?.pct ?? 0, 20))
  }

  /* ── Marked-down price ──────────────────────────────────────────────── */
  console.log('\n— A marked-down price —')
  {
    const lines = [line(1, 100)]
    const r = computeSpecials(
      lines, [special({ shape: 'special_price', items: [scope(1, { priceIncl: 75 })] })], NOW,
    )
    ok('R100 marked down to R75 is 25% off', near(r.lineSpecials[0]?.pct ?? 0, 25))
  }
  {
    const lines = [line(1, 100)]
    const r = computeSpecials(
      lines, [special({ shape: 'special_price', items: [scope(1, { priceIncl: 120 })] })], NOW,
    )
    ok('a "special" price ABOVE the shelf price does nothing', r.lineSpecials[0] === undefined)
  }
  {
    // A product row and a department row both match; the product must win.
    const lines = [line(1, 100, 1, 7)]
    const deptRow: SpecialItem = { role: 'scope', productId: null, departmentId: 7, qty: 1, priceIncl: 90 }
    const r = computeSpecials(
      lines,
      [special({ shape: 'special_price', items: [deptRow, scope(1, { priceIncl: 60 })] })],
      NOW,
    )
    ok('a product row beats a department row', near(r.lineSpecials[0]?.pct ?? 0, 40), 'R60, not R90')
  }

  /* ── Cheapest free ──────────────────────────────────────────────────── */
  console.log('\n— Buy three, cheapest free —')
  {
    // Three separate lines at 30, 20, 10. One deal; the R10 is free.
    const lines = [line(1, 30), line(2, 20), line(3, 10)]
    const s = special({ shape: 'cheapest_free', triggerQty: 3, items: [trigger(1), trigger(2), trigger(3)] })
    const r = computeSpecials(lines, [s], NOW)
    ok('the cheapest is free', near(r.lineSpecials[2]?.pct ?? 0, 100))
    ok('the others pay full price', r.lineSpecials[0] === undefined && r.lineSpecials[1] === undefined)
  }
  {
    const lines = [line(1, 10, 3)]
    const s = special({ shape: 'cheapest_free', triggerQty: 3, items: [trigger(1)] })
    const r = computeSpecials(lines, [s], NOW)
    ok(
      'three on ONE line gives a third off that line',
      near(r.lineSpecials[0]?.pct ?? 0, 100 / 3),
      `${r.lineSpecials[0]?.pct.toFixed(2)}%`,
    )
  }
  {
    const lines = [line(1, 10, 2)]
    const s = special({ shape: 'cheapest_free', triggerQty: 3, items: [trigger(1)] })
    ok('two of three does not fire', computeSpecials(lines, [s], NOW).lineSpecials[0] === undefined)
  }
  {
    // 50% rather than free — "second at half price".
    const lines = [line(1, 100), line(2, 100)]
    const s = special({ shape: 'cheapest_free', triggerQty: 2, discountPct: 50, items: [trigger(1), trigger(2)] })
    const r = computeSpecials(lines, [s], NOW)
    ok('a partial discount is honoured', near(r.lineSpecials[0]?.pct ?? 0, 50))
  }

  /* ── The claiming rule ──────────────────────────────────────────────── */
  console.log('\n— A line is only claimed once —')
  {
    const lines = [line(1, 30), line(2, 20), line(3, 10)]
    const threeForTwo = special({
      id: 1, priority: 1, name: '3 for 2', shape: 'cheapest_free', triggerQty: 3,
      items: [trigger(1), trigger(2), trigger(3)],
    })
    const tenPercent = special({
      id: 2, priority: 2, name: '10% off', shape: 'happy_hour', discountPct: 10,
      items: [scope(1), scope(2), scope(3)],
    })
    const r = computeSpecials(lines, [threeForTwo, tenPercent], NOW)
    ok(
      'the paid-for lines are NOT also discounted by the next special',
      r.lineSpecials[0] === undefined && r.lineSpecials[1] === undefined,
      'claiming covers every qualifying line, not only the free one',
    )
    ok('and the free one still belongs to the first special', r.lineSpecials[2]?.specialId === 1)
  }
  {
    // Reversing the priority changes which deal the customer gets.
    const lines = [line(1, 30), line(2, 20), line(3, 10)]
    const threeForTwo = special({ id: 1, priority: 2, shape: 'cheapest_free', triggerQty: 3,
      items: [trigger(1), trigger(2), trigger(3)] })
    const tenPercent = special({ id: 2, priority: 1, shape: 'happy_hour', discountPct: 10,
      items: [scope(1), scope(2), scope(3)] })
    const r = computeSpecials(lines, [threeForTwo, tenPercent], NOW)
    ok(
      'priority decides, not which is worth more',
      r.lineSpecials.every((s) => s?.specialId === 2),
      'the 10% is higher in the list, so the 3-for-2 never fires',
    )
  }
  {
    // A special that cannot fire must not block the one below it.
    const lines = [line(1, 100)]
    const impossible = special({ id: 1, priority: 1, shape: 'special_price',
      items: [scope(1, { priceIncl: 150 })] })
    const real = special({ id: 2, priority: 2, shape: 'happy_hour', discountPct: 10, items: [scope(1)] })
    const r = computeSpecials(lines, [impossible, real], NOW)
    ok(
      'a special that gives nothing does not claim',
      r.lineSpecials[0]?.specialId === 2,
      'otherwise a mistyped special silently kills every one beneath it',
    )
  }

  /* ── Several for one price ──────────────────────────────────────────── */
  console.log('\n— Several for one price —')
  {
    const lines = [line(1, 60), line(2, 60)]
    const s = special({ shape: 'bundle_price', bundlePriceIncl: 100, items: [trigger(1), trigger(2)] })
    const r = computeSpecials(lines, [s], NOW)
    const paid = lines.reduce(
      (sum, l, i) => sum + l.priceIncl * l.qty * (1 - (r.lineSpecials[i]?.pct ?? 0) / 100), 0,
    )
    ok('R120 of goods sells for the bundle price', near(paid, 100, 0.01), `paid ${paid.toFixed(2)}`)
  }
  {
    // The bundle costs MORE than the items — must not fire.
    const lines = [line(1, 30), line(2, 30)]
    const s = special({ id: 1, priority: 1, shape: 'bundle_price', bundlePriceIncl: 100,
      items: [trigger(1), trigger(2)] })
    const other = special({ id: 2, priority: 2, shape: 'happy_hour', discountPct: 5,
      items: [scope(1), scope(2)] })
    const r = computeSpecials(lines, [s, other], NOW)
    ok(
      'a bundle dearer than the goods does not fire, and does not claim',
      r.lineSpecials[0]?.specialId === 2,
    )
  }

  /* ── Multibuy tiers ─────────────────────────────────────────────────── */
  console.log('\n— Multibuy tiers —')
  {
    // 3 for R25 against R10 shelf units: R30 of goods for R25.
    const lines = [line(1, 10, 3)]
    const s = special({ shape: 'multibuy', items: [trigger(1)],
      tiers: [tier(3, 25)] })
    const r = computeSpecials(lines, [s], NOW)
    const paid = lines.reduce(
      (sum, l, i) => sum + l.priceIncl * l.qty * (1 - (r.lineSpecials[i]?.pct ?? 0) / 100), 0,
    )
    ok('three R10 units ring up at the R25 tier', near(paid, 25, 0.01), `paid ${paid.toFixed(2)}`)
  }
  {
    // Nine units against 3-for-R25 and 6-for-R45: the LARGEST tier fills
    // first — one six and one three (R70), not three threes (R75).
    const lines = [line(1, 10, 9)]
    const s = special({ shape: 'multibuy', items: [trigger(1)],
      tiers: [tier(3, 25), tier(6, 45)] })
    const r = computeSpecials(lines, [s], NOW)
    const paid = lines.reduce(
      (sum, l, i) => sum + l.priceIncl * l.qty * (1 - (r.lineSpecials[i]?.pct ?? 0) / 100), 0,
    )
    ok('nine units fill the six-tier THEN the three-tier', near(paid, 70, 0.01),
      `paid ${paid.toFixed(2)}, expected 45 + 25`)
  }
  {
    // Four units against a 3-tier: three at the tier, the fourth at shelf.
    const lines = [line(1, 10, 4)]
    const s = special({ shape: 'multibuy', items: [trigger(1)],
      tiers: [tier(3, 25)] })
    const r = computeSpecials(lines, [s], NOW)
    const paid = lines.reduce(
      (sum, l, i) => sum + l.priceIncl * l.qty * (1 - (r.lineSpecials[i]?.pct ?? 0) / 100), 0,
    )
    ok('the unit below the smallest tier pays the shelf price', near(paid, 35, 0.01),
      `paid ${paid.toFixed(2)}, expected 25 + 10`)
  }
  {
    // A mixed group: the deal spends the CHEAPEST units, the house rule.
    const lines = [line(1, 10, 2), line(2, 20, 2)]
    const s = special({ shape: 'multibuy',
      items: [trigger(1), trigger(2)], tiers: [tier(2, 15)] })
    const r = computeSpecials(lines, [s], NOW)
    // Two bundles fire: [10,10] for 15 and [20,20] for 15 — greedy consumes
    // all four units, cheapest bundle first.
    const paid = lines.reduce(
      (sum, l, i) => sum + l.priceIncl * l.qty * (1 - (r.lineSpecials[i]?.pct ?? 0) / 100), 0,
    )
    ok('a mixed group fills tiers cheapest-first across products',
      near(paid, 30, 0.01), `paid ${paid.toFixed(2)}`)
  }
  {
    // A tier at or above what the units cost is not a deal, and must not
    // claim — the special below still gets its chance.
    const lines = [line(1, 10, 2)]
    const dud = special({ id: 1, priority: 1, shape: 'multibuy',
      items: [trigger(1)], tiers: [tier(2, 25)] })
    const other = special({ id: 2, priority: 2, shape: 'happy_hour', discountPct: 5, items: [scope(1)] })
    const r = computeSpecials(lines, [dud, other], NOW)
    ok('a tier dearer than the goods does not fire, and does not claim',
      r.lineSpecials[0]?.specialId === 2)
  }
  {
    // Once ANY tier fires, every qualifying line is claimed — including the
    // units paying shelf price — exactly like cheapest_free.
    const lines = [line(1, 10, 4)]
    const mb = special({ id: 1, priority: 1, shape: 'multibuy',
      items: [trigger(1)], tiers: [tier(3, 25)] })
    const other = special({ id: 2, priority: 2, shape: 'happy_hour', discountPct: 50, items: [scope(1)] })
    const r = computeSpecials(lines, [mb, other], NOW)
    ok('a fired multibuy claims the whole qualifying line',
      r.lineSpecials[0]?.specialId === 1,
      'otherwise the 50% below would discount the full-price fourth unit')
  }

  /* ── Free item ──────────────────────────────────────────────────────── */
  console.log('\n— Buy this, get that —')
  {
    const lines = [line(1, 50, 2)]
    const s = special({ shape: 'free_item', items: [trigger(1, 2), reward(9)] })
    const r = computeSpecials(lines, [s], NOW)
    ok('the reward is earned', r.rewards.length === 1 && r.rewards[0].productId === 9)
    ok('the trigger line is not discounted', r.lineSpecials[0] === undefined, 'the reward IS the deal')
  }
  {
    const lines = [line(1, 50, 4)]
    const s = special({ shape: 'free_item', items: [trigger(1, 2), reward(9)] })
    ok('two deals earn two rewards', computeSpecials(lines, [s], NOW).rewards[0]?.qty === 2)
  }

  /* ── Spend and get ──────────────────────────────────────────────────── */
  console.log('\n— Spend this much —')
  {
    const lines = [line(1, 300), line(2, 300)]
    const s = special({ shape: 'spend', spendAmountIncl: 500, discountPct: 10 })
    const r = computeSpecials(lines, [s], NOW)
    ok('over the threshold, everything is discounted', r.lineSpecials.every((x) => near(x?.pct ?? 0, 10)))
  }
  {
    const lines = [line(1, 100)]
    const s = special({ shape: 'spend', spendAmountIncl: 500, discountPct: 10 })
    ok('under it, nothing is', computeSpecials(lines, [s], NOW).lineSpecials[0] === undefined)
  }
  {
    const lines = [line(1, 2000)]
    const s = special({ shape: 'spend', spendAmountIncl: 500, items: [reward(9)] })
    ok(
      'clearing the threshold four times is still ONE reward',
      computeSpecials(lines, [s], NOW).rewards[0]?.qty === 1,
    )
  }
  {
    // The threshold counts the whole basket, even lines already claimed —
    // what the customer brought to the till is what they spent.
    const lines = [line(1, 400), line(2, 200)]
    const first = special({ id: 1, priority: 1, shape: 'happy_hour', discountPct: 50, items: [scope(1)] })
    const spend = special({ id: 2, priority: 2, shape: 'spend', spendAmountIncl: 500, discountPct: 10 })
    const r = computeSpecials(lines, [first, spend], NOW)
    ok(
      'an earlier discount does not push a basket under the threshold',
      near(r.lineSpecials[1]?.pct ?? 0, 10),
      'gross is R600 at normal prices, not R400 after the first special',
    )
  }

  /* ── Manual discounts ───────────────────────────────────────────────── */
  console.log('\n— Against a cashier’s own discount —')
  ok(
    'they do not compound',
    effectiveDiscountPct(20, { specialId: 1, name: 'x', pct: 10 }) === 20,
    '20% by hand over a 10% special is 20%, not 28%',
  )
  ok('the better one wins', effectiveDiscountPct(5, { specialId: 1, name: 'x', pct: 30 }) === 30)
  ok('with no special, the manual one stands', effectiveDiscountPct(15, undefined) === 15)
  ok('with neither, nothing comes off', effectiveDiscountPct(null, undefined) === 0)

  /* ── Awkward baskets ────────────────────────────────────────────────── */
  console.log('\n— Awkward baskets —')
  ok('an empty basket is fine', computeSpecials([], [special({})], NOW).lineSpecials.length === 0)
  ok('no specials is fine', computeSpecials([line(1, 10)], [], NOW).lineSpecials[0] === undefined)
  {
    // A refund line. It must keep its slot so the results stay index-aligned,
    // but must never earn a deal.
    const lines = [line(1, 10, -1)]
    const s = special({ shape: 'happy_hour', discountPct: 10 })
    const r = computeSpecials(lines, [s], NOW)
    ok('the result stays index-aligned with the basket', r.lineSpecials.length === 1)
    ok(
      'and a REFUND line earns nothing',
      r.lineSpecials[0] === undefined,
      'goods coming back must not be credited at a promotional price',
    )
  }
  {
    // The till passes a refund in as qty 0, to keep the array aligned with the
    // basket while making sure it cannot complete or collect a deal.
    const lines = [line(1, 10, 0)]
    const s = special({ shape: 'happy_hour', discountPct: 10 })
    ok(
      'nor does a zero-quantity line',
      computeSpecials(lines, [s], NOW).lineSpecials[0] === undefined,
    )
  }
  {
    const lines = [line(1, 0)]
    const s = special({ shape: 'special_price', items: [scope(1, { priceIncl: 5 })] })
    ok('a zero-priced line cannot be marked down', computeSpecials(lines, [s], NOW).lineSpecials[0] === undefined)
  }
  {
    const lines = [line(1, 100)]
    const s = special({ shape: 'happy_hour', discountPct: 500, items: [scope(1)] })
    ok(
      'a discount over 100% is clamped',
      near(computeSpecials(lines, [s], NOW).lineSpecials[0]?.pct ?? 0, 100),
    )
  }

  await databaseChecks()

  console.log(`\n${fails === 0 ? 'All specials checks passed.' : `${fails} FAILED.`}`)
  process.exit(fails === 0 ? 0 : 1)
}

/**
 * The parts that need a real database.
 *
 * Kept apart from the pure checks above so a failure here reads as "storage",
 * not "arithmetic".
 */
async function databaseChecks() {
  const { listSpecials, saveSpecial, deleteSpecial, reorderSpecials, setSpecialActive } =
    await import('../src/lib/site/specials')
  const { validateSpecial } = await import('../src/lib/specialsEngine')

  const SITE = 1
  const TAG = '__TEST_SPECIAL__'
  const clean = async () => {
    for (const s of await listSpecials(SITE)) {
      if (s.name.startsWith(TAG)) await deleteSpecial(SITE, s.id)
    }
  }
  await clean()

  const pad = (n: number) => String(n).padStart(2, '0')
  const at = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  const now = new Date()

  const base = {
    id: null as number | null,
    name: `${TAG} one`,
    shape: 'happy_hour' as SpecialShape,
    isActive: true,
    startsAt: at(new Date(now.getTime() - 3600_000)),
    endsAt: at(new Date(now.getTime() + 86400_000)),
    dailyStart: '',
    dailyEnd: '',
    daysOfWeek: '1111111',
    discountPct: 25,
    triggerQty: 0,
    bundlePriceIncl: 0,
    spendAmountIncl: 0,
    items: [],
    tiers: [] as SpecialTier[],
  }

  console.log('\n— Validation —')
  ok('a nameless special is refused', validateSpecial({ ...base, name: ' ' }) !== null)
  ok('one that ends before it starts is refused', validateSpecial({ ...base, endsAt: base.startsAt }) !== null)
  ok('half a daily band is refused', validateSpecial({ ...base, dailyStart: '17:00' }) !== null)
  ok('no days of the week is refused', validateSpecial({ ...base, daysOfWeek: '0000000' }) !== null)
  ok(
    'a happy hour naming nothing is the WHOLE STORE, not an error',
    validateSpecial({ ...base, items: [] }) === null,
    'an empty scope replaced the applies_to_all flag — see 210',
  )
  ok(
    'a marked-down price on a whole DEPARTMENT is allowed',
    validateSpecial({
      ...base, shape: 'special_price',
      items: [{ role: 'scope', productId: null, departmentId: 1, qty: 1, priceIncl: 5 }],
    }) === null,
    'a department row prices everything in it — the legacy shop relies on this',
  )
  ok('a good one passes', validateSpecial(base) === null)

  const mbBase = {
    ...base, shape: 'multibuy' as SpecialShape,
    items: [{ role: 'trigger' as const, productId: 2, departmentId: null, qty: 1, priceIncl: 0 }],
  }
  ok('a multibuy with no tiers is refused',
    validateSpecial({ ...mbBase, tiers: [] }) !== null)
  ok('a one-unit tier is refused — that is just the shelf price',
    validateSpecial({ ...mbBase, tiers: [tier(1, 10)] }) !== null)
  ok('two tiers at the same quantity are refused',
    validateSpecial({ ...mbBase, tiers: [tier(3, 25), tier(3, 20)] }) !== null)
  ok('a priced ladder passes',
    validateSpecial({ ...mbBase, tiers: [tier(3, 25), tier(6, 45)] }) === null)

  console.log('\n— The window survives the database —')
  const saved = await saveSpecial(SITE, base, 'test')
  ok('it saves', saved.ok, saved.ok ? '' : saved.error)
  if (!saved.ok) return

  const readBack = (await listSpecials(SITE)).find((s) => s.id === saved.id)!
  /*
   * The one that caught a real bug. Stored as DATETIME through a pool that
   * treats them as UTC, a window written at 07:30 read back as 09:30 — so
   * every special silently ran two hours late, or never.
   */
  ok(
    'the start time comes back EXACTLY as written',
    readBack.startsAt === base.startsAt,
    `wrote ${base.startsAt}, read ${readBack.startsAt}`,
  )
  ok('and so does the end time', readBack.endsAt === base.endsAt)
  ok('it is running right now', specialActiveAt(readBack, new Date()))

  console.log('\n— Items round-trip —')
  const withItems = await saveSpecial(
    SITE,
    {
      ...base, id: saved.id, name: `${TAG} two`, shape: 'cheapest_free', triggerQty: 3, discountPct: 100,
      items: [
        { role: 'trigger', productId: 2, departmentId: null, qty: 1, priceIncl: 0 },
        // A scope row on a combo: itemsFor should drop it, because the kind
        // has no use for one and it would only confuse the next reader.
        { role: 'scope', productId: 3, departmentId: null, qty: 1, priceIncl: 0 },
      ],
    },
    'test',
  )
  ok('it updates', withItems.ok, withItems.ok ? '' : withItems.error)
  const updated = (await listSpecials(SITE)).find((s) => s.id === saved.id)!
  ok('the trigger is stored', updated.items.some((i) => i.role === 'trigger' && i.productId === 2))
  ok(
    'and a row the kind cannot use is dropped',
    !updated.items.some((i) => i.role === 'scope'),
  )

  console.log('\n— Tiers round-trip —')
  const withTiers = await saveSpecial(
    SITE,
    {
      ...base, id: saved.id, name: `${TAG} tiers`, shape: 'multibuy',
      items: [{ role: 'trigger', productId: 2, departmentId: null, qty: 1, priceIncl: 0 }],
      tiers: [tier(6, 45), tier(3, 25)],
    },
    'test',
  )
  ok('a multibuy saves', withTiers.ok, withTiers.ok ? '' : withTiers.error)
  const tiered = (await listSpecials(SITE)).find((s) => s.id === saved.id)!
  ok('its tiers come back smallest-first, exactly as priced',
    tiered.tiers.length === 2 &&
      tiered.tiers[0].qty === 3 && near(tiered.tiers[0].priceIncl, 25) &&
      tiered.tiers[1].qty === 6 && near(tiered.tiers[1].priceIncl, 45),
    JSON.stringify(tiered.tiers))

  // Edited into another shape, the ladder must not linger. Back to the combo
  // it was above — NOT to `base`, whose applies-to-all happy hour would claim
  // every line in the basket checks further down.
  await saveSpecial(
    SITE,
    {
      ...base, id: saved.id, name: `${TAG} two`, shape: 'cheapest_free',
      triggerQty: 3, discountPct: 100,
      items: [{ role: 'trigger', productId: 2, departmentId: null, qty: 1, priceIncl: 0 }],
    },
    'test',
  )
  ok('a special edited out of multibuy drops its tiers',
    ((await listSpecials(SITE)).find((s) => s.id === saved.id)!).tiers.length === 0)

  console.log('\n— Switching off and ordering —')
  await setSpecialActive(SITE, saved.id, false)
  ok(
    'a switched-off special stops running',
    !specialActiveAt((await listSpecials(SITE)).find((s) => s.id === saved.id)!, new Date()),
  )
  await setSpecialActive(SITE, saved.id, true)

  const all = await listSpecials(SITE)
  await reorderSpecials(SITE, [saved.id, ...all.filter((s) => s.id !== saved.id).map((s) => s.id)])
  ok('reordering puts it first', (await listSpecials(SITE))[0].id === saved.id)

  // A stale tab that does not know about a special must not drop it.
  await reorderSpecials(SITE, [saved.id])
  ok(
    'an omitted special is appended, never lost',
    (await listSpecials(SITE)).length === all.length,
  )
  ok('a foreign id is ignored', (await reorderSpecials(SITE, [999_999])).ok)

  await basketChecks()

  console.log('\n— Cleanup —')
  await clean()
  ok('the test specials are gone', !(await listSpecials(SITE)).some((s) => s.name.startsWith(TAG)))
}

/**
 * Pricing a basket, and recording WHY on the sale.
 *
 * The engine tests above prove the arithmetic. This proves the WIRING: that a
 * saved special is loaded by `liveSpecials` and reaches a basket through the
 * same pure engine the till runs, and that the sale line written afterwards
 * remembers which special caused its discount — which is the whole reason
 * `special_id` exists.
 *
 * It deliberately prices the way the till does — `liveSpecials` then
 * `computeSpecials` — rather than through a server-side helper of its own. A
 * test that exercises a path no customer is charged through proves nothing
 * about the one they are.
 */
async function basketChecks() {
  const { liveSpecials, saveSpecial, listSpecials, deleteSpecial } = await import(
    '../src/lib/site/specials'
  )
  const { saveDraft, getDocument } = await import('../src/lib/site/salesDocuments')
  const { siteQuery: q } = await import('../src/lib/siteDb')

  const SITE = 1
  const TAG = '__TEST_SPECIAL__'
  const pad = (n: number) => String(n).padStart(2, '0')
  const at = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  const now = new Date()

  const product = (
    await q<{ id: number; description: string; department_id: number | null }>(
      SITE,
      `SELECT p.id, p.description, p.department_id FROM products p
        JOIN product_prices pp ON pp.product_id = p.id
       WHERE p.is_archived = 0 AND pp.selling_price_incl > 0 LIMIT 1`,
    )
  )[0]
  if (!product) {
    console.log('SKIP  no priced product to test with')
    return
  }

  console.log('\n— Pricing a basket —')
  const saved = await saveSpecial(
    SITE,
    {
      id: null, name: `${TAG} basket`, shape: 'happy_hour', isActive: true,
      startsAt: at(new Date(now.getTime() - 3600_000)),
      endsAt: at(new Date(now.getTime() + 86400_000)),
      dailyStart: '', dailyEnd: '', daysOfWeek: '1111111',
      discountPct: 20, triggerQty: 0,
      bundlePriceIncl: 0, spendAmountIncl: 0,
      items: [{ role: 'scope', productId: product.id, departmentId: null, qty: 1, priceIncl: 0 }],
      tiers: [],
    },
    'test',
  )
  ok('a special is set up', saved.ok, saved.ok ? '' : saved.error)
  if (!saved.ok) return

  const priced = computeSpecials(
    [
      { productId: product.id, departmentId: product.department_id, priceIncl: 100, qty: 1 },
      // A product the special does not name, to prove it is not blanket-applied.
      { productId: -1, departmentId: null, priceIncl: 50, qty: 1 },
    ],
    await liveSpecials(SITE),
    new Date(),
  ).lineSpecials
  ok('the named product is discounted', near(priced[0]?.pct ?? 0, 20))
  ok('and it says WHICH special did it', priced[0]?.specialId === saved.id)
  ok('the name comes with it, for the slip', priced[0]?.name === `${TAG} basket`)
  // Undefined IS "no special" in the engine's own vocabulary — the slot stays,
  // holding nothing, so the results line up with the basket.
  ok('an unrelated product is untouched, and carries no special', priced[1] === undefined)

  console.log('\n— The sale remembers the special —')
  const doc = await saveDraft(
    SITE,
    { userId: 1, userName: 'test' },
    {
      docType: 'invoice',
      customerName: TAG,
      lines: [
        {
          productId: product.id,
          description: product.description,
          qty: 1,
          unitPriceIncl: 100,
          discountPct: priced[0]?.pct ?? 0,
          specialId: priced[0]?.specialId ?? null,
          vatRatePct: 15,
        },
      ],
    },
  )
  ok('the sale saves', doc.ok, doc.ok ? '' : doc.error)

  if (doc.ok) {
    const written = await getDocument(SITE, doc.id)
    const saleLine = written?.lines[0]
    ok('the discount is on the line', near(saleLine?.discountPct ?? 0, 20))
    ok(
      'and so is the special that caused it',
      saleLine?.specialId === saved.id,
      'this is what makes "what did that promotion cost us" answerable',
    )
    // The discount must actually have come off the money, not just be recorded.
    ok(
      'the line total reflects the discount',
      near(saleLine?.lineTotalIncl ?? 0, 80, 0.01),
      `${saleLine?.lineTotalIncl}`,
    )

    await siteExecute(SITE, `DELETE FROM sales_document_lines WHERE document_id = ?`, [doc.id])
    await siteExecute(SITE, `DELETE FROM sales_documents WHERE id = ?`, [doc.id])
  }

  // Deleting the promotion must NOT delete the history it created.
  if (doc.ok) {
    for (const s of await listSpecials(SITE)) {
      if (s.name.startsWith(TAG)) await deleteSpecial(SITE, s.id)
    }
    ok('deleting a special is allowed even after it has sold things', true)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
