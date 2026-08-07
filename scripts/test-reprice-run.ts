/**
 * Bulk repricing against the real catalogue.
 *
 * test-repricing.ts covers the arithmetic. This one proves the planner reads
 * the right rows, that preview and apply agree, and that a run over tens of
 * thousands of products completes without falling over.
 *
 * It creates its own throwaway price type and only ever writes prices under
 * THAT — the existing tiers are never touched.
 *
 *   npm run test:reprice-run
 */
import { siteQueryOne, siteExecute } from '../src/lib/siteDb'
import { planReprice, applyReprice } from '../src/lib/site/reprice'
import {
  createPriceStructure,
  deletePriceStructure,
  listPriceStructuresForSetup,
} from '../src/lib/site/pricingSetup'
import { toNum } from '../src/lib/decimals'

const SITE = 1

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stamp = Date.now().toString().slice(-6)
  const name = `ZZ Reprice Test ${stamp}`

  const made = await createPriceStructure(SITE, { name })
  ok('throwaway price type created', made.ok, made.ok ? `id ${made.id}` : made.error)
  if (!made.ok) return
  const targetId = made.id

  const structures = await listPriceStructuresForSetup(SITE)
  const retail = structures.find((s) => s.isDefault)!
  ok('found the default price type to source from', !!retail, retail?.name)

  try {
    /* ── Preview ──────────────────────────────────────────────────────────── */

    const rule = {
      source: { kind: 'cost' as const },
      method: { kind: 'markup' as const, percent: 40 },
      rounding: { kind: 'ending' as const, cents: 99, direction: 'up' as const },
      floorAtCost: true,
    }
    const scope = { targetStructureId: targetId, onlyMissing: true }

    const started = process.hrtime.bigint()
    const plan = await planReprice(SITE, scope, rule)
    const ms = Number(process.hrtime.bigint() - started) / 1e6

    ok('planner returned rows', plan.considered > 0, `${plan.considered} considered`)
    console.log(
      `      ${plan.changes.length} changes, ${plan.skips.length} skips, ${ms.toFixed(0)}ms`,
    )
    ok('a full-catalogue plan completes in reasonable time', ms < 60000, `${ms.toFixed(0)}ms`)

    // Nothing is priced under a brand-new structure, so onlyMissing must not
    // have excluded anything.
    ok(
      'every considered product is a change or a skip',
      plan.changes.length + plan.skips.length === plan.considered,
      `${plan.changes.length} + ${plan.skips.length} vs ${plan.considered}`,
    )
    ok('all changes are marked changed (nothing priced yet)', plan.changes.every((c) => c.changed))
    ok('all changes have no current price', plan.changes.every((c) => c.currentIncl === null))

    // The ending must actually be applied.
    const badEnding = plan.changes.filter((c) => Math.round((c.newIncl % 1) * 100) !== 99)
    ok('every new price ends in .99', badEnding.length === 0, `${badEnding.length} bad, e.g. ${badEnding[0]?.newIncl}`)

    // The floor must hold.
    const belowCost = plan.changes.filter((c) => c.newIncl < c.costExcl)
    ok('no price landed below its own cost', belowCost.length === 0, `${belowCost.length} below`)

    if (plan.skips.length > 0) {
      const reasons = new Map<string, number>()
      for (const s of plan.skips) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1)
      console.log(`      skip reasons: ${[...reasons].map(([r, n]) => `${n}× ${r}`).join(', ')}`)
    }

    /* ── Apply ────────────────────────────────────────────────────────────── */

    const applied = await applyReprice(SITE, targetId, plan.changes)
    ok('apply succeeded', applied.ok, applied.ok ? `${applied.written} written` : applied.error)
    if (!applied.ok) return

    ok('wrote exactly the changed count', applied.written === plan.changes.length, `${applied.written} vs ${plan.changes.length}`)

    const stored = await siteQueryOne<any>(
      SITE,
      'SELECT COUNT(*) AS n FROM product_prices WHERE price_structure_id = ?',
      [targetId],
    )
    ok('rows are actually in the table', Number(stored.n) === applied.written, `${stored.n} rows`)

    // Spot-check one product's stored figure against the plan.
    if (plan.changes.length > 0) {
      const sample = plan.changes[0]
      const row = await siteQueryOne<any>(
        SITE,
        'SELECT selling_price_incl FROM product_prices WHERE product_id = ? AND price_structure_id = ?',
        [sample.productId, targetId],
      )
      ok(
        'the stored price matches what the preview showed',
        Math.abs(toNum(row.selling_price_incl) - sample.newIncl) < 0.0001,
        `${row?.selling_price_incl} vs ${sample.newIncl}`,
      )
    }

    /* ── Idempotency ──────────────────────────────────────────────────────── */

    // Re-planning with onlyMissing OFF must now find everything already correct
    // — the single most important property, because it means re-running a rule
    // does not walk every price up a rand.
    const rerun = await planReprice(SITE, { ...scope, onlyMissing: false }, rule)
    const stillChanging = rerun.changes.filter((c) => c.changed)
    ok(
      're-running the same rule changes nothing',
      stillChanging.length === 0,
      `${stillChanging.length} would change, e.g. ${stillChanging[0]?.code} ${stillChanging[0]?.currentIncl}→${stillChanging[0]?.newIncl}`,
    )

    const reapplied = await applyReprice(SITE, targetId, rerun.changes)
    ok('a second apply writes nothing', reapplied.ok && reapplied.written === 0, reapplied.ok ? String(reapplied.written) : reapplied.error)

    /* ── Pricing off another structure ────────────────────────────────────── */

    const offRetail = await planReprice(
      SITE,
      { targetStructureId: targetId, onlyMissing: false },
      {
        source: { kind: 'structure', structureId: retail.id },
        method: { kind: 'adjust', percent: -10 },
        rounding: { kind: 'none' },
        floorAtCost: false,
      },
    )
    ok('pricing off another structure produces changes', offRetail.changes.length > 0, `${offRetail.changes.length}`)

    // Every one should be 10% under the retail price it came from.
    if (offRetail.changes.length > 0) {
      const s = offRetail.changes[0]
      const retailPrice = await siteQueryOne<any>(
        SITE,
        'SELECT selling_price_incl FROM product_prices WHERE product_id = ? AND price_structure_id = ?',
        [s.productId, retail.id],
      )
      const expected = toNum(retailPrice.selling_price_incl) * 0.9
      ok(
        'a -10% adjustment is 90% of the source price',
        Math.abs(s.newIncl - expected) < 0.01,
        `${s.newIncl} vs ${expected.toFixed(4)}`,
      )
    }
  } finally {
    // Clean up: prices first, then the structure itself. deletePriceStructure
    // deliberately refuses while prices exist, which is exactly the guard being
    // relied on everywhere else.
    await siteExecute(SITE, 'DELETE FROM product_prices WHERE price_structure_id = ?', [targetId])
    const removed = await deletePriceStructure(SITE, targetId)
    ok('throwaway price type cleaned up', removed.ok, removed.ok ? '' : removed.error)
  }

  console.log(fails === 0 ? '\nAll passed.' : `\n${fails} FAILED.`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
