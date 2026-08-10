/**
 * Scheduled price changes — the resolver a till runs.
 *
 * Pure, so this needs no database and covers cases a shop would take months to
 * produce. The parts worth the most attention:
 *
 *   TIME. 'YYYY-MM-DDTHH:mm' is LOCAL wall-clock text. Parsed as UTC — which is
 *   what `new Date(string)` does — a six o'clock change lands at eight in South
 *   Africa, which is the bug migration 057 exists to document.
 *
 *   LATE IS FINE, EARLY IS NOT. A till that was off at six and switched on at
 *   nine must apply the change immediately, not decide it missed it.
 *
 *   NO FLICKER. The till applies the change at six; the cron writes the same
 *   number minutes later. Both sides of that write must resolve identically, or
 *   the price visibly moves when the catalogue reloads.
 *
 *   npm run test:price-schedules
 */
import {
  parseLocal,
  pendingPriceFor,
  pendingPriceIndex,
  resolvedFromIndex,
  resolvedPriceIncl,
  scheduleDueAt,
  type PendingSchedule,
} from '../src/lib/priceSchedules'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** A schedule with everything defaulted, so each test states only what matters. */
function schedule(over: Partial<PendingSchedule> = {}): PendingSchedule {
  return {
    id: 1,
    name: 'Winter menu',
    effectiveAt: '2026-08-14T06:00',
    lines: [{ productId: 10, priceStructureId: 1, newPriceIncl: 12 }],
    ...over,
  }
}

const at = (text: string) => parseLocal(text)!

console.log('\n── Reading a moment ─────────────────────────────────────────')

{
  const parsed = parseLocal('2026-08-14T06:00')
  ok('parses to LOCAL six, not UTC six', parsed?.getHours() === 6, `got ${parsed?.getHours()}`)
  ok('parses the right day', parsed?.getDate() === 14 && parsed.getMonth() === 7)
}

ok('rejects an empty moment', parseLocal('') === null)
ok('rejects a half-written moment', parseLocal('2026-08-14') === null)
ok('rejects a day that does not exist', parseLocal('2026-02-31T10:00') === null)
ok('rejects an impossible hour', parseLocal('2026-08-14T25:00') === null)
ok('accepts the last minute of a day', parseLocal('2026-08-14T23:59') !== null)
ok('accepts a leap day that exists', parseLocal('2028-02-29T06:00') !== null)
ok('rejects a leap day that does not', parseLocal('2027-02-29T06:00') === null)

console.log('\n── Late is fine, early is not ───────────────────────────────')

{
  const s = schedule({ effectiveAt: '2026-08-14T06:00' })
  ok('not due a minute before', !scheduleDueAt(s, at('2026-08-14T05:59')))
  ok('due at the moment itself', scheduleDueAt(s, at('2026-08-14T06:00')))
  ok('due a minute after', scheduleDueAt(s, at('2026-08-14T06:01')))
  ok('STILL due the next night — a missed tick catches up', scheduleDueAt(s, at('2026-08-15T23:00')))
  ok('still due a year later', scheduleDueAt(s, at('2027-08-14T06:00')))
}

ok('a malformed moment is never due', !scheduleDueAt(schedule({ effectiveAt: 'soon' }), new Date()))
ok('an empty moment is never due', !scheduleDueAt(schedule({ effectiveAt: '' }), new Date()))

console.log('\n── Resolving a price ────────────────────────────────────────')

{
  const s = [schedule()]
  ok('nothing due yet leaves the price alone', pendingPriceFor(10, 1, s, at('2026-08-14T05:00')) === null)
  ok('due, so the new price applies', pendingPriceFor(10, 1, s, at('2026-08-14T06:00')) === 12)
  ok('a different product is untouched', pendingPriceFor(99, 1, s, at('2026-08-14T07:00')) === null)
  ok('a different price type is untouched', pendingPriceFor(10, 2, s, at('2026-08-14T07:00')) === null)
  ok('no price type at all resolves nothing', pendingPriceFor(10, null, s, at('2026-08-14T07:00')) === null)
  ok('no schedules at all resolves nothing', pendingPriceFor(10, 1, [], at('2026-08-14T07:00')) === null)
}

{
  const product = { id: 10, priceIncl: 10 }
  const s = [schedule()]
  ok(
    'before the moment, the catalogue price stands',
    resolvedPriceIncl(product, 1, s, at('2026-08-14T05:00')) === 10,
  )
  ok(
    'after the moment, the scheduled price stands',
    resolvedPriceIncl(product, 1, s, at('2026-08-14T06:00')) === 12,
  )
}

