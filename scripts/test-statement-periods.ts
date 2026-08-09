/**
 * Statement cycles — the period generator.
 *
 * Pure functions only: no database, no site. The properties asserted here are
 * the ones a balance brought forward depends on — periods must TILE, meaning
 * consecutive ones are contiguous, non-overlapping, and leave no day in
 * between. A gap silently drops transactions from every statement; an overlap
 * counts them twice.
 *
 * The DB-backed half of statement correctness lives in test-statements.ts.
 *
 *   npx tsx scripts/test-statement-periods.ts
 */
import {
  periodContaining,
  statementPeriods,
  periodFromKey,
  cycleBucketLabels,
  toStatementCycle,
  CYCLE_DAYS,
  type CycleConfig,
} from '../src/lib/statementCycles'
import { bucketFor } from '../src/lib/site/ledger'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + days)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function daysApart(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime()
  const b = new Date(`${to}T00:00:00`).getTime()
  return Math.round((b - a) / 86_400_000)
}

/**
 * The load-bearing property: `count` periods back from `asAt` tile perfectly.
 *
 * statementPeriods returns newest-first, so period n starts the day after
 * period n+1 ends.
 */
function assertTiles(label: string, config: CycleConfig, asAt: string, count = 26) {
  const periods = statementPeriods(config, asAt, count)
  let gaps = 0
  let inverted = 0

  for (let i = 0; i < periods.length; i++) {
    if (periods[i].to < periods[i].from) inverted++
    if (i + 1 < periods.length && periods[i].from !== addDays(periods[i + 1].to, 1)) gaps++
  }

  ok(`  ${label} — no gaps or overlaps across ${count} periods`, gaps === 0, `${gaps} break(s)`)
  ok(`  ${label} — no period ends before it starts`, inverted === 0, `${inverted} inverted`)
}

