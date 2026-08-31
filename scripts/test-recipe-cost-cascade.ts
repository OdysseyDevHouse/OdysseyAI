/**
 * A cost change on an ingredient must reach everything built out of it.
 *
 *   npm run test:recipe-cost-cascade
 *
 * ── WHAT IS ACTUALLY BEING TESTED ────────────────────────────────────────
 *
 * A composed product's stored cost is a CACHE of compositionCost(). The till
 * charges a sale at the live figure, but every report, price list and product
 * grid reads the stored column. If nothing invalidates that cache, the two
 * disagree — silently, and in the direction that overstates margin.
 *
 * So each case here moves an ingredient's cost, runs the cascade, and asserts
 * the STORED column now equals what compositionCost() says. Comparing the
 * cascade's arithmetic against a re-implementation of the same arithmetic
 * would prove nothing; the stored/live agreement is the property that matters.
 *
 * ── FIXTURES ─────────────────────────────────────────────────────────────
 *
 * Built and torn down per run under an anchored TCC- prefix, on whatever site
 * is given. Nothing here reads the seeded burgers: a test that depends on
 * seed data fails for the wrong reason the day somebody edits a recipe.
 */
import { createProduct, setDerivedCost } from '../src/lib/site/products'
import {
  saveRecipe,
  saveRefer,
  compositionCost,
  cascadeCompositionCosts,
} from '../src/lib/site/productComposition'
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'
import { setSetting } from '../src/lib/site/settings'

const SITE = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 53)

/** Anchored, so cleanup can only ever remove this test's own rows. */
const PATTERN = '^TCC-[0-9]{3}$'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** The stored column, which is the thing under test. */
async function storedCost(id: number): Promise<number> {
  const row = await siteQueryOne<{ average_cost: string; last_cost: string }>(
    SITE,
    'SELECT average_cost, last_cost FROM products WHERE id = ?',
    [id],
  )
  return Number(row?.average_cost ?? 0)
}

/** Stored equals live, to the cent. */
async function assertStoredMatchesLive(name: string, id: number, type: 'recipe' | 'refer') {
  const stored = await storedCost(id)
  const live = await compositionCost(SITE, id, type)
  check(
    name,
    live !== null && Math.abs(stored - live) < 0.005,
    `stored ${stored.toFixed(4)} vs live ${live?.toFixed(4)}`,
  )
}

async function cleanup() {
  const mine = `(SELECT id FROM (SELECT id FROM products WHERE code REGEXP '${PATTERN}') t)`
  await siteExecute(
    SITE,
    `DELETE FROM product_recipes WHERE parent_id IN ${mine} OR component_id IN ${mine}`,
  )
  await siteExecute(
    SITE,
    `DELETE FROM product_refers WHERE product_id IN ${mine} OR target_id IN ${mine}`,
  )
  for (const t of ['stock_movements', 'product_location_stock', 'product_prices']) {
    await siteExecute(SITE, `DELETE FROM ${t} WHERE product_id IN ${mine}`)
  }
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${PATTERN}'`)
}

async function make(
  code: string,
  description: string,
  opts: { cost?: number; type?: 'normal' | 'recipe' | 'refer'; stock?: number } = {},
): Promise<number> {
  const res = await createProduct(SITE, {
    code,
    description,
    productType: opts.type ?? 'normal',
    lastCost: opts.cost ?? 0,
    openingStock: opts.stock ?? 0,
    visibleInPos: false,
    allowFractions: true,
  })
  if (!res.ok) throw new Error(`could not create ${code}: ${res.error}`)
  return res.id
}