console.log('\n── Two changes due at once ──────────────────────────────────')

{
  /* A change from this morning, and one from last week that failed and is still
     armed. The LATER moment must win — that is what the database will hold once
     the tick catches up, because it applies them in the same order. */
  const older = schedule({ id: 1, effectiveAt: '2026-08-07T06:00', lines: [{ productId: 10, priceStructureId: 1, newPriceIncl: 11 }] })
  const newer = schedule({ id: 2, effectiveAt: '2026-08-14T06:00', lines: [{ productId: 10, priceStructureId: 1, newPriceIncl: 12 }] })

  ok('the later moment wins', pendingPriceFor(10, 1, [older, newer], at('2026-08-14T07:00')) === 12)
  ok('order in the array does not matter', pendingPriceFor(10, 1, [newer, older], at('2026-08-14T07:00')) === 12)
  ok(
    'before the later one is due, the earlier one still applies',
    pendingPriceFor(10, 1, [older, newer], at('2026-08-10T09:00')) === 11,
  )
}

{
  // Same moment: the higher id wins, matching the tick's ORDER BY effective_at, id.
  const a = schedule({ id: 1, lines: [{ productId: 10, priceStructureId: 1, newPriceIncl: 11 }] })
  const b = schedule({ id: 2, lines: [{ productId: 10, priceStructureId: 1, newPriceIncl: 12 }] })
  ok('a tie breaks on id', pendingPriceFor(10, 1, [b, a], at('2026-08-14T07:00')) === 12)
}

console.log('\n── One change across several price types ────────────────────')

{
  const s = [
    schedule({
      lines: [
        { productId: 10, priceStructureId: 1, newPriceIncl: 95 },
        { productId: 10, priceStructureId: 2, newPriceIncl: 80 },
      ],
    }),
  ]
  const now = at('2026-08-14T06:00')
  ok('retail moves', pendingPriceFor(10, 1, s, now) === 95)
  ok('wholesale moves in the same change', pendingPriceFor(10, 2, s, now) === 80)
  ok('a third type is untouched', pendingPriceFor(10, 3, s, now) === null)
}

console.log('\n── The index agrees with the single lookup ──────────────────')

{
  const s = [
    schedule({ id: 1, effectiveAt: '2026-08-07T06:00', lines: [{ productId: 10, priceStructureId: 1, newPriceIncl: 11 }] }),
    schedule({
      id: 2,
      effectiveAt: '2026-08-14T06:00',
      lines: [
        { productId: 10, priceStructureId: 1, newPriceIncl: 12 },
        { productId: 20, priceStructureId: 2, newPriceIncl: 45 },
      ],
    }),
  ]

  let agreed = true
  for (const when of ['2026-08-01T00:00', '2026-08-07T06:00', '2026-08-14T06:00', '2027-01-01T00:00']) {
    const now = at(when)
    const index = pendingPriceIndex(s, now)
    for (const productId of [10, 20, 99]) {
      for (const structureId of [1, 2, 3]) {
        const single = pendingPriceFor(productId, structureId, s, now)
        const viaIndex = resolvedFromIndex({ id: productId, priceIncl: -1 }, structureId, index)
        const expected = single === null ? -1 : single
        if (viaIndex !== expected) agreed = false
      }
    }
  }
  ok('index and single lookup agree across every combination', agreed)
}

console.log('\n── The no-flicker invariant ─────────────────────────────────')

{
  /*
   * The whole feature rests on this. At six the till resolves the pending price
   * against a stale base; minutes later the cron writes it and the till reloads
   * with the new base and no pending change. Both must produce the same number,
   * or the price visibly jumps on the reload.
   */
  const now = at('2026-08-14T06:00')

  const beforeCron = resolvedPriceIncl({ id: 10, priceIncl: 10 }, 1, [schedule()], now)
  const afterCron = resolvedPriceIncl({ id: 10, priceIncl: 12 }, 1, [], now)

  ok('till before the cron charges 12', beforeCron === 12)
  ok('till after the cron charges 12', afterCron === 12)
  ok('THE PRICE DOES NOT MOVE ACROSS THE WRITE', beforeCron === afterCron)

  /* And the pathological case the absolute price exists to prevent: if the same
     schedule is somehow still held after the base has moved, it must resolve to
     the same 12 rather than compounding. */
  const stillHolding = resolvedPriceIncl({ id: 10, priceIncl: 12 }, 1, [schedule()], now)
  ok('a stale pending line cannot double-apply', stillHolding === 12)
}

console.log(`\n${fails === 0 ? 'All good.' : `${fails} failure(s).`}\n`)
process.exit(fails === 0 ? 0 : 1)