function main() {
  console.log('\n── Monthly, calendar (the default every existing account has) ──')
  {
    const cfg: CycleConfig = { cycle: 'monthly', anchorDay: 0 }
    const p = periodContaining(cfg, '2026-08-14')
    ok('August 2026 runs 1st to 31st', p.from === '2026-08-01' && p.to === '2026-08-31', `${p.from}..${p.to}`)
    ok('  labelled by month name', p.label === 'August 2026', p.label)
    ok('  key is the from:to composite', p.key === '2026-08-01:2026-08-31', p.key)

    const feb = periodContaining(cfg, '2026-02-10')
    ok('February 2026 ends on the 28th', feb.to === '2026-02-28', feb.to)
    const febLeap = periodContaining(cfg, '2028-02-10')
    ok('February 2028 ends on the 29th', febLeap.to === '2028-02-29', febLeap.to)

    assertTiles('calendar months', cfg, '2026-08-14')
  }

  console.log('\n── Monthly, anchored on a day ──')
  {
    const cfg: CycleConfig = { cycle: 'monthly', anchorDay: 25 }
    const p = periodContaining(cfg, '2026-08-14')
    ok('the 14th falls in 25 Jul – 24 Aug', p.from === '2026-07-25' && p.to === '2026-08-24', `${p.from}..${p.to}`)
    ok('  labelled as a span', p.label === '25 Jul – 24 Aug 2026', p.label)

    const onAnchor = periodContaining(cfg, '2026-08-25')
    ok('the anchor day starts a new period', onAnchor.from === '2026-08-25', onAnchor.from)

    assertTiles('anchored on the 25th', cfg, '2026-08-14')
  }

  console.log('\n── Monthly, anchor day 31 (the short-month case) ──')
  {
    const cfg: CycleConfig = { cycle: 'monthly', anchorDay: 31 }
    const jan = periodContaining(cfg, '2026-02-05')
    ok('31 Jan runs to 27 Feb', jan.from === '2026-01-31' && jan.to === '2026-02-27', `${jan.from}..${jan.to}`)
    const feb = periodContaining(cfg, '2026-03-01')
    ok('  and 28 Feb picks straight up', feb.from === '2026-02-28', feb.from)

    // The whole reason for clamping rather than rolling forward.
    assertTiles('anchored on the 31st', cfg, '2026-08-14')
    assertTiles('anchored on the 31st, across a leap year', cfg, '2028-06-14')
  }

  console.log('\n── Weekly (7 days) ──')
  {
    const cfg: CycleConfig = { cycle: '7day', anchorDate: '2026-08-04' } // a Tuesday
    const p = periodContaining(cfg, '2026-08-06')
    ok('the week of the 4th runs Tue 4 – Mon 10', p.from === '2026-08-04' && p.to === '2026-08-10', `${p.from}..${p.to}`)
    ok('  labelled within one month', p.label === '4–10 Aug 2026', p.label)
    ok('  the 11th starts the next week', periodContaining(cfg, '2026-08-11').from === '2026-08-11')

    const periods = statementPeriods(cfg, '2026-08-06', 30)
    const wrong = periods.filter((x) => daysApart(x.from, x.to) !== 6)
    ok('every period spans exactly 7 days', wrong.length === 0, `${wrong.length} wrong`)

    // A date before the anchor must still resolve — an opening balance dated
    // before the account existed is exactly this case.
    const before = periodContaining(cfg, '2026-07-01')
    ok('a date before the anchor still resolves', before.from <= '2026-07-01' && before.to >= '2026-07-01', `${before.from}..${before.to}`)
    ok('  and still spans 7 days', daysApart(before.from, before.to) === 6)

    assertTiles('weekly', cfg, '2026-08-06')
    assertTiles('weekly across a year boundary', cfg, '2026-01-05')
  }

  console.log('\n── Fortnightly (14 days) ──')
  {
    const cfg: CycleConfig = { cycle: '14day', anchorDate: '2026-08-04' }
    const periods = statementPeriods(cfg, '2026-08-20', 30)
    const wrong = periods.filter((x) => daysApart(x.from, x.to) !== 13)
    ok('every period spans exactly 14 days', wrong.length === 0, `${wrong.length} wrong`)
    assertTiles('fortnightly', cfg, '2026-08-20')
    assertTiles('fortnightly across a year boundary', cfg, '2026-01-05')
  }

  console.log('\n── Per-customer anchors are genuinely independent ──')
  {
    const a = periodContaining({ cycle: '7day', anchorDate: '2026-08-04' }, '2026-08-06')
    const b = periodContaining({ cycle: '7day', anchorDate: '2026-08-06' }, '2026-08-06')
    ok('two accounts two days apart stay two days apart', daysApart(a.from, b.from) === 2, `${a.from} vs ${b.from}`)
  }

  console.log('\n── The anchor fallback ──')
  {
    const withFallback = periodContaining(
      { cycle: '7day', anchorDate: null, fallbackAnchor: '2026-08-04' },
      '2026-08-06',
    )
    ok('a null anchor falls back to the creation date', withFallback.from === '2026-08-04', withFallback.from)

    // Determinism matters more than the specific epoch: the same account asked
    // twice must get the same periods, whenever it is asked.
    const bare: CycleConfig = { cycle: '7day' }
    const once = periodContaining(bare, '2026-08-06')
    const twice = periodContaining(bare, '2026-08-06')
    ok('with no anchor at all it is still deterministic', once.key === twice.key, once.key)
    ok('  and still a 7-day period', daysApart(once.from, once.to) === 6)
  }

  console.log('\n── The period list ──')
  {
    const cfg: CycleConfig = { cycle: 'monthly', anchorDay: 0 }
    const periods = statementPeriods(cfg, '2026-08-14', 13)
    ok('returns the count asked for', periods.length === 13, String(periods.length))
    ok('  newest first', periods[0].from === '2026-08-01', periods[0].from)
    ok('  reaches the same month last year', periods[12].from === '2025-08-01', periods[12].from)
    ok('  exactly one is current', periods.filter((p) => p.isCurrent).length === 1)
    ok('  and it is the first', periods[0].isCurrent)
    ok('  keys are unique', new Set(periods.map((p) => p.key)).size === 13)

    // A key is resolved through the generator, not trusted: a hand-edited URL
    // must not produce an arbitrary window claiming to be a cycle period.
    const round = periodFromKey(cfg, periods[3].key, '2026-08-14')
    ok('a real key round-trips', round?.from === periods[3].from && round?.to === periods[3].to)
    ok('  and is not marked current', round?.isCurrent === false)
    ok('the current key round-trips as current', periodFromKey(cfg, periods[0].key, '2026-08-14')?.isCurrent === true)
    ok('garbage is refused', periodFromKey(cfg, 'nonsense', '2026-08-14') === null)
    ok('an empty key is refused', periodFromKey(cfg, undefined, '2026-08-14') === null)
    ok('a well-formed but off-boundary window is refused', periodFromKey(cfg, '2026-08-03:2026-08-19', '2026-08-14') === null)
  }

  console.log('\n── Bucket widths follow the cycle ──')
  {
    ok('monthly keeps the familiar ladder', cycleBucketLabels('monthly').d30 === '30 days')
    ok('  and 120+ at the top', cycleBucketLabels('monthly').d120 === '120+ days')
    ok('weekly reads 7 days', cycleBucketLabels('7day').d30 === '7 days')
    ok('  and 28+ at the top', cycleBucketLabels('7day').d120 === '28+ days')
    ok('fortnightly reads 14 days', cycleBucketLabels('14day').d30 === '14 days')
    ok('  and 56+ at the top', cycleBucketLabels('14day').d120 === '56+ days')
    ok('Current is Current at every width', cycleBucketLabels('7day').current === 'Current')
  }

  console.log('\n── bucketFor is unchanged for every existing caller ──')
  {
    // The regression fence. Six call sites pass no width and must keep the
    // exact behaviour they had before the parameter was added.
    const expected = (d: number) =>
      d <= 0 ? 'current' : d <= 30 ? 'd30' : d <= 60 ? 'd60' : d <= 90 ? 'd90' : 'd120'
    let drift = 0
    for (let d = -10; d <= 200; d++) if (bucketFor(d) !== expected(d)) drift++
    ok('default width matches the pre-change function over -10..200', drift === 0, `${drift} differ`)

    ok('a 7-day width puts 31 days late in the top bucket', bucketFor(31, 7) === 'd120')
    ok('  and 7 days late in the first', bucketFor(7, 7) === 'd30')
    ok('  and 8 days late in the second', bucketFor(8, 7) === 'd60')
    ok('nothing overdue is Current at any width', bucketFor(0, 7) === 'current' && bucketFor(-5, 14) === 'current')
    ok('CYCLE_DAYS matches the labels', CYCLE_DAYS['7day'] === 7 && CYCLE_DAYS['14day'] === 14 && CYCLE_DAYS.monthly === 30)
  }

  console.log('\n── Narrowing untrusted input ──')
  {
    ok('a known cycle passes through', toStatementCycle('7day') === '7day')
    ok('an unknown one falls back to monthly', toStatementCycle('fortnightly') === 'monthly')
    ok('null falls back to monthly', toStatementCycle(null) === 'monthly')
  }

  console.log(fails === 0 ? '\nAll period assertions passed.\n' : `\n${fails} assertion(s) failed.\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