async function main() {
  console.log(`site ${SITE}\n`)

  // A previous crashed run must not fail this one — see the restore-to-default
  // rule: clean to a known state rather than trusting what is there.
  await cleanup()

  try {
    /* ── Fixtures ──────────────────────────────────────────────────────
     *
     *   TOMATO ──> BURGER ──> PLATTER        (recipe of a recipe)
     *      │          └─────> WRAP           (a second dependant)
     *      └──────> SALAD                    (unrelated branch)
     *
     *   BURGER ──> BURGER 6-PACK             (a refer ONTO a recipe)
     */
    const tomato = await make('TCC-001', 'Cascade Tomatoes', { cost: 20, stock: 100 })
    const bun = await make('TCC-002', 'Cascade Bun', { cost: 5, stock: 100 })
    const burger = await make('TCC-010', 'Cascade Burger', { type: 'recipe' })
    const wrap = await make('TCC-011', 'Cascade Wrap', { type: 'recipe' })
    const salad = await make('TCC-012', 'Cascade Salad', { type: 'recipe' })
    const platter = await make('TCC-020', 'Cascade Platter', { type: 'recipe' })
    const sixPack = await make('TCC-030', 'Cascade Burger 6-Pack', { type: 'refer' })

    // 2 tomato + 1 bun = 40 + 5 = 45
    await saveRecipe(SITE, burger, [
      { componentId: tomato, qty: 2 },
      { componentId: bun, qty: 1 },
    ])
    // 1 tomato = 20
    await saveRecipe(SITE, wrap, [{ componentId: tomato, qty: 1 }])
    // 3 tomato = 60
    await saveRecipe(SITE, salad, [{ componentId: tomato, qty: 3 }])
    // 2 burgers = 90
    await saveRecipe(SITE, platter, [{ componentId: burger, qty: 2 }])
    // 6 burgers = 270
    await saveRefer(SITE, sixPack, burger, 6, 'subtract')

    // Seed the caches the way the products form does on save.
    for (const [id, type] of [
      [burger, 'recipe'],
      [wrap, 'recipe'],
      [salad, 'recipe'],
      [platter, 'recipe'],
      [sixPack, 'refer'],
    ] as const) {
      const c = await compositionCost(SITE, id, type)
      if (c !== null && c > 0) await setDerivedCost(SITE, id, c)
    }

    console.log('1. Fixtures cost correctly to begin with')
    check('burger is 45.00', Math.abs((await storedCost(burger)) - 45) < 0.005,
      `got ${(await storedCost(burger)).toFixed(2)}`)
    check('platter is 90.00', Math.abs((await storedCost(platter)) - 90) < 0.005,
      `got ${(await storedCost(platter)).toFixed(2)}`)
    check('6-pack is 270.00', Math.abs((await storedCost(sixPack)) - 270) < 0.005,
      `got ${(await storedCost(sixPack)).toFixed(2)}`)

    /* ── The headline case ────────────────────────────────────────────── */
    console.log('\n2. Tomato 20.00 -> 50.00 reaches every dependant')
    await siteExecute(SITE, 'UPDATE products SET last_cost = ?, average_cost = ? WHERE id = ?',
      ['50.0000', '50.0000', tomato])
    const written = await cascadeCompositionCosts(SITE, tomato)

    // 2*50 + 5 = 105
    check('burger recosted to 105.00', Math.abs((await storedCost(burger)) - 105) < 0.005,
      `got ${(await storedCost(burger)).toFixed(2)}`)
    check('wrap recosted to 50.00', Math.abs((await storedCost(wrap)) - 50) < 0.005,
      `got ${(await storedCost(wrap)).toFixed(2)}`)
    check('salad recosted to 150.00', Math.abs((await storedCost(salad)) - 150) < 0.005,
      `got ${(await storedCost(salad)).toFixed(2)}`)
    check('every dependant was counted', written >= 5, `wrote ${written}`)

    /* ── The nesting the old refer-only walk could not do ─────────────── */
    console.log('\n3. It climbs THROUGH a made item, and across link kinds')
    check('platter (recipe of a recipe) is 210.00',
      Math.abs((await storedCost(platter)) - 210) < 0.005,
      `got ${(await storedCost(platter)).toFixed(2)}`)
    check('6-pack (refer ONTO a recipe) is 630.00',
      Math.abs((await storedCost(sixPack)) - 630) < 0.005,
      `got ${(await storedCost(sixPack)).toFixed(2)}`)

    /* ── The invariant, stated directly ───────────────────────────────── */
    console.log('\n4. Stored cost agrees with what the till charges')
    await assertStoredMatchesLive('burger', burger, 'recipe')
    await assertStoredMatchesLive('wrap', wrap, 'recipe')
    await assertStoredMatchesLive('salad', salad, 'recipe')
    await assertStoredMatchesLive('platter', platter, 'recipe')
    await assertStoredMatchesLive('6-pack', sixPack, 'refer')

    /* ── Down as well as up ───────────────────────────────────────────── */
    console.log('\n5. A cost that FALLS cascades too')
    await siteExecute(SITE, 'UPDATE products SET last_cost = ?, average_cost = ? WHERE id = ?',
      ['1.0000', '1.0000', tomato])
    await cascadeCompositionCosts(SITE, tomato)
    check('burger back to 7.00', Math.abs((await storedCost(burger)) - 7) < 0.005,
      `got ${(await storedCost(burger)).toFixed(2)}`)
    check('platter back to 14.00', Math.abs((await storedCost(platter)) - 14) < 0.005,
      `got ${(await storedCost(platter)).toFixed(2)}`)

    /* ── Refusals, which matter as much as the writes ─────────────────── */
    console.log('\n6. It refuses to make things worse')

    const orphan = await make('TCC-040', 'Cascade Orphan', { type: 'recipe' })
    await setDerivedCost(SITE, orphan, 99)
    // A recipe with no lines cannot resolve. The stored figure must survive:
    // overwriting it with 0 would replace a stale number with a wrong one.
    await cascadeCompositionCosts(SITE, orphan)
    check('an unresolvable recipe keeps its stored cost',
      Math.abs((await storedCost(orphan)) - 99) < 0.005,
      `got ${(await storedCost(orphan)).toFixed(2)}`)

    const lonely = await make('TCC-041', 'Cascade Lonely', { cost: 12 })
    const none = await cascadeCompositionCosts(SITE, lonely)
    check('a product nothing is built from writes nothing', none === 0, `wrote ${none}`)

    // A cycle must terminate rather than hang the caller. saveRecipe refuses a
    // direct self-reference, so this is built through two products.
    const cycleA = await make('TCC-050', 'Cascade Cycle A', { type: 'recipe' })
    const cycleB = await make('TCC-051', 'Cascade Cycle B', { type: 'recipe' })
    await saveRecipe(SITE, cycleA, [{ componentId: bun, qty: 1 }])
    await saveRecipe(SITE, cycleB, [{ componentId: cycleA, qty: 1 }])
    // Close the loop behind saveRecipe's back — it validates, and that is the
    // point: this is the corrupt state the depth cap exists for.
    await siteExecute(
      SITE,
      'INSERT INTO product_recipes (parent_id, component_id, qty, wastage_pct, position) VALUES (?,?,?,?,?)',
      [cycleA, cycleB, '1.000', '0.000', 1],
    )
    const start = Date.now()
    await cascadeCompositionCosts(SITE, bun)
    const took = Date.now() - start
    check('a cycle terminates instead of hanging', took < 15000, `took ${took}ms`)

    /* ── The cost basis decides which column an ingredient is read at ─── */
    //
    // The bug this covers: typing a cost writes last_cost and deliberately
    // leaves average_cost alone (it is a consequence of purchases). A recipe
    // engine hardcoded to average_cost therefore showed the OLD figure on a
    // site costing at last, and the burger never moved — which reads exactly
    // like a broken cascade and is not one.
    console.log('\n7. Recipe cost follows the site cost basis')

    const basisProduct = await make('TCC-060', 'Cascade Basis Ingredient', { cost: 10, stock: 10 })
    const basisRecipe = await make('TCC-061', 'Cascade Basis Recipe', { type: 'recipe' })
    await saveRecipe(SITE, basisRecipe, [{ componentId: basisProduct, qty: 1 }])

    // last_cost and average_cost deliberately DIFFERENT, which is exactly what
    // typing a cost on an average-basis site produces.
    await siteExecute(SITE, 'UPDATE products SET last_cost = ?, average_cost = ? WHERE id = ?', [
      '99.0000',
      '10.0000',
      basisProduct,
    ])

    await setSetting(SITE, 'cost_basis', 'average')
    const onAverage = await compositionCost(SITE, basisRecipe, 'recipe')
    check("'average' basis reads average_cost (10.00)",
      onAverage !== null && Math.abs(onAverage - 10) < 0.005, `got ${onAverage?.toFixed(2)}`)

    await setSetting(SITE, 'cost_basis', 'last')
    const onLast = await compositionCost(SITE, basisRecipe, 'recipe')
    check("'last' basis reads last_cost (99.00)",
      onLast !== null && Math.abs(onLast - 99) < 0.005, `got ${onLast?.toFixed(2)}`)

    // And the cascade uses the same column, so a typed cost on a 'last' site
    // now reaches the recipe — the user-facing symptom that started this.
    await cascadeCompositionCosts(SITE, basisProduct)
    check("a typed cost reaches the recipe on a 'last' site",
      Math.abs((await storedCost(basisRecipe)) - 99) < 0.005,
      `got ${(await storedCost(basisRecipe)).toFixed(2)}`)

    console.log(`\n${passed} passed, ${failed} failed`)
  } finally {
    /*
     * Back to the DEFAULT, not to whatever was read at the start.
     *
     * Restoring "the original" faithfully re-writes a previous crashed run's
     * pollution. SETTING_DEFAULTS says 'average', and that is the value a site
     * that has never been touched reports.
     */
    await setSetting(SITE, 'cost_basis', 'average').catch(() => {})
    await cleanup()
    console.log('fixtures removed, cost_basis restored to average.')
  }

  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  cleanup()
    .catch(() => {})
    .finally(() => process.exit(1))
})
