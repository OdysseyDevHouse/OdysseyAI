/**
 * Pushing a promotion to the rest of the group.
 *
 * The check that matters most for fan-out: the copy has to land in a DIFFERENT
 * database, carrying that store's OWN product ids, or the whole feature is a
 * button that reports success and does nothing.
 *
 * Product ids increment independently per database, so id 113 at head office is
 * something else entirely at a branch. Everything travels by CODE and is
 * re-resolved at the far end — this proves that actually happens rather than
 * an id being copied across and silently pointing at the wrong product.
 *
 * SKIPS, rather than failing, on an environment with no linked stores: there is
 * nothing to prove there, and a vacuous pass would be worse than a skip.
 *
 *   npm run test:special-fanout
 */
import { fanoutTargets, fanoutSpecial } from '../src/lib/site/specialFanout'
import { listSpecials, saveSpecial, deleteSpecial } from '../src/lib/site/specials'
import { siteQuery } from '../src/lib/siteDb'

const TAG = `__FANOUT_${String(Date.now()).slice(-6)}`

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  // Find a site that actually has linked stores; otherwise this proves nothing.
  let origin = 0
  let targets: { siteId: number; name: string }[] = []
  for (const candidate of [33, 34, 1, 2]) {
    const found = await fanoutTargets(candidate)
    if (found.length > 0) {
      origin = candidate
      targets = found
      break
    }
  }
  if (origin === 0) {
    console.log('SKIP  no site in this environment has linked stores')
    process.exit(0)
  }
  console.log(`origin site ${origin}, ${targets.length} target(s): ${targets.map((t) => t.name).join(', ')}`)

  // A product the origin stocks, so the special has something real to cover.
  const product = (
    await siteQuery<{ id: number; code: string }>(
      origin,
      `SELECT id, code FROM products WHERE is_archived = 0 ORDER BY id LIMIT 1`,
    )
  )[0]
  console.log(`covering product ${product.code} (id ${product.id} at the origin)`)

  const saved = await saveSpecial(
    origin,
    {
      id: null,
      name: `${TAG} group promo`,
      shape: 'happy_hour',
      isActive: true,
      startsAt: '2026-01-01T00:00',
      endsAt: '2030-12-31T23:59',
      dailyStart: '',
      dailyEnd: '',
      daysOfWeek: '1111111',
      discountPct: 15,
      triggerQty: 0,
      bundlePriceIncl: 0,
      spendAmountIncl: 0,
      items: [{ role: 'scope', productId: product.id, departmentId: null, qty: 1, priceIncl: 0 }],
      tiers: [],
    },
    'scratch',
  )
  if (!saved.ok) throw new Error(saved.error)

  const source = (await listSpecials(origin)).find((s) => s.id === saved.id)!
  const pick = targets.slice(0, 2)
  const outcomes = await fanoutSpecial(origin, source, pick.map((t) => t.siteId), 'scratch')

  console.log('\n— outcomes —')
  for (const o of outcomes) {
    console.log(`  ${o.storeName}: ok=${o.ok} ${o.detail}${o.skipped.length ? ' skipped=' + o.skipped.join(',') : ''}`)
  }
  ok('every chosen store reported', outcomes.length === pick.length)
  ok('and they took it', outcomes.every((o) => o.ok), outcomes.map((o) => o.detail).join(' / '))

  console.log('\n— what actually landed —')
  for (const t of pick) {
    const copy = (await listSpecials(t.siteId)).find((s) => s.name === `${TAG} group promo`)
    ok(`${t.name} has the promotion`, !!copy)
    if (!copy) continue
    ok(`  it knows where it came from`, copy.originSiteId === origin, String(copy.originSiteId))
    ok(`  it carries the discount`, copy.discountPct === 15, String(copy.discountPct))

    // The important one: the item points at THAT store's product id.
    const scope = copy.items.find((i) => i.role === 'scope')
    if (scope?.productId) {
      const there = (
        await siteQuery<{ code: string }>(t.siteId, `SELECT code FROM products WHERE id = ?`, [
          scope.productId,
        ])
      )[0]
      ok(
        `  its product resolves to the SAME CODE at that store`,
        there?.code === product.code,
        `origin id ${product.id} -> ${t.name} id ${scope.productId} (${there?.code})`,
      )
    } else {
      console.log(`  (the product is not stocked at ${t.name}, which the outcome reported)`)
    }
  }

  // Pushing again must UPDATE rather than duplicate.
  console.log('\n— pushing the same promotion again —')
  const again = await fanoutSpecial(origin, source, pick.map((t) => t.siteId), 'scratch')
  ok('the second push updates', again.every((o) => o.detail === 'updated'), again.map((o) => o.detail).join('/'))
  for (const t of pick) {
    const copies = (await listSpecials(t.siteId)).filter((s) => s.name === `${TAG} group promo`)
    ok(`${t.name} still has exactly one copy`, copies.length === 1, String(copies.length))
  }

  console.log('\n— cleaning up —')
  for (const t of pick) {
    for (const s of (await listSpecials(t.siteId)).filter((x) => x.name.startsWith(TAG))) {
      await deleteSpecial(t.siteId, s.id)
    }
  }
  await deleteSpecial(origin, saved.id)
  console.log(fails === 0 ? '\nAll fan-out checks passed.' : `\n${fails} FAILED.`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('THREW:', e instanceof Error ? e.message : e)
  process.exit(1)
})
