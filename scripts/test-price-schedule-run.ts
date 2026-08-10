/**
 * Scheduled price changes against the real database.
 *
 * test-price-schedules.ts covers the resolver a till runs. This one proves the
 * other half: that a change claims itself exactly once, writes what it said it
 * would, and can be put back.
 *
 * The cases worth the most attention:
 *
 *   CLAIMING. Two ticks that overlap must not both apply the same change, or
 *   every price is written twice and the "before" recorded for the undo is the
 *   price the first run already set.
 *
 *   LATE, NOT EARLY. A change whose moment has not come writes nothing. One
 *   that is overdue writes immediately.
 *
 *   NO POINTLESS WRITES. A line already at its target is not written, because
 *   touching product_prices.updated_at sends every till in the shop into a full
 *   catalogue reload.
 *
 * It creates its own throwaway price type and only ever writes prices under
 * THAT — the existing tiers are never touched.
 *
 *   npm run test:price-schedule-run
 */
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'
import {
  createSchedule,
  setScheduleLines,
  seedFromCurrent,
  armSchedule,
  applyDueSchedules,
  applyOneSchedule,
  revertSchedule,
  pendingSchedulesForTill,
  duePricesFor,
  getSchedule,
  staleLines,
} from '../src/lib/site/priceSchedules'
import {
  createPriceStructure,
  deletePriceStructure,
  listPriceStructuresForSetup,
} from '../src/lib/site/pricingSetup'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const ACTOR = { userId: 0, userName: 'Test' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const pad = (n: number) => String(n).padStart(2, '0')
/** Wall-clock text N minutes from now, in the format the column stores. */
function momentIn(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60_000)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/** Read a price straight from the table, bypassing every helper. */
async function priceOf(productId: number, structureId: number): Promise<number | null> {
  const row = await siteQueryOne<{ selling_price_incl: string }>(
    SITE,
    'SELECT selling_price_incl FROM product_prices WHERE product_id = ? AND price_structure_id = ?',
    [productId, structureId],
  )
  return row ? toNum(row.selling_price_incl) : null
}

async function main() {
  const stamp = Date.now().toString().slice(-6)

  const madeA = await createPriceStructure(SITE, { name: `ZZ Sched A ${stamp}` })
  const madeB = await createPriceStructure(SITE, { name: `ZZ Sched B ${stamp}` })
  ok('throwaway price types created', madeA.ok && madeB.ok)
  if (!madeA.ok || !madeB.ok) return
  const structureA = madeA.id
  const structureB = madeB.id

  const structures = await listPriceStructuresForSetup(SITE)
  const retail = structures.find((s) => s.isDefault)!

  /* Real products to work with. Variant parents never sell, so they are
     excluded here for the same reason seedFromCurrent excludes them. */
  const products = await siteQuery<{ id: number }>(
    SITE,
    'SELECT id FROM products WHERE is_archived = 0 AND has_variants = 0 ORDER BY id LIMIT 3',
  )
  ok('found products to price', products.length === 3, `${products.length} found`)
  if (products.length < 3) return
  const [p1, p2, p3] = products.map((p) => p.id)

  const scheduleIds: number[] = []

  try {
    /* ── Building one ─────────────────────────────────────────────────── */

    const made = await createSchedule(SITE, ACTOR, { name: `ZZ Change ${stamp}`, effectiveAt: '' })
    ok('schedule created', made.ok)
    if (!made.ok) return
    const id = made.id
    scheduleIds.push(id)

    await setScheduleLines(SITE, id, [
      { productId: p1, priceStructureId: structureA, newPriceIncl: 12 },
      { productId: p2, priceStructureId: structureA, newPriceIncl: 25 },
      { productId: p1, priceStructureId: structureB, newPriceIncl: 10 },
    ])

    const built = await getSchedule(SITE, id)
    ok('three lines on the change', built?.lines.length === 3, `${built?.lines.length}`)
    ok(
      'the before-price is null where the product had no price under that type',
      built?.lines.every((l) => l.oldPriceIncl === null) === true,
    )

    // Upsert, not a second row: re-adding corrects rather than contradicting.
    await setScheduleLines(SITE, id, [
      { productId: p1, priceStructureId: structureA, newPriceIncl: 13 },
    ])
    const corrected = await getSchedule(SITE, id)
    ok('re-adding a product corrects it', corrected?.lines.length === 3)
    ok(
      'the corrected price is the new one',
      corrected?.lines.find((l) => l.productId === p1 && l.priceStructureId === structureA)
        ?.newPriceIncl === 13,
    )

    /* ── Arming refuses what it should ────────────────────────────────── */

    const noMoment = await armSchedule(SITE, ACTOR, id)
    ok('will not schedule without a time', !noMoment.ok, noMoment.ok ? '' : noMoment.error)

    await siteExecute(SITE, 'UPDATE price_schedules SET effective_at = ? WHERE id = ?', [
      momentIn(-60),
      id,
    ])
    const inPast = await armSchedule(SITE, ACTOR, id)
    ok('will not schedule a time in the past', !inPast.ok, inPast.ok ? '' : inPast.error)

    /* ── Nothing happens before its moment ────────────────────────────── */

    await siteExecute(SITE, 'UPDATE price_schedules SET effective_at = ? WHERE id = ?', [
      momentIn(60),
      id,
    ])
    const armedOk = await armSchedule(SITE, ACTOR, id)
    ok('scheduled for an hour from now', armedOk.ok, armedOk.ok ? '' : armedOk.error)

    const early = await applyDueSchedules(SITE)
    ok('a future change writes nothing', early.applied === 0, `applied ${early.applied}`)
    ok('and no price moved', (await priceOf(p1, structureA)) === null)

    /* ── The till is told about it anyway ─────────────────────────────── */

    const pending = await pendingSchedulesForTill(SITE)
    const mine = pending.find((s) => s.id === id)
    ok('a future change IS shipped to the tills', !!mine)
    ok('with all of its lines', mine?.lines.length === 3, `${mine?.lines.length}`)
    ok(
      'and the absolute prices, not deltas',
      mine?.lines.some((l) => l.productId === p1 && l.newPriceIncl === 13) === true,
    )

    // Not yet due, so nothing may be charged at the new price.
    const notYetDue = await duePricesFor(SITE, structureA, [p1])
    ok('a future price is not yet chargeable', notYetDue.size === 0)

    /* ── Overdue: it fires ────────────────────────────────────────────── */

    await siteExecute(SITE, 'UPDATE price_schedules SET effective_at = ? WHERE id = ?', [
      momentIn(-5),
      id,
    ])

    const nowDue = await duePricesFor(SITE, structureA, [p1])
    ok('an overdue price IS chargeable before the tick runs', nowDue.get(p1) === 13)

    const fired = await applyDueSchedules(SITE)
    ok('the overdue change applied', fired.applied === 1, `applied ${fired.applied}`)
    ok('three prices written', fired.prices === 3, `${fired.prices}`)
    ok('retail A moved', (await priceOf(p1, structureA)) === 13)
    ok('the second product moved', (await priceOf(p2, structureA)) === 25)
    ok('the SECOND PRICE TYPE moved in the same change', (await priceOf(p1, structureB)) === 10)

    const afterFiring = await getSchedule(SITE, id)
    ok('it is marked applied', afterFiring?.status === 'applied')
    ok('with the count recorded', afterFiring?.appliedCount === 3, `${afterFiring?.appliedCount}`)

    /* ── It cannot fire twice ─────────────────────────────────────────── */

    const again = await applyDueSchedules(SITE)
    ok('a second sweep applies nothing', again.applied === 0, `applied ${again.applied}`)

    /* ── Two overlapping ticks claim it once ──────────────────────────── */

    const second = await createSchedule(SITE, ACTOR, {
      name: `ZZ Race ${stamp}`,
      effectiveAt: momentIn(60),
    })
    if (second.ok) {
      scheduleIds.push(second.id)
      await setScheduleLines(SITE, second.id, [
        { productId: p3, priceStructureId: structureA, newPriceIncl: 77 },
      ])
      await armSchedule(SITE, ACTOR, second.id)
      await siteExecute(SITE, 'UPDATE price_schedules SET effective_at = ? WHERE id = ?', [
        momentIn(-5),
        second.id,
      ])

      /*
       * THE TEST THAT PROVES THE CLAIM. Two sweeps at once, as a slow tick and
       * the next one five minutes later would be. Exactly one may apply it.
       */
      const [runA, runB] = await Promise.all([applyDueSchedules(SITE), applyDueSchedules(SITE)])
      ok(
        'two concurrent sweeps apply it exactly once',
        runA.applied + runB.applied === 1,
        `${runA.applied} + ${runB.applied}`,
      )
      ok('and the price is the scheduled one', (await priceOf(p3, structureA)) === 77)

      const raced = await getSchedule(SITE, second.id)
      ok('the count was not doubled', raced?.appliedCount === 1, `${raced?.appliedCount}`)
    }

    /* ── An applied change is no longer shipped ───────────────────────── */

    const afterPending = await pendingSchedulesForTill(SITE)
    ok(
      'an applied change is not shipped to the tills',
      !afterPending.some((s) => s.id === id),
    )

    /* ── A line already at its target is not written ──────────────────── */

    const noop = await createSchedule(SITE, ACTOR, {
      name: `ZZ Noop ${stamp}`,
      effectiveAt: momentIn(60),
    })
    if (noop.ok) {
      scheduleIds.push(noop.id)
      // p1 under structureA is already 13.
      await setScheduleLines(SITE, noop.id, [
        { productId: p1, priceStructureId: structureA, newPriceIncl: 13 },
      ])
      const armNoop = await armSchedule(SITE, ACTOR, noop.id)
      ok(
        'a change that moves nothing refuses to be scheduled',
        !armNoop.ok,
        armNoop.ok ? '' : armNoop.error,
      )
    }

    /* ── Seeding from what the shop charges today ─────────────────────── */

    const seeded = await createSchedule(SITE, ACTOR, {
      name: `ZZ Seed ${stamp}`,
      effectiveAt: momentIn(60),
    })
    if (seeded.ok) {
      scheduleIds.push(seeded.id)
      const result = await seedFromCurrent(SITE, seeded.id, { priceStructureIds: [structureA] })
      ok('seeding brought lines in', result.ok && result.added > 0, result.ok ? `${result.added}` : result.error)

      const seededSchedule = await getSchedule(SITE, seeded.id)
      ok(
        'every seeded line starts unchanged',
        seededSchedule?.lines.every((l) => l.oldPriceIncl === l.newPriceIncl) === true,
      )

      const armSeeded = await armSchedule(SITE, ACTOR, seeded.id)
      ok(
        'an untouched seed refuses to be scheduled',
        !armSeeded.ok,
        armSeeded.ok ? '' : armSeeded.error,
      )
    }

    /* ── Stale detection ──────────────────────────────────────────────── */

    const staleCheck = await createSchedule(SITE, ACTOR, {
      name: `ZZ Stale ${stamp}`,
      effectiveAt: momentIn(60),
    })
    if (staleCheck.ok) {
      scheduleIds.push(staleCheck.id)
      await setScheduleLines(SITE, staleCheck.id, [
        { productId: p1, priceStructureId: structureA, newPriceIncl: 99 },
      ])
      ok('nothing stale to begin with', (await staleLines(SITE, staleCheck.id)).length === 0)

      // Somebody edits the price by hand after the list was built.
      await siteExecute(
        SITE,
        'UPDATE product_prices SET selling_price_incl = 14 WHERE product_id = ? AND price_structure_id = ?',
        [p1, structureA],
      )
      const stale = await staleLines(SITE, staleCheck.id)
      ok('a hand edit since is reported as stale', stale.length === 1, `${stale.length}`)

      // Put it back for the revert test below.
      await siteExecute(
        SITE,
        'UPDATE product_prices SET selling_price_incl = 13 WHERE product_id = ? AND price_structure_id = ?',
        [p1, structureA],
      )
    }

    /* ── Putting it back ──────────────────────────────────────────────── */

    // p2 is edited by hand after the change applied — the undo must leave it.
    await siteExecute(
      SITE,
      'UPDATE product_prices SET selling_price_incl = 30 WHERE product_id = ? AND price_structure_id = ?',
      [p2, structureA],
    )

    const reverted = await revertSchedule(SITE, ACTOR, id)
    ok('the change was put back', reverted.ok)
    if (reverted.ok) {
      ok('one line was left alone', reverted.skipped === 1, `skipped ${reverted.skipped}`)
      ok('the hand-edited price was NOT touched', (await priceOf(p2, structureA)) === 30)
      /* These had no price before the change, so putting them back means having
         no price again — not zero, which is a price a shop would sell at. */
      ok('a line with no before-price has its row removed', (await priceOf(p1, structureA)) === null)
      ok('across both price types', (await priceOf(p1, structureB)) === null)

      const afterRevert = await getSchedule(SITE, id)
      ok('the change is marked cancelled', afterRevert?.status === 'cancelled')
    }

    /* ── Applying one by hand ─────────────────────────────────────────── */

    const byHand = await createSchedule(SITE, ACTOR, {
      name: `ZZ Hand ${stamp}`,
      effectiveAt: momentIn(600),
    })
    if (byHand.ok) {
      scheduleIds.push(byHand.id)
      await setScheduleLines(SITE, byHand.id, [
        { productId: p3, priceStructureId: structureB, newPriceIncl: 55 },
      ])
      await armSchedule(SITE, ACTOR, byHand.id)

      const done = await applyOneSchedule(SITE, byHand.id, ACTOR)
      ok('a change can be applied ahead of its moment by hand', done.ok)
      ok('and the price moved', (await priceOf(p3, structureB)) === 55)
    }

    /* ── The audit trail ──────────────────────────────────────────────── */

    const logged = await siteQueryOne<{ n: number }>(
      SITE,
      `SELECT COUNT(*) AS n FROM activity_log
        WHERE entity = 'price_schedule' AND entity_id IN (${scheduleIds.map(() => '?').join(',')})`,
      scheduleIds,
    )
    ok('every change left an audit trail', Number(logged?.n ?? 0) > 0, `${logged?.n} rows`)
  } finally {
    /* Prices first, then the schedules, then the structures — deletePriceStructure
       refuses while prices exist, which is the guard relied on everywhere else. */
    if (scheduleIds.length > 0) {
      await siteExecute(
        SITE,
        `DELETE FROM price_schedules WHERE id IN (${scheduleIds.map(() => '?').join(',')})`,
        scheduleIds,
      )
      await siteExecute(
        SITE,
        `DELETE FROM activity_log WHERE entity = 'price_schedule' AND entity_id IN (${scheduleIds.map(() => '?').join(',')})`,
        scheduleIds,
      )
    }
    for (const structureId of [structureA, structureB]) {
      await siteExecute(SITE, 'DELETE FROM product_prices WHERE price_structure_id = ?', [
        structureId,
      ])
      const removed = await deletePriceStructure(SITE, structureId)
      if (!removed.ok) ok('throwaway price type cleaned up', false, removed.error)
    }
    console.log('      cleaned up')
  }

  console.log(fails === 0 ? '\nAll passed.' : `\n${fails} FAILED.`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
